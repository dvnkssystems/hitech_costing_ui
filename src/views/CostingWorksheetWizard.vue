<script setup>
/**
 * Phone-setup-style wizard for authoring a Quotation from several Costing
 * Worksheets in one sitting.
 *
 * One page, no navigation between products. Three independent "frm groups"
 * live here at once:
 *
 *   - `orderFrm` — a Costing Worksheet frm holding only the fields shared by
 *     every item (customer, opportunity, company, rating, region). Never
 *     saved on its own; its values get copied onto each item.
 *   - `items` — one Costing Worksheet frm PER PRODUCT, each running the same
 *     per-item step sequence (`ITEM_STEPS`) this wizard always had. Switching
 *     the active item tab is a client-side state change, never a navigation.
 *   - `quotationHeaderFrm` — a throwaway Quotation frm (never saved) used only
 *     to stage real, standard Quotation fields (taxes, address, terms) that
 *     get applied to the real Quotation once the first item creates it.
 *
 * All three are booted the same way the single frm used to be — same
 * `useFrmRemote`, same native-script wiring, same post-resolve steps — see
 * `bootFrm()` below. `src/lib/costingWorksheetWizard.js` holds the field
 * lists; `docs/quotation-wizard-flow.md` (hitech_costing app) explains why.
 *
 * Save strategy, per item: unchanged from before — nothing saves before that
 * item's own Commercials step ("Save item"). Nothing SUBMITS until Review &
 * Submit's one "Submit" action, which walks every item in order and maps
 * each onto the same Quotation via the backend's `submit_and_map` (first
 * item creates it, later ones target it) — see `submitAll()`.
 */
import { ref, shallowRef, shallowReactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fieldState, useFrmRemote, confirm } from '@frappe-vue-sdk/vue'
import ChildRowDrawer from '@/components/ChildRowDrawer.vue'
import WizardStep from '@/components/wizard/WizardStep.vue'
import WizardProgress from '@/components/wizard/WizardProgress.vue'
import LucideIcon from '@/components/LucideIcon.vue'
import {
  SHARED_STEP,
  ITEM_STEPS,
  TYPE_FIELDS,
  TAX_FIELDS,
  ADDRESS_FIELDS,
  EXIM_FIELDS,
  TERMS_FIELDS,
  TAX_TABLE_FIELD,
  TERMS_TABLE_FIELD,
  GATED_STEP_INDEXES,
  COMMERCIALS_STEP_INDEX,
  stepIsComplete,
  volumesSplitError,
  pureMarginError,
  MIN_PURE_MARGIN_PERCENT
} from '@/lib/costingWorksheetWizard'
import { call, metaFetcher, hasBackend } from '@/lib/frappe'
import { db } from '@/lib/frappeDb'
import { installFormEnhancements } from '@/lib/formEnhance'
import { installRouting, renderTextEditorsAsHtml, listRouteFor } from '@/lib/frappeRouting'
import { nativeClientScripts, flt } from '@/lib/clientScripts'
import {
  coerceTableFields,
  hideEmptyReadOnlyFields,
  hideNamingSeries,
  restoreOnloadCustomButtons,
  installWorkflowActions
} from '@/lib/frmCompat'
import { installDeskApis, installAmend, takePendingDoc } from '@/lib/mappedDoc'
import { money, decimal, formatDate, timeAgo } from '@/utils/format'

const DOCTYPE = 'Costing Worksheet'
const HEADER_DOCTYPE = 'Quotation'

const PAGE_STEPS = [
  { key: 'customer', title: 'Customer & Order' },
  { key: 'items', title: 'Costing Sheet' },
  { key: 'pricing', title: 'Items & Pricing' },
  { key: 'address', title: 'Address & Delivery' },
  { key: 'exim', title: 'Exim / Incoterms' },
  { key: 'terms', title: 'Terms & Conditions' },
  { key: 'review', title: 'Review & Submit' }
]

const props = defineProps({
  name: { type: String, default: '' },
  // Resume every Costing Worksheet already mapped onto an existing Quotation,
  // rather than a single in-progress worksheet — see `load()`. Set by
  // `QuotationOpenView` for a Draft Quotation opened from the list.
  quotation: { type: String, default: '' }
})

const router = useRouter()

const loading = ref(true)
const error = ref('')
const live = computed(() => hasBackend)

const orderFrm = shallowRef(null)
const quotationHeaderFrm = shallowRef(null)
const items = ref([])
const activeItemKey = ref(null)
const activeItem = computed(() => items.value.find((i) => i.key === activeItemKey.value) ?? null)
const activeItemStep = computed(() => (activeItem.value ? ITEM_STEPS[activeItem.value.activeStepIndex] : null))

const activePageStep = ref('customer')
const activePageIndex = computed(() => PAGE_STEPS.findIndex((s) => s.key === activePageStep.value))
// A quotation resume is multi-item-capable even when only one worksheet is
// linked today (a harmless single tab) — only a bare worksheet resume is
// pinned to exactly one item.
const singleItemMode = computed(() => Boolean(props.name) && !props.quotation)

const quotationName = ref(null)
/** docstatus of `quotationName`'s Quotation — 0 until it's actually
 *  submitted. Drives `activeItemLocked` below; see its doc comment. */
const quotationDocstatus = ref(0)
const submitPhase = ref('idle') // 'idle' | 'running' | 'done' | 'partial-failure'
const submitAllError = ref('')

const SHARED_FIELDNAMES = SHARED_STEP.fields

/** Pure address entry now — `incoterm`/`named_place`/`hitech_port_of_discharge`
 *  moved to `EXIM_FIELDS`/the new `exim` step, so there's no region-based
 *  filtering left to do here. Kept as a computed (rather than inlined) in
 *  case address-side filtering is ever needed again. */
const visibleAddressFields = computed(() => ADDRESS_FIELDS)

/** Used to cross-filter `hitech_vehicle_type`/`hitech_domestic_destination`/
 *  `hitech_sector`/`hitech_basic_freight` off the Costing Worksheet frm's
 *  `region` (`orderFrm`), since `depends_on` can't reach across docs. Now
 *  that `hitech_region` lives directly on the Quotation header frm
 *  (`quotationHeaderFrm`) — the SAME frm as these four fields and everything
 *  else in `EXIM_FIELDS` — their real native `depends_on` on `hitech_region`
 *  is honoured for free by `WizardStep`'s own `isVisible`/`sectionRows`'
 *  `fieldState` check. No client-side filtering left to do here; kept as a
 *  computed (rather than inlined) for the same reason `visibleAddressFields`
 *  above is, in case cross-frm filtering is ever needed again. */
const visibleEximFields = computed(() => EXIM_FIELDS)

/** Only 'customer' is unlocked until it's complete; everything else needs at
 *  least one item to exist. No manual bookkeeping — always derived. */
const unlockedPageIndexes = computed(() => {
  const idx = new Set([0])
  if (orderFrm.value && stepIsComplete(orderFrm.value, SHARED_STEP, fieldState)) {
    idx.add(1)
    if (items.value.length > 0) {
      idx.add(2)
      idx.add(3)
      idx.add(4)
      idx.add(5)
      idx.add(6)
    }
  }
  return idx
})

function selectPageStep(i) {
  if (!unlockedPageIndexes.value.has(i)) return
  activePageStep.value = PAGE_STEPS[i].key
}
function pageBack() {
  if (activePageIndex.value > 0) activePageStep.value = PAGE_STEPS[activePageIndex.value - 1].key
}
function pageNext() {
  const next = activePageIndex.value + 1
  if (next < PAGE_STEPS.length && unlockedPageIndexes.value.has(next)) activePageStep.value = PAGE_STEPS[next].key
}

const heading = computed(() => {
  if (quotationName.value) return quotationName.value
  if (props.name) return props.name
  // No worksheet name yet and nothing mapped to a Quotation yet either — this
  // is the brand-new front door reached from `/quotation/new`, so it should
  // read like the Quotation it's about to become, not the Costing Worksheet
  // record backing it.
  return 'New Quotation'
})

/** The breadcrumb's middle crumb follows the same identity `heading` does:
 *  once an item has been mapped to a Quotation, `heading` shows that
 *  Quotation's name, not the Costing Worksheet's own — the crumb linking
 *  back to "Costing Worksheet" at that point would be pointing at the wrong
 *  list for what's actually on screen. Same reasoning for a brand-new,
 *  unnamed worksheet (`heading` above already reads "New Quotation" there);
 *  only a resumed, already-named worksheet (`props.name`) keeps its own
 *  "Costing Worksheet" identity. */
const crumbDoctype = computed(() => (quotationName.value || !props.name ? 'Quotation' : 'Costing Worksheet'))

const saveState = computed(() => {
  if (submitPhase.value === 'done' || (submitPhase.value === 'idle' && allSucceeded.value)) {
    return `Submitted as ${quotationName.value}`
  }
  if (submitPhase.value === 'partial-failure') return 'Submit failed — see Review & Submit'
  const n = items.value.length
  if (!n) return 'No items yet'
  return `${n} item${n === 1 ? '' : 's'} · not submitted yet`
})

function pick(obj, keys) {
  const out = {}
  for (const k of keys) out[k] = obj?.[k]
  return out
}

/** `address_display`/`shipping_address` are core Frappe read-only fields
 *  whose value is `get_address_display()`'s own HTML — each address line
 *  joined with a literal `<br>` — not this app's doing. Interpolating that
 *  straight into text (`{{ value }}`) shows the raw tags instead of line
 *  breaks. Deliberately not `v-html` here (an editable Address doctype's
 *  content, however unlikely to carry markup, shouldn't be rendered as
 *  HTML) — instead the tags are converted to real newlines and the row's
 *  value span gets `white-space: pre-line` so they render as line breaks
 *  as plain text. Scoped to just these two fieldnames so a field that
 *  legitimately contained the literal text "<br>" wouldn't get mangled. */
const BR_JOINED_FIELDS = new Set(['address_display', 'shipping_address'])

function brJoinedToLines(raw) {
  return String(raw)
    .split(/<br\s*\/?>/gi)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function reviewDisplayValue(df, raw, fieldname) {
  if (!df || raw === undefined || raw === null || raw === '') return '—'
  switch (df.fieldtype) {
    case 'Currency':
      return money(raw)
    case 'Float':
    case 'Percent':
      return decimal(raw)
    case 'Int':
      return Number(raw).toLocaleString()
    case 'Check':
      return raw ? 'Yes' : 'No'
    case 'Date':
      return formatDate(raw)
    default:
      return BR_JOINED_FIELDS.has(fieldname) ? brJoinedToLines(raw) : String(raw)
  }
}

function sectionRows(frm, fields) {
  if (!frm) return []
  return fields
    .map((fieldname) => {
      const df = frm.fields_dict?.[fieldname]?.df
      if (!df) return null
      try {
        if (!fieldState(frm, df).visible) return null
      } catch {
        return null
      }
      return { label: df.label || fieldname, value: reviewDisplayValue(df, frm.doc?.[fieldname], fieldname) }
    })
    .filter(Boolean)
}

const termsReviewRows = computed(() => {
  const selectedTexts = termChecklist.value.filter((t) => t.row?.selected).map((t) => t.text)
  const rows = [{ label: 'Terms selected', value: `${selectedTexts.length} of ${termChecklist.value.length}` }]
  // A checklist reads as a wall of semicolon-joined text once flattened to one
  // string — render it as the same checked-item list the Terms & Conditions
  // step itself uses instead. `list` (not `value`) signals the template to
  // branch into that layout.
  if (selectedTexts.length) rows.push({ label: 'Selected terms', list: selectedTexts })
  return rows.concat(sectionRows(quotationHeaderFrm.value, TERMS_FIELDS))
})

const reviewSections = computed(() => [
  {
    key: 'customer',
    n: '01',
    title: 'Customer & Order',
    // 'Type' isn't a Costing Worksheet field (it lives on the Quotation
    // header, see TYPE_FIELDS) so it can't come from sectionRows(orderFrm,
    // ...) like the rest of this section — added manually instead.
    rows: [
      { label: 'Type', value: quotationHeaderFrm.value?.doc?.custom_type },
      ...sectionRows(orderFrm.value, SHARED_STEP.fields)
    ]
  },
  { key: 'address', n: '02', title: 'Address & Delivery', rows: sectionRows(quotationHeaderFrm.value, visibleAddressFields.value) },
  { key: 'exim', n: '03', title: 'Exim / Incoterms', rows: sectionRows(quotationHeaderFrm.value, visibleEximFields.value) },
  { key: 'terms', n: '04', title: 'Terms & Conditions', rows: termsReviewRows.value }
])

function itemLabel(item, i) {
  return item.frm.doc?.tank_type || `Item ${i + 1}`
}

function df(item, fieldname) {
  return item.frm.fields_dict?.[fieldname]?.df
}

/** The single source of truth for an item's Quotation-line quantity — the
 *  raw `item.quantity` is whatever's currently in the input (which can be an
 *  empty string mid-edit, via `v-model.number`, or a stray 0/negative), so
 *  every place that computes or submits a quantity goes through this instead
 *  of repeating its own fallback. Keeping preview and `submitAll()` on two
 *  different fallbacks (`|| 0` vs `|| 1`) let the Review page show one number
 *  while the backend silently received another. */
function normalizedQuantity(item) {
  const n = Number(item.quantity)
  return Number.isFinite(n) && n > 0 ? n : 1
}

const itemsPricingRows = computed(() =>
  items.value.map((item, i) => {
    const doc = item.frm.doc
    const quantity = normalizedQuantity(item)
    const finalAmount = Number(doc.total_deal_value || 0) * quantity
    // Client-side preview of Containers Required, ahead of the real figure
    // (see costing_worksheet.py's `_calculate_container_fit`) -- that one
    // only fills in once this item is a submitted Quotation Item with a real
    // qty in the database, which happens after this page. This page already
    // has both `units_per_container` (computed on this same Items & Pricing
    // step's own Container / Logistics sub-section, Sea-only) and the
    // quantity being typed in right here, so the same
    // qty ÷ units-per-container ÷ rounded-up math can be shown immediately,
    // no submit needed. `null` means "not applicable" (mode of transport
    // isn't Sea, or no Container Type chosen yet) vs. `0` meaning "doesn't
    // fit this container" -- the template tells those apart.
    //
    // Was gated on `region === 'Export'` -- the backend's own `depends_on`
    // for `container_type`/`units_per_container`/`containers_required`/
    // `container_utilization_percent` switched to `mode_of_transport ==
    // "Sea"`, so this client-side preview follows suit.
    const isSeaWithContainer = doc.mode_of_transport === 'Sea' && Boolean(doc.container_type)
    const unitsPerContainer = Number(doc.units_per_container || 0)
    const containersRequiredPreview = isSeaWithContainer
      ? unitsPerContainer > 0
        ? Math.ceil(quantity / unitsPerContainer)
        : 0
      : null
    return {
      key: item.key,
      item,
      label: itemLabel(item, i),
      weight: reviewDisplayValue(df(item, 'total_weight_kg'), doc.total_weight_kg),
      builtUpCost: reviewDisplayValue(df(item, 'total_fg_cost_inr_kg'), doc.total_fg_cost_inr_kg),
      dealPrice: reviewDisplayValue(df(item, 'deal_price_fg_inr_per_kg'), doc.deal_price_fg_inr_per_kg),
      marginPercent: reviewDisplayValue(df(item, 'pure_margin_percent'), doc.pure_margin_percent),
      totalDealValue: reviewDisplayValue(df(item, 'total_deal_value'), doc.total_deal_value),
      quantity,
      finalAmountRaw: finalAmount,
      finalAmount: money(finalAmount),
      submitState: item.submitState,
      unitsPerContainer,
      containersRequiredPreview
    }
  })
)

/** Whether to render the Containers Required column at all -- only worth a
 *  column when at least one item is actually Export with a Container Type
 *  picked; a fully-Domestic quotation shouldn't show an empty column. */
const showContainersRequiredColumn = computed(() =>
  itemsPricingRows.value.some((row) => row.containersRequiredPreview !== null)
)

/** Quotation-style grand totals for the Items & Pricing step — the same
 *  Total Quantity / Total / Net Total block the real Quotation shows below
 *  its Items table. No item-level discounts exist yet at this point in the
 *  wizard (that's a header-level field filled in on the Taxes & Charges step
 *  and applied to the grand total there), so Total and Net Total match; no
 *  multi-currency support either, so the "(Company Currency)" figures match
 *  their plain counterparts too — same as ERPNext shows when currency ==
 *  company currency. */
const itemsSummary = computed(() => {
  const totalQuantity = itemsPricingRows.value.reduce((sum, row) => sum + row.quantity, 0)
  const total = itemsPricingRows.value.reduce((sum, row) => sum + row.finalAmountRaw, 0)

  // Grand total alongside Total Quantity, same idea: how many containers does
  // the WHOLE order need, not just this one line. Rows with no preview
  // (Domestic, no Container Type) don't count either way. A row that doesn't
  // fit its container (preview === 0) makes the grand total meaningless --
  // flagged via `hasNonFitting` rather than silently under-counting, same
  // spirit as the per-row "Doesn't fit this container" warning.
  const containerRows = itemsPricingRows.value.filter((row) => row.containersRequiredPreview !== null)
  const hasNonFitting = containerRows.some((row) => row.containersRequiredPreview === 0)
  const totalContainersRequired = hasNonFitting
    ? null
    : containerRows.reduce((sum, row) => sum + row.containersRequiredPreview, 0)

  return {
    totalQuantity,
    total: money(total),
    netTotal: money(total),
    totalRaw: total,
    showContainers: containerRows.length > 0,
    totalContainersRequired,
    hasNonFitting
  }
})

/* ── Terms & Conditions step ─────────────────────────────────────────────── */

const termOptions = ref([])
const termsLoading = ref(false)
const termsError = ref('')

async function loadTermOptions() {
  if (termOptions.value.length || termsLoading.value || !live.value) return
  termsLoading.value = true
  termsError.value = ''
  try {
    termOptions.value = await db.get_list('Quotation Term', {
      fields: ['name', 'term_text', 'sequence', 'default_selected'],
      limit_page_length: 0,
      order_by: 'sequence asc'
    })
  } catch (e) {
    termsError.value = e?.message ?? String(e)
  } finally {
    termsLoading.value = false
  }
}

/** Seeds the header frm's `hitech_quotation_terms` table with one row per
 *  known term, defaults pre-ticked — once, per throwaway header frm (`load()`
 *  swaps in a fresh one on every boot, e.g. a `props.name` change), and only
 *  once term options have actually loaded. */
watch(
  [() => quotationHeaderFrm.value, termOptions],
  ([frm, options]) => {
    if (!frm || !options.length) return
    if ((frm.doc[TERMS_TABLE_FIELD] ?? []).length) return
    for (const opt of options) {
      frm.add_child(TERMS_TABLE_FIELD, { term: opt.name, selected: opt.default_selected ? 1 : 0 })
    }
  },
  { immediate: true }
)

const termChecklist = computed(() => {
  const rows = quotationHeaderFrm.value?.doc?.[TERMS_TABLE_FIELD] ?? []
  return termOptions.value.map((opt) => ({
    key: opt.name,
    text: opt.term_text,
    row: rows.find((r) => r.term === opt.name) ?? null
  }))
})
function toggleTerm(entry) {
  if (entry.row) entry.row.selected = entry.row.selected ? 0 : 1
}
const termsSelectedCount = computed(() => termChecklist.value.filter((t) => t.row?.selected).length)

/**
 * Taxes/Address/Terms edits made while attached to an already-existing
 * Quotation (`quotationName` set) need their own save: `submitAll()` only
 * ever applies `quotationHeaderFrm`'s staged fields onto a Quotation it's
 * creating for the FIRST time — see its
 * `...(quotationName.value ? {} : { quotation_header: header })` — so once a
 * Quotation already exists, nothing else ever persists this frm. All three
 * steps edit the same `quotationHeaderFrm`, so one save covers whichever of
 * them are currently dirty.
 */
const headerSaving = ref(false)
const headerSaveError = ref('')
async function saveQuotationHeader() {
  if (!quotationHeaderFrm.value) return
  headerSaving.value = true
  headerSaveError.value = ''
  try {
    await quotationHeaderFrm.value.save()
  } catch (e) {
    headerSaveError.value = e?.message ?? String(e)
  } finally {
    headerSaving.value = false
  }
}

/**
 * Live freight preview for the Exim / Incoterms step — `exim.preview_freight`
 * runs the exact same `calculate_freight()` engine a real save would, against
 * a throwaway in-memory Quotation, and touches nothing server-side. This is
 * what lets the Freight Summary fields (Total Freight Cost, Freight Rate
 * Source, …) update as the estimator types, well before there's any
 * Quotation to save at all — see this step's own "Save Changes" button above,
 * which only exists once `quotationName` is set; a brand-new quotation has
 * nothing to save until the whole wizard is submitted, so without this the
 * Calculated rail would stay blank the entire time.
 *
 * `FREIGHT_PREVIEW_HEADER_FIELDS` mirrors the backend's own `HEADER_FIELDS`
 * in `exim.py` — kept in sync by hand, same as `EXIM_FIELDS` above already
 * says it must be. `customer` is in that backend list too (it biases which
 * Freight Master row wins when several match), but it deliberately isn't
 * read from `quotationHeaderFrm` like the rest: this wizard never puts a
 * `customer` field on the Quotation header frm at all — it's collected once,
 * on `orderFrm` (the Costing Worksheet's own Customer & Order step, see
 * `SHARED_STEP.fields`) — so it's read from there instead.
 */
const FREIGHT_PREVIEW_HEADER_FIELDS = [
  'incoterm',
  'hitech_region',
  'hitech_domestic_destination',
  'hitech_vehicle_type',
  'hitech_port_of_loading',
  'hitech_port_of_discharge',
  'hitech_mode_of_transport',
  'hitech_sector',
  'hitech_basic_freight',
  'hitech_insurance_percent',
  'hitech_insurance_value',
  'hitech_destination_inland_cost',
  'hitech_unloading_cost_at_destination',
  'hitech_import_duty_tax'
]
/** What `preview_freight` hands back — applied onto `quotationHeaderFrm.doc`
 *  via `set_value` (same idiom every other computed value in this file
 *  applies through), so the Exim step's read-only "Calculated" rail
 *  (the second `WizardStep read-only-filter="only"` pass) reflects it right
 *  away, exactly as if a real save had just come back from the server. None
 *  of these overlap `FREIGHT_PREVIEW_HEADER_FIELDS` above, so applying them
 *  can't re-trigger this same preview in a loop. */
const FREIGHT_PREVIEW_RESULT_FIELDS = [
  'hitech_freight_rate_source',
  'hitech_total_freight_cost',
  'hitech_freight_inr_per_kg',
  'hitech_total_gross_weight_kg',
  'hitech_insurance_cost',
  'hitech_fob_cost_applied',
  'hitech_region_margin_applied'
]

const freightPreviewPending = ref(false)
const freightPreviewError = ref('')
/** Bumped on every `runFreightPreview()` call, and checked again once that
 *  call resolves — a slow/older request finishing after a newer one already
 *  applied its own result must never overwrite it with stale data. Simpler
 *  than snapshot-comparing the header (the header can legitimately return to
 *  an earlier value, e.g. the user undoes a change), and needs no extra
 *  state beyond a counter. */
let freightPreviewToken = 0
let freightPreviewDebounce = null

/** Rebuilt fresh at call time (not captured from whatever triggered the
 *  watcher) so a debounced call always fires against the LATEST state, not a
 *  half-second-stale snapshot from the moment typing paused. */
function buildFreightPreviewHeader() {
  const header = pick(quotationHeaderFrm.value?.doc, FREIGHT_PREVIEW_HEADER_FIELDS)
  header.customer = orderFrm.value?.doc?.customer ?? null
  return header
}
/** `costing_worksheet` names that don't resolve to a real saved record yet
 *  (every not-yet-saved item) are tolerated gracefully by the backend — see
 *  `preview_freight`'s own doc comment — so there's no need to filter down to
 *  only-saved items here. Quantity comes from `itemsPricingRows`, the exact
 *  same client-side source the Items & Pricing step's own "Containers
 *  Required (est.)" preview already reads (`normalizedQuantity(item)` under
 *  the hood) — not `item.quantity` directly, which can be blank/0/negative
 *  mid-edit (see `normalizedQuantity`'s own doc comment). */
function buildFreightPreviewItems() {
  return itemsPricingRows.value.map((row) => ({ costing_worksheet: row.item.frm.doc?.name, qty: row.quantity }))
}

async function runFreightPreview() {
  if (!quotationHeaderFrm.value) return
  const token = ++freightPreviewToken
  freightPreviewPending.value = true
  try {
    const result = await call('hitech_costing.hitech_costing.exim.preview_freight', {
      header: buildFreightPreviewHeader(),
      items: buildFreightPreviewItems()
    })
    // A newer preview may have started (or even already applied) while this
    // one was in flight — never let an older response clobber newer input.
    if (token !== freightPreviewToken) return
    const frm = quotationHeaderFrm.value
    if (!frm || !result) return
    for (const fieldname of FREIGHT_PREVIEW_RESULT_FIELDS) {
      if (fieldname in result) await frm.set_value(fieldname, result[fieldname])
    }
    freightPreviewError.value = ''
  } catch (e) {
    // This fires automatically as a side effect of typing — never surface a
    // hard error to the user, just a quiet inline note (see the Exim step's
    // template). The Calculated rail simply keeps showing whatever it last
    // had.
    if (token === freightPreviewToken) freightPreviewError.value = e?.message ?? String(e)
  } finally {
    if (token === freightPreviewToken) freightPreviewPending.value = false
  }
}

/** 400ms of quiet before firing — the same debounce window (and reasoning)
 *  `scheduleDraftSave()` above uses. */
function scheduleFreightPreview() {
  clearTimeout(freightPreviewDebounce)
  freightPreviewDebounce = setTimeout(runFreightPreview, 400)
}

// Deliberately NOT gated on `activePageStep === 'exim'` or `quotationName` —
// item quantities are edited on the Items & Pricing step, and this needs to
// have already run by the time the estimator reaches Exim either way (a
// brand-new quotation has no "Save Changes" button at all to fall back on,
// see this function group's own doc comment above).
//
// One getter PER FIELD, passed to `watch()` as an array of sources, rather
// than a single getter that builds one combined object via `pick()` (the
// original approach here). Both read the same underlying reactive
// `quotationHeaderFrm.value.doc` properties, but a multi-source array watch
// is the same idiom `watchAddressDisplay()`/the Terms-checklist watcher above
// already use successfully on this exact frm — each source is its own tiny
// tracked getter, so there's no reliance on a `deep: true` traversal of a
// freshly-allocated plain object (`pick()`'s `out = {}`) to rediscover
// dependencies on every run. Keeps the failure mode this function group was
// built to avoid (a silently-dead trigger) as unlikely as possible.
watch(
  FREIGHT_PREVIEW_HEADER_FIELDS.map((fieldname) => () => quotationHeaderFrm.value?.doc?.[fieldname]),
  () => {
    if (quotationHeaderFrm.value) scheduleFreightPreview()
  }
)
watch(() => orderFrm.value?.doc?.customer, scheduleFreightPreview)
watch(() => buildFreightPreviewItems(), scheduleFreightPreview, { deep: true })

/** Pure Margin (INR/kg) and Pure Margin % moved out of the Commercials step's
 *  Calculated rail and into its main card instead (on request) — they sit
 *  right next to Deal Price - FG now, since that's the one input that
 *  actually moves them, rather than one figure among several in a side
 *  panel. `derivedFieldnames` below excludes them from the rail so they
 *  don't also render there; `commercialsMarginRows` (near
 *  `activeItemDerivedRows`) renders them in the main card in the same
 *  formatted-row style the rail uses. */
const COMMERCIALS_MAIN_CARD_FIELDS = new Set(['pure_margin_inr_kg', 'pure_margin_percent'])

/** Whether any field in `step` is read-only for `frm` — i.e. worth its own
 *  calculated-values rail. */
function derivedFieldnames(step, frm) {
  if (!frm) return []
  return step.fields.filter(
    (fieldname) =>
      frm.fields_dict?.[fieldname]?.df?.read_only &&
      !(step.key === 'commercials' && COMMERCIALS_MAIN_CARD_FIELDS.has(fieldname))
  )
}
function hasDerivedFields(step, frm) {
  return derivedFieldnames(step, frm).length > 0
}
const activeItemHasDerived = computed(
  () =>
    activeItem.value &&
    activeItemStep.value &&
    activeItemStep.value.key !== 'product' && // Facility/Effective Labour Rate rail hidden here, per request
    hasDerivedFields(activeItemStep.value, activeItem.value.frm)
)

/**
 * A Costing Worksheet's own `status` (Draft/Submitted/Quoted/Lost) no longer
 * locks editing on its own — see `_guard_against_edit_after_submit()` in
 * `costing_worksheet.py` and `docs/decisions.md`, "Costing Worksheet editable
 * until its Quotation is submitted": a worksheet already marked Quoted stays
 * editable for as long as its Quotation is still Draft. The real lock
 * boundary is that Quotation's own docstatus — mirrored here via
 * `quotationDocstatus` (set in `load()`) rather than re-deriving it from the
 * worksheet's `status` field, which would drift out of sync with the actual
 * server-side guard.
 */
const activeItemLocked = computed(() => Boolean(quotationName.value) && quotationDocstatus.value === 1)
/**
 * The "Calculated" rail's rows — formatted like `sectionRows` (₹ currency,
 * 2dp) rather than `WizardStep`'s SDK controls, which bind the raw doc value
 * straight to a number input with no rounding (a step with several chained
 * float divisions, e.g. Commercials' totals, would otherwise show something
 * like "233.91004000000004" instead of "₹233.91").
 *
 * Used to skip `sectionRows`'s `fieldState(...).visible` check outright: every
 * field `derivedFieldnames` selected was `read_only` with no `depends_on`
 * anywhere in the DocType. That's no longer true now that the container-
 * load-fit fields (`units_per_container`, `containers_required`,
 * `container_utilization_percent`) carry an Export-only `depends_on`, same
 * as the freight fields conceptually should — so this now checks visibility
 * the same safe way `sectionRows` does (catch-and-hide on any SDK hiccup,
 * rather than let a throw crash the rail).
 */
function derivedRows(frm, fieldnames) {
  if (!frm) return []
  return fieldnames
    .map((fieldname) => {
      const df = frm.fields_dict?.[fieldname]?.df
      if (!df) return null
      try {
        if (!fieldState(frm, df).visible) return null
      } catch {
        return null
      }
      let low = false
      let warning = ''
      if (fieldname === 'pure_margin_percent' && Number(frm.doc?.[fieldname] ?? 0) < MIN_PURE_MARGIN_PERCENT) {
        low = true
        warning = `Below the ${MIN_PURE_MARGIN_PERCENT}% minimum`
      } else if (
        // A Container Type is picked but nothing fits (0 either way it's
        // oriented, see costing_worksheet.py's _calculate_container_fit) --
        // flag it the same way a below-minimum margin is flagged, so 0 reads
        // as "doesn't fit" rather than "not calculated yet".
        fieldname === 'units_per_container' &&
        frm.doc?.container_type &&
        !Number(frm.doc?.[fieldname] ?? 0)
      ) {
        low = true
        warning = "Doesn't fit this container"
      }
      return { label: df.label || fieldname, value: reviewDisplayValue(df, frm.doc?.[fieldname]), low, warning }
    })
    .filter(Boolean)
}
const activeItemDerivedRows = computed(() =>
  activeItem.value && activeItemStep.value
    ? derivedRows(activeItem.value.frm, derivedFieldnames(activeItemStep.value, activeItem.value.frm))
    : []
)

/** Pure Margin (INR/kg) / Pure Margin % rows for the Commercials main card —
 *  see `COMMERCIALS_MAIN_CARD_FIELDS`'s doc comment above. */
const commercialsMarginRows = computed(() =>
  activeItem.value && activeItemStep.value?.key === 'commercials'
    ? derivedRows(activeItem.value.frm, [...COMMERCIALS_MAIN_CARD_FIELDS])
    : []
)

/**
 * Mode of Transport / Container Type and their calculated container-load-fit
 * fields, relocated off the per-item Dimensions step onto this page-level
 * Items & Pricing step's own "Container / Logistics" sub-section (rendered
 * per active item, one at a time, below the items table — see the
 * `activePageStep === 'pricing'` template branch). Split the same
 * editable/calculated way every ITEM_STEPS step is: `CONTAINER_LOGISTICS_FIELDS`
 * feeds a `WizardStep` `exclude` pass, `CONTAINER_LOGISTICS_CALCULATED_FIELDS`
 * an `only` pass rendered through `derivedRows` below (same helper the
 * Calculated rail elsewhere in this file uses, so the "Doesn't fit this
 * container" warning still fires here).
 */
const CONTAINER_LOGISTICS_FIELDS = ['mode_of_transport', 'container_type']
const CONTAINER_LOGISTICS_CALCULATED_FIELDS = [
  'units_per_container',
  'containers_required',
  'container_utilization_percent'
]
const containerLogisticsRows = computed(() =>
  activeItem.value ? derivedRows(activeItem.value.frm, CONTAINER_LOGISTICS_CALCULATED_FIELDS) : []
)

/**
 * Live container-fit preview for the Container / Logistics sub-section above
 * -- `costing_worksheet.preview_container_fit` runs the exact same
 * `compute_container_fit()` a real save's `_calculate_container_fit()` would,
 * against whatever the active item's frm currently holds, and touches no
 * document at all. Without this, `units_per_container` /
 * `container_utilization_percent` only ever reflect whatever was true the
 * last time this item's Costing Worksheet was actually saved -- picking a
 * new Container Type or nudging a dimension here would otherwise show
 * nothing new until some unrelated save happened to run, same problem
 * `runFreightPreview()` above solves for the Exim step's freight fields (see
 * that function group's own doc comment, which this one otherwise mirrors
 * closely, adapted for a PER-ITEM frm rather than one shared header frm).
 *
 * `containers_required` deliberately isn't part of this -- it needs a real
 * order qty off a Quotation Item linked to a saved Costing Worksheet, which
 * a not-yet-submitted item doesn't have (see `preview_container_fit`'s own
 * doc comment); it keeps updating only on an actual save, same as today.
 */
const CONTAINER_FIT_PREVIEW_FIELDS = [
  'mode_of_transport',
  'container_type',
  'ext_length_mm',
  'ext_width_mm',
  'ext_height_mm',
  'total_weight_kg'
]
/** What `preview_container_fit` hands back -- applied onto the active item's
 *  frm via `set_value`, same idiom `runFreightPreview()` uses. Neither
 *  overlaps `CONTAINER_FIT_PREVIEW_FIELDS` above, so applying them can't
 *  re-trigger this same preview in a loop. */
const CONTAINER_FIT_PREVIEW_RESULT_FIELDS = ['units_per_container', 'container_utilization_percent']

const containerFitPreviewPending = ref(false)
const containerFitPreviewError = ref('')
/** Bumped on every `runContainerFitPreview()` call, AND whenever the active
 *  item itself changes (see the `activeItemKey` watcher below) -- a slow
 *  response for whatever item was active when the call started must never
 *  be applied once a different item is active, exactly the same failure
 *  mode `freightPreviewToken` guards against for the (single, shared)
 *  header frm, just also triggered by an item switch here since there are
 *  several independent per-item frms in play instead of one. */
let containerFitPreviewToken = 0
let containerFitPreviewDebounce = null

async function runContainerFitPreview() {
  const frm = activeItem.value?.frm
  if (!frm) return
  const token = ++containerFitPreviewToken
  containerFitPreviewPending.value = true
  try {
    // Read fresh off the frm at call time (not a stale snapshot from
    // whatever triggered the watcher), same reasoning as
    // `buildFreightPreviewHeader()`'s own doc comment.
    const doc = frm.doc
    // `call()` JSON-serializes this object, which silently DROPS any key
    // whose value is `undefined` (unlike `null`, which still round-trips) --
    // and every one of `preview_container_fit`'s five params is a required
    // positional argument with no default, so an omitted key throws a
    // TypeError server-side instead of degrading gracefully. `?? null`
    // guarantees every key is always present, even before this item's
    // Dimensions/Volumes & Weights steps have set anything -- the backend
    // already treats a missing/falsy value as "doesn't fit yet" (see
    // `compute_container_fit`'s own doc comment), which is exactly the
    // graceful no-op this preview should degrade to in that case.
    const result = await call(
      'hitech_costing.hitech_costing.doctype.costing_worksheet.costing_worksheet.preview_container_fit',
      {
        container_type: doc?.container_type ?? null,
        ext_length_mm: doc?.ext_length_mm ?? null,
        ext_width_mm: doc?.ext_width_mm ?? null,
        ext_height_mm: doc?.ext_height_mm ?? null,
        total_weight_kg: doc?.total_weight_kg ?? null
      }
    )
    // A newer preview may have started -- or the active item itself may
    // have changed -- while this one was in flight; either way, never let
    // a stale response land on whichever item is active now.
    if (token !== containerFitPreviewToken || activeItem.value?.frm !== frm) return
    if (!result) return
    for (const fieldname of CONTAINER_FIT_PREVIEW_RESULT_FIELDS) {
      if (fieldname in result) await frm.set_value(fieldname, result[fieldname])
    }
    // units_per_container may have just changed -- keep containers_required
    // in step with it (see syncContainersRequiredPreview's own doc comment).
    syncContainersRequiredPreview()
    containerFitPreviewError.value = ''
  } catch (e) {
    // Fires automatically as a side effect of picking a Container Type /
    // editing dimensions -- never surface a hard error, just a quiet inline
    // note (see this section's own template). The Container / Logistics
    // rows simply keep showing whatever they last had.
    if (token === containerFitPreviewToken) containerFitPreviewError.value = e?.message ?? String(e)
  } finally {
    if (token === containerFitPreviewToken) containerFitPreviewPending.value = false
  }
}

/** Same 400ms debounce window `scheduleFreightPreview()` uses. */
function scheduleContainerFitPreview() {
  clearTimeout(containerFitPreviewDebounce)
  containerFitPreviewDebounce = setTimeout(runContainerFitPreview, 400)
}

/** Keeps the REAL `containers_required` field (shown read-only in the
 *  Container / Logistics section above) live too, instead of only updating
 *  on an actual save -- the backend's own version needs a real Quotation
 *  Item's saved qty (see `_calculate_container_fit`'s doc comment), which a
 *  not-yet-submitted item doesn't have, but this page already has everything
 *  needed to preview the SAME number purely client-side: the live
 *  `units_per_container` (from `runContainerFitPreview` above) and the
 *  Quantity being typed into the Items & Pricing table right now -- the
 *  exact same math `itemsPricingRows`' "(est.)" column already does. No
 *  network round trip needed, so this runs directly off both watchers below
 *  rather than through the debounced preview call. */
function syncContainersRequiredPreview() {
  const item = activeItem.value
  if (!item) return
  const doc = item.frm.doc
  if (!(doc?.mode_of_transport === 'Sea' && doc?.container_type)) return
  const unitsPerContainer = Number(doc.units_per_container || 0)
  const value = unitsPerContainer > 0 ? Math.ceil(normalizedQuantity(item) / unitsPerContainer) : 0
  if (Number(doc.containers_required || 0) !== value) item.frm.set_value('containers_required', value)
}

// One getter PER FIELD off the active item's frm, exactly the idiom
// `runFreightPreview()`'s own watcher uses (and its doc comment explains why
// this beats a single `pick()`-built object under `deep: true`) -- except
// here every getter reads through `activeItem.value` first, so the SAME
// watcher naturally re-evaluates against whichever item is currently active
// without needing a second watcher keyed off `activeItemKey` to rebuild it.
watch(
  CONTAINER_FIT_PREVIEW_FIELDS.map((fieldname) => () => activeItem.value?.frm?.doc?.[fieldname]),
  () => {
    if (activeItem.value?.frm) scheduleContainerFitPreview()
  }
)
// Quantity itself doesn't change `units_per_container`, so it skips the
// debounced network round trip above entirely -- straight to
// `syncContainersRequiredPreview()`, same as typing into the Items & Pricing
// table's own Quantity column already does for its "(est.)" column.
watch(
  () => activeItem.value?.quantity,
  () => syncContainersRequiredPreview()
)
// Switching the active item (via this section's own item tabs) must
// invalidate any in-flight/pending preview for whichever item was active
// before -- `runContainerFitPreview()`'s own token check above handles a
// response arriving late, but a still-*pending* debounce timer or a
// "Calculating…"/error message left over from the previous item needs
// clearing here too, so this section never shows item A's status while item
// B's fields are on screen.
watch(activeItemKey, () => {
  containerFitPreviewToken += 1
  clearTimeout(containerFitPreviewDebounce)
  containerFitPreviewPending.value = false
  containerFitPreviewError.value = ''
  // The newly active item's own containers_required may be stale (0, or
  // some other item's last-synced number) until its next edit -- refresh it
  // immediately off whatever units_per_container/quantity it already has.
  syncContainersRequiredPreview()
})

const wizardEl = ref(null)
let teardownEnhancements = null
const currentFrm = computed(() => {
  if (activePageStep.value === 'customer') return orderFrm.value
  if (activePageStep.value === 'items') return activeItem.value?.frm ?? null
  if (['address', 'exim', 'terms'].includes(activePageStep.value)) return quotationHeaderFrm.value
  return null
})
watch(wizardEl, (el) => {
  teardownEnhancements?.()
  teardownEnhancements = el ? installFormEnhancements(el, () => currentFrm.value) : null
})
onBeforeUnmount(() => {
  teardownEnhancements?.()
  // Skips the debounce -- navigating away is exactly the moment a pending
  // write would otherwise be lost.
  flushDraftSave()
})

/** Filters `customer_address`/`shipping_address_name` on the throwaway
 *  Quotation frm to the wizard's own customer — same `frm.set_query` idiom
 *  the real Costing Worksheet client script already uses for `tank_type`.
 *
 *  `link_doctype`/`link_name` aren't fields on Address itself — they live on
 *  its child `Dynamic Link` table, so filtering them needs the child-table
 *  array form (`[["Dynamic Link", "link_doctype", "=", ...], ...]`), not a
 *  flat `{field: value}` dict (which `frappe.desk.search.search_link` reads
 *  as direct Address fields and rejects with a permission/invalid-field
 *  error). That error was thrown on every search regardless of whether a
 *  customer was set — confirmed directly against the backend. `useLinkSearch`
 *  (the SDK's Link control) treats any search error as "never break the
 *  control": it drops the results and silently closes the dropdown rather
 *  than surfacing the error, so the dropdown never visibly opened at all.
 *
 *  Also skips the filter entirely (every Address, unscoped) before a
 *  customer is picked, rather than filtering to a blank `link_name`. */
function addressQueryScript(frappe) {
  frappe.ui.form.on(HEADER_DOCTYPE, {
    setup(frm) {
      const filters = () => {
        const customer = orderFrm.value?.doc?.customer
        return customer
          ? { filters: [['Dynamic Link', 'link_doctype', '=', 'Customer'], ['Dynamic Link', 'link_name', '=', customer]] }
          : {}
      }
      frm.set_query('customer_address', filters)
      frm.set_query('shipping_address_name', filters)
    }
  })
}

/** Auto-fills the Address & Delivery step's two address fields from the
 *  customer's own default addresses — mirrors what picking a Customer does
 *  on the real Quotation form (`erpnext.utils.get_party_details`). That real
 *  endpoint also wants a Company/Posting Date this throwaway header frm
 *  doesn't carry, so this queries `Address` directly for the same "default
 *  billing / default shipping" flags instead of reusing it.
 *
 *  Only fills a field that's still empty — a resumed Quotation that already
 *  has its own (possibly non-default) address saved is left alone; this is
 *  purely for a brand-new wizard run where the fields start blank. */
watch(
  () => orderFrm.value?.doc?.customer,
  async (customer) => {
    const frm = quotationHeaderFrm.value
    if (!customer || !frm) return
    if (frm.doc.customer_address && frm.doc.shipping_address_name) return
    try {
      const addresses = await db.get_list('Address', {
        filters: [
          ['Dynamic Link', 'link_doctype', '=', 'Customer'],
          ['Dynamic Link', 'link_name', '=', customer]
        ],
        fields: ['name', 'is_primary_address', 'is_shipping_address'],
        limit_page_length: 0
      })
      const billing = addresses.find((a) => a.is_primary_address) ?? addresses[0]
      const shipping = addresses.find((a) => a.is_shipping_address) ?? billing
      if (billing && !frm.doc.customer_address) await frm.set_value('customer_address', billing.name)
      if (shipping && !frm.doc.shipping_address_name) await frm.set_value('shipping_address_name', shipping.name)
    } catch {
      // Best-effort default — the step still lets the user pick manually.
    }
  }
)

/** Keeps `address_display`/`shipping_address` (the real Quotation's own
 *  read-only formatted-address text fields, shown right under the Link
 *  picker on the real desk form's Address & Contact tab) in sync with
 *  whichever address is picked — same helper core Frappe forms use
 *  (`frappe.utils.get_address_display` in address_and_contact.js), just
 *  called directly since this throwaway frm has no such built-in trigger. */
function watchAddressDisplay(linkField, displayField) {
  watch(
    () => quotationHeaderFrm.value?.doc?.[linkField],
    async (addressName) => {
      const frm = quotationHeaderFrm.value
      if (!frm) return
      if (!addressName) return void frm.set_value(displayField, '')
      try {
        const display = await call('frappe.contacts.doctype.address.address.get_address_display', {
          address_dict: addressName
        })
        await frm.set_value(displayField, display ?? '')
      } catch {
        // Leave the display field as-is — the Link value itself is still correct.
      }
    }
  )
}
watchAddressDisplay('customer_address', 'address_display')
watchAddressDisplay('shipping_address_name', 'shipping_address')

/** Deliberately omits `lockOnSubmit`: a Costing Worksheet's own docstatus
 *  does NOT lock its fields here — see `activeItemLocked` above for why
 *  (the real boundary is the Quotation's docstatus). Applying the generic
 *  desk rule ("submitted doc's fields go read_only") would stamp
 *  `df.read_only` onto every field the moment `submit_and_map` submits an
 *  item, and `WizardStep`'s `exclude` filter then drops every one of them
 *  from step 1 and every per-item step — a blank card, not a locked one. */
function itemScripts(doctype) {
  return [
    nativeClientScripts(doctype),
    renderTextEditorsAsHtml(doctype),
    hideEmptyReadOnlyFields(doctype),
    hideNamingSeries(doctype),
    installWorkflowActions(doctype, { stateField: 'status' })
  ]
}

/** Every frm booted here — orderFrm, quotationHeaderFrm, every item — goes
 *  through this same sequence, matching what the single-frm wizard always did. */
async function bootFrm(doctype, { name = null, initialDoc = null, scripts = [] } = {}) {
  const result = await useFrmRemote({
    transport: call,
    metaFetcher,
    doctype,
    name,
    // A hand-built initialDoc has no `docstatus` of its own -- unlike a doc
    // loaded from the server, or one `frappe.model.get_new_doc()` would build
    // in real Desk, it stays `undefined` rather than the real Frappe model's
    // `0` for an unsaved draft. Every `docstatus === 0` guard anywhere in any
    // client script (this app's own `costing_worksheet.js` RECALC_FIELDS
    // handlers included — `recalculate()`'s very first line) then silently
    // no-ops forever, since `undefined !== 0`: no error, no network call,
    // nothing — exactly the bug behind Effective Labour Rate staying blank.
    // Default it here, once, rather than in every initialDoc literal.
    initialDoc: initialDoc ? { docstatus: 0, ...initialDoc } : initialDoc,
    autoBoot: true,
    scripts
  })
  installRouting(router, result.frappe)
  installDeskApis(result.frappe, router)
  await restoreOnloadCustomButtons(result.frm)
  installAmend(result.frm, router)
  return coerceTableFields(result.frm)
}

function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Steps navigable right away. A brand-new item starts locked to step 0, same
 * as always — but an EXISTING worksheet (resumed from a Quotation, or opened
 * by name) already has data sitting in every step it previously got through,
 * regardless of its current `status`. Walk the steps in order, unlocking
 * each as long as the one before it is complete, so reopening an
 * already-Quoted item lands with every filled-in step (Dimensions, Volumes,
 * Paint System, Complexity, Commercials…) directly clickable instead of
 * relocked to just Product Line.
 */
function initialUnlockedSteps(frm) {
  const unlocked = new Set([0])
  if (frm.is_new()) return unlocked
  for (let i = 0; i < ITEM_STEPS.length; i++) {
    unlocked.add(i)
    if (!stepIsComplete(frm, ITEM_STEPS[i], fieldState)) break
  }
  return unlocked
}

function makeItem(frm, key) {
  return shallowReactive({
    key,
    frm,
    activeStepIndex: 0,
    unlockedSteps: initialUnlockedSteps(frm),
    stepError: '',
    saving: false,
    submitState: frm.docstatus === 1 ? 'succeeded' : 'pending',
    submitError: '',
    // Wizard-only overrides for this item's Quotation line — not Costing
    // Worksheet fields, just carried through to `submit_and_map`. Quantity
    // lets one costed design price multiple units of the same job; Description
    // overrides the backend's auto-generated line text when set.
    quantity: 1,
    description: ''
  })
}

/** Add another product line — a fresh Costing Worksheet frm, seeded with
 *  whatever Customer & Order already has. `seedDoc` (Tank Type from the
 *  `/quotation/new` picker) only ever applies to the very first item.
 *
 * `initialDoc.name` is stamped with a unique placeholder rather than left to
 * default to "New Costing Worksheet": several unsaved Costing Worksheet frms
 * are alive at once here (orderFrm plus every item), and the installed SDK's
 * `set_value`/`get_doc` key a doc by (doctype, name) — two simultaneously-open
 * docs sharing that default name silently orphan one frm's `.doc` reference
 * the moment the second one boots, so edits on the first stop landing
 * anywhere `save()`/`submit_and_map()` would see. A throwaway placeholder
 * name is never sent anywhere meaningful: the real backend autoname always
 * replaces it on `save()`. */
async function addItem(seedDoc) {
  const key = uid()
  const shared = orderFrm.value ? pick(orderFrm.value.doc, SHARED_FIELDNAMES) : {}
  const initialDoc = { doctype: DOCTYPE, name: `New Costing Worksheet (${key})`, ...shared }
  const frm = await bootFrm(DOCTYPE, { initialDoc, scripts: itemScripts(DOCTYPE) })
  // `seedDoc` goes through `set_value`, not the `initialDoc` merge above:
  // `boot-frm.ts` builds a new doc as a plain object merge
  // (`{ ...defaults, ...initialDoc }`), which lands the raw value on
  // `frm.doc` but never runs the field's own change trigger — exactly the
  // "silently no-ops forever" trap `bootFrm()`'s own comment on `docstatus`
  // describes. Tank Type's trigger is what derives Facility/Labour Rate for
  // this step, so seeding it that way leaves those blank until the estimator
  // re-touches the field by hand. `applyMappedDoc` in mappedDoc.js hits the
  // same trap and already solves it the same way.
  for (const [fieldname, value] of Object.entries(seedDoc ?? {})) {
    if (fieldname === 'doctype' || fieldname === 'name') continue
    await frm.set_value(fieldname, value)
  }
  const item = makeItem(frm, key)
  items.value = [...items.value, item]
  activeItemKey.value = item.key
  return item
}

/** Never-saved item: drop client-side. Saved-but-unsubmitted: confirm, then a
 *  real server-side delete (otherwise it leaks an orphan Draft). Submitted:
 *  never offered — the Remove control is hidden for those in the template. */
function removeItem(key) {
  const item = items.value.find((i) => i.key === key)
  if (!item || item.frm.docstatus === 1) return

  const drop = () => {
    const wasActive = activeItemKey.value === key
    items.value = items.value.filter((i) => i.key !== key)
    if (wasActive) activeItemKey.value = items.value.at(-1)?.key ?? null
  }

  if (item.frm.is_new()) {
    drop()
    return
  }
  confirm(`Delete this draft costing sheet (${item.frm.doc.name})? This cannot be undone.`, async () => {
    try {
      await item.frm.frappe.call('frappe.client.delete', { doctype: DOCTYPE, name: item.frm.doc.name })
      drop()
    } catch (e) {
      error.value = e?.message ?? String(e)
    }
  })
}

/**
 * Local autosave/restore for a brand-new "New Quotation" session only (no
 * `props.name`/`props.quotation` -- see `load()`'s innermost `else` branch).
 * Nothing here saves before that item's own Commercials step, and the header
 * frm never saves at all before `submitAll()` succeeds -- see this file's own
 * top-of-file doc comment -- so navigating away mid-way (e.g. to the sidebar)
 * lost every field typed so far. This mirrors the fields that flow into
 * `submitAll()`'s own `header` object plus `SHARED_STEP`, into
 * `localStorage`, and offers to restore them the next time `/quotation/new`
 * boots with the exact same (still-unsaved) shape found.
 *
 * A single fixed key, not one per draft: the app only ever has one
 * "in-progress, not-yet-saved-anywhere" New Quotation session open at a time
 * (there's no way to have two `/quotation/new` tabs mid-flow both wanting to
 * be resumed independently -- and if there were, the second would just
 * overwrite the first's autosave, same as it would overwrite the first's own
 * unsaved browser state today).
 */
const DRAFT_STORAGE_KEY = 'hitech-costing:quotation-draft'
const DRAFT_HEADER_FIELDS = [
  ...TYPE_FIELDS,
  ...TAX_FIELDS,
  ...ADDRESS_FIELDS,
  ...EXIM_FIELDS,
  ...TERMS_FIELDS,
  TAX_TABLE_FIELD,
  TERMS_TABLE_FIELD
]
// Table fields (`volumes`, `complexity_ratings`) are deliberately excluded --
// restoring a Table field means rebuilding its rows one at a time via
// `add_child` (see the Terms checklist watcher above), and an item that's
// still on an early step this early in its life rarely has rows worth that
// extra risk. Everything else on the per-item steps is a plain scalar,
// same as `SHARED_FIELDNAMES` below.
const DRAFT_ITEM_FIELDS = [...new Set(ITEM_STEPS.flatMap((step) => step.fields))]

/** Which draft (if any) the current session autosaves/restores:
 *   - 'new' — the brand-new `/quotation/new` path, unchanged from before.
 *   - 'resume' — reopening a single existing, not-yet-submitted worksheet by
 *     name (see `load()`'s `singleItemMode` branch). Originally skipped on
 *     the theory that a resumed worksheet's fields are already backed by a
 *     real record, so "there's nothing at risk" -- true for whatever was
 *     last *saved*, but not for edits made *after* reopening it and before
 *     the next "Save item": those live only in this tab's `frm.doc`, same as
 *     a brand-new item's fields, and vanish just as silently on an
 *     accidental navigate-away or refresh. Keyed per-worksheet (see
 *     `currentDraftKey()`) rather than sharing 'new' mode's single fixed
 *     key, since unlike "one new quotation in flight", several different
 *     existing worksheets can each have their own stale unsaved edits
 *     waiting across different visits. */
const draftMode = ref(null) // null | 'new' | 'resume'

function readDraft(key) {
  if (!key) return null
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function writeDraft(key, snapshot) {
  if (!key) return
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(snapshot))
  } catch {
    // Private mode or storage disabled -- the wizard still works for this
    // session, it just won't survive a navigate-away-and-back.
  }
}
function clearDraft(key) {
  if (!key) return
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // ditto
  }
}
/** The storage key for whichever draft `draftMode` currently points at, or
 *  `null` when neither applies (nothing to autosave/restore). 'resume' is
 *  keyed by the worksheet's own name so reopening a DIFFERENT worksheet
 *  later never offers to restore the wrong one's leftover draft. */
function currentDraftKey() {
  if (draftMode.value === 'new') return DRAFT_STORAGE_KEY
  if (draftMode.value === 'resume' && props.name) return `${DRAFT_STORAGE_KEY}:worksheet:${props.name}`
  return null
}

/** One-shot signal set by `QuotationNewView.vue`'s "Resume" button on the
 *  draft banner there — when present, the user already explicitly chose to
 *  restore, so skip asking again via `confirmAsync()` below. Read-once (the
 *  flag is removed as soon as it's checked) so a later brand-new session
 *  reached some other way still gets the normal prompt. */
const DRAFT_RESUME_FLAG = 'hitech-costing:quotation-draft-resume'
function takeDraftResumeFlag() {
  try {
    const flagged = globalThis.sessionStorage?.getItem(DRAFT_RESUME_FLAG) === '1'
    globalThis.sessionStorage?.removeItem(DRAFT_RESUME_FLAG)
    return flagged
  } catch {
    return false
  }
}

/** `confirm()` is callback-based (Yes/No), not a Promise -- wrap it once so
 *  `load()` can just `await` the user's choice like everything else here. */
function confirmAsync(message) {
  return new Promise((resolve) => confirm(message, () => resolve(true), () => resolve(false)))
}

/** Non-Table fields only -- see `DRAFT_ITEM_FIELDS`'s comment. */
function itemDraftFields(frm) {
  const out = {}
  for (const fieldname of DRAFT_ITEM_FIELDS) {
    if (frm.fields_dict?.[fieldname]?.df?.fieldtype === 'Table') continue
    out[fieldname] = frm.doc?.[fieldname]
  }
  return out
}

function buildDraftSnapshot() {
  return {
    savedAt: new Date().toISOString(),
    order: orderFrm.value ? pick(orderFrm.value.doc, SHARED_FIELDNAMES) : null,
    header: quotationHeaderFrm.value ? pick(quotationHeaderFrm.value.doc, DRAFT_HEADER_FIELDS) : null,
    // Only items never yet saved to the server -- once an item reaches its
    // own Commercials "Save item", the real Costing Worksheet record is the
    // source of truth for it, same as everywhere else in this file.
    items: items.value
      .filter((item) => item.frm.is_new())
      .map((item) => ({
        fields: itemDraftFields(item.frm),
        quantity: item.quantity,
        description: item.description,
        activeStepIndex: item.activeStepIndex
      }))
  }
}

/** 'resume' mode's own field list -- `DRAFT_ITEM_FIELDS` alone misses
 *  `SHARED_STEP.fields` (customer/rating/region), which a resumed worksheet
 *  edits through this SAME frm (`orderFrm === item.frm` in `singleItemMode`,
 *  see `load()`'s doc comment there) just as unsaved as anything on the
 *  per-item steps. */
const RESUME_DRAFT_FIELDS = [...new Set([...SHARED_STEP.fields, ...DRAFT_ITEM_FIELDS])]
function resumeItemDraftFields(frm) {
  const out = {}
  for (const fieldname of RESUME_DRAFT_FIELDS) {
    if (frm.fields_dict?.[fieldname]?.df?.fieldtype === 'Table') continue
    out[fieldname] = frm.doc?.[fieldname]
  }
  return out
}
/** 'resume' mode only ever has the one worksheet `load()` opened by name --
 *  no order/header capture needed (Address & Delivery / Terms save through
 *  their own explicit "Save Changes" button, not this autosave). */
function buildResumeDraftSnapshot() {
  const item = items.value[0]
  if (!item) return null
  return {
    savedAt: new Date().toISOString(),
    resumeName: props.name,
    fields: resumeItemDraftFields(item.frm),
    quantity: item.quantity,
    description: item.description,
    activeStepIndex: item.activeStepIndex
  }
}
function currentDraftSnapshot() {
  return draftMode.value === 'resume' ? buildResumeDraftSnapshot() : buildDraftSnapshot()
}

let draftSaveTimer = null
/** Whether a write should actually happen right now -- checked both when
 *  scheduling (skip arming a timer at all when there's nothing to autosave)
 *  and again inside the timer callback itself: `submitAll()` can flip
 *  `quotationName`/`draftMode` mid-debounce (the real Quotation now exists,
 *  `clearDraft()` already ran) -- without re-checking at fire time, a timer
 *  armed just before submit would silently resurrect the draft it just
 *  cleared a few hundred ms later. 'resume' has no equivalent "session is
 *  now done" signal the way 'new' mode's `quotationName` is -- explicit
 *  `clearDraft()` calls right after a real save (see `itemNext()`,
 *  `submitAll()`) keep it from going stale instead.*/
function shouldPersistDraft() {
  if (draftMode.value === 'new') return !quotationName.value
  return draftMode.value === 'resume'
}
/** Debounced so a fast typist doesn't hit `localStorage.setItem` on every
 *  keystroke -- 400ms of quiet is plenty for data this size. */
function scheduleDraftSave() {
  if (!shouldPersistDraft()) return
  clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(() => {
    if (shouldPersistDraft()) writeDraft(currentDraftKey(), currentDraftSnapshot())
  }, 400)
}
/** Skips the debounce -- used right before the draft matters most (unmount). */
function flushDraftSave() {
  clearTimeout(draftSaveTimer)
  if (shouldPersistDraft()) writeDraft(currentDraftKey(), currentDraftSnapshot())
}

/** Applies a restored draft onto the frms `load()` just booted for a brand-new
 *  session -- `set_value` throughout, not a plain object merge, for the same
 *  reason `addItem()`'s own `seedDoc` loop does (see its comment): a merge
 *  lands the raw value but skips the field's change trigger, leaving derived
 *  fields (Facility/Labour Rate off Tank Type, address display text, etc.)
 *  blank until the estimator re-touches the field by hand. `items[0]` already
 *  exists (this runs after `addItem(seed)`); any further draft items create
 *  their own tab first. */
async function applyDraftToFrms(draft) {
  for (const [fieldname, value] of Object.entries(draft.order ?? {})) {
    if (value === undefined) continue
    await orderFrm.value.set_value(fieldname, value)
  }
  for (const [fieldname, value] of Object.entries(draft.header ?? {})) {
    if (value === undefined) continue
    await quotationHeaderFrm.value.set_value(fieldname, value)
  }
  const draftItems = draft.items ?? []
  for (let i = 0; i < draftItems.length; i++) {
    const target = i === 0 ? items.value[0] : await addItem()
    if (!target) continue
    const { fields = {}, quantity, description, activeStepIndex } = draftItems[i]
    for (const [fieldname, value] of Object.entries(fields)) {
      if (value === undefined) continue
      await target.frm.set_value(fieldname, value)
    }
    if (typeof quantity === 'number') target.quantity = quantity
    if (typeof description === 'string') target.description = description
    if (typeof activeStepIndex === 'number') {
      target.unlockedSteps = initialUnlockedSteps(target.frm)
      target.unlockedSteps.add(activeStepIndex)
      target.activeStepIndex = activeStepIndex
    }
  }
}

/** 'resume' mode's counterpart to `applyDraftToFrms` -- only ever one item,
 *  already loaded from the server by `load()`'s `singleItemMode` branch
 *  before this runs, so no `addItem()` needed. */
async function applyResumeDraft(draft) {
  const item = items.value[0]
  if (!item) return
  for (const [fieldname, value] of Object.entries(draft.fields ?? {})) {
    if (value === undefined) continue
    await item.frm.set_value(fieldname, value)
  }
  if (typeof draft.quantity === 'number') item.quantity = draft.quantity
  if (typeof draft.description === 'string') item.description = draft.description
  if (typeof draft.activeStepIndex === 'number') {
    item.unlockedSteps = initialUnlockedSteps(item.frm)
    item.unlockedSteps.add(draft.activeStepIndex)
    item.activeStepIndex = draft.activeStepIndex
  }
}

async function load() {
  loading.value = true
  error.value = ''
  orderFrm.value = null
  quotationHeaderFrm.value = null
  items.value = []
  activeItemKey.value = null
  quotationName.value = null
  quotationDocstatus.value = 0
  submitPhase.value = 'idle'
  submitAllError.value = ''
  draftMode.value = null

  if (!live.value) {
    error.value = 'No Frappe backend configured. Set VITE_FRAPPE_URL in .env to use the wizard.'
    loading.value = false
    return
  }

  try {
    if (props.quotation) {
      // Resuming an existing Quotation — boot its REAL header frm (not a
      // throwaway) so Taxes/Address/Terms show what's actually staged, then
      // discover every Costing Worksheet already mapped onto it and load each
      // as its own item, reusing the exact per-item boot/makeItem machinery
      // every other path here already uses.
      quotationHeaderFrm.value = await bootFrm(HEADER_DOCTYPE, {
        name: props.quotation,
        scripts: [addressQueryScript]
      })
      quotationName.value = props.quotation
      quotationDocstatus.value = quotationHeaderFrm.value.doc.docstatus ?? 0

      const linked = await db.get_list(DOCTYPE, {
        filters: { quotation: props.quotation },
        fields: ['name'],
        limit_page_length: 0
      })
      for (const row of linked) {
        const frm = await bootFrm(DOCTYPE, { name: row.name, scripts: itemScripts(DOCTYPE) })
        items.value = [...items.value, makeItem(frm, uid())]
      }
      orderFrm.value = items.value[0]?.frm ?? null
      activeItemKey.value = items.value[0]?.key ?? null
      // Opened from the Quotation list — land on the summary, not back in
      // the middle of item entry. `unlockedPageIndexes` above is derived
      // from the loaded data (shared step complete + at least one item), so
      // an existing Quotation always has 'review' unlocked by this point.
      activePageStep.value = 'review'
    } else {
      // Set by `/quotation/new`'s Type cards (Tank/Radiator) via
      // seedPendingDoc('Quotation', ...) — see QuotationNewView.vue. Falls
      // back to "Tank" when the wizard is opened some other way (e.g.
      // directly via URL), since that's still the only real flow either
      // Type runs through (see TYPE_FIELDS in costingWorksheetWizard.js).
      const headerSeed = takePendingDoc(HEADER_DOCTYPE)
      quotationHeaderFrm.value = await bootFrm(HEADER_DOCTYPE, {
        initialDoc: { doctype: HEADER_DOCTYPE, custom_type: 'Tank', ...headerSeed },
        scripts: [addressQueryScript]
      })

      if (props.name) {
        // Resuming/editing one existing worksheet — single-item mode. The same
        // frm serves double duty as both `orderFrm` (it already has real
        // customer/company/etc.) and the sole item.
        const frm = await bootFrm(DOCTYPE, { name: props.name, scripts: itemScripts(DOCTYPE) })
        orderFrm.value = frm
        const item = makeItem(frm, uid())
        items.value = [item]
        activeItemKey.value = item.key
        quotationName.value = frm.doc.quotation || null
        // `quotationHeaderFrm` here is a throwaway new Quotation, not this
        // item's real one — its docstatus tells us nothing, so fetch the
        // actual linked Quotation's.
        quotationDocstatus.value = quotationName.value
          ? (await db.get_value('Quotation', quotationName.value, 'docstatus'))?.docstatus ?? 0
          : 0
        activePageStep.value = 'items'

        // See `draftMode`'s doc comment: reopening this worksheet doesn't
        // mean nothing's at risk -- edits made after this point and before
        // the next "Save item" are exactly as unsaved as a brand-new item's.
        // Skipped once the linked Quotation is actually submitted (the form
        // locks anyway, see `activeItemLocked`) -- nothing to restore into.
        if (quotationDocstatus.value !== 1) {
          draftMode.value = 'resume'
          const key = currentDraftKey()
          const draft = readDraft(key)
          if (draft) {
            const wantsRestore = await confirmAsync(
              `You have unsaved changes to this Costing Worksheet from ${timeAgo(draft.savedAt) || 'earlier'}. Restore them?`
            )
            if (wantsRestore) await applyResumeDraft(draft)
            else clearDraft(key)
          }
        }
      } else {
        // Set by `/quotation/new` when the user picked a Tank Type there — see
        // mappedDoc.js's `seedPendingDoc` / `takePendingDoc`. Belongs on the
        // first ITEM (tank_type is per-item), not the shared step.
        const seed = takePendingDoc(DOCTYPE)
        orderFrm.value = await bootFrm(DOCTYPE, {
          // Unique placeholder — see the comment on addItem() for why two
          // simultaneously-open new Costing Worksheet frms can't share the
          // default "New Costing Worksheet" name.
          initialDoc: { doctype: DOCTYPE, name: `New Costing Worksheet (order-${uid()})` },
          scripts: itemScripts(DOCTYPE)
        })
        await addItem(seed)
        activePageStep.value = 'customer'

        // Brand-new session — the 'new' draft mode (see `draftMode`'s doc
        // comment above).
        draftMode.value = 'new'
        const draft = readDraft(DRAFT_STORAGE_KEY)
        if (draft) {
          const wantsRestore = takeDraftResumeFlag()
            ? true
            : await confirmAsync(
                `You have an unsaved quotation draft from ${timeAgo(draft.savedAt) || 'earlier'}. Restore it and continue where you left off?`
              )
          if (wantsRestore) await applyDraftToFrms(draft)
          else clearDraft(DRAFT_STORAGE_KEY)
        }
      }
    }
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

/** Customer & Order is filled once, but edited any time after items already
 *  exist — push a changed value out to every item so `submit_and_map`'s own
 *  customer/company-match check never fails on a stale copy. */
watch(
  () => pick(orderFrm.value?.doc, SHARED_FIELDNAMES),
  async (vals) => {
    for (const item of items.value) {
      if (item.frm === orderFrm.value) continue
      for (const [fieldname, value] of Object.entries(vals)) {
        if (item.frm.doc[fieldname] !== value) await item.frm.set_value(fieldname, value)
      }
    }
  },
  { deep: true }
)

/** Autosaves the brand-new session's in-progress fields to `localStorage` --
 *  see `scheduleDraftSave()`'s doc comment. Three separate watchers (order,
 *  header, items) rather than one combined getter, so a change to any one
 *  doesn't need to re-walk the other two just to notice it did. */
watch(() => (orderFrm.value ? pick(orderFrm.value.doc, SHARED_FIELDNAMES) : null), scheduleDraftSave, { deep: true })
watch(
  () => (quotationHeaderFrm.value ? pick(quotationHeaderFrm.value.doc, DRAFT_HEADER_FIELDS) : null),
  scheduleDraftSave,
  { deep: true }
)
watch(
  () =>
    items.value
      .filter((item) => item.frm.is_new())
      .map((item) => ({ fields: itemDraftFields(item.frm), quantity: item.quantity, description: item.description })),
  scheduleDraftSave,
  { deep: true }
)

/**
 * This installed SDK build's `save()` writes the server's response fields
 * onto `frm.doc` (so `doc.name` correctly becomes the real backend name) but
 * never clears `doc.__islocal` — the server response has no such key, and
 * nothing else does either — so `frm.is_new()` (which is only ever
 * `!!doc.__islocal`) keeps reporting `true` forever after a successful save.
 * Left alone, every later `is_new()` check (`submitAll`'s pre-submit
 * save-if-needed guard, in particular) would re-`save()` an already-saved
 * item on every call — sent with a stale `__islocal: 1` in the payload, that
 * risks the server treating it as a fresh insert instead of an update.
 * Called once, right after a save actually succeeds. */
function markSaved(frm) {
  frm.doc.__islocal = 0
  frm.doc.__unsaved = 0
}

/** Index of the Complexity step — the one place a "Load default questions"
 *  auto-trigger below cares which step it just landed on. */
const COMPLEXITY_STEP_INDEX = ITEM_STEPS.findIndex((s) => s.key === 'complexity')

/** Complexity Ratings starts empty for every new item, and every item uses
 *  the same default question set — so load it automatically the first time
 *  an item reaches this step, rather than making the estimator find and
 *  click a button for what's never actually a choice. Skipped once rows
 *  already exist (a resumed, already-scored item) so this never clobbers
 *  real answers. */
function autoLoadComplexityQuestions(item) {
  if (!item || item.activeStepIndex !== COMPLEXITY_STEP_INDEX) return
  if (item.frm.doc?.complexity_ratings?.length) return
  loadComplexityQuestions()
}

/** Deal Price - FG starts at 0 for every new item; default it to the item's
 *  own built-up cost (Total FG Cost (INR/kg)) the first time Commercials is
 *  reached, so margin starts at 0% and the estimator adjusts the price up
 *  from cost instead of typing one in from scratch. Skipped once a price is
 *  already set, so revisiting this step never overwrites a real entry.
 *
 *  `total_fg_cost_inr_kg` is the end of a chain of client-side divisions
 *  (rate-per-kg math throughout the costing sheet), so it routinely carries
 *  IEEE-754 noise out past a dozen digits (`1208.68864223999999`) — invisible
 *  everywhere else because every other display goes through `money()`'s
 *  rounding, but this is a straight `set_value` into a *live, editable*
 *  Currency field, whose input shows the raw doc value verbatim. `flt(…, 2)`
 *  (Frappe's own float-round, same as the Currency fieldtype's own default
 *  precision) is what the real desk form's Currency control applies before
 *  ever displaying a value — do the same here before it ever reaches the field. */
function autoPrefillDealPrice(item) {
  if (!item || item.activeStepIndex !== COMMERCIALS_STEP_INDEX) return
  const doc = item.frm.doc
  if (Number(doc.deal_price_fg_inr_per_kg) > 0) return
  const cost = flt(doc.total_fg_cost_inr_kg, 2)
  if (cost > 0) item.frm.set_value('deal_price_fg_inr_per_kg', cost)
}

function goToItemStep(i) {
  const item = activeItem.value
  if (!item || i === item.activeStepIndex) return
  if (i > item.activeStepIndex && !item.unlockedSteps.has(i)) return
  item.stepError = ''
  item.activeStepIndex = i
  autoLoadComplexityQuestions(item)
  autoPrefillDealPrice(item)
}
function itemBack() {
  const item = activeItem.value
  if (!item || item.activeStepIndex === 0) return
  item.stepError = ''
  item.activeStepIndex -= 1
}
async function itemNext() {
  const item = activeItem.value
  if (!item) return
  item.stepError = ''

  const step = ITEM_STEPS[item.activeStepIndex]
  if (GATED_STEP_INDEXES.has(item.activeStepIndex) && !stepIsComplete(item.frm, step, fieldState)) {
    item.stepError = 'Fill in the required fields before continuing.'
    return
  }
  if (step.key === 'volumes') {
    const splitError = volumesSplitError(item.frm)
    if (splitError) {
      item.stepError = splitError
      return
    }
  }
  if (step.key === 'commercials') {
    const marginError = pureMarginError(item.frm)
    if (marginError) {
      item.stepError = marginError
      return
    }
  }

  if (item.activeStepIndex === COMMERCIALS_STEP_INDEX) {
    item.saving = true
    error.value = ''
    try {
      await item.frm.save()
      markSaved(item.frm)
      // The server now has exactly what's on screen -- a 'resume' draft
      // from before this save would only ever replay stale values over it
      // on a future reopen. Turning `draftMode` off (not just clearing the
      // key) matters here: `save()`'s own `_writeBack` mutates `frm.doc`
      // with the freshly recalculated fields, which the deep watcher above
      // sees as another change and re-arms `scheduleDraftSave()`'s debounce
      // -- without this, that timer fires ~400ms later, sees `shouldPersist
      // Draft()` still true, and silently resurrects the very draft just
      // cleared (same race `shouldPersistDraft()`'s doc comment describes
      // for 'new' mode, just with no `quotationName`-style signal to guard
      // it in 'resume' mode otherwise).
      if (draftMode.value === 'resume') {
        clearDraft(currentDraftKey())
        draftMode.value = null
      }
    } catch (e) {
      item.stepError = e?.message ?? String(e)
      item.saving = false
      return
    }
    item.saving = false
    pageNext() // last item step — saving it also advances off the Costing Sheet page
    return
  }

  const nextIndex = item.activeStepIndex + 1
  item.unlockedSteps = new Set(item.unlockedSteps).add(nextIndex)
  item.activeStepIndex = nextIndex
  autoLoadComplexityQuestions(item)
  autoPrefillDealPrice(item)
}

/** The native client script's own buttons — reused rather than reimplemented. */
function loadComplexityQuestions() {
  const btn = activeItem.value?.frm?.custom_buttons?.find((b) => b.label === 'Load Complexity Questions')
  if (btn) btn.action()
}
function recalculate() {
  const btn = activeItem.value?.frm?.custom_buttons?.find((b) => b.label === 'Recalculate')
  if (btn) btn.action()
}

function goToItem(key) {
  activePageStep.value = 'items'
  activeItemKey.value = key
}

const incompleteItems = computed(() =>
  items.value
    .map((item, i) => ({ item, label: itemLabel(item, i) }))
    .filter(
      ({ item }) =>
        item.submitState !== 'succeeded' &&
        (item.frm.is_new() || !stepIsComplete(item.frm, ITEM_STEPS[COMMERCIALS_STEP_INDEX], fieldState))
    )
)
const allSucceeded = computed(() => items.value.length > 0 && items.value.every((i) => i.submitState === 'succeeded'))
const canSubmit = computed(
  () => items.value.length > 0 && submitPhase.value !== 'running' && !items.value.some((i) => i.submitState === 'submitting')
)

/**
 * Submits every item in order, mapping each onto the same Quotation — the
 * first with no target (the backend creates it and returns its name, plus
 * applies the staged Taxes/Address/Terms header once), every later item with
 * that name as `target_quotation`. Sequential, not parallel: item 2+ needs
 * the Quotation name item 1's call returns.
 */
async function submitAll() {
  if (!canSubmit.value) return
  if (incompleteItems.value.length) {
    const names = incompleteItems.value.map(({ label }) => label).join(', ')
    submitAllError.value = `Finish these items' Commercials step before submitting: ${names}.`
    return
  }
  submitAllError.value = ''
  submitPhase.value = 'running'

  const header = quotationHeaderFrm.value
    ? pick(quotationHeaderFrm.value.doc, [
        ...TYPE_FIELDS,
        ...TAX_FIELDS,
        TAX_TABLE_FIELD,
        ...ADDRESS_FIELDS,
        ...EXIM_FIELDS,
        ...TERMS_FIELDS,
        TERMS_TABLE_FIELD
      ])
    : {}

  for (const item of items.value) {
    if (item.submitState === 'succeeded') continue
    item.submitState = 'submitting'
    item.submitError = ''
    try {
      if (item.frm.is_new() || item.frm.is_dirty()) {
        await item.frm.save()
        markSaved(item.frm)
      }
      const result = await item.frm.call('submit_and_map', {
        target_quotation: quotationName.value,
        quantity: normalizedQuantity(item),
        description: item.description || undefined,
        ...(quotationName.value ? {} : { quotation_header: header })
      })
      quotationName.value = quotationName.value ?? result?.message

      // frm.call() goes through run_doc_method, not frm.submit() — replay the
      // trigger sequence submit() normally runs, so this item's own refresh
      // handler repopulates its custom buttons and its workflow state updates.
      await item.frm.trigger?.('after_save')
      await item.frm.trigger?.('refresh')
      await item.frm.trigger?.('on_submit')

      // `submit_and_map`'s own `self.save()` runs `calculate()` (via
      // `validate()`) BEFORE its `on_update` hook sets `self.quotation` and
      // creates the real Quotation Item row -- so the container-fit fields it
      // just saved were computed with no quotation/qty yet, same as the
      // Items & Pricing step's Container / Logistics sub-section showing 0
      // the whole time up to now (see
      // `_calculate_container_fit`, "Order quantity has no field of its own
      // on Costing Worksheet"). A real `frm.save()` here (not just
      // `frm.call('calculate')`, which only refreshes the client's copy)
      // re-runs `calculate()` now that the real qty exists AND persists the
      // result -- `_guard_against_edit_after_submit` only blocks a save once
      // the *Quotation* itself is submitted (still Draft at this point in the
      // wizard), and `on_update`'s `_auto_create_quotation`/labour-override
      // comment guards both no-op on a second save since nothing they check
      // changed. Sea-only (was Export-only; the backend's own `depends_on`
      // for this feature switched to `mode_of_transport == "Sea"`), matching
      // everywhere else this feature is gated; best-effort since it's purely
      // informational and must never fail an otherwise-successful submit.
      if (item.frm.doc?.mode_of_transport === 'Sea' && item.frm.doc?.container_type) {
        try {
          await item.frm.save()
        } catch (e) {
          console.error('[hitech-costing-ui] post-submit container-fit recalculate failed:', e)
        }
      }
      item.submitState = 'succeeded'
    } catch (e) {
      item.submitState = 'failed'
      item.submitError = e?.message ?? String(e)
      submitPhase.value = 'partial-failure'
      return
    }
  }
  submitPhase.value = 'done'
  // The real Quotation now exists — a stale draft here would otherwise offer
  // to "restore" this same data into a NEXT session by mistake.
  clearDraft(currentDraftKey())
  draftMode.value = null
}

function finishQuotation() {
  if (!quotationName.value) return
  router.push(`/quotation/${encodeURIComponent(quotationName.value)}/review`)
}

onMounted(load)
onMounted(loadTermOptions)
watch(() => props.name, load)
watch(() => props.quotation, load)
</script>

<template>
  <div class="qw-wizard">
    <div class="qw-crumbtrail">
      <RouterLink to="/" class="qw-crumbtrail__link">Dashboard</RouterLink>
      <LucideIcon name="chevron-right" />
      <RouterLink :to="listRouteFor(crumbDoctype)" class="qw-crumbtrail__link">{{ crumbDoctype }}</RouterLink>
      <LucideIcon name="chevron-right" />
      <span class="qw-crumbtrail__current">{{ heading }}</span>
    </div>

    <h1 class="qw-heading">{{ heading }}</h1>

    <div v-if="!live && !loading" class="qw-notice">
      Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to use the wizard.
    </div>

    <div v-if="error" class="qw-error-banner">
      <span class="qw-error-banner__icon"><LucideIcon name="x" /></span>
      <div style="min-width:0;">
        <div class="qw-error-banner__title">Could not save</div>
        <div class="qw-error-banner__body">{{ error }}</div>
      </div>
    </div>

    <div v-if="loading" class="qw-loading">Loading…</div>

    <template v-if="orderFrm && quotationHeaderFrm">
      <div class="qw-topline">
        <WizardProgress :steps="PAGE_STEPS" :active-index="activePageIndex" :unlocked-steps="unlockedPageIndexes" @select="selectPageStep" />
        <span class="qw-save-pill">{{ saveState }}</span>
      </div>

      <div ref="wizardEl" class="frappe-form">
        <!-- 01 · Customer & Order (shared, once) -->
        <section v-if="activePageStep === 'customer'">
          <p v-if="activeItemLocked" class="qw-step-lede">
            This Quotation (<strong>{{ quotationName }}</strong>) has been submitted and can no longer be edited.
          </p>
          <div class="qw-step-card">
            <h2 class="qw-step-title"><span class="qw-step-title__n">01</span>Customer & Order</h2>
            <fieldset :disabled="activeItemLocked" style="border: none; padding: 0; margin: 0;">
              <WizardStep :frm="orderFrm" :fields="SHARED_STEP.fields" read-only-filter="exclude" />
            </fieldset>
          </div>
          <div class="qw-footer">
            <button type="button" class="qw-back-btn" disabled>← Back</button>
            <button
              type="button"
              class="qw-next-btn"
              :disabled="activeItemLocked || !stepIsComplete(orderFrm, SHARED_STEP, fieldState)"
              @click="pageNext"
            >
              Next
            </button>
          </div>
        </section>

        <!-- 02 · Costing sheet (per item, tabbed) -->
        <section v-else-if="activePageStep === 'items'">
          <div class="qw-item-tabs">
            <span class="qw-item-tabs__eyebrow">Items</span>
            <template v-if="!singleItemMode">
              <button
                v-for="(item, i) in items"
                :key="item.key"
                type="button"
                class="qw-item-tab"
                :class="{ 'is-active': item.key === activeItemKey }"
                @click="activeItemKey = item.key"
              >
                {{ itemLabel(item, i) }}
                <span v-if="item.submitState === 'succeeded'" class="qw-item-tab__badge">✓</span>
              </button>
              <button type="button" class="qw-ghost-btn qw-ghost-btn--dashed" @click="addItem()">+ Add item</button>
              <button
                v-if="activeItem && activeItem.frm.docstatus !== 1"
                type="button"
                class="qw-ghost-btn"
                @click="removeItem(activeItemKey)"
              >
                Remove this item
              </button>
            </template>
          </div>

          <template v-if="activeItem">
            <div :key="activeItem.key">
              <WizardProgress
                :steps="ITEM_STEPS"
                :active-index="activeItem.activeStepIndex"
                :unlocked-steps="activeItem.unlockedSteps"
                @select="goToItemStep"
              />

              <p v-if="activeItemLocked" class="qw-step-lede">
                This Costing Worksheet's Quotation (<strong>{{ quotationName }}</strong>) has been submitted and can no
                longer be edited.
              </p>

              <div class="qw-step-layout">
                <div class="qw-step-main">
                  <template v-for="(step, i) in ITEM_STEPS" :key="step.key">
                    <div v-show="i === activeItem.activeStepIndex" class="qw-step-card">
                      <h2 class="qw-step-title">
                        <span class="qw-step-title__n">{{ String(i + 1).padStart(2, '0') }}</span>
                        {{ step.title }}
                      </h2>
                      <fieldset :disabled="activeItemLocked" style="border: none; padding: 0; margin: 0;">
                        <WizardStep :frm="activeItem.frm" :fields="step.fields" read-only-filter="exclude" />
                        <div v-if="step.key === 'commercials'" class="qw-derived__rows" style="margin-top: 16px;">
                          <div
                            v-for="row in commercialsMarginRows"
                            :key="row.label"
                            class="qw-derived__row"
                            :class="{ 'qw-derived__row--low': row.low }"
                          >
                            <span class="qw-derived__k">{{ row.label }}</span>
                            <span class="qw-derived__v">{{ row.value }}</span>
                            <span v-if="row.warning" class="qw-derived__warning">{{ row.warning }}</span>
                          </div>
                        </div>
                        <div v-if="step.key === 'complexity'" class="qw-step-actions">
                          <button type="button" @click="recalculate" class="qw-ghost-btn">Recalculate</button>
                        </div>
                      </fieldset>
                    </div>
                  </template>
                </div>

                <aside v-if="activeItemHasDerived" class="qw-derived">
                  <div class="qw-derived__eyebrow">Calculated</div>
                  <div class="qw-derived__hint">Recalculates live as you edit this step's fields.</div>
                  <div class="qw-derived__rows">
                    <div v-for="row in activeItemDerivedRows" :key="row.label" class="qw-derived__row" :class="{ 'qw-derived__row--low': row.low }">
                      <span class="qw-derived__k">{{ row.label }}</span>
                      <span class="qw-derived__v">{{ row.value }}</span>
                      <span v-if="row.warning" class="qw-derived__warning">{{ row.warning }}</span>
                    </div>
                  </div>
                </aside>
              </div>

              <div v-if="activeItem.stepError" class="qw-step-error">{{ activeItem.stepError }}</div>

              <div class="qw-footer">
                <button type="button" :disabled="activeItem.activeStepIndex === 0" @click="itemBack" class="qw-back-btn">
                  ← Back
                </button>
                <button
                  type="button"
                  :disabled="activeItem.saving || (activeItemLocked && activeItem.activeStepIndex === COMMERCIALS_STEP_INDEX)"
                  @click="itemNext"
                  class="qw-next-btn"
                >
                  {{ activeItem.saving ? 'Saving…' : activeItem.activeStepIndex === COMMERCIALS_STEP_INDEX ? 'Save item' : 'Next' }}
                </button>
              </div>
            </div>
          </template>
        </section>

        <!-- 03 · Items & pricing (shared summary, read-only) -->
        <section v-else-if="activePageStep === 'pricing'">
          <div class="qw-step-card">
            <h2 class="qw-step-title"><span class="qw-step-title__n">03</span>Items & Pricing</h2>
            <p class="qw-step-lede">
              One line per item. Weight and built-up cost come from that item's own costing sheet. Add a description
              and quantity to price multiple units of the same design — final amount is total deal value × quantity.
            </p>
            <div class="qw-pricing-table-wrap">
              <table class="qw-quotation-items qw-pricing-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Deal price</th>
                    <th>Qty</th>
                    <th>Weight (kg)</th>
                    <th>Built-up cost</th>
                    <th>Margin %</th>
                    <th>Total deal value</th>
                    <th>Final amount</th>
                    <th>Description</th>
                    <th v-if="showContainersRequiredColumn" title="Preview only, from this page's Quantity — not the saved Costing Worksheet figure">
                      Containers (est.)
                    </th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in itemsPricingRows" :key="row.key">
                    <td class="qw-pricing-table__label">{{ row.label }}</td>
                    <td class="qw-pricing-table__num">{{ row.dealPrice }}</td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        class="qw-inline-input qw-inline-input--qty"
                        v-model.number="row.item.quantity"
                        :disabled="row.item.frm.docstatus === 1"
                      />
                    </td>
                    <td class="qw-pricing-table__num">{{ row.weight }}</td>
                    <td class="qw-pricing-table__num">{{ row.builtUpCost }}</td>
                    <td class="qw-pricing-table__num">{{ row.marginPercent }}</td>
                    <td class="qw-pricing-table__num">{{ row.totalDealValue }}</td>
                    <td class="qw-pricing-table__num qw-pricing-table__final">{{ row.finalAmount }}</td>
                    <td>
                      <input
                        type="text"
                        class="qw-inline-input"
                        v-model="row.item.description"
                        :disabled="row.item.frm.docstatus === 1"
                        :placeholder="`${row.label} tank — as per Costing Worksheet`"
                      />
                    </td>
                    <td v-if="showContainersRequiredColumn" class="qw-pricing-table__num">
                      <span v-if="row.containersRequiredPreview === null">—</span>
                      <span v-else-if="row.containersRequiredPreview === 0" class="qw-derived__warning">Doesn't fit</span>
                      <span v-else>{{ row.containersRequiredPreview }} (~{{ row.unitsPerContainer }}/ctr)</span>
                    </td>
                    <td class="qw-pricing-table__actions">
                      <button type="button" class="qw-review-card__edit" @click="goToItem(row.key)">Costing →</button>
                      <button
                        v-if="row.item.frm.docstatus !== 1"
                        type="button"
                        class="qw-review-card__edit qw-review-card__edit--danger"
                        @click="removeItem(row.key)"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="qw-step-actions">
              <button type="button" class="qw-ghost-btn qw-ghost-btn--dashed" @click="addItem()">
                + Add item — opens a new costing sheet
              </button>
            </div>

            <h3 class="qw-terms-notes__title qw-items-totals-heading">Totals</h3>
            <div class="qw-totals-grid qw-items-totals-grid">
              <div class="qw-totals-box">
                <span class="qw-totals-box__k">Total Quantity</span>
                <span class="qw-totals-box__v">{{ itemsSummary.totalQuantity }}</span>
              </div>
              <div class="qw-totals-box">
                <span class="qw-totals-box__k">Total (Company Currency)</span>
                <span class="qw-totals-box__v">{{ itemsSummary.total }}</span>
              </div>
              <div class="qw-totals-box">
                <span class="qw-totals-box__k">Total</span>
                <span class="qw-totals-box__v">{{ itemsSummary.total }}</span>
              </div>
              <div class="qw-totals-box">
                <span class="qw-totals-box__k">Net Total (Company Currency)</span>
                <span class="qw-totals-box__v">{{ itemsSummary.netTotal }}</span>
              </div>
              <div class="qw-totals-box">
                <span class="qw-totals-box__k">Net Total</span>
                <span class="qw-totals-box__v">{{ itemsSummary.netTotal }}</span>
              </div>
              <div v-if="itemsSummary.showContainers" class="qw-totals-box">
                <span class="qw-totals-box__k">Total Containers Required (est.)</span>
                <span v-if="itemsSummary.hasNonFitting" class="qw-derived__warning">
                  One or more items don't fit their container — see the row above
                </span>
                <span v-else class="qw-totals-box__v">{{ itemsSummary.totalContainersRequired }}</span>
              </div>
            </div>

            <!-- Container / Logistics — Mode of Transport, Container Type and
                 the container-load-fit numbers, one item at a time (see
                 `CONTAINER_LOGISTICS_FIELDS` above for why these moved off
                 the per-item Dimensions step). Reuses the SAME
                 `activeItem`/`activeItemKey` state as the "Costing Sheet"
                 page step's own item tabs, just a smaller selector since
                 add/remove already live in the table above. -->
            <div v-if="items.length" class="qw-terms-notes">
              <h3 class="qw-terms-notes__title">Container / Logistics</h3>
              <div v-if="items.length > 1" class="qw-item-tabs" style="margin-bottom: 16px;">
                <span class="qw-item-tabs__eyebrow">Item</span>
                <button
                  v-for="(item, i) in items"
                  :key="item.key"
                  type="button"
                  class="qw-item-tab"
                  :class="{ 'is-active': item.key === activeItemKey }"
                  @click="activeItemKey = item.key"
                >
                  {{ itemLabel(item, i) }}
                </button>
              </div>
              <template v-if="activeItem">
                <fieldset :disabled="activeItemLocked" style="border: none; padding: 0; margin: 0;">
                  <WizardStep :frm="activeItem.frm" :fields="CONTAINER_LOGISTICS_FIELDS" read-only-filter="exclude" />
                </fieldset>
                <div v-if="containerLogisticsRows.length" class="qw-derived__rows qw-derived__rows--inline" style="margin-top: 16px;">
                  <div
                    v-for="row in containerLogisticsRows"
                    :key="row.label"
                    class="qw-derived__row"
                    :class="{ 'qw-derived__row--low': row.low }"
                  >
                    <span class="qw-derived__k">{{ row.label }}</span>
                    <span class="qw-derived__v">{{ row.value }}</span>
                    <span v-if="row.warning" class="qw-derived__warning">{{ row.warning }}</span>
                  </div>
                </div>
                <!-- Live container-fit preview status -- see
                     `runContainerFitPreview()`. Quiet by design: this fires
                     automatically as a side effect of picking a Container
                     Type / editing dimensions, so neither state should read
                     as an error or block the step. -->
                <p v-if="containerFitPreviewPending" class="qw-step-lede" style="margin-top: 10px;">
                  Calculating container fit…
                </p>
                <p v-else-if="containerFitPreviewError" class="qw-derived__warning" style="margin-top: 10px;">
                  Container fit preview unavailable right now ({{ containerFitPreviewError }}) — figures above may be out of date.
                </p>
              </template>
            </div>
          </div>
          <div class="qw-footer">
            <button type="button" class="qw-back-btn" @click="pageBack">← Back</button>
            <button type="button" class="qw-next-btn" @click="pageNext">Next</button>
          </div>
        </section>

        <!-- 04 · Address & delivery (shared, once) -->
        <section v-else-if="activePageStep === 'address'">
          <div class="qw-step-card">
            <h2 class="qw-step-title"><span class="qw-step-title__n">04</span>Address & Delivery</h2>
            <p v-if="quotationName" class="qw-step-lede">
              Editing delivery details on <strong>{{ quotationName }}</strong> directly — use Save Changes below to apply changes.
            </p>
            <WizardStep :frm="quotationHeaderFrm" :fields="visibleAddressFields" read-only-filter="exclude" />
            <!-- `address_display`/`shipping_address` are `read_only`, so the
                 "exclude" step above never renders them — same "only" split
                 the Complexity step's Calculated rail uses, just inline here
                 rather than off to the side, since these read as a caption
                 under each address picker, not a separate calculated panel. -->
            <WizardStep
              :frm="quotationHeaderFrm"
              :fields="['address_display', 'shipping_address']"
              read-only-filter="only"
              style="margin-top: 14px;"
            />
            <div v-if="quotationName" style="margin-top: 18px; display: flex; align-items: center; gap: 12px;">
              <button type="button" class="qw-next-btn" @click="saveQuotationHeader" :disabled="headerSaving">
                {{ headerSaving ? 'Saving…' : 'Save Changes' }}
              </button>
              <span v-if="headerSaveError" class="qw-step-error">{{ headerSaveError }}</span>
            </div>
          </div>
          <div class="qw-footer">
            <button type="button" class="qw-back-btn" @click="pageBack">← Back</button>
            <button type="button" class="qw-next-btn" @click="pageNext">Next</button>
          </div>
        </section>

        <!-- 05 · Exim / Incoterms (shared, once) -->
        <section v-else-if="activePageStep === 'exim'">
          <div class="qw-step-card">
            <h2 class="qw-step-title"><span class="qw-step-title__n">05</span>Exim / Incoterms</h2>
            <p v-if="quotationName" class="qw-step-lede">
              Editing freight &amp; Incoterm details on <strong>{{ quotationName }}</strong> directly — use Save Changes below to apply changes.
            </p>
            <WizardStep :frm="quotationHeaderFrm" :fields="visibleEximFields" read-only-filter="exclude" />
            <WizardStep
              :frm="quotationHeaderFrm"
              :fields="visibleEximFields"
              read-only-filter="only"
              style="margin-top: 14px;"
            />
            <!-- Live freight preview status -- see `runFreightPreview()`. Quiet
                 by design: this fires automatically as a side effect of typing,
                 so neither state should read as an error or block the step. -->
            <p v-if="freightPreviewPending" class="qw-step-lede" style="margin-top: 10px;">
              Calculating freight preview…
            </p>
            <p v-else-if="freightPreviewError" class="qw-derived__warning" style="margin-top: 10px;">
              Freight preview unavailable right now ({{ freightPreviewError }}) — figures below may be out of date.
            </p>
            <div v-if="quotationName" style="margin-top: 18px; display: flex; align-items: center; gap: 12px;">
              <button type="button" class="qw-next-btn" @click="saveQuotationHeader" :disabled="headerSaving">
                {{ headerSaving ? 'Saving…' : 'Save Changes' }}
              </button>
              <span v-if="headerSaveError" class="qw-step-error">{{ headerSaveError }}</span>
            </div>
          </div>
          <div class="qw-footer">
            <button type="button" class="qw-back-btn" @click="pageBack">← Back</button>
            <button type="button" class="qw-next-btn" @click="pageNext">Next</button>
          </div>
        </section>

        <!-- 06 · Terms & conditions (shared, once) -->
        <section v-else-if="activePageStep === 'terms'">
          <div class="qw-step-card">
            <h2 class="qw-step-title"><span class="qw-step-title__n">06</span>Terms & Conditions</h2>
            <p v-if="quotationName" class="qw-step-lede">
              Editing terms on <strong>{{ quotationName }}</strong> directly — use Save Changes below to apply changes.
            </p>
            <p class="qw-step-lede">
              {{ termChecklist.length || 26 }} terms, sensible defaults pre-ticked. Selection is per quote.
            </p>
            <div v-if="termsError" class="qw-step-error">{{ termsError }}</div>
            <p v-else-if="termsLoading" class="qw-step-lede">Loading terms…</p>
            <div v-else class="qw-terms-grid">
              <label v-for="(entry, i) in termChecklist" :key="entry.key" class="qw-term-item">
                <input type="checkbox" :checked="entry.row?.selected == 1" @change="toggleTerm(entry)" />
                <span class="qw-term-item__n">{{ String(i + 1).padStart(2, '0') }}</span>
                <span class="qw-term-item__text">{{ entry.text }}</span>
              </label>
            </div>
            <div class="qw-terms-notes">
              <h3 class="qw-terms-notes__title">Notes & exclusions</h3>
              <WizardStep :frm="quotationHeaderFrm" :fields="TERMS_FIELDS" read-only-filter="exclude" />
            </div>
            <div v-if="quotationName" style="margin-top: 18px; display: flex; align-items: center; gap: 12px;">
              <button type="button" class="qw-next-btn" @click="saveQuotationHeader" :disabled="headerSaving">
                {{ headerSaving ? 'Saving…' : 'Save Changes' }}
              </button>
              <span v-if="headerSaveError" class="qw-step-error">{{ headerSaveError }}</span>
            </div>
          </div>
          <div class="qw-footer">
            <button type="button" class="qw-back-btn" @click="pageBack">← Back</button>
            <button type="button" class="qw-next-btn" @click="pageNext">Next</button>
          </div>
        </section>

        <!-- 07 · Review & submit -->
        <section v-else-if="activePageStep === 'review'">
          <div v-for="sec in reviewSections" :key="sec.key" class="qw-review-card">
            <div class="qw-review-card__head">
              <span class="qw-review-card__n">{{ sec.n }}</span>
              <span class="qw-review-card__title">{{ sec.title }}</span>
              <button type="button" class="qw-review-card__edit" @click="activePageStep = sec.key">Edit section</button>
            </div>
            <div class="qw-review-card__rows">
              <div
                v-for="row in sec.rows"
                :key="row.label"
                class="qw-review-card__row"
                :class="{ 'qw-review-card__row--full': row.list }"
              >
                <span class="qw-review-card__k">{{ row.label }}</span>
                <span v-if="!row.list" class="qw-review-card__v">{{ row.value }}</span>
                <ul v-else class="qw-review-terms-list">
                  <li v-for="(text, i) in row.list" :key="i" class="qw-review-terms-list__item">
                    <LucideIcon name="check" />
                    <span>{{ text }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div class="qw-review-card">
            <div class="qw-review-card__head">
              <span class="qw-review-card__title">Items ({{ items.length }})</span>
              <button type="button" class="qw-review-card__edit" @click="activePageStep = 'pricing'">Edit section</button>
            </div>
            <table class="qw-quotation-items">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Quantity</th>
                  <th>Final amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="row in itemsPricingRows" :key="row.key">
                  <tr>
                    <td>{{ row.label }}</td>
                    <td>{{ row.quantity }}</td>
                    <td>{{ row.finalAmount }}</td>
                    <td>
                      <span class="qw-submit-badge" :class="`qw-submit-badge--${row.submitState}`">{{ row.submitState }}</span>
                    </td>
                    <td>
                      <button type="button" class="qw-review-card__edit" @click="goToItem(row.key)">Costing →</button>
                    </td>
                  </tr>
                  <tr v-if="row.item.submitState === 'failed' && row.item.submitError">
                    <td colspan="5" class="qw-submit-error-row">{{ row.item.submitError }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <div v-if="submitPhase === 'partial-failure'" class="qw-error-banner">
            <span class="qw-error-banner__icon"><LucideIcon name="x" /></span>
            <div style="min-width:0;">
              <div class="qw-error-banner__title">
                {{ items.filter((i) => i.submitState === 'succeeded').length }} of {{ items.length }} items submitted and
                mapped to Quotation {{ quotationName }}
              </div>
              <div class="qw-error-banner__body">
                An item failed and submitted items cannot be undone here. Fix the issue below, then Retry — items already
                submitted are skipped.
              </div>
            </div>
          </div>

          <div v-if="submitAllError" class="qw-step-error">{{ submitAllError }}</div>

          <div class="qw-footer">
            <button type="button" class="qw-back-btn" @click="pageBack">← Back</button>
            <button
              v-if="!allSucceeded"
              type="button"
              class="qw-next-btn"
              :disabled="!canSubmit"
              @click="submitAll"
            >
              {{ submitPhase === 'running' ? 'Submitting…' : submitPhase === 'partial-failure' ? 'Retry' : 'Submit' }}
            </button>
            <button v-else type="button" class="qw-next-btn" @click="finishQuotation">Finish quotation →</button>
          </div>
        </section>
      </div>

      <ChildRowDrawer :frm="activeItem?.frm ?? null" :root="wizardEl" :read-only="activeItemLocked" />
    </template>
  </div>
</template>

<style scoped>
/* Hi-Tech Radiators brandbook (Raleway / IBM Plex Mono, navy-on-canvas
   palette), scoped to this page only — see src/assets/brand.css for the
   shared tokens this mirrors, and frappe-form.css for the SDK-control
   tokens re-tinted the same way. */
.qw-wizard {
  --qw-primary: #0B3465;
  --qw-primary-dark: #0B3465;
  --qw-primary-hover: #0E4079;
  --qw-primary-tint: #E9EFF7;
  --qw-border: #D7DEE8;
  --qw-row-border: #EDF1F6;
  --qw-text: #0E1B2B;
  --qw-body: #33414F;
  --qw-muted: #5E6B7A;
  --qw-faint: #94A0AE;
  font-family: 'Raleway', system-ui, sans-serif;
  color: var(--qw-body);
  padding: 30px 36px 80px;
  margin: 0 auto;
  max-width: 1400px;
}

.qw-crumbtrail {
  display: flex;
  align-items: center;
  gap: 6px;
  font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--qw-faint);
  margin-bottom: 10px;
}

.qw-crumbtrail__link {
  color: var(--qw-muted);
}

.qw-crumbtrail__link:hover {
  color: var(--qw-primary-dark);
}

.qw-crumbtrail__current {
  color: var(--qw-primary-dark);
}

.qw-heading {
  margin: 0 0 22px;
  font: 900 32px/1.15 'Raleway', system-ui, sans-serif;
  letter-spacing: -0.02em;
  color: var(--qw-text);
}

.qw-notice {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--qw-primary-tint);
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 15px 18px;
  margin-bottom: 18px;
  font-size: 13px;
  color: var(--qw-primary-dark);
}

.qw-error-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 15px 18px;
  margin-bottom: 18px;
}

.qw-error-banner__icon {
  color: #e63946;
  font-size: 17px;
  flex: none;
}

.qw-error-banner__title {
  font-size: 14.5px;
  font-weight: 700;
  color: #991b1b;
}

.qw-error-banner__body {
  font-size: 13px;
  color: #b91c1c;
  margin-top: 3px;
  word-break: break-word;
}

.qw-loading {
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 48px;
  text-align: center;
  color: var(--qw-faint);
  font-size: 14px;
  font-weight: 600;
}

.qw-topline {
  display: flex;
  align-items: center;
  gap: 14px;
}

.qw-topline :deep(.wizard-crumbs) {
  flex: 1;
  margin-bottom: 0;
}

.qw-save-pill {
  flex: none;
  font: 700 11px/1 'Raleway', system-ui, sans-serif;
  color: var(--qw-muted);
  background: var(--qw-row-border);
  border-radius: 999px;
  padding: 8px 12px;
  white-space: nowrap;
}

.qw-step-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  margin-top: 22px;
}

@media (min-width: 1080px) {
  .qw-step-layout {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
}

.qw-step-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.qw-step-card {
  min-width: 0;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 24px;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
  margin-top: 22px;
}

.qw-step-lede {
  margin: 0 0 18px;
  font: 400 15px/22px 'Raleway', system-ui, sans-serif;
  color: var(--qw-muted);
  max-width: 64ch;
}

.qw-review-card {
  min-width: 0;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 18px 20px;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
  margin-top: 14px;
}

.qw-review-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--qw-border);
  padding-bottom: 10px;
}

.qw-review-card__n {
  font: 500 14px/1 'IBM Plex Mono', monospace;
  color: var(--qw-primary);
  font-variant-numeric: tabular-nums;
  margin-right: 12px;
}

.qw-review-card__title {
  font: 800 20px/1.2 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-review-card__edit {
  margin-left: auto;
  background: transparent;
  border: none;
  padding: 6px 10px;
  border-radius: 8px;
  font: 700 13px/1 'Raleway', system-ui, sans-serif;
  color: var(--qw-primary-dark);
  cursor: pointer;
}

.qw-review-card__edit:hover {
  background: var(--qw-primary-tint);
}

.qw-review-card__edit--danger {
  color: #b91c1c;
}

.qw-review-card__edit--danger:hover {
  background: #fef2f2;
}

.qw-review-card__rows {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px 22px;
  margin-top: 14px;
}

.qw-review-card__row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.qw-review-card__k {
  font: 600 12px/16px 'Raleway', system-ui, sans-serif;
  color: var(--qw-faint);
}

.qw-review-card__v {
  font: 400 15px/20px 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
  overflow-wrap: anywhere;
  /* Lets `address_display`/`shipping_address`'s <br>-to-newline conversion
     (see `brJoinedToLines` above) actually render as line breaks — has no
     effect on every other value here, none of which contain newlines. */
  white-space: pre-line;
}

/* The selected-terms checklist needs the full card width, not the 1/3 column
   every other fact-row gets — a run of 20 items crammed into one column reads
   worse than the flattened semicolon-joined string it replaced. */
.qw-review-card__row--full {
  grid-column: 1 / -1;
}

.qw-items-totals-heading {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--qw-border);
}

/* The divider now lives on the heading above, so the totals grid itself
   doesn't need its own — avoids a doubled-up border/gap. */
.qw-items-totals-grid {
  margin-top: 10px;
  padding-top: 0;
  border-top: none;
}

.qw-review-terms-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 7px 22px;
}

.qw-review-terms-list__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font: 400 14px/1.5 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-review-terms-list__item :deep(.lucide) {
  flex: none;
  margin-top: 3px;
  width: 14px;
  height: 14px;
  color: var(--qw-primary);
}

.qw-quotation-items {
  width: 100%;
  border-collapse: collapse;
  margin-top: 16px;
  font: 400 13.5px/1.4 'Raleway', system-ui, sans-serif;
}

.qw-quotation-items th {
  text-align: left;
  font: 600 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--qw-faint);
  padding: 0 10px 8px;
  border-bottom: 1px solid var(--qw-border);
}

.qw-quotation-items td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--qw-row-border);
  color: var(--qw-text);
}

/* Items & Pricing: one row per item, child-table style, instead of a card
   per item — same shell as `.qw-quotation-items` (Review & Submit's own
   read-only items table) but with inline-editable Qty/Description cells and
   a per-row actions cell. */
.qw-pricing-table-wrap {
  overflow-x: auto;
  margin-top: 16px;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
}

.qw-pricing-table {
  margin-top: 0;
  white-space: nowrap;
}

.qw-pricing-table th {
  background: var(--qw-row-border);
  padding: 8px 10px;
  white-space: nowrap;
}

.qw-pricing-table td {
  vertical-align: middle;
}

.qw-pricing-table tbody tr:hover {
  background: var(--qw-row-border);
}

.qw-pricing-table tbody tr:last-child td {
  border-bottom: none;
}

.qw-pricing-table__label {
  font-weight: 600;
}

.qw-pricing-table__num {
  font: 700 13px/1 'IBM Plex Mono', monospace;
}

.qw-pricing-table__final {
  color: var(--qw-primary);
}

.qw-pricing-table td:has(> .qw-inline-input) {
  min-width: 150px;
}

.qw-pricing-table__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.qw-totals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 18px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--qw-border);
}

.qw-totals-box {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.qw-totals-box__k {
  font: 600 12px/16px 'Raleway', system-ui, sans-serif;
  color: var(--qw-faint);
}

.qw-totals-box__v {
  font: 700 14px/1 'IBM Plex Mono', monospace;
  color: var(--qw-text);
  background: var(--qw-row-border);
  border: 1px solid var(--qw-border);
  border-radius: 6px;
  padding: 7px 10px;
}

.qw-inline-input {
  width: 100%;
  min-width: 120px;
  font: 400 13.5px/1.4 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 6px 9px;
}

.qw-inline-input:disabled {
  background: var(--qw-row-border);
  color: var(--qw-faint);
  cursor: not-allowed;
}

.qw-inline-input:focus {
  outline: none;
  border-color: var(--qw-primary);
}

.qw-inline-input--qty {
  width: 72px;
  min-width: 72px;
}

.qw-terms-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px 28px;
}

.qw-term-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--qw-row-border);
  cursor: pointer;
  font: 400 14px/1.4 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-term-item input[type='checkbox'] {
  flex: none;
  width: 16px;
  height: 16px;
  accent-color: var(--qw-primary);
}

.qw-term-item__n {
  flex: none;
  font: 500 12px/1 'IBM Plex Mono', monospace;
  color: var(--qw-faint);
}

.qw-term-item__text {
  min-width: 0;
}

.qw-terms-notes {
  margin-top: 22px;
  padding-top: 20px;
  border-top: 1px solid var(--qw-border);
}

.qw-terms-notes__title {
  margin: 0 0 12px;
  font: 700 15px/1.2 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-submit-badge {
  font: 700 11px/1 'Raleway', system-ui, sans-serif;
  border-radius: 999px;
  padding: 5px 9px;
  text-transform: capitalize;
  white-space: nowrap;
}

.qw-submit-badge--pending {
  background: var(--qw-row-border);
  color: var(--qw-muted);
}

.qw-submit-badge--submitting {
  background: #fff7e6;
  color: #92600a;
}

.qw-submit-badge--succeeded {
  background: #e8f7ee;
  color: #1a7f4b;
}

.qw-submit-badge--failed {
  background: #fef2f2;
  color: #b91c1c;
}

.qw-submit-error-row {
  padding: 0 10px 12px !important;
  font-size: 12.5px;
  color: #b91c1c;
  border-bottom: 1px solid var(--qw-row-border);
}

.qw-item-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.qw-item-tabs__eyebrow {
  font: 700 11px/1 'Raleway', system-ui, sans-serif;
  color: var(--qw-faint);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-right: 4px;
}

.qw-item-tab {
  font: 700 13px/1 'Raleway', system-ui, sans-serif;
  border-radius: 8px;
  padding: 9px 14px;
  cursor: pointer;
  background: #fff;
  color: var(--qw-muted);
  border: 1px solid var(--qw-border);
  display: flex;
  align-items: center;
  gap: 6px;
}

.qw-item-tab:hover {
  background: var(--qw-row-border);
}

.qw-item-tab.is-active {
  background: var(--qw-primary);
  color: #fff;
  border-color: var(--qw-primary);
}

.qw-item-tab__badge {
  color: inherit;
  opacity: 0.85;
}

.qw-step-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 18px;
  font: 800 20px/1.2 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-step-title__n {
  font: 500 14px/1 'IBM Plex Mono', monospace;
  color: var(--qw-primary);
  font-variant-numeric: tabular-nums;
}

.qw-derived {
  min-width: 0;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
  margin-top: 22px;
}

.qw-derived__eyebrow {
  font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.1em;
  color: var(--qw-primary-dark);
}

.qw-derived__hint {
  font: 400 12px/17px 'Raleway', system-ui, sans-serif;
  color: var(--qw-faint);
  margin: 5px 0 14px;
}

.qw-derived__rows {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.qw-derived__row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* Container / Logistics' three load-fit numbers (Units per Container /
   Containers Required / Container Utilization %) read better side by side
   than stacked — the other `.qw-derived__rows` users (Pure Margin etc.)
   keep the default vertical stack. */
.qw-derived__rows--inline {
  flex-direction: row;
}

.qw-derived__rows--inline .qw-derived__row {
  flex: 1;
  min-width: 0;
}

.qw-derived__k {
  font: 600 12px/16px 'Raleway', system-ui, sans-serif;
  color: var(--qw-muted);
}

.qw-derived__v {
  font: 700 14px/1 'IBM Plex Mono', monospace;
  color: var(--qw-text);
  background: var(--qw-row-border);
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 10px 11px;
}

/* Pure Margin % below the required minimum — mirrors the backend's own
   submit-time floor (see MIN_PURE_MARGIN_PERCENT in costingWorksheetWizard.js
   and costing_worksheet.py's _validate_before_submit). */
.qw-derived__row--low .qw-derived__v {
  background: rgba(230, 57, 70, .08);
  border-color: #E63946;
  color: #E63946;
}

.qw-derived__warning {
  font: 600 11.5px/1.4 'Raleway', system-ui, sans-serif;
  color: #E63946;
}

.qw-step-actions {
  margin-top: 16px;
  display: flex;
  gap: 10px;
}

.qw-ghost-btn {
  background: transparent;
  color: var(--qw-muted);
  border: 1px solid var(--qw-border);
  padding: 9px 15px;
  border-radius: 10px;
  font: 600 13.5px/1 'Raleway', system-ui, sans-serif;
  cursor: pointer;
}

.qw-ghost-btn:hover {
  background: var(--qw-row-border);
}

.qw-ghost-btn--dashed {
  background: #fff;
  color: var(--qw-primary-dark);
  border-style: dashed;
  border-color: var(--qw-primary);
}

.qw-step-error {
  color: #e63946;
  font-size: 13px;
  font-weight: 600;
  margin: 18px 0 0;
}

.qw-footer {
  position: sticky;
  bottom: 0;
  margin-top: 18px;
  background: #fff;
  border-top: 1px solid var(--qw-border);
  padding: 14px 4px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  box-shadow: 0 -2px 8px rgba(38, 38, 38, 0.05);
}

.qw-back-btn {
  background: #fff;
  color: var(--qw-primary-dark);
  border: 2px solid var(--qw-primary);
  padding: 11px 20px;
  border-radius: 10px;
  font: 700 14px/1 'Raleway', system-ui, sans-serif;
  cursor: pointer;
}

.qw-back-btn:hover:not(:disabled) {
  background: var(--qw-primary-tint);
}

.qw-back-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.qw-next-btn {
  background: var(--qw-primary);
  color: #fff;
  border: none;
  padding: 11px 22px;
  border-radius: 10px;
  font: 700 14px/1 'Raleway', system-ui, sans-serif;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(11, 52, 101, 0.22);
}

.qw-next-btn:hover:not(:disabled) {
  background: var(--qw-primary-hover);
}

.qw-next-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Re-tint the SDK-rendered form controls (WizardStep -> controlFor(...)) to
   this page's palette, scoped to .qw-wizard only. `:deep()` is required here
   because these inputs are rendered deep inside child/SDK components, not in
   this component's own template. */
.qw-wizard :deep(.frappe-form) {
  --fv-primary: #0B3465;
  --fv-border: #D7DEE8;
  --fv-radius: 5px;
  --app-input-h: 44px;
  --app-label: #33414F;
  --app-muted: #5E6B7A;
  --app-faint: #94A0AE;
  --app-card-border: #D7DEE8;
  --app-row-border: #EDF1F6;
  --app-head-bg: #F4F6F9;
}

/* Read-only "calculated" values (WizardStep read-only-filter="only", e.g.
   the Exim step's rail and the Address step's caption fields) should read
   as clearly as the .qw-derived__v rows do -- same near-black --qw-text,
   not the near-invisible --qw-faint that's meant for placeholder-level hints. */
.qw-wizard :deep(.control input:disabled),
.qw-wizard :deep(.control select:disabled),
.qw-wizard :deep(.control textarea:disabled) {
  background: var(--qw-row-border);
  color: var(--qw-text);
}
</style>
