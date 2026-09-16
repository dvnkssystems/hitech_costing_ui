<script setup>
/**
 * 3D container load view AND per-item load plan editor.
 *
 * One plan per quotation item (= per Costing Worksheet), stored server-side
 * as a `Container Fit Plan` -- see
 * `hitech_costing/doctype/container_fit_plan/container_fit_plan.py`. The
 * scene draws from that plan's payload, never from the automatic estimate's
 * uniform-gap `layout`:
 *
 *   - On open: the saved plan when there is one and it isn't stale; otherwise
 *     an opening proposal (`preview_fit_plan` with `start_from_estimate`),
 *     which picks the same orientation and counts the automatic estimate
 *     priced from, so the dialog opens agreeing with Units per Container.
 *   - While editing: every change re-runs `preview_fit_plan` (debounced,
 *     request-token guarded) with the tank AS PLACED from the last payload,
 *     so orientation never flips mid-edit. The payload is the only source of
 *     every figure, verdict and drawn position -- nothing about fit is
 *     recomputed here.
 *   - Save / Reset persist or delete the plan, then emit `refresh` so the
 *     wizard re-runs its container-fit preview and Units per Container /
 *     Containers Required update straight away.
 *
 * Geometry (mirrors the backend): along the length the cursor starts at
 * length gap 1, each tank takes its length and is followed by the next gap;
 * same across the width. Height has no gap: one pallet under the bottom
 * tank, the two tanks of a stack sit directly on each other, and a second
 * pallet goes on top of the upper tank only (pallet, tank, tank, pallet --
 * the client's confirmed stacking rule; never a pallet between the two).
 *
 * Container by container: every plan call is sent the order Quantity and the
 * item's per-container gap / pallet override rows (the wizard's "Load per
 * container" table), and the payload's `containers` split says what each
 * container holds. A container WITHOUT an override is drawn from the plan
 * being edited (its per-position gaps, pallet and stacking); one WITH its own
 * gap / pallet is drawn from the automatic layout at those values (uniform
 * gaps, its own layers and orientation, as the backend sized it) -- so the
 * picture matches the wizard's table container for container. Nothing about
 * fit is recomputed here; the only client fallback is the plain qty ÷
 * units_per_container split when the backend returned no split at all.
 * Physical positions past what is loaded are ghosted (free, or ruled out by
 * weight).
 *
 * Coordinate mapping: container length along X, height along Y (up), width
 * along Z; containers line up side by side along Z; 1 scene unit = 1 metre.
 */
import { ref, shallowRef, computed, watch, onBeforeUnmount, nextTick, useId } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { call } from '@/lib/frappe.js'
import { containerBreakdown, numberOrNull } from '@/lib/containerLoad.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** `preview_container_fit().layout` -- the automatic estimate. Only used
   *  to seed the opening proposal's Stacked default. */
  layout: { type: Object, default: null },
  /** The item's order quantity on the Items & Pricing table. */
  quantity: { type: Number, default: 1 },
  itemLabel: { type: String, default: '' },
  /** The item's SAVED Costing Worksheet name, or null while unsaved. */
  costingWorksheet: { type: String, default: null },
  containerType: { type: String, default: null },
  extLengthMm: { type: [Number, String], default: 0 },
  extWidthMm: { type: [Number, String], default: 0 },
  extHeightMm: { type: [Number, String], default: 0 },
  totalWeightKg: { type: [Number, String], default: 0 },
  /** The item's Standard Gap / Pallet Thickness (mm) as edited in the
   *  wizard; null = use the worksheet's / Packing Settings' value. */
  standardGapMm: { type: [Number, String], default: null },
  palletThicknessMm: { type: [Number, String], default: null },
  /** The item's per-container gap / pallet rows, already in the shape
   *  `preview_container_fit` takes (`containerOverridesPayload()`):
   *  `[{ container_no, standard_gap_mm, pallet_thickness_mm }]`. Sent with
   *  every plan call so the payload's split -- and the scene -- honour them. */
  containerOverrides: { type: Array, default: () => [] },
  /** Quotation submitted -- the plan can be viewed and tried, not saved. */
  locked: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'refresh'])

const FIT_PLAN_API = 'hitech_costing.hitech_costing.doctype.container_fit_plan.container_fit_plan'
const PREVIEW_DEBOUNCE_MS = 300
const STALE_NOTICE =
  'The saved load plan was for a different container or tank size. This is a fresh proposal; save to replace it.'

const MM = 1 / 1000
/** Past this many containers the scene stops being readable anyway; the
 *  side panel still lists every one. */
const MAX_DRAWN_CONTAINERS = 12

const COLORS = {
  background: 0xf4f6fa,
  container: 0x0b3465,
  tank: 0x107830,
  tankEdge: 0x0a4d20,
  ghost: 0x94a0ae,
  pallet: 0xb08a5a,
  palletEdge: 0x7a5a36,
  label: '#0b3465'
}

const uid = useId()
const panel = ref(null)
const canvasHost = ref(null)

// ------------------------------------------------------------------ state
/** Last plan payload from the backend -- what the scene and figures show. */
const plan = shallowRef(null)
const loading = ref(false)
const previewing = ref(false)
const saving = ref(false)
const resetting = ref(false)
const error = ref('')
const notice = ref('')
const flash = ref('')
/** A Container Fit Plan exists server-side for this item (stale or not). */
const savedPlanExists = ref(false)

// Editor inputs -- the source of truth while editing. Gap values are kept as
// the raw input strings so clearing a field to retype doesn't snap it to 0.
const stacked = ref(0)
const lengthGaps = ref([])
const widthGaps = ref([])

/** Bumped on every open / context change: nothing from an earlier session
 *  may land on a later one. */
let session = 0
/** Bumped on every edit preview (and by save/reset/load, which supersede
 *  any in-flight preview). */
let previewToken = 0
let previewTimer = null

const busy = computed(() => loading.value || saving.value || resetting.value)

// --------------------------------------------------------------- figures
const orderQty = computed(() => Math.max(Number(props.quantity) || 0, 1))
const slotsPerContainer = computed(() => Math.max(0, Number(plan.value?.units_per_container || 0)))
const physicalPositions = computed(() => Math.max(0, Number(plan.value?.total_tanks || 0)))
const ruledOutByWeight = computed(() => Math.max(0, physicalPositions.value - slotsPerContainer.value))
/** `n + 1` gaps of `gap` mm -- how an overridden container's automatic
 *  layout (uniform standard gap) is drawn. */
function uniformGaps(count, gap) {
  const n = Math.max(0, Number(count) || 0)
  return n ? Array.from({ length: n + 1 }, () => gap) : []
}

/** One container drawn from the plan being edited: its per-position gaps,
 *  pallet and stacking, `loaded` of `capacity` tanks in it. */
function planView(index, loaded, free, utilization) {
  const p = plan.value
  return {
    index,
    containerNo: index + 1,
    overridden: false,
    gapMm: Number(p?.standard_gap_mm) || 0,
    palletMm: Number(p?.pallet_thickness_mm) || 0,
    tank: p?.tank ?? null,
    lengthGaps: gapValues(p?.length_axis_gaps),
    widthGaps: gapValues(p?.width_axis_gaps),
    layers: Math.max(0, Number(p?.layers) || 0),
    capacity: slotsPerContainer.value,
    loaded: Math.max(0, Number(loaded) || 0),
    free: Math.max(0, Number(free) || 0),
    utilization: Number(utilization) || 0,
    fits: true
  }
}

/**
 * One entry per container the order needs -- what the scene draws and the
 * side panel lists. From the payload's `containers` split (the backend's
 * `compute_container_split`, the same figures the wizard's "Load per
 * container" table shows): a container without an override row is the plan
 * as edited here; one with its own gap / pallet is the automatic layout at
 * those values -- uniform gaps, its own layers and orientation. Falls back to
 * the plain qty ÷ units_per_container split (`containerLoad.js`) only when
 * the payload carries no split.
 */
const containerViews = computed(() => {
  const p = plan.value
  if (!p) return []
  const split = Array.isArray(p.containers) ? p.containers : []
  if (split.length) {
    return split.map((row, index) => {
      const view = planView(index, row.loaded, row.free, row.utilization_percent)
      view.containerNo = Number(row.container_no) || index + 1
      view.capacity = Math.max(0, Number(row.capacity) || 0)
      view.fits = row.fits !== false
      if (!row.overridden) return view
      const counts = row.counts || {}
      const gap = Number(row.standard_gap_mm) || 0
      return {
        ...view,
        overridden: true,
        gapMm: gap,
        palletMm: Number(row.pallet_thickness_mm) || 0,
        tank: row.tank ?? p.tank ?? null,
        lengthGaps: uniformGaps(counts.along_length, gap),
        widthGaps: uniformGaps(counts.along_width, gap),
        layers: Math.max(0, Number(counts.along_height) || 0)
      }
    })
  }
  return containerBreakdown({
    quantity: orderQty.value,
    unitsPerContainer: slotsPerContainer.value,
    tank: p.tank,
    container: p.container
  }).rows.map((row) => planView(row.index, row.loaded, row.free, row.utilization))
})
const containersRequired = computed(() => containerViews.value.length)
const drawnContainers = computed(() => Math.max(1, Math.min(containersRequired.value, MAX_DRAWN_CONTAINERS)))
const hasOverriddenContainers = computed(() => containerViews.value.some((view) => view.overridden))

/** Actual fill of everything being shipped: the mean fill of the containers
 *  needed (the wizard table's total row uses the same figure). */
const shipmentUtilization = computed(() => {
  const views = containerViews.value
  return views.length ? views.reduce((sum, view) => sum + view.utilization, 0) / views.length : 0
})
/** The plan's utilization when a container is full. */
const fullUtilization = computed(() => Number(plan.value?.container_utilization_percent || 0))

/** Per-item Standard gap / Pallet thickness overrides from the wizard (the
 *  worksheet's `standard_gap_mm` / `pallet_thickness_mm`), sent to every
 *  fit-plan call; they win over the worksheet's stored values server-side,
 *  and null falls back to it / Packing Settings. */
function packingOverrides() {
  return {
    standard_gap_mm: numberOrNull(props.standardGapMm),
    pallet_thickness_mm: numberOrNull(props.palletThicknessMm)
  }
}

/** Order quantity + the per-container override rows, sent with every plan
 *  call so the payload carries the per-container split the scene draws.
 *  Always a list (possibly empty) so unsaved deletions win over saved rows. */
function splitArgs() {
  return {
    quantity: orderQty.value,
    container_overrides: Array.isArray(props.containerOverrides) ? props.containerOverrides : []
  }
}

function mm(value) {
  return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}
function kg(value) {
  return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })
}
function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`
}
function dims(box) {
  if (!box) return '—'
  return `${mm(box.length_mm)} × ${mm(box.width_mm)} × ${mm(box.height_mm)} mm`
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

const verdict = computed(() => {
  const p = plan.value
  if (!p) return null
  const notes = String(p.fit_notes || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!p.geometric_fit) return { tone: 'bad', text: 'Does not fit yet', notes }
  if (p.exceeds_max_load) {
    return { tone: 'warn', text: `Fits, but weight caps it at ${slotsPerContainer.value}`, notes }
  }
  return { tone: 'ok', text: `Fits: ${plural(slotsPerContainer.value, 'tank')} per container`, notes: [] }
})

function varianceRow(label, variance, used, available) {
  const n = Number(variance || 0)
  return {
    label,
    value: n < 0 ? `${mm(-n)} mm over` : `${mm(n)} mm spare`,
    note: `${mm(used)} of ${mm(available)} mm used`,
    tone: n < 0 ? 'bad' : ''
  }
}

const figures = computed(() => {
  const p = plan.value
  if (!p) return []
  const c = p.container || {}
  const capped = slotsPerContainer.value < physicalPositions.value
  return [
    { label: 'Tanks per row', value: String(p.tanks_per_row ?? 0) },
    { label: 'Tanks per column', value: String(p.tanks_per_column ?? 0) },
    { label: 'Layers', value: String(p.layers ?? 0) },
    { label: 'Total tanks', value: String(p.total_tanks ?? 0) },
    {
      label: 'Units per container',
      value: String(slotsPerContainer.value),
      note: capped
        ? `capped by weight${p.max_units_by_weight != null ? ` (max ${p.max_units_by_weight} by load)` : ''}`
        : '',
      tone: capped ? 'warn' : ''
    },
    varianceRow('Length variance', p.length_variance_mm, p.total_length_used_mm, c.length_mm),
    varianceRow('Width variance', p.width_variance_mm, p.total_width_used_mm, c.width_mm),
    varianceRow('Height variance', p.height_variance_mm, p.height_used_mm, c.height_mm),
    {
      label: 'Total weight vs max load',
      value: c.max_load_kg ? `${kg(p.total_weight_kg)} / ${kg(c.max_load_kg)} kg` : `${kg(p.total_weight_kg)} kg`,
      note: c.max_load_kg ? '' : 'no max load set on this container type',
      tone: p.exceeds_max_load ? 'bad' : ''
    }
  ]
})

const axes = computed(() => [
  {
    key: 'length',
    title: 'Length axis gaps',
    hint: 'Gap 1 is against the far wall; the last gap is at the doors.',
    gaps: lengthGaps.value
  },
  {
    key: 'width',
    title: 'Width axis gaps',
    hint: 'Gap 1 and the last gap sit against the side walls.',
    gaps: widthGaps.value
  }
])

const saveHelp = computed(() => {
  if (!props.costingWorksheet) return 'Save the item first. The load plan is stored against its costing sheet.'
  if (props.locked) return 'This quotation is submitted, so its load plan can no longer be changed.'
  if (plan.value && !plan.value.geometric_fit) return 'Adjust the gaps or tank counts until the plan fits, then save.'
  return ''
})
const canSave = computed(
  () => Boolean(props.costingWorksheet && plan.value?.geometric_fit) && !props.locked && !busy.value
)

// ------------------------------------------------------------ plan calls
function messageOf(e) {
  return e?.message || String(e)
}
function gapValues(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => Number(row?.gap_mm ?? row) || 0)
}
function cleanGaps(list) {
  return list.map((value) => Math.max(0, Number(value) || 0))
}
function gapList(key) {
  return key === 'length' ? lengthGaps.value : widthGaps.value
}

function applyPlan(payload) {
  plan.value = payload ?? null
  stacked.value = payload?.stacked ? 1 : 0
  const fallback = [String(Number(payload?.standard_gap_mm || 0))]
  const lengths = gapValues(payload?.length_axis_gaps).map(String)
  const widths = gapValues(payload?.width_axis_gaps).map(String)
  lengthGaps.value = lengths.length ? lengths : fallback
  widthGaps.value = widths.length ? widths : [...fallback]
}

function cancelPendingPreview() {
  clearTimeout(previewTimer)
  previewTimer = null
  previewToken += 1
  previewing.value = false
}

function openingProposalArgs() {
  return {
    ...packingOverrides(),
    ...splitArgs(),
    plan: {
      container_type: props.containerType ?? null,
      ...(props.costingWorksheet ? { costing_worksheet: props.costingWorksheet } : {}),
      stacked: Number(props.layout?.counts?.along_height) === 2 ? 1 : 0,
      tank_length_mm: Number(props.extLengthMm) || 0,
      tank_width_mm: Number(props.extWidthMm) || 0,
      tank_height_mm: Number(props.extHeightMm) || 0,
      tank_weight_kg: Number(props.totalWeightKg) || 0,
      start_from_estimate: 1
    }
  }
}

/** The tank AS PLACED from the last payload plus the current inputs. */
function editedPlan(base) {
  return {
    container_type: base.container_type || props.containerType || null,
    stacked: stacked.value ? 1 : 0,
    tank_length_mm: Number(base.tank?.length_mm) || 0,
    tank_width_mm: Number(base.tank?.width_mm) || 0,
    tank_height_mm: Number(base.tank?.height_mm) || 0,
    length_axis_gaps: cleanGaps(lengthGaps.value),
    width_axis_gaps: cleanGaps(widthGaps.value)
  }
}

async function load() {
  const mine = ++session
  cancelPendingPreview()
  plan.value = null
  error.value = ''
  notice.value = ''
  flash.value = ''
  savedPlanExists.value = false
  loading.value = true
  try {
    let saved = null
    if (props.costingWorksheet) {
      const res = await call(`${FIT_PLAN_API}.get_worksheet_fit_plan`, {
        costing_worksheet: props.costingWorksheet,
        ...packingOverrides(),
        ...splitArgs()
      })
      if (mine !== session) return
      saved = res?.plan ?? null
      savedPlanExists.value = Boolean(saved)
    }
    if (saved && !saved.stale) {
      applyPlan(saved)
      return
    }
    if (saved?.stale) notice.value = STALE_NOTICE
    const proposal = await call(`${FIT_PLAN_API}.preview_fit_plan`, openingProposalArgs())
    if (mine !== session) return
    applyPlan(proposal)
  } catch (e) {
    if (mine === session) error.value = messageOf(e)
  } finally {
    if (mine === session) loading.value = false
  }
}

async function runPreview() {
  previewTimer = null
  const base = plan.value
  if (!base) {
    previewing.value = false
    return
  }
  const token = ++previewToken
  const mine = session
  try {
    const res = await call(`${FIT_PLAN_API}.preview_fit_plan`, {
      ...packingOverrides(),
      ...splitArgs(),
      plan: {
        ...editedPlan(base),
        ...(props.costingWorksheet ? { costing_worksheet: props.costingWorksheet } : {}),
        tank_weight_kg: Number(base.tank?.weight_kg) || 0
      }
    })
    if (token !== previewToken || mine !== session) return
    // Figures and scene only -- the inputs stay as typed.
    if (res) plan.value = res
    error.value = ''
  } catch (e) {
    if (token === previewToken && mine === session) error.value = messageOf(e)
  } finally {
    if (token === previewToken && mine === session) previewing.value = false
  }
}

function onEdit() {
  if (!plan.value) return
  flash.value = ''
  clearTimeout(previewTimer)
  previewing.value = true
  previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS)
}

function setStacked(checked) {
  stacked.value = checked ? 1 : 0
  onEdit()
}
function setGap(key, index, value) {
  gapList(key)[index] = value
  onEdit()
}
function addTank(key) {
  gapList(key).push(String(Number(plan.value?.standard_gap_mm || 0)))
  onEdit()
}
function removeTank(key) {
  const list = gapList(key)
  if (list.length <= 1) return
  list.pop()
  onEdit()
}

async function save() {
  const base = plan.value
  if (!base || !props.costingWorksheet || saving.value) return
  cancelPendingPreview()
  const mine = session
  saving.value = true
  error.value = ''
  flash.value = ''
  try {
    const res = await call(`${FIT_PLAN_API}.save_worksheet_fit_plan`, {
      costing_worksheet: props.costingWorksheet,
      ...packingOverrides(),
      ...splitArgs(),
      plan: editedPlan(base)
    })
    if (mine !== session) return
    if (res?.plan) applyPlan(res.plan)
    savedPlanExists.value = true
    notice.value = ''
    flash.value = 'Load plan saved'
    emit('refresh', res?.worksheet ?? null)
  } catch (e) {
    if (mine === session) error.value = messageOf(e)
  } finally {
    if (mine === session) saving.value = false
  }
}

async function resetToAutomatic() {
  if (!props.costingWorksheet || resetting.value) return
  cancelPendingPreview()
  const mine = session
  resetting.value = true
  error.value = ''
  flash.value = ''
  try {
    const res = await call(`${FIT_PLAN_API}.delete_worksheet_fit_plan`, { costing_worksheet: props.costingWorksheet })
    if (mine !== session) return
    savedPlanExists.value = false
    notice.value = ''
    emit('refresh', res?.worksheet ?? null)
    const proposal = await call(`${FIT_PLAN_API}.preview_fit_plan`, openingProposalArgs())
    if (mine !== session) return
    applyPlan(proposal)
    flash.value = 'Reset to the automatic estimate'
  } catch (e) {
    if (mine === session) error.value = messageOf(e)
  } finally {
    if (mine === session) resetting.value = false
  }
}

// ----------------------------------------------------------------- three.js
let renderer = null
let scene = null
let camera = null
let controls = null
let sun = null
let contentGroup = null
/** Container size + drawn count the camera was last framed for -- edits
 *  that don't change it keep whatever angle the user orbited to. */
let framingKey = ''
let frameId = 0
let resizeObserver = null

function disposeObject(obj) {
  obj.traverse((node) => {
    node.geometry?.dispose?.()
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
    materials.forEach((m) => {
      m.map?.dispose?.()
      m.dispose?.()
    })
  })
}

function teardown() {
  cancelAnimationFrame(frameId)
  frameId = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  controls?.dispose()
  controls = null
  if (scene) disposeObject(scene)
  scene = null
  camera = null
  sun = null
  contentGroup = null
  framingKey = ''
  if (renderer) {
    renderer.dispose()
    renderer.domElement.remove()
    renderer = null
  }
}

function fitCanvas() {
  const host = canvasHost.value
  if (!host || !renderer || !camera) return
  const width = Math.max(host.clientWidth, 1)
  const height = Math.max(host.clientHeight, 1)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

/** Renderer, camera, controls and lights -- created once per canvas host and
 *  reused across edits; only the content group is rebuilt. */
function ensureRenderer(host) {
  if (renderer && renderer.domElement.parentNode === host) return
  teardown()

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(COLORS.background, 1)
  host.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(40, 1, 0.05, 500)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.maxPolarAngle = Math.PI / 2 - 0.02

  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c2cc, 1.1))
  sun = new THREE.DirectionalLight(0xffffff, 1.3)
  scene.add(sun)

  fitCanvas()
  resizeObserver = new ResizeObserver(fitCanvas)
  resizeObserver.observe(host)

  const animate = () => {
    frameId = requestAnimationFrame(animate)
    controls.update()
    renderer.render(scene, camera)
  }
  animate()
}

function frameCamera(L, H, totalDepth) {
  const centre = new THREE.Vector3(L / 2, H / 2, totalDepth / 2)
  const reach = Math.max(L, totalDepth, H) * 1.15
  camera.position.set(centre.x + reach * 0.95, centre.y + reach * 0.75, centre.z + reach * 1.15)
  camera.lookAt(centre)
  controls.target.copy(centre)
  controls.minDistance = reach * 0.3
  controls.maxDistance = reach * 4
  controls.update()
  sun.position.set(L, H * 2.2, totalDepth * 1.4)
}

/** A floating "1", "2", … above each container. */
function makeLabel(text, size) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(64, 64, 56, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = 6
  ctx.strokeStyle = COLORS.label
  ctx.stroke()
  ctx.fillStyle = COLORS.label
  ctx.font = 'bold 64px "IBM Plex Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 64, 68)
  const texture = new THREE.CanvasTexture(canvas)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }))
  sprite.scale.set(size, size, 1)
  return sprite
}

function buildContainer(group, container, zOffset, index) {
  const L = container.length_mm * MM
  const H = container.height_mm * MM
  const W = container.width_mm * MM
  const centre = new THREE.Vector3(L / 2, H / 2, zOffset + W / 2)

  // Barely-there tinted walls seen from inside, crisp navy edges, a darker
  // floor so stacked layers read as resting on something, and a door-end
  // frame so length reads left→right the way a loading plan does.
  const geometry = new THREE.BoxGeometry(L, H, W)
  const walls = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: COLORS.container, transparent: true, opacity: 0.05, side: THREE.BackSide })
  )
  walls.position.copy(centre)
  group.add(walls)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: COLORS.container })
  )
  edges.position.copy(centre)
  group.add(edges)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(L, W),
    new THREE.MeshBasicMaterial({ color: COLORS.container, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.set(L / 2, 0.001, zOffset + W / 2)
  group.add(floor)
  const doorFrame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, H)),
    new THREE.LineBasicMaterial({ color: COLORS.container, transparent: true, opacity: 0.35 })
  )
  doorFrame.rotation.y = Math.PI / 2
  doorFrame.position.set(L - 0.002, H / 2, zOffset + W / 2)
  group.add(doorFrame)

  if (containersRequired.value > 1) {
    const label = makeLabel(String(index + 1), Math.max(H, W) * 0.28)
    label.position.set(L / 2, H + Math.max(H, W) * 0.22, zOffset + W / 2)
    group.add(label)
  }
}

/** Tank centres (mm) along one axis: cursor starts at gap 1; each tank is
 *  followed by the next gap. `gaps.length - 1` tanks. */
function axisCentres(gaps, size) {
  const centres = []
  let cursor = gaps[0] ?? 0
  for (let i = 0; i < gaps.length - 1; i += 1) {
    centres.push(cursor + size / 2)
    cursor += size + (gaps[i + 1] ?? 0)
  }
  return centres
}

function buildTanks(group, view, zOffset) {
  const pallet = Number(view.palletMm || 0) * MM
  const tankL = Number(view.tank?.length_mm) || 0
  const tankW = Number(view.tank?.width_mm) || 0
  const th = (Number(view.tank?.height_mm) || 0) * MM
  const xs = axisCentres(view.lengthGaps, tankL)
  const zs = axisCentres(view.widthGaps, tankW)
  const nH = Math.max(0, Number(view.layers) || 0)
  if (!xs.length || !zs.length || !nH || !tankL || !tankW || !th) return
  const tl = tankL * MM
  const tw = tankW * MM

  const solidGeometry = new THREE.BoxGeometry(tl, th, tw)
  const edgeGeometry = new THREE.EdgesGeometry(solidGeometry)
  const solidMaterial = new THREE.MeshStandardMaterial({ color: COLORS.tank, roughness: 0.55, metalness: 0.1 })
  const solidEdgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.tankEdge })
  const ghostMaterial = new THREE.MeshBasicMaterial({ color: COLORS.ghost, transparent: true, opacity: 0.08 })
  const ghostEdgeMaterial = new THREE.LineDashedMaterial({
    color: COLORS.ghost,
    dashSize: 0.08,
    gapSize: 0.05,
    transparent: true,
    opacity: 0.8
  })
  // Pallet slab: same footprint as the tank, `palletMm` tall, in a muted
  // wood tone. One under the bottom tank; when stacked 2 high the upper tank
  // sits straight on the lower one and a second pallet goes on top of it
  // (pallet, tank, tank, pallet) -- never one between the two tanks.
  const palletGeometry = pallet > 0 ? new THREE.BoxGeometry(tl, pallet, tw) : null
  const palletEdgeGeometry = palletGeometry ? new THREE.EdgesGeometry(palletGeometry) : null
  const palletMaterial = new THREE.MeshStandardMaterial({ color: COLORS.pallet, roughness: 0.9, metalness: 0 })
  const palletEdgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.palletEdge })
  const ghostPalletMaterial = new THREE.MeshBasicMaterial({ color: COLORS.pallet, transparent: true, opacity: 0.1 })
  const addPallet = (x, yCentre, z, isLoaded) => {
    if (!palletGeometry) return
    const slab = new THREE.Mesh(palletGeometry, isLoaded ? palletMaterial : ghostPalletMaterial)
    slab.position.set(x, yCentre, z)
    group.add(slab)
    const outline = new THREE.LineSegments(palletEdgeGeometry, isLoaded ? palletEdgeMaterial : ghostEdgeMaterial)
    outline.position.set(x, yCentre, z)
    if (!isLoaded) outline.computeLineDistances()
    group.add(outline)
  }

  const slots = Math.max(0, Number(view.capacity) || 0)
  const placed = Math.max(0, Number(view.loaded) || 0)
  // Loader's fill order: floor first, front-to-back along the length, then
  // across the width, then the next layer up. Every physical position is
  // drawn; slots past `placed` are free, positions past `slots` are ruled
  // out by weight -- both ghosted.
  let slot = 0
  for (let iz = 0; iz < nH; iz += 1) {
    for (let iy = 0; iy < zs.length; iy += 1) {
      for (let ix = 0; ix < xs.length; ix += 1) {
        const x = xs[ix] * MM
        const z = zOffset + zs[iy] * MM
        // Tank k sits at pallet + k × tank height: the stack's one pallet
        // is under the bottom tank only.
        const y = pallet + iz * th + th / 2
        const isLoaded = slot < slots && slot < placed
        if (iz === 0) addPallet(x, pallet / 2, z, isLoaded)
        const box = new THREE.Mesh(solidGeometry, isLoaded ? solidMaterial : ghostMaterial)
        box.position.set(x, y, z)
        group.add(box)
        const outline = new THREE.LineSegments(edgeGeometry, isLoaded ? solidEdgeMaterial : ghostEdgeMaterial)
        outline.position.set(x, y, z)
        if (!isLoaded) outline.computeLineDistances()
        group.add(outline)
        // Top pallet: above the upper tank of a 2-high stack only.
        if (nH === 2 && iz === 1) addPallet(x, pallet + 2 * th + pallet / 2, z, isLoaded)
        slot += 1
      }
    }
  }
}

function draw() {
  const p = plan.value
  const host = canvasHost.value
  const c = p?.container
  if (!props.open || !host || !c?.length_mm || !c?.width_mm || !c?.height_mm) return
  ensureRenderer(host)

  const L = c.length_mm * MM
  const H = c.height_mm * MM
  const W = c.width_mm * MM
  const count = drawnContainers.value
  const spacing = W * 0.4
  const totalDepth = count * W + (count - 1) * spacing
  const key = `${c.length_mm}|${c.width_mm}|${c.height_mm}|${count}`
  if (key !== framingKey) {
    frameCamera(L, H, totalDepth)
    framingKey = key
  }

  if (contentGroup) {
    scene.remove(contentGroup)
    disposeObject(contentGroup)
  }
  contentGroup = new THREE.Group()
  // No split at all (nothing fits yet): one container, every position ghosted.
  const views = containerViews.value.length ? containerViews.value : [planView(0, 0, 0, 0)]
  for (let i = 0; i < count; i += 1) {
    const zOffset = i * (W + spacing)
    buildContainer(contentGroup, c, zOffset, i)
    if (views[i]) buildTanks(contentGroup, views[i], zOffset)
  }
  scene.add(contentGroup)
}

// ------------------------------------------------------------- lifecycle
// Escape closes from anywhere -- the panel itself may not hold focus (the
// canvas grabs pointer events, and focus() during the enter transition
// isn't reliable), so a panel-scoped keydown alone misses most presses.
function onWindowKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

watch(
  [
    () => props.open,
    () => props.costingWorksheet,
    () => props.containerType,
    () => props.extLengthMm,
    () => props.extWidthMm,
    () => props.extHeightMm,
    () => props.totalWeightKg,
    // Changing any of these re-opens from scratch (saved plan / fresh
    // proposal) so the facts, figures and per-container split reflect the
    // new effective values.
    () => numberOrNull(props.standardGapMm),
    () => numberOrNull(props.palletThicknessMm),
    () => props.quantity,
    () => JSON.stringify(props.containerOverrides ?? [])
  ],
  ([open], previous) => {
    window.removeEventListener('keydown', onWindowKeydown, true)
    if (!open) {
      session += 1
      cancelPendingPreview()
      loading.value = false
      saving.value = false
      resetting.value = false
      teardown()
      return
    }
    window.addEventListener('keydown', onWindowKeydown, true)
    load()
    if (!previous?.[0]) {
      nextTick(() => requestAnimationFrame(() => panel.value?.focus?.({ preventScroll: true })))
    }
  },
  { immediate: true }
)

watch([plan, () => props.open], async () => {
  await nextTick()
  if (props.open) draw()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  clearTimeout(previewTimer)
  session += 1
  teardown()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="cf3d">
      <div v-if="open" class="cf3d-scrim" @click="emit('close')" />
    </Transition>
    <Transition name="cf3d-panel">
      <div
        v-if="open"
        ref="panel"
        class="cf3d"
        role="dialog"
        aria-modal="true"
        aria-label="Container load plan in 3D"
        tabindex="-1"
      >
        <header class="cf3d__head">
          <div>
            <div class="cf3d__eyebrow">Container load plan · 3D</div>
            <div class="cf3d__title">
              {{ itemLabel || 'Tank' }} in {{ plan?.container?.name || containerType || 'container' }}
              <span v-if="containersRequired > 1" class="cf3d__title-count">× {{ containersRequired }}</span>
            </div>
          </div>
          <button type="button" class="cf3d__close" title="Close" aria-label="Close" @click="emit('close')">✕</button>
        </header>

        <div class="cf3d__body">
          <div class="cf3d__stage">
            <div ref="canvasHost" class="cf3d__canvas" />
            <div v-if="!plan" class="cf3d__empty">
              <template v-if="loading">Working out the load plan…</template>
              <template v-else-if="error">No load plan to draw. See the message alongside.</template>
              <template v-else>
                Container fit hasn't been calculated yet. Pick a Container Type and make sure this item's external
                dimensions are filled in on its costing sheet.
              </template>
            </div>
            <div v-else-if="!physicalPositions" class="cf3d__banner">
              No tanks placed. Add at least one tank on both the length and width axes.
            </div>
            <div v-if="plan && physicalPositions" class="cf3d__hint">
              Drag to rotate · scroll to zoom · right-drag to pan
              <span v-if="containersRequired > drawnContainers">
                · showing {{ drawnContainers }} of {{ containersRequired }} containers
              </span>
            </div>
          </div>

          <aside class="cf3d__side" :aria-busy="busy || previewing">
            <div class="cf3d__side-scroll">
              <p v-if="loading" class="cf3d__alert" role="status">Working out the load plan…</p>
              <p v-if="error" class="cf3d__alert cf3d__alert--error" role="alert">{{ error }}</p>
              <p v-if="notice" class="cf3d__alert cf3d__alert--notice">{{ notice }}</p>
              <p v-if="flash" class="cf3d__alert cf3d__alert--ok" role="status">{{ flash }}</p>

              <template v-if="plan">
                <div
                  v-if="verdict"
                  class="cf3d__verdict"
                  :class="`cf3d__verdict--${verdict.tone}`"
                  role="status"
                  aria-live="polite"
                >
                  <span class="cf3d__verdict-text">{{ verdict.text }}</span>
                  <ul v-if="verdict.notes.length" class="cf3d__verdict-notes">
                    <li v-for="(line, i) in verdict.notes" :key="i">{{ line }}</li>
                  </ul>
                </div>

                <section class="cf3d__section" :aria-labelledby="`${uid}-plan-title`">
                  <div class="cf3d__section-head">
                    <h3 :id="`${uid}-plan-title`" class="cf3d__section-title">Load plan</h3>
                    <span v-if="previewing" class="cf3d__updating">Updating…</span>
                  </div>

                  <label class="cf3d__toggle" :for="`${uid}-stacked`">
                    <input
                      :id="`${uid}-stacked`"
                      type="checkbox"
                      :checked="stacked === 1"
                      :disabled="busy"
                      @change="setStacked($event.target.checked)"
                    />
                    <span>Stacked 2 high <span class="cf3d__muted">· pallet, tank, tank, pallet</span></span>
                  </label>
                  <p v-if="plan.rotated" class="cf3d__rotated">
                    Rotated 90°: the tank's length runs across the container's width.
                  </p>

                  <fieldset v-for="axis in axes" :key="axis.key" class="cf3d__axis" :disabled="busy">
                    <legend class="cf3d__axis-title">
                      {{ axis.title }}
                      <span class="cf3d__muted">· {{ plural(Math.max(axis.gaps.length - 1, 0), 'tank') }}</span>
                    </legend>
                    <p class="cf3d__axis-hint">{{ axis.hint }}</p>
                    <ol class="cf3d__gaps">
                      <li v-for="(gap, i) in axis.gaps" :key="i" class="cf3d__gap">
                        <label :for="`${uid}-${axis.key}-gap-${i}`" class="cf3d__gap-label">
                          Gap {{ i + 1 }}<span class="cf3d__sr"> on the {{ axis.key }} axis, in millimetres</span>
                        </label>
                        <span class="cf3d__gap-field">
                          <input
                            :id="`${uid}-${axis.key}-gap-${i}`"
                            class="cf3d__gap-input"
                            type="number"
                            min="0"
                            step="10"
                            inputmode="numeric"
                            :value="gap"
                            @input="setGap(axis.key, i, $event.target.value)"
                          />
                          <span class="cf3d__gap-unit" aria-hidden="true">mm</span>
                        </span>
                      </li>
                    </ol>
                    <div class="cf3d__axis-actions">
                      <button type="button" class="cf3d__btn cf3d__btn--small" @click="addTank(axis.key)">
                        + Add tank
                      </button>
                      <button
                        type="button"
                        class="cf3d__btn cf3d__btn--small"
                        :disabled="axis.gaps.length <= 1"
                        @click="removeTank(axis.key)"
                      >
                        − Remove tank
                      </button>
                    </div>
                  </fieldset>
                </section>

                <dl class="cf3d__figures">
                  <div
                    v-for="row in figures"
                    :key="row.label"
                    class="cf3d__figure"
                    :class="row.tone ? `cf3d__figure--${row.tone}` : ''"
                  >
                    <dt>{{ row.label }}</dt>
                    <dd>
                      {{ row.value }}
                      <span v-if="row.note" class="cf3d__figure-note">{{ row.note }}</span>
                    </dd>
                  </div>
                </dl>

                <div v-if="slotsPerContainer" class="cf3d__stat cf3d__stat--hero">
                  <span class="cf3d__k">Shipment utilization</span>
                  <span class="cf3d__v">{{ pct(shipmentUtilization) }}</span>
                  <div class="cf3d__bar">
                    <div class="cf3d__bar-fill" :style="{ width: `${Math.min(shipmentUtilization, 100)}%` }" />
                  </div>
                  <p class="cf3d__note">
                    Volume of the {{ plural(orderQty, 'tank') }} ordered ÷ volume of the
                    {{ plural(containersRequired, 'container') }} needed.
                    <strong>{{ pct(fullUtilization) }} when full</strong> ({{ slotsPerContainer }} per container). The
                    rest is the gaps set above, the {{ mm(plan.pallet_thickness_mm) }} mm pallet under the bottom
                    tank<template v-if="plan.layers === 2"> (and the one on top of the upper tank)</template>, and
                    whatever space is left along each axis.
                  </p>
                </div>

                <div v-if="containerViews.length" class="cf3d__containers">
                  <div
                    v-for="row in containerViews"
                    :key="row.containerNo"
                    class="cf3d__container-row"
                    :class="{ 'cf3d__container-row--own': row.overridden }"
                  >
                    <span class="cf3d__container-n">{{ row.containerNo }}</span>
                    <span class="cf3d__container-load">
                      <template v-if="!row.fits && !row.loaded">
                        <span class="cf3d__container-bad">Doesn't fit</span>
                      </template>
                      <template v-else>
                        <span class="cf3d__swatch cf3d__swatch--tank" />{{ row.loaded }} of {{ row.capacity }}
                        <span v-if="row.free" class="cf3d__muted">
                          · <span class="cf3d__swatch cf3d__swatch--ghost" />{{ row.free }} free
                        </span>
                      </template>
                      <span v-if="row.overridden" class="cf3d__container-own">
                        own gap {{ mm(row.gapMm) }} · pallet {{ mm(row.palletMm) }} mm
                      </span>
                    </span>
                    <span class="cf3d__container-pct">{{ pct(row.utilization) }}</span>
                  </div>
                </div>
                <p v-if="hasOverriddenContainers" class="cf3d__note">
                  A container marked <strong>own</strong> is packed at the gap and pallet set for it in the
                  Load per container table and is drawn that way; the gaps above apply to the others.
                </p>
                <p v-if="ruledOutByWeight" class="cf3d__note cf3d__note--warn">
                  <span class="cf3d__swatch cf3d__swatch--ghost" />{{ plural(ruledOutByWeight, 'position') }} per
                  container ruled out by weight: they fit by size, but the container's max load stops at
                  {{ slotsPerContainer }}.
                </p>

                <dl class="cf3d__facts">
                  <div class="cf3d__fact">
                    <dt>Standard gap</dt>
                    <dd>{{ mm(plan.standard_gap_mm) }} mm <span class="cf3d__muted">· pre-fills each added tank's gap</span></dd>
                  </div>
                  <div class="cf3d__fact">
                    <dt>Pallet thickness</dt>
                    <dd>
                      {{ mm(plan.pallet_thickness_mm) }} mm
                      <span class="cf3d__muted">· under the bottom tank, and on top when stacked 2 high</span>
                    </dd>
                  </div>
                  <div class="cf3d__fact">
                    <dt>Container internal</dt>
                    <dd>{{ dims(plan.container) }}</dd>
                  </div>
                  <div class="cf3d__fact">
                    <dt>Tank as placed (L × W × H)</dt>
                    <dd>{{ dims(plan.tank) }}</dd>
                  </div>
                  <div class="cf3d__fact">
                    <dt>Order quantity</dt>
                    <dd>{{ plural(orderQty, 'tank') }} → {{ plural(containersRequired, 'container') }}</dd>
                  </div>
                </dl>
              </template>
            </div>

            <div v-if="plan || savedPlanExists" class="cf3d__actions">
              <div class="cf3d__actions-row">
                <button
                  type="button"
                  class="cf3d__btn cf3d__btn--primary"
                  :disabled="!canSave"
                  :title="saveHelp || undefined"
                  :aria-describedby="saveHelp ? `${uid}-save-help` : undefined"
                  @click="save"
                >
                  {{ saving ? 'Saving…' : 'Save load plan' }}
                </button>
                <button
                  v-if="savedPlanExists"
                  type="button"
                  class="cf3d__btn"
                  :disabled="busy || !costingWorksheet || locked"
                  @click="resetToAutomatic"
                >
                  {{ resetting ? 'Resetting…' : 'Reset to automatic' }}
                </button>
              </div>
              <p v-if="saveHelp" :id="`${uid}-save-help`" class="cf3d__action-help">{{ saveHelp }}</p>
            </div>
          </aside>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cf3d-scrim {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  z-index: 70;
}

.cf3d {
  --cf-navy: #0b3465;
  --cf-green: #107830;
  --cf-amber: #b45309;
  --cf-red: #b42318;
  --cf-border: #d7dee8;
  --cf-row: #edf1f6;
  --cf-text: #0e1b2b;
  --cf-muted: #5e6b7a;
  --cf-faint: #94a0ae;
  position: fixed;
  z-index: 71;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(1180px, 94vw);
  height: min(760px, 92vh);
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid var(--cf-border);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(11, 52, 101, 0.28);
  font-family: 'Raleway', system-ui, sans-serif;
  color: var(--cf-text);
  outline: none;
  overflow: hidden;
}

.cf3d__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--cf-border);
}

.cf3d__eyebrow {
  font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cf-navy);
}

.cf3d__title {
  margin-top: 6px;
  font: 700 18px/1.2 'Raleway', system-ui, sans-serif;
}

.cf3d__title-count {
  margin-left: 6px;
  font: 700 14px/1 'IBM Plex Mono', monospace;
  color: var(--cf-muted);
}

.cf3d__close {
  flex: none;
  width: 32px;
  height: 32px;
  border: 1px solid var(--cf-border);
  border-radius: 8px;
  background: #fff;
  color: var(--cf-muted);
  cursor: pointer;
  font-size: 14px;
}

.cf3d__close:hover {
  color: var(--cf-text);
  background: var(--cf-row);
}

.cf3d__close:focus-visible,
.cf3d__btn:focus-visible,
.cf3d__gap-input:focus-visible,
.cf3d__toggle input:focus-visible {
  outline: 2px solid var(--cf-navy);
  outline-offset: 2px;
}

.cf3d__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
}

.cf3d__stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  background: #f4f6fa;
}

.cf3d__canvas {
  position: absolute;
  inset: 0;
}

.cf3d__canvas :deep(canvas) {
  display: block;
  width: 100% !important;
  height: 100% !important;
}

.cf3d__hint {
  position: absolute;
  left: 14px;
  bottom: 12px;
  font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.04em;
  color: var(--cf-faint);
  pointer-events: none;
}

.cf3d__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 32px;
  text-align: center;
  background: #f4f6fa;
  font: 400 14px/1.6 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__banner {
  position: absolute;
  top: 12px;
  left: 14px;
  right: 14px;
  padding: 8px 12px;
  border: 1px solid var(--cf-border);
  border-radius: 8px;
  background: #fff;
  font: 500 13px/1.45 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
  pointer-events: none;
}

.cf3d__side {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--cf-border);
}

.cf3d__side-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cf3d__alert {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--cf-border);
  font: 500 12.5px/1.45 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
  white-space: pre-line;
}

.cf3d__alert--error {
  border-color: #f3c3be;
  background: #fef3f2;
  color: var(--cf-red);
}

.cf3d__alert--notice {
  border-color: #f6d9a8;
  background: #fffaeb;
  color: var(--cf-amber);
}

.cf3d__alert--ok {
  border-color: #b7dfc3;
  background: #effaf2;
  color: var(--cf-green);
}

.cf3d__verdict {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
}

.cf3d__verdict-text {
  font: 700 14px/1.3 'Raleway', system-ui, sans-serif;
}

.cf3d__verdict--ok {
  background: #effaf2;
  border-color: #b7dfc3;
  color: var(--cf-green);
}

.cf3d__verdict--warn {
  background: #fffaeb;
  border-color: #f6d9a8;
  color: var(--cf-amber);
}

.cf3d__verdict--bad {
  background: #fef3f2;
  border-color: #f3c3be;
  color: var(--cf-red);
}

.cf3d__verdict-notes {
  margin: 6px 0 0;
  padding-left: 18px;
  font: 500 12px/1.5 'Raleway', system-ui, sans-serif;
}

.cf3d__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cf3d__section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.cf3d__section-title {
  margin: 0;
  font: 700 13px/1.2 'Raleway', system-ui, sans-serif;
  color: var(--cf-navy);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.cf3d__updating {
  font: 500 11px/1 'IBM Plex Mono', monospace;
  color: var(--cf-faint);
}

.cf3d__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font: 600 13px/1.4 'Raleway', system-ui, sans-serif;
  cursor: pointer;
}

.cf3d__toggle input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--cf-navy);
}

.cf3d__rotated {
  margin: 0;
  font: 500 12px/1.45 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__axis {
  margin: 0;
  padding: 10px 12px 12px;
  border: 1px solid var(--cf-border);
  border-radius: 8px;
  min-width: 0;
}

.cf3d__axis-title {
  padding: 0 4px;
  font: 700 12.5px/1.2 'Raleway', system-ui, sans-serif;
}

.cf3d__axis-hint {
  margin: 0 0 8px;
  font: 400 11.5px/1.45 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__gaps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.cf3d__gap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.cf3d__gap-label {
  font: 600 11px/1.2 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__gap-field {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cf3d__gap-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--cf-border);
  border-radius: 6px;
  background: #fff;
  font: 600 13px/1 'IBM Plex Mono', monospace;
  color: var(--cf-text);
}

.cf3d__gap-input:disabled {
  background: var(--cf-row);
  color: var(--cf-muted);
}

.cf3d__gap-unit {
  font: 500 11px/1 'IBM Plex Mono', monospace;
  color: var(--cf-faint);
}

.cf3d__axis-actions {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cf3d__btn {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--cf-border);
  border-radius: 8px;
  background: #fff;
  color: var(--cf-text);
  font: 600 13px/1 'Raleway', system-ui, sans-serif;
  cursor: pointer;
}

.cf3d__btn:hover:not(:disabled) {
  background: var(--cf-row);
}

.cf3d__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cf3d__btn--small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}

.cf3d__btn--primary {
  border-color: var(--cf-navy);
  background: var(--cf-navy);
  color: #fff;
}

.cf3d__btn--primary:hover:not(:disabled) {
  background: #082747;
}

.cf3d__figures {
  margin: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cf-border);
  border-radius: 8px;
  overflow: hidden;
}

.cf3d__figure {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  padding: 7px 10px;
}

.cf3d__figure + .cf3d__figure {
  border-top: 1px solid var(--cf-row);
}

.cf3d__figure dt {
  font: 600 12px/1.4 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__figure dd {
  margin: 0;
  text-align: right;
  font: 600 12.5px/1.4 'IBM Plex Mono', monospace;
  color: var(--cf-text);
}

.cf3d__figure-note {
  display: block;
  font: 500 11px/1.35 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__figure--bad dd,
.cf3d__figure--bad .cf3d__figure-note {
  color: var(--cf-red);
}

.cf3d__figure--warn dd,
.cf3d__figure--warn .cf3d__figure-note {
  color: var(--cf-amber);
}

.cf3d__stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cf3d__k {
  font: 600 12px/16px 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__stat--hero .cf3d__v {
  font: 700 26px/1 'IBM Plex Mono', monospace;
  color: var(--cf-navy);
}

.cf3d__bar {
  height: 8px;
  border-radius: 999px;
  background: var(--cf-row);
  overflow: hidden;
}

.cf3d__bar-fill {
  height: 100%;
  background: var(--cf-green);
  border-radius: 999px;
}

.cf3d__note {
  margin: 4px 0 0;
  font: 400 12px/1.55 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__note strong {
  color: var(--cf-text);
  font-weight: 700;
}

.cf3d__note--warn {
  margin: 0;
  color: var(--cf-amber);
}

.cf3d__containers {
  /* `flex: none`: with `overflow: hidden` a flex item's min-height is 0,
     so inside the scrolling column this list used to shrink to its border
     and the per-container rows were never visible. */
  flex: none;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--cf-border);
  border-radius: 8px;
  overflow: hidden;
}

.cf3d__container-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font: 600 12.5px/1.3 'IBM Plex Mono', monospace;
}

.cf3d__container-row + .cf3d__container-row {
  border-top: 1px solid var(--cf-row);
}

.cf3d__container-n {
  width: 22px;
  height: 22px;
  border: 2px solid var(--cf-navy);
  border-radius: 50%;
  display: grid;
  place-items: center;
  font: 700 11px/1 'IBM Plex Mono', monospace;
  color: var(--cf-navy);
}

.cf3d__container-load {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cf3d__container-pct {
  color: var(--cf-navy);
  font-weight: 700;
}

.cf3d__container-row--own {
  background: #fff8ec;
}

.cf3d__container-own {
  display: block;
  margin-top: 2px;
  font: 500 11px/1.3 'IBM Plex Mono', monospace;
  color: var(--cf-amber);
}

.cf3d__container-bad {
  color: var(--cf-red);
}

.cf3d__facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cf3d__fact {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cf3d__fact dt {
  font: 600 12px/16px 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__fact dd {
  margin: 0;
  font: 600 13.5px/1.45 'IBM Plex Mono', monospace;
  color: var(--cf-text);
}

.cf3d__muted {
  color: var(--cf-muted);
  font-weight: 500;
}

.cf3d__actions {
  flex: none;
  padding: 12px 20px 14px;
  border-top: 1px solid var(--cf-border);
  background: #fff;
}

.cf3d__actions-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cf3d__action-help {
  margin: 8px 0 0;
  font: 500 11.5px/1.45 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__swatch {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 3px;
  margin-right: 6px;
  vertical-align: -1px;
}

.cf3d__swatch--tank {
  background: var(--cf-green);
}

.cf3d__swatch--ghost {
  border: 1.5px dashed var(--cf-faint);
  background: transparent;
}

.cf3d__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 860px) {
  .cf3d__body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(220px, 1fr) auto;
  }
  .cf3d__side {
    border-left: none;
    border-top: 1px solid var(--cf-border);
    max-height: 58%;
  }
}

/* Opacity only -- animating transform on a full-size fixed panel with a
   live WebGL canvas inside is needlessly heavy. */
.cf3d-enter-active,
.cf3d-leave-active,
.cf3d-panel-enter-active,
.cf3d-panel-leave-active {
  transition: opacity 0.15s ease;
}
.cf3d-enter-from,
.cf3d-leave-to,
.cf3d-panel-enter-from,
.cf3d-panel-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .cf3d-enter-active,
  .cf3d-leave-active,
  .cf3d-panel-enter-active,
  .cf3d-panel-leave-active {
    transition: none;
  }
}
</style>
