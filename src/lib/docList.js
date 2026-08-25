import { call } from './frappe'
import { db } from './frappeDb'

export const LIST_PAGE_SIZE = 20

/** Layout fieldtypes and anything that can't sit in a table cell. */
const NON_COLUMN_FIELDTYPES = new Set([
  'Section Break',
  'Column Break',
  'Tab Break',
  'Table',
  'Table MultiSelect',
  'HTML',
  'Button',
  'Heading',
  'Fold',
  'Text Editor',
  'Code',
  'Signature',
  'Geolocation',
  'Image',
  'Attach Image'
])

/** Fetch a DocType's meta straight from the desk endpoint. */
export async function fetchDocTypeMeta(doctype) {
  const result = await call('frappe.desk.form.load.getdoctype', { doctype })
  const docs = Array.isArray(result?.docs) ? result.docs : []
  // Mirror it into locals so the form view and DocConnections can reuse it.
  const locals = (globalThis.locals ??= {})
  const store = (locals.DocType ??= {})
  for (const doc of docs) if (doc?.name) store[doc.name] = doc
  return docs.find((d) => d.name === doctype) ?? null
}

/**
 * Which columns to show.
 *
 * Frappe's own answer is `in_list_view`, so use that first. Plenty of DocTypes
 * flag nothing at all, though — `Transportation` among them — and a table of
 * just IDs is useless, so fall back to the first few plain fields.
 */
export function listColumns(meta) {
  const usable = (meta?.fields ?? []).filter(
    (f) =>
      f.fieldname &&
      f.fieldname !== 'naming_series' &&
      !f.hidden &&
      !NON_COLUMN_FIELDTYPES.has(f.fieldtype)
  )
  const flagged = usable.filter((f) => f.in_list_view)
  const chosen = (flagged.length ? flagged : usable).slice(0, 5)

  return chosen.map((f) => ({
    fieldname: f.fieldname,
    label: f.label || f.fieldname,
    fieldtype: f.fieldtype
  }))
}

/* ── Filters in the URL ─────────────────────────────────────────────────────
 * A query param is normally a plain equality (`?branch=JEDDAH`). Dashboards
 * need more than that — "arrival date has passed", "no departure recorded" —
 * so a value may carry a leading operator:
 *
 *   ?eta_date=<2026-07-31     eta_date before that date
 *   ?ata_date=~notset         no arrival recorded
 *   ?ata_date=~set            an arrival recorded
 *   ?billing_status=!=Billed  anything but Billed
 *   ?customer=~like:%acme%    partial match
 *   ?branch=JEDDAH            plain equality
 *
 * Filters are decoded to Frappe's **list form** (`[[field, op, value], …]`)
 * rather than the `{field: value}` dict, because a dict can only hold one
 * condition per field. Two are routinely needed on the same one: Frappe
 * compiles `eta_date < X` to `ifnull(eta_date, '0001-01-01') < X`, so a row
 * with no ETA counts as "before X" — the null has to be excluded with a
 * companion `eta_date is set`. A dict would silently drop one of the pair.
 * Hence repeated params: `?eta_date=~set&eta_date=<2026-07-31`.
 */
const COMPARISONS = ['<=', '>=', '!=', '<', '>']

/** Decode one query value into a `[operator, value]` pair. */
export function parseFilterValue(raw) {
  const value = String(raw)
  if (value === '~set') return ['is', 'set']
  if (value === '~notset') return ['is', 'not set']
  if (value.startsWith('~like:')) return ['like', value.slice(6)]
  // Longest first, so '<=' is not read as '<' with a stray '='.
  for (const op of COMPARISONS) {
    if (value.startsWith(op)) return [op, value.slice(op.length)]
  }
  return ['=', value]
}

/** Human-readable form of one filter, for the chips above the list. */
export function describeFilter([fieldname, op, value]) {
  if (op === 'is') return `${fieldname}: ${value === 'set' ? 'is set' : 'not set'}`
  if (op === '=') return `${fieldname}: ${value}`
  if (op === 'like') return `${fieldname} like ${value}`
  return `${fieldname} ${op} ${value}`
}

/**
 * Every query param except our own, decoded into Frappe list-form filters.
 * A repeated param becomes several conditions on the same field.
 */
export function parseListFilters(query = {}) {
  const out = []
  for (const [key, raw] of Object.entries(query)) {
    if (key === 'page' || key === 'search') continue
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value !== 'string' || !value) continue
      const [op, parsed] = parseFilterValue(value)
      out.push([key, op, parsed])
    }
  }
  return out
}

/** One page of records, filtered and paged on the server. */
export async function fetchDocList(doctype, { columns = [], filters = [], search = '', page = 1 } = {}) {
  const fields = ['name', 'modified', ...columns.map((c) => c.fieldname)].filter(
    (f, i, all) => all.indexOf(f) === i
  )

  const or_filters = search?.trim()
    ? [['name', 'like', `%${search.trim()}%`]]
    : undefined

  const [rows, total] = await Promise.all([
    db.get_list(doctype, {
      fields,
      filters,
      or_filters,
      order_by: 'modified desc',
      limit_start: (page - 1) * LIST_PAGE_SIZE,
      limit_page_length: LIST_PAGE_SIZE
    }),
    or_filters ? Promise.resolve(null) : db.count(doctype, filters)
  ])

  const list = rows ?? []
  return { rows: list, total: total ?? list.length, exactTotal: total !== null }
}

/** Render a cell without pulling in the SDK's control machinery. */
export function formatCell(value, fieldtype) {
  if (value === null || value === undefined || value === '') return '—'
  if (fieldtype === 'Check') return value ? 'Yes' : 'No'
  if (fieldtype === 'Currency' || fieldtype === 'Float') {
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  }
  if (fieldtype === 'Int') return Number(value).toLocaleString()
  return String(value)
}
