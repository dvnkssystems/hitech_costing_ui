import { describeFilter } from './docList'
import { quotationNamesInStage } from './home'

/**
 * List filters on a value the server has no field for.
 *
 * A dashboard drill-down must open the list it counted, but some of what the
 * dashboard counts is derived: a Quotation's pipeline stage is the weakest
 * status among its linked Costing Worksheets (see `home.js`), not a column on
 * `tabQuotation`. `?costing_status=Quoted` therefore cannot go to the server as
 * written — it is resolved here, with the same rule the dashboard counted by,
 * into the one thing the server can filter on: the matching record names.
 *
 * Keyed by DocType then by the query param. `resolve(value)` returns a real
 * `[field, op, value]` filter; `label` is what the chip above the list reads.
 */
const DERIVED_FILTERS = {
  Quotation: {
    costing_status: {
      label: 'Costing status',
      resolve: async (stage) => namesFilter(await quotationNamesInStage(stage))
    }
  }
}

/** `name in […]`, or a condition nothing satisfies when the set is empty —
 *  an empty `in` list is not something to leave to the query builder. */
const namesFilter = (names) => (names.length ? ['name', 'in', names] : ['name', '=', ''])

const derivedFor = (doctype, fieldname) => DERIVED_FILTERS[doctype]?.[fieldname] ?? null

/** True for a filter that only exists client-side. */
export const isDerivedFilter = (doctype, [fieldname]) => Boolean(derivedFor(doctype, fieldname))

/** Chip text: the derived filter's own label, not the names it expands to. */
export function describeListFilter(doctype, filter) {
  const derived = derivedFor(doctype, filter[0])
  return derived ? `${derived.label}: ${filter[2]}` : describeFilter(filter)
}

/** The filters as the server can run them. Plain filters pass through as-is. */
export function resolveListFilters(doctype, filters = []) {
  return Promise.all(
    filters.map((filter) => {
      const derived = derivedFor(doctype, filter[0])
      return derived ? derived.resolve(filter[2]) : filter
    })
  )
}
