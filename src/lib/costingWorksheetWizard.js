/**
 * Step layout for the Costing Worksheet wizard.
 *
 * A phone-setup-style alternative to the generic card form for one DocType:
 * fill the worksheet a few fields at a time instead of one long page, each
 * step unlocking the next. The field groupings below are hand-picked for how
 * an estimator actually fills this document (see docs/quotation-wizard-flow.md
 * in the hitech_costing app) — they do not follow the DocType's own Section
 * Break labels the way `formSections.js` does for the generic form.
 *
 * Split into three shapes because the wizard now builds one Quotation from
 * SEVERAL Costing Worksheets in one sitting (see CostingWorksheetWizard.vue):
 *
 *   - `SHARED_STEP` — filled once, applied to every item (these fields don't
 *     exist per-item on the backend).
 *   - `ITEM_STEPS` — the per-item costing sheet, one full pass per product;
 *     whichever item tab is active runs through these.
 *   - `TAX_FIELDS` / `ADDRESS_FIELDS` / `TERMS_FIELDS` — real, standard
 *     Quotation fields (ERPNext core, plus this app's own
 *     `hitech_port_of_discharge`), filled once against a throwaway Quotation
 *     frm and only actually written to a document once the first item's
 *     `submit_and_map` creates the real Quotation.
 *
 * `ITEM_STEPS`' first (`product`) and third (`volumes`) and last
 * (`commercials`) entries carry fields that can ever be mandatory on
 * `Costing Worksheet` (checked against the DocType JSON) — `volumes`'
 * mandatory field is on the child table's own DocType (Finished Weight (kg)
 * per row), not on the Costing Worksheet doc itself, which is why it's easy
 * to miss. The rest have none, so their "Next" never needs a completeness
 * gate.
 */

export const SHARED_STEP = {
  key: 'customer',
  title: 'Customer & Order',
  // 'opportunity' and 'company' dropped: 'opportunity' isn't a real field on
  // Costing Worksheet (was rendering as a dead fallback text box), and
  // 'company' is auto-defaulted by the backend from Global Defaults when
  // left unset (see costing_worksheet.py's on-save default), so it doesn't
  // need a wizard input.
  fields: ['customer', 'rating_mva', 'rating_kv', 'region']
}

export const ITEM_STEPS = [
  {
    key: 'product',
    title: 'Product Line',
    fields: [
      'tank_type',
      'labour_rate_source',
      'manual_labour_rate_inr_per_kg',
      'labour_override_reason',
      'labour_rate_inr_per_kg'
    ]
  },
  {
    key: 'dimensions',
    title: 'Dimensions',
    fields: [
      'length_mm',
      'width_mm',
      'height_mm',
      'ext_length_mm',
      'ext_width_mm',
      'ext_height_mm',
      'internal_surface_area_sqm',
      'external_surface_area_sqm'
      // Mode of Transport / Container Type and the container-load-fit
      // numbers (`units_per_container`, `containers_required`,
      // `container_utilization_percent`) used to live here too, but moved to
      // a "Container / Logistics" sub-section on the page-level Items &
      // Pricing step (see CostingWorksheetWizard.vue's `activePageStep ===
      // 'pricing'` branch) — that's the page where an item's order Quantity
      // actually gets typed in, so seeing container fit right there beats a
      // step four pages earlier. Same fields, same DocType, same
      // `mode_of_transport == "Sea"` `depends_on` gating on
      // `container_type`/the three fit numbers; just relocated.
    ]
  },
  {
    key: 'volumes',
    title: 'Volumes & Weights',
    fields: [
      'volumes',
      'tank_weight_kg',
      'accessory_weight_kg',
      'total_weight_kg',
      'total_material_cost',
      'material_cost_inr_kg',
      'accessory_content_percent',
      'fabrication_class',
      'fabrication_multiplier'
    ]
  },
  {
    key: 'paint',
    title: 'Paint System',
    fields: [
      'paint_method',
      'paint_make',
      'dft_internal',
      'dft_external',
      'accessory_surface_internal_sqm',
      'accessory_surface_external_sqm',
      'internal_paint_price_sqm',
      'external_paint_price_sqm',
      'derived_internal_paint_cost',
      'derived_external_paint_cost',
      'total_paint_cost',
      'paint_cost_inr_kg'
    ]
  },
  {
    key: 'complexity',
    title: 'Complexity',
    fields: [
      'complexity_ratings',
      'order_complexity_score',
      'order_complexity_class',
      'order_complexity_multiplier',
      // "Processing and Labour" on the real DocType: its own Section Break,
      // but every field in it is read_only (computed from the complexity
      // multiplier above and step 1's labour rate) — no input of its own to
      // warrant a step, so it rides along here as more calculated values.
      'packaging_consumable_inr_kg',
      'processing_consumable_inr_kg',
      'repair_maintenance_inr_kg',
      'energy_utilities_inr_kg',
      'total_processing_cost_inr_kg',
      'labour_cost_inr_kg'
    ]
  },
  {
    key: 'commercials',
    title: 'Commercials',
    fields: [
      'deal_price_fg_inr_per_kg',
      // 'payment_terms_days' and 'transport_rate_inr_per_kg' hidden on
      // request — not needed for this workflow. Left as real fields on the
      // DocType (and still contribute to Total Freight if ever set via the
      // desk form directly); just not shown in this step.
      'sea_freight_rate_inr_per_kg',
      'total_freight_inr_kg',
      // Container-load-fit numbers moved off ITEM_STEPS entirely, onto the
      // page-level Items & Pricing step's "Container / Logistics"
      // sub-section (see CostingWorksheetWizard.vue) — that's where
      // Container Type itself is now picked.
      'financial_cost_inr_kg',
      // The item's final built-up cost and margin — this is the last per-item
      // step, so its calculated-values rail is where "what does this item's
      // costing actually come out to" belongs, same numbers the old
      // (now page-level) Review & Submit step used to show.
      'total_fg_cost_inr_kg',
      'pure_margin_inr_kg',
      'pure_margin_percent',
      'total_fg_cost',
      'total_deal_value',
      'total_margin'
    ]
  }
]

/** Real, standard Quotation fields (ERPNext core) covering taxes, address and
 *  delivery — see `QUOTATION_HEADER_FIELDS` in the backend's
 *  `costing_worksheet.py`, which this must stay in sync with.
 *
 *  `disable_rounded_total` is the one exception: the backend allowlist
 *  doesn't cover it yet, so toggling it before a Quotation exists previews
 *  the rounding math client-side (see CostingWorksheetWizard.vue's totals
 *  block) but won't carry into the Quotation the first item creates —
 *  it only actually persists once resuming/editing a Quotation that
 *  already exists, via the Taxes step's own Save Changes. */
/** `custom_type` (Tank/Radiator) on Quotation — chosen on the "What type of
 *  quotation?" screen (QuotationNewView.vue) before the wizard even opens,
 *  since there's no per-item reason to ask twice. Both values run this same
 *  wizard (Radiator is just a different Tank Type record, e.g. "Radiator
 *  Line"), and the choice rides through to `quotationHeaderFrm`'s initial
 *  doc via `takePendingDoc('Quotation')` (see CostingWorksheetWizard.vue,
 *  falling back to "Tank" if the wizard is opened without going through that
 *  screen) — this list exists so that value actually gets picked up and sent
 *  as part of `quotation_header` on submit, same as every other real header
 *  field below. */
export const TYPE_FIELDS = ['custom_type']
export const TAX_FIELDS = ['taxes_and_charges', 'disable_rounded_total']
export const ADDRESS_FIELDS = [
  'customer_address',
  // Real, read-only core Quotation field — the formatted address text the
  // real desk form shows under "Customer Address" on its own Address &
  // Contact tab. CostingWorksheetWizard.vue keeps it filled in the same way
  // core Frappe does (`frappe.utils.get_address_display`): re-fetched
  // whenever `customer_address` changes.
  'address_display',
  'shipping_address_name',
  // Same pairing for the shipping side — core fieldname is `shipping_address`
  // (not `shipping_address_name_display` or similar), despite sharing a label
  // with the Link field above it.
  'shipping_address',
  'additional_discount_percentage'
]
/** The Exim / Incoterms step's fields — the freight-calc custom field set
 *  added to Quotation/Sales Order by the backend's Phase 1
 *  (`hitech_costing/setup/install.py`'s `EXIM_FIELDS`, which this must stay
 *  in sync with, along with `QUOTATION_HEADER_FIELDS` in
 *  `costing_worksheet.py`). `incoterm`/`named_place`/`hitech_port_of_discharge`
 *  used to live in `ADDRESS_FIELDS` above; moved here now that Exim exists as
 *  its own step/concept.
 *
 *  `hitech_region` (Domestic/Export) now lives directly on Quotation/Sales
 *  Order too, right after `named_place` — the freight engine reads THIS
 *  field, not the Costing Worksheet's own `region` (that field only ever
 *  drove the wizard's Items & Pricing step Container Type gating, a
 *  different doc entirely). `hitech_vehicle_type`/`hitech_domestic_destination`
 *  (Domestic) and `hitech_sector`/`hitech_basic_freight` (Export) now carry
 *  real native `depends_on` on `hitech_region`, same frm as everything else
 *  here — so, like every Incoterm-gated field below (insurance, ports,
 *  pre-carriage, destination costs), they need no client-side gating logic
 *  at all (see `WizardStep.vue`'s `isVisible`). CostingWorksheetWizard.vue's
 *  `visibleEximFields` used to cross-filter these off the Costing Worksheet
 *  frm's `region` before `hitech_region` existed; simplified now that it
 *  doesn't need to. */
export const EXIM_FIELDS = [
  'incoterm',
  'named_place',
  'hitech_region',
  'hitech_country_of_origin',
  'hitech_country_of_destination',
  'hitech_domestic_destination',
  'hitech_mode_of_transport',
  'hitech_vehicle_type',
  'hitech_port_of_loading',
  'hitech_port_of_discharge',
  'hitech_pre_carriage_by',
  'hitech_place_of_pre_carrier',
  'hitech_insurance_percent',
  'hitech_insurance_value',
  'hitech_insurance_cost',
  'hitech_destination_inland_cost',
  'hitech_unloading_cost_at_destination',
  'hitech_import_duty_tax',
  'hitech_total_gross_weight_kg',
  'hitech_partial_shipment',
  'hitech_trans_shipment',
  'hitech_sector',
  'hitech_basic_freight',
  'hitech_containers_override',
  'hitech_containers_estimated',
  'hitech_containers_applied',
  'hitech_freight_rate_source',
  'hitech_total_freight_cost',
  'hitech_fob_cost_applied',
  'hitech_region_margin_applied',
  'hitech_freight_inr_per_kg',
  // "Currency Conversion" section (backend Phase 2) — every one of these is
  // `read_only`, engine-computed alongside the freight numbers above, so
  // they all land in the Exim step's Calculated rail. The CIF/DAP legs are
  // priced in `hitech_freight_currency` (the Freight Master's own currency)
  // and converted to INR at that quarter's Currency Exchange Master rate;
  // `hitech_exchange_rate_flags` is non-empty whenever a quarter's rate is
  // missing — that leg is then 0 INR, never silently 1:1 — and the wizard
  // renders it as a warning block rather than a plain rail row. The two
  // Item Deal Value figures only fill once the linked worksheets are saved.
  'hitech_freight_currency',
  'hitech_cif_leg_native',
  'hitech_cif_exchange_rate',
  'hitech_cif_leg_inr',
  'hitech_dap_addon_native',
  'hitech_dap_exchange_rate',
  'hitech_dap_addon_inr',
  'hitech_item_deal_value_inr',
  'hitech_item_exchange_rate',
  'hitech_item_deal_value_fc',
  'hitech_exchange_rate_flags'
]
/** The quote's own currency trio — real, standard Quotation fields (ERPNext
 *  core), edited at the top of the Exim / Incoterms step and staged on the
 *  same throwaway Quotation header frm as everything else there. `currency`
 *  is what the Item Deal Value (FC) figure above is expressed in;
 *  `conversion_rate` is ERPNext's own quote→company-currency rate (kept at 1
 *  for INR, otherwise looked up via `erpnext.setup.utils.get_exchange_rate`
 *  when blank — see CostingWorksheetWizard.vue); `transaction_date` picks
 *  which quarter's Currency Exchange Master rates the freight engine uses. */
export const CURRENCY_FIELDS = ['currency', 'conversion_rate', 'transaction_date']
/**
 * The currency field ALSO offered on the Items & Pricing step.
 *
 * Same core `currency` field as `CURRENCY_FIELDS` above, one frm, one value --
 * just a second control. The item is priced on Items & Pricing (step 03) but
 * the currency trio lives on Exim (step 05), so an estimator pricing an
 * export job had no way to choose the customer's currency until after the
 * pricing step, and the converted Item Deal Value below the totals looked
 * simply absent. Conversion rate and transaction date stay on Exim only:
 * they belong with the CIF/DAP legs that read them.
 */
export const ITEMS_CURRENCY_FIELDS = ['currency']
/** The one `EXIM_FIELDS` entry that is NOT rendered as a Calculated-rail
 *  row — see the Exim step's own warning block in CostingWorksheetWizard.vue. */
export const EXIM_FLAGS_FIELD = 'hitech_exchange_rate_flags'
/** The two engine-computed Item Deal Value fields (INR and quote currency)
 *  that stay 0 until at least one linked Costing Worksheet has been saved. */
export const EXIM_ITEM_DEAL_VALUE_FIELDS = ['hitech_item_deal_value_inr', 'hitech_item_deal_value_fc']
/** The Terms step's free-text box — a real custom field (`hitech_terms_notes`,
 *  see `costing_worksheet.py`'s `QUOTATION_HEADER_FIELDS` and the backend's
 *  `setup/install.py`). The step's 26-item checklist isn't a flat field
 *  list — it's the `hitech_quotation_terms` Table field, built and staged
 *  directly by CostingWorksheetWizard.vue rather than through `WizardStep`.
 *  Supersedes the old single `tc_name` template picker for this flow;
 *  `tc_name` itself still exists on Quotation, just isn't part of the wizard. */
export const TERMS_FIELDS = ['hitech_terms_notes']
/** The standard Quotation child table the Taxes step stages real tax rows
 *  onto (fetched from the chosen `taxes_and_charges` template) — see
 *  `computeTaxRow` below for the client-side preview math, and
 *  `QUOTATION_HEADER_FIELDS` for why staging real rows (not just the
 *  template name) is what makes the real Quotation actually charge tax. */
export const TAX_TABLE_FIELD = 'taxes'
/** The custom child table the Terms step's checklist selection is staged
 *  onto — one row per `Quotation Term` master record. */
export const TERMS_TABLE_FIELD = 'hitech_quotation_terms'

/** Only these ITEM_STEPS can ever have a mandatory field — see the file header. */
export const GATED_STEP_INDEXES = new Set([0, 2, 5])

/** Index of the last item step (Commercials) — the only point a per-item save happens. */
export const COMMERCIALS_STEP_INDEX = ITEM_STEPS.length - 1

const isEmpty = (value) => value === undefined || value === null || value === ''

/**
 * Whether every row of a Table field has its own mandatory child fields
 * filled — the row-level counterpart of the mandatory check below, which
 * only ever sees the Table field itself (i.e. "does it have rows"), not
 * what's mandatory on its child DocType. Static `reqd` only: rows don't go
 * through `fieldState`-style `mandatory_depends_on` evaluation here, since
 * `volumes` (the only case today) doesn't use it.
 */
function tableRowsComplete(frm, fieldname) {
  const doctype = frm.fields_dict?.[fieldname]?.df?.options
  const meta = doctype ? frm.frappe?.get_meta?.(doctype) : null
  const rows = frm.doc?.[fieldname]
  if (!meta || !Array.isArray(rows)) return true

  const mandatoryFields = (meta.fields ?? []).filter((df) => df.reqd)
  if (!mandatoryFields.length) return true
  return rows.every((row) => mandatoryFields.every((df) => !isEmpty(row[df.fieldname])))
}

/**
 * Whether every mandatory, currently-visible field in `step` has a value.
 *
 * Uses the SDK's own `fieldState` so `depends_on` / `mandatory_depends_on`
 * (the Manual Override pair in the Product Line step) are honoured without
 * special-casing — a field the form is not showing can never block Next.
 *
 * Takes an arbitrary `frm`/`step` pair, so it works the same whether `frm` is
 * the shared order frm, one item's frm, or (never gated today, but harmless)
 * the throwaway Quotation header frm.
 */
export function stepIsComplete(frm, step, fieldState) {
  return step.fields.every((fieldname) => {
    const df = frm.fields_dict?.[fieldname]?.df
    if (!df) return true
    if (df.fieldtype === 'Table') return tableRowsComplete(frm, fieldname)
    const state = fieldState(frm, df)
    if (!state.mandatory) return true
    return !isEmpty(frm.doc[fieldname])
  })
}

/**
 * Mirrors the backend's submit-time check (`costing_worksheet.py`,
 * `submit_and_map`) that Tank Weight + Accessory Weight reconcile with the
 * Volumes table's Total Finished Weight. Run here too, on the Volumes &
 * Weights step itself, so a mismatch is caught before an estimator fills in
 * the rest of the item and only learns about it at Review & Submit — see the
 * matching wiring in `itemNext()` in CostingWorksheetWizard.vue.
 */
export function volumesSplitError(frm) {
  const tank = Number(frm.doc?.tank_weight_kg) || 0
  const accessory = Number(frm.doc?.accessory_weight_kg) || 0
  const total = Number(frm.doc?.total_weight_kg) || 0
  const split = tank + accessory
  if (Math.abs(split - total) < 0.005) return ''
  return `Tank Weight (${tank.toFixed(2)} kg) + Accessory Weight (${accessory.toFixed(2)} kg) = ${split.toFixed(2)} kg, which does not match Total Finished Weight (${total.toFixed(2)} kg) from the Volumes table. Fix the split before continuing.`
}

/** Mirrors the backend's submit-time check (`costing_worksheet.py`,
 *  `_validate_before_submit`'s `MIN_PURE_MARGIN_PERCENT` guard) that Pure
 *  Margin % never goes to submission below the floor. Run here too, on the
 *  Commercials step itself, so a thin-or-negative margin is caught before
 *  "Save item" instead of only at Review & Submit. */
export const MIN_PURE_MARGIN_PERCENT = 20

export function pureMarginError(frm) {
  const percent = Number(frm.doc?.pure_margin_percent) || 0
  if (percent >= MIN_PURE_MARGIN_PERCENT) return ''
  return `Pure Margin % (${percent.toFixed(2)}%) is below the minimum required margin of ${MIN_PURE_MARGIN_PERCENT}%. Increase Deal Price - FG or reduce cost before continuing.`
}

/* ── Taxes & Charges step ────────────────────────────────────────────────── */

/** Human label for a tax row's basis column — mirrors ERPNext's own
 *  `charge_type` options, just worded for the wizard's read-only table. */
export function taxBasisLabel(chargeType) {
  return (
    {
      'On Net Total': 'Taxable value',
      Actual: 'Actual',
      'On Previous Row Amount': 'Previous row amount',
      'On Previous Row Total': 'Previous row total',
      'On Item Quantity': 'Item quantity'
    }[chargeType] ?? chargeType ?? '—'
  )
}

/**
 * A PREVIEW amount for one tax row — not what actually gets charged. The
 * wizard only ever knows its own local estimate of the taxable value (items
 * total, less the discount entered on a later step); the real Quotation's
 * `tax_amount` is recomputed authoritatively by ERPNext's own
 * `calculate_taxes_and_totals` once the real Quotation Items exist (see
 * `QUOTATION_HEADER_FIELDS` in `costing_worksheet.py`). This exists purely so
 * the estimator sees a plausible number while building the quote.
 *
 * `rows` are the raw dicts `erpnext.controllers.accounts_controller.
 * get_taxes_and_charges` returns for the chosen template (`charge_type`,
 * `rate`, `row_id`, ...). `row_id` is the 1-based `idx` of an earlier row in
 * the SAME list for the two "previous row" charge types.
 */
export function computeTaxRow(row, rows, taxableValue) {
  const rate = Number(row.rate) || 0
  switch (row.charge_type) {
    case 'Actual':
      return Number(row.tax_amount) || 0
    case 'On Previous Row Amount': {
      const prevRow = rows.find((r) => r.idx === row.row_id)
      return prevRow ? (computeTaxRow(prevRow, rows, taxableValue) * rate) / 100 : 0
    }
    case 'On Previous Row Total': {
      const priorRows = rows.filter((r) => r.idx < row.idx)
      const runningTotal = taxableValue + priorRows.reduce((sum, r) => sum + computeTaxRow(r, rows, taxableValue), 0)
      return (runningTotal * rate) / 100
    }
    case 'On Net Total':
    default:
      return (taxableValue * rate) / 100
  }
}
