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
 * Steps 1, 2, 4 and 7 carry fields that can ever be mandatory on
 * `Costing Worksheet` (checked against the DocType JSON) — step 4's mandatory
 * field is on the `volumes` child table's own DocType (Finished Weight (kg)
 * per row), not on the Costing Worksheet doc itself, which is why it's easy to
 * miss. Steps 3, 5 and 6 have none, so their "Next" never needs a
 * completeness gate.
 */

export const WIZARD_STEPS = [
  {
    key: 'customer',
    title: 'Customer & Order',
    fields: ['customer', 'opportunity', 'company', 'rating_mva_kv', 'region']
  },
  {
    key: 'product',
    title: 'Product Line',
    fields: [
      'tank_type',
      'facility',
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
      // multiplier above and step 2's labour rate) — no input of its own to
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
      'payment_terms_days',
      'transport_rate_inr_per_kg',
      'sea_freight_rate_inr_per_kg',
      'total_freight_inr_kg',
      'financial_cost_inr_kg'
    ]
  },
  {
    key: 'review',
    title: 'Review & Submit',
    fields: [
      'total_fg_cost_inr_kg',
      'pure_margin_inr_kg',
      'pure_margin_percent',
      'total_fg_cost',
      'total_deal_value',
      'total_margin'
    ]
  }
]

export const REVIEW_STEP_INDEX = WIZARD_STEPS.length - 1

/** Only these steps can ever have a mandatory field — see the file header. */
export const GATED_STEP_INDEXES = new Set([0, 1, 3, 6])

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
 * (the Manual Override pair in step 2) are honoured without special-casing —
 * a field the form is not showing can never block Next.
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
