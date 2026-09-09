<script setup>
/**
 * 3D view of one shipping container with the active item's tanks packed
 * inside -- the visual answer to "why is utilization only 30% when all my
 * tanks fit?". Draws EXACTLY the arrangement the backend's
 * `compute_container_layout()` priced from (same orientation, per-axis
 * counts and 180mm gap -- see `preview_container_fit`'s `layout` key), so
 * what's on screen can never disagree with the Units per Container /
 * Container Utilization % figures shown next to the button that opens this.
 *
 * Nothing here recomputes fit: `layout` is taken as given. The only
 * client-side arithmetic is splitting the order Quantity across containers
 * (qty ÷ units_per_container, the same math the Items & Pricing table's
 * "(est.)" column already does) to decide how many of the container's slots
 * are filled in the container currently being looked at.
 *
 * Coordinate mapping: container length along X, height along Y (up), width
 * along Z; 1 scene unit = 1 metre.
 */
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** `preview_container_fit().layout` -- see compute_container_layout(). */
  layout: { type: Object, default: null },
  /** The item's order quantity on the Items & Pricing table. */
  quantity: { type: Number, default: 1 },
  itemLabel: { type: String, default: '' }
})
const emit = defineEmits(['close'])

const MM = 1 / 1000

const COLORS = {
  background: 0xf4f6fa,
  container: 0x0b3465,
  floor: 0x0b3465,
  tank: 0x107830,
  tankEdge: 0x0a4d20,
  ghost: 0x94a0ae
}

const panel = ref(null)
const canvasHost = ref(null)
const containerIndex = ref(0)

const unitsPerContainer = computed(() => Number(props.layout?.units_per_container || 0))
const containersRequired = computed(() =>
  unitsPerContainer.value > 0 ? Math.ceil(Math.max(props.quantity, 1) / unitsPerContainer.value) : 0
)
/** Tanks actually loaded into the container being looked at -- a full
 *  container for every one but the last, which gets the remainder. */
const tanksInThisContainer = computed(() => {
  if (!unitsPerContainer.value) return 0
  const remaining = Math.max(props.quantity, 1) - containerIndex.value * unitsPerContainer.value
  return Math.max(0, Math.min(unitsPerContainer.value, remaining))
})
const freeSlots = computed(() => Math.max(0, unitsPerContainer.value - tanksInThisContainer.value))
const utilization = computed(() => Number(props.layout?.container_utilization_percent || 0))

function mm(value) {
  return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}
function dims(box) {
  if (!box) return '—'
  return `${mm(box.length_mm)} × ${mm(box.width_mm)} × ${mm(box.height_mm)} mm`
}

// ----------------------------------------------------------------- three.js
let renderer = null
let scene = null
let camera = null
let controls = null
let tankGroup = null
let frameId = 0
let resizeObserver = null

function disposeObject(obj) {
  obj.traverse((node) => {
    node.geometry?.dispose?.()
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
    materials.forEach((m) => m.dispose?.())
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
  tankGroup = null
  camera = null
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

function buildScene() {
  const layout = props.layout
  const host = canvasHost.value
  if (!layout || !host) return
  teardown()

  const L = layout.container.length_mm * MM
  const H = layout.container.height_mm * MM
  const W = layout.container.width_mm * MM

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(COLORS.background, 1)
  host.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200)
  const centre = new THREE.Vector3(L / 2, H / 2, W / 2)
  const reach = Math.max(L, W, H) * 1.15
  camera.position.set(centre.x + reach * 0.95, centre.y + reach * 0.75, centre.z + reach * 1.15)
  camera.lookAt(centre)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(centre)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = reach * 0.4
  controls.maxDistance = reach * 4
  controls.maxPolarAngle = Math.PI / 2 - 0.02
  controls.update()

  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c2cc, 1.1))
  const sun = new THREE.DirectionalLight(0xffffff, 1.3)
  sun.position.set(L, H * 2.2, W * 1.4)
  scene.add(sun)

  // Container: barely-there tinted walls seen from inside, crisp navy
  // edges, and a slightly darker floor so stacking layers read as resting
  // on something.
  const containerGeometry = new THREE.BoxGeometry(L, H, W)
  const walls = new THREE.Mesh(
    containerGeometry,
    new THREE.MeshBasicMaterial({ color: COLORS.container, transparent: true, opacity: 0.05, side: THREE.BackSide })
  )
  walls.position.copy(centre)
  scene.add(walls)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(containerGeometry),
    new THREE.LineBasicMaterial({ color: COLORS.container })
  )
  edges.position.copy(centre)
  scene.add(edges)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(L, W),
    new THREE.MeshBasicMaterial({ color: COLORS.floor, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.set(L / 2, 0.001, W / 2)
  scene.add(floor)

  // Door-end marker so length reads left→right the way a loading plan does.
  const doorFrame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, H)),
    new THREE.LineBasicMaterial({ color: COLORS.container, transparent: true, opacity: 0.35 })
  )
  doorFrame.rotation.y = Math.PI / 2
  doorFrame.position.set(L - 0.002, H / 2, W / 2)
  scene.add(doorFrame)

  fitCanvas()
  resizeObserver = new ResizeObserver(fitCanvas)
  resizeObserver.observe(host)

  buildTanks()

  const animate = () => {
    frameId = requestAnimationFrame(animate)
    controls.update()
    renderer.render(scene, camera)
  }
  animate()
}

/** (Re)draws just the tank boxes -- the container stays put -- so paging
 *  between containers or editing Quantity behind the dialog is cheap. */
function buildTanks() {
  const layout = props.layout
  if (!scene || !layout) return
  if (tankGroup) {
    scene.remove(tankGroup)
    disposeObject(tankGroup)
  }
  tankGroup = new THREE.Group()

  const gap = layout.gap_mm * MM
  const tl = layout.tank.length_mm * MM
  const tw = layout.tank.width_mm * MM
  const th = layout.tank.height_mm * MM
  const { along_length: nL, along_width: nW, along_height: nH } = layout.counts

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

  const placed = tanksInThisContainer.value
  const capacity = unitsPerContainer.value
  // Same fill order a loader would use: floor first, front-to-back along
  // the length, then across the width, then the next layer up. Slot
  // indices past `capacity` are geometric positions the payload cap ruled
  // out -- not drawn at all, so "what you see" is what can actually ship.
  let slot = 0
  for (let iz = 0; iz < nH; iz += 1) {
    for (let iy = 0; iy < nW; iy += 1) {
      for (let ix = 0; ix < nL; ix += 1) {
        if (slot >= capacity) break
        const x = gap + ix * (tl + gap) + tl / 2
        const z = gap + iy * (tw + gap) + tw / 2
        const y = gap + iz * (th + gap) + th / 2
        const isLoaded = slot < placed
        const box = new THREE.Mesh(solidGeometry, isLoaded ? solidMaterial : ghostMaterial)
        box.position.set(x, y, z)
        tankGroup.add(box)
        const outline = new THREE.LineSegments(edgeGeometry, isLoaded ? solidEdgeMaterial : ghostEdgeMaterial)
        outline.position.set(x, y, z)
        if (!isLoaded) outline.computeLineDistances()
        tankGroup.add(outline)
        slot += 1
      }
    }
  }
  scene.add(tankGroup)
}

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
  () => [props.open, props.layout],
  async ([open]) => {
    window.removeEventListener('keydown', onWindowKeydown, true)
    if (!open) {
      teardown()
      return
    }
    window.addEventListener('keydown', onWindowKeydown, true)
    containerIndex.value = 0
    await nextTick()
    buildScene()
    requestAnimationFrame(() => panel.value?.focus?.({ preventScroll: true }))
  },
  { immediate: true }
)

watch([containerIndex, () => props.quantity], () => {
  // Quantity may have dropped below the container being viewed.
  if (containerIndex.value > Math.max(containersRequired.value - 1, 0)) {
    containerIndex.value = Math.max(containersRequired.value - 1, 0)
  }
  buildTanks()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
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
        aria-label="Container load in 3D"
        tabindex="-1"
      >
        <header class="cf3d__head">
          <div>
            <div class="cf3d__eyebrow">Container load · 3D</div>
            <div class="cf3d__title">
              {{ itemLabel || 'Tank' }} in {{ layout?.container?.name || 'container' }}
            </div>
          </div>
          <button type="button" class="cf3d__close" title="Close" @click="emit('close')">✕</button>
        </header>

        <div class="cf3d__body">
          <div class="cf3d__stage">
            <div v-if="!layout" class="cf3d__empty">
              Container fit hasn't been calculated yet — pick a Container Type and make sure this item's
              external dimensions are filled in on its costing sheet.
            </div>
            <div v-else-if="!unitsPerContainer" class="cf3d__empty">
              This tank doesn't fit in {{ layout.container.name }} at all — nothing to draw. Try a larger
              Container Type.
            </div>
            <div v-else ref="canvasHost" class="cf3d__canvas" />
            <div v-if="layout && unitsPerContainer" class="cf3d__hint">Drag to rotate · scroll to zoom · right-drag to pan</div>
          </div>

          <aside v-if="layout" class="cf3d__side">
            <div v-if="containersRequired > 1" class="cf3d__pager">
              <button type="button" class="cf3d__pager-btn" :disabled="containerIndex === 0" @click="containerIndex -= 1">←</button>
              <span>Container {{ containerIndex + 1 }} of {{ containersRequired }}</span>
              <button
                type="button"
                class="cf3d__pager-btn"
                :disabled="containerIndex >= containersRequired - 1"
                @click="containerIndex += 1"
              >
                →
              </button>
            </div>

            <div class="cf3d__stat cf3d__stat--hero">
              <span class="cf3d__k">Container utilization</span>
              <span class="cf3d__v">{{ utilization.toFixed(1) }}%</span>
              <div class="cf3d__bar"><div class="cf3d__bar-fill" :style="{ width: `${Math.min(utilization, 100)}%` }" /></div>
              <p class="cf3d__note">
                Tank volume ÷ container volume when the container is full. The empty space is the
                {{ mm(layout.gap_mm) }} mm handling gap on every side of every tank, plus whatever is left over
                once no more whole tanks fit along each axis.
              </p>
            </div>

            <dl class="cf3d__facts">
              <div class="cf3d__fact">
                <dt>Loaded in this container</dt>
                <dd>
                  <span class="cf3d__swatch cf3d__swatch--tank" />{{ tanksInThisContainer }} of {{ unitsPerContainer }}
                  <span v-if="freeSlots" class="cf3d__muted">· <span class="cf3d__swatch cf3d__swatch--ghost" />{{ freeSlots }} free</span>
                </dd>
              </div>
              <div class="cf3d__fact">
                <dt>Arrangement</dt>
                <dd>
                  {{ layout.counts.along_length }} along × {{ layout.counts.along_width }} across ×
                  {{ layout.counts.along_height }} high
                  <span v-if="layout.payload_capped" class="cf3d__warn">
                    · {{ layout.geometric_units }} fit by size, capped to {{ unitsPerContainer }} by
                    {{ mm(layout.container.max_payload_kg) }} kg payload
                  </span>
                </dd>
              </div>
              <div class="cf3d__fact">
                <dt>Container internal</dt>
                <dd>{{ dims(layout.container) }}</dd>
              </div>
              <div class="cf3d__fact">
                <dt>Tank as placed (L × W × H)</dt>
                <dd>{{ dims(layout.tank) }}</dd>
              </div>
              <div class="cf3d__fact">
                <dt>Order quantity</dt>
                <dd>{{ Math.max(quantity, 1) }} tank{{ Math.max(quantity, 1) === 1 ? '' : 's' }} → {{ containersRequired }} container{{ containersRequired === 1 ? '' : 's' }}</dd>
              </div>
            </dl>
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
  width: min(1120px, 94vw);
  height: min(740px, 92vh);
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

.cf3d__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
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
  font: 400 14px/1.6 'Raleway', system-ui, sans-serif;
  color: var(--cf-muted);
}

.cf3d__side {
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px 20px;
  border-left: 1px solid var(--cf-border);
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.cf3d__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font: 600 13px/1 'Raleway', system-ui, sans-serif;
}

.cf3d__pager-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--cf-border);
  border-radius: 8px;
  background: #fff;
  color: var(--cf-navy);
  cursor: pointer;
  font-weight: 700;
}

.cf3d__pager-btn:disabled {
  color: var(--cf-faint);
  cursor: not-allowed;
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
  font: 700 30px/1 'IBM Plex Mono', monospace;
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

.cf3d__warn {
  display: block;
  margin-top: 2px;
  font: 600 12px/1.45 'Raleway', system-ui, sans-serif;
  color: #b45309;
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

@media (max-width: 860px) {
  .cf3d__body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .cf3d__side {
    border-left: none;
    border-top: 1px solid var(--cf-border);
    max-height: 42%;
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
