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
  TAX_FIELDS,
  ADDRESS_FIELDS,
  TERMS_FIELDS,
  TAX_TABLE_FIELD,
  TERMS_TABLE_FIELD,
  GATED_STEP_INDEXES,
  COMMERCIALS_STEP_INDEX,
  stepIsComplete,
  volumesSplitError,
  pureMarginError,
  MIN_PURE_MARGIN_PERCENT,
  taxBasisLabel,
  computeTaxRow
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
import { money, decimal, formatDate, moneyInWords } from '@/utils/format'

const DOCTYPE = 'Costing Worksheet'
const HEADER_DOCTYPE = 'Quotation'

const PAGE_STEPS = [
  { key: 'customer', title: 'Customer & Order' },
  { key: 'items', title: 'Costing Sheet' },
  { key: 'pricing', title: 'Items & Pricing' },
  { key: 'taxes', title: 'Taxes & Charges' },
  { key: 'address', title: 'Address & Delivery' },
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

function reviewDisplayValue(df, raw) {
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
      return String(raw)
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
      return { label: df.label || fieldname, value: reviewDisplayValue(df, frm.doc?.[fieldname]) }
    })
    .filter(Boolean)
}

const taxReviewRows = computed(() => {
  const rows = sectionRows(quotationHeaderFrm.value, TAX_FIELDS)
  if (taxRows.value.length) rows.push({ label: 'Estimated tax total', value: money(taxTotalRaw.value) })
  return rows
})
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
  { key: 'customer', n: '01', title: 'Customer & Order', rows: sectionRows(orderFrm.value, SHARED_STEP.fields) },
  { key: 'taxes', n: '02', title: 'Taxes & Charges', rows: taxReviewRows.value },
  { key: 'address', n: '03', title: 'Address & Delivery', rows: sectionRows(quotationHeaderFrm.value, ADDRESS_FIELDS) },
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
      submitState: item.submitState
    }
  })
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
  return { totalQuantity, total: money(total), netTotal: money(total), totalRaw: total }
})

/* ── Taxes & Charges step ────────────────────────────────────────────────── */

const taxTemplateRows = ref([])
const taxTemplateLoading = ref(false)
const taxTemplateError = ref('')

/** Taxable value the Taxes step previews against — items total less the
 *  Address & Delivery step's discount. Reactive to both even though discount
 *  is entered on a LATER step: the design's own footnote calls this out, and
 *  Vue's reactivity doesn't care about wizard step order either way. */
const discountAmount = computed(() => {
  const percent = Number(quotationHeaderFrm.value?.doc?.additional_discount_percentage) || 0
  return (itemsSummary.value.totalRaw * percent) / 100
})
const taxableValue = computed(() => Math.max(0, itemsSummary.value.totalRaw - discountAmount.value))

/** Re-fetches the chosen template's raw rows and stages them onto the
 *  throwaway header frm's real `taxes` table whenever the template changes —
 *  see `TAX_TABLE_FIELD`'s doc comment for why staging real rows (not just
 *  the template name) is what makes the eventual Quotation actually charge
 *  tax. */
watch(
  () => quotationHeaderFrm.value?.doc?.taxes_and_charges,
  async (templateName) => {
    const frm = quotationHeaderFrm.value
    if (!frm) return
    frm.clear_table(TAX_TABLE_FIELD)
    taxTemplateRows.value = []
    taxTemplateError.value = ''
    if (!templateName) return
    taxTemplateLoading.value = true
    try {
      const rows = await call('erpnext.controllers.accounts_controller.get_taxes_and_charges', {
        master_doctype: 'Sales Taxes and Charges Template',
        master_name: templateName
      })
      // `get_taxes_and_charges` strips `idx` along with every other
      // house-keeping field — reconstruct it (1-based) from list order, the
      // same order the source template's own child table iterated in, since
      // `computeTaxRow`'s "previous row" charge types chase `row_id` against
      // it.
      const list = (Array.isArray(rows) ? rows : []).map((row, i) => ({ ...row, idx: i + 1 }))
      for (const row of list) frm.add_child(TAX_TABLE_FIELD, row)
      taxTemplateRows.value = list
    } catch (e) {
      taxTemplateError.value = e?.message ?? String(e)
    } finally {
      taxTemplateLoading.value = false
    }
  }
)

const taxRows = computed(() =>
  taxTemplateRows.value.map((row, i) => ({
    key: row.name || row.idx || i,
    label: row.description || row.account_head || row.charge_type,
    rate: decimal(row.rate),
    basis: taxBasisLabel(row.charge_type),
    amount: computeTaxRow(row, taxTemplateRows.value, taxableValue.value)
  }))
)
const taxTotalRaw = computed(() => taxRows.value.reduce((sum, r) => sum + r.amount, 0))

/** Client-side preview of the real Quotation's own Grand Total / Rounding /
 *  In Words fields — no real Quotation exists yet at this point for a
 *  brand-new wizard run, so these mirror ERPNext's own math (grand total =
 *  net total + taxes; rounded total = nearest rupee unless disabled; rounding
 *  adjustment = the difference) against the client-side `taxRows` above,
 *  rather than reading server-computed fields. */
const grandTotalRaw = computed(() => taxableValue.value + taxTotalRaw.value)
const disableRoundedTotal = computed(() => Boolean(quotationHeaderFrm.value?.doc?.disable_rounded_total))
const roundedTotalRaw = computed(() => (disableRoundedTotal.value ? grandTotalRaw.value : Math.round(grandTotalRaw.value)))
const roundingAdjustmentRaw = computed(() => roundedTotalRaw.value - grandTotalRaw.value)
const totalsInWords = computed(() => moneyInWords(roundedTotalRaw.value))

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

/** Whether any field in `step` is read-only for `frm` — i.e. worth its own
 *  calculated-values rail. */
function derivedFieldnames(step, frm) {
  if (!frm) return []
  return step.fields.filter((fieldname) => frm.fields_dict?.[fieldname]?.df?.read_only)
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
 * Deliberately skips `sectionRows`'s `fieldState(...).visible` check rather
 * than reusing it outright: every field `derivedFieldnames` selects is
 * `read_only` with no `depends_on` anywhere in the DocType (verified against
 * the JSON — none of Commercials/Summary's derived fields are ever
 * conditionally hidden), so that check can only ever ADD risk here, not
 * value — `fieldState` throwing on a field mid-recalculation (or any other
 * transient SDK hiccup) would otherwise silently drop an otherwise-always-
 * visible row instead of just showing its current value.
 */
function derivedRows(frm, fieldnames) {
  if (!frm) return []
  return fieldnames
    .map((fieldname) => {
      const df = frm.fields_dict?.[fieldname]?.df
      if (!df) return null
      const low = fieldname === 'pure_margin_percent' && Number(frm.doc?.[fieldname] ?? 0) < MIN_PURE_MARGIN_PERCENT
      return { label: df.label || fieldname, value: reviewDisplayValue(df, frm.doc?.[fieldname]), low }
    })
    .filter(Boolean)
}
const activeItemDerivedRows = computed(() =>
  activeItem.value && activeItemStep.value
    ? derivedRows(activeItem.value.frm, derivedFieldnames(activeItemStep.value, activeItem.value.frm))
    : []
)

const wizardEl = ref(null)
let teardownEnhancements = null
const currentFrm = computed(() => {
  if (activePageStep.value === 'customer') return orderFrm.value
  if (activePageStep.value === 'items') return activeItem.value?.frm ?? null
  if (['taxes', 'address', 'terms'].includes(activePageStep.value)) return quotationHeaderFrm.value
  return null
})
watch(wizardEl, (el) => {
  teardownEnhancements?.()
  teardownEnhancements = el ? installFormEnhancements(el, () => currentFrm.value) : null
})
onBeforeUnmount(() => teardownEnhancements?.())

/** Filters `customer_address`/`shipping_address_name` on the throwaway
 *  Quotation frm to the wizard's own customer — same `frm.set_query` idiom
 *  the real Costing Worksheet client script already uses for `tank_type`. */
function addressQueryScript(frappe) {
  frappe.ui.form.on(HEADER_DOCTYPE, {
    setup(frm) {
      const filters = () => ({ filters: { link_doctype: 'Customer', link_name: orderFrm.value?.doc?.customer } })
      frm.set_query('customer_address', filters)
      frm.set_query('shipping_address_name', filters)
    }
  })
}

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
      quotationHeaderFrm.value = await bootFrm(HEADER_DOCTYPE, {
        initialDoc: { doctype: HEADER_DOCTYPE },
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
        ...TAX_FIELDS,
        TAX_TABLE_FIELD,
        ...ADDRESS_FIELDS,
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
      item.submitState = 'succeeded'
    } catch (e) {
      item.submitState = 'failed'
      item.submitError = e?.message ?? String(e)
      submitPhase.value = 'partial-failure'
      return
    }
  }
  submitPhase.value = 'done'
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
                      <span v-if="row.low" class="qw-derived__warning">Below the {{ MIN_PURE_MARGIN_PERCENT }}% minimum</span>
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
            <table class="qw-quotation-items">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Weight (kg)</th>
                  <th>Built-up cost</th>
                  <th>Deal price</th>
                  <th>Margin %</th>
                  <th>Total deal value</th>
                  <th>Description</th>
                  <th>Quantity</th>
                  <th>Final amount</th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in itemsPricingRows" :key="row.key">
                  <td>{{ row.label }}</td>
                  <td>{{ row.weight }}</td>
                  <td>{{ row.builtUpCost }}</td>
                  <td>{{ row.dealPrice }}</td>
                  <td>{{ row.marginPercent }}</td>
                  <td>{{ row.totalDealValue }}</td>
                  <td>
                    <input
                      type="text"
                      class="qw-inline-input"
                      v-model="row.item.description"
                      :disabled="row.item.frm.docstatus === 1"
                      :placeholder="`${row.label} tank — as per Costing Worksheet`"
                    />
                  </td>
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
                  <td>{{ row.finalAmount }}</td>
                  <td>
                    <button type="button" class="qw-review-card__edit" @click="goToItem(row.key)">Costing →</button>
                  </td>
                  <td>
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
            <div class="qw-step-actions">
              <button type="button" class="qw-ghost-btn qw-ghost-btn--dashed" @click="addItem()">
                + Add item — opens a new costing sheet
              </button>
            </div>

            <div class="qw-totals-grid">
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
            </div>
          </div>
          <div class="qw-footer">
            <button type="button" class="qw-back-btn" @click="pageBack">← Back</button>
            <button type="button" class="qw-next-btn" @click="pageNext">Next</button>
          </div>
        </section>

        <!-- 04 · Taxes & charges (shared, once) -->
        <section v-else-if="activePageStep === 'taxes'">
          <div class="qw-step-card">
            <h2 class="qw-step-title"><span class="qw-step-title__n">04</span>Taxes & Charges</h2>
            <p v-if="quotationName" class="qw-step-lede">
              Editing taxes on <strong>{{ quotationName }}</strong> directly — use Save Changes below to apply changes.
            </p>
            <WizardStep :frm="quotationHeaderFrm" :fields="['taxes_and_charges']" read-only-filter="exclude" />
            <div v-if="taxTemplateError" class="qw-step-error">{{ taxTemplateError }}</div>
            <p v-else-if="taxTemplateLoading" class="qw-step-lede" style="margin-top: 18px;">Loading tax template…</p>
            <template v-else>
              <template v-if="taxRows.length">
                <table class="qw-quotation-items" style="margin-top: 18px;">
                  <thead>
                    <tr>
                      <th>Charge</th>
                      <th>Rate</th>
                      <th>On</th>
                      <th>Amount ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in taxRows" :key="row.key">
                      <td>{{ row.label }}</td>
                      <td>{{ row.rate }} %</td>
                      <td>{{ row.basis }}</td>
                      <td>{{ money(row.amount) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p class="qw-step-lede" style="margin-top: 14px;">
                  Charges compute on the taxable value — item amount less discount (set in Address & Delivery).
                </p>
              </template>
              <div class="qw-totals-grid" style="margin-top: 18px;">
                <div class="qw-totals-box">
                  <span class="qw-totals-box__k">Total Taxes and Charges (INR)</span>
                  <span class="qw-totals-box__v">{{ money(taxTotalRaw) }}</span>
                </div>
                <div class="qw-totals-box">
                  <span class="qw-totals-box__k">Grand Total (INR)</span>
                  <span class="qw-totals-box__v">{{ money(grandTotalRaw) }}</span>
                </div>
                <div v-if="!disableRoundedTotal" class="qw-totals-box">
                  <span class="qw-totals-box__k">Rounding Adjustment (INR)</span>
                  <span class="qw-totals-box__v">{{ money(roundingAdjustmentRaw) }}</span>
                </div>
                <div class="qw-totals-box">
                  <span class="qw-totals-box__k">Rounded Total (INR)</span>
                  <span class="qw-totals-box__v">{{ money(roundedTotalRaw) }}</span>
                </div>
              </div>
              <WizardStep
                :frm="quotationHeaderFrm"
                :fields="['disable_rounded_total']"
                read-only-filter="exclude"
                style="margin-top: 12px;"
              />
              <p class="qw-step-lede" style="margin-top: 10px;"><strong>In Words:</strong> {{ totalsInWords }}</p>
            </template>
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

        <!-- 05 · Address & delivery (shared, once) -->
        <section v-else-if="activePageStep === 'address'">
          <div class="qw-step-card">
            <h2 class="qw-step-title"><span class="qw-step-title__n">05</span>Address & Delivery</h2>
            <p v-if="quotationName" class="qw-step-lede">
              Editing delivery details on <strong>{{ quotationName }}</strong> directly — use Save Changes below to apply changes.
            </p>
            <WizardStep :frm="quotationHeaderFrm" :fields="ADDRESS_FIELDS" read-only-filter="exclude" />
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
}

/* The selected-terms checklist needs the full card width, not the 1/3 column
   every other fact-row gets — a run of 20 items crammed into one column reads
   worse than the flattened semicolon-joined string it replaced. */
.qw-review-card__row--full {
  grid-column: 1 / -1;
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

.qw-totals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px 22px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--qw-border);
}

.qw-totals-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.qw-totals-box__k {
  font: 600 12px/16px 'Raleway', system-ui, sans-serif;
  color: var(--qw-faint);
}

.qw-totals-box__v {
  font: 700 15px/1 'IBM Plex Mono', monospace;
  color: var(--qw-text);
  background: var(--qw-row-border);
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 11px 12px;
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

.qw-wizard :deep(.control input:disabled),
.qw-wizard :deep(.control select:disabled),
.qw-wizard :deep(.control textarea:disabled) {
  background: var(--qw-row-border);
  color: var(--qw-faint);
}
</style>
