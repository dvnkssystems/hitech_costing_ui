import { call } from './frappe'
import { db } from './frappeDb'
import { numberByFieldtype } from '@/utils/format'

/** Fieldtypes `formatCell` hands to `numberByFieldtype` rather than stringify. */
const NUMERIC_FIELDTYPES = new Set(['Currency', 'Float', 'Percent', 'Int'])

/** A column of numbers is read down its last digit, so it right-aligns. */
export const isNumericFieldtype = (fieldtype) => NUMERIC_FIELDTYPES.has(fieldtype)

/**
 * Fieldtypes that hold text rather than a number, a date or a flag.
 *
 * Two jobs: they are the only ones worth a `like` search, and they are the only
 * ones long enough to need truncating in a cell.
 */
const TEXT_FIELDTYPES = new Set([
  'Data',
  'Small Text',
  'Text',
  'Long Text',
  'Link',
  'Dynamic Link',
  'Select',
  'Read Only'
])

export const isTextFieldtype = (fieldtype) => TEXT_FIELDTYPES.has(fieldtype)

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
  'Attach Image',
  'Attach',
  'Password'
])

/**
 * Fetch a DocType's meta straight from the desk endpoint.
 *
 * Memoised on the promise, like `meta.js`'s own probe: the list view asks for
 * the identity fields and the column set from the same meta, and a DocType's
 * schema does not change while somebody browses it.
 */
const metaCache = new Map()

export function fetchDocTypeMeta(doctype) {
  if (!doctype) return Promise.resolve(null)
  if (!metaCache.has(doctype)) metaCache.set(doctype, loadDocTypeMeta(doctype))
  return metaCache.get(doctype)
}

async function loadDocTypeMeta(doctype) {
  try {
    const result = await call('frappe.desk.form.load.getdoctype', { doctype })
    const docs = Array.isArray(result?.docs) ? result.docs : []
    // Mirror it into locals so the form view and DocConnections can reuse it.
    const locals = (globalThis.locals ??= {})
    const store = (locals.DocType ??= {})
    for (const doc of docs) if (doc?.name) store[doc.name] = doc
    return docs.find((d) => d.name === doctype) ?? null
  } catch (e) {
    // Never cache a failure: the next paint should be able to try again.
    metaCache.delete(doctype)
    throw e
  }
}

/** Fields that could stand in a column, in DocType field order. */
function usableFields(meta) {
  return (meta?.fields ?? []).filter(
    (f) =>
      f.fieldname &&
      f.fieldname !== 'naming_series' &&
      !f.hidden &&
      !NON_COLUMN_FIELDTYPES.has(f.fieldtype)
  )
}

/* ── Row identity ───────────────────────────────────────────────────────────
 * Half these DocTypes name their records after something a person typed
 * ("CRG", "Q4 2026") and half after a hash (`im3lnqfsrc`). A list that leads
 * with the ID either way is unreadable for the second half, so the decision is
 * made from the DocType, not from a list of known DocTypes.
 *
 * `nameMode` is what the row does with `name`:
 *
 *   'lead'    the ID *is* the identity — first column, as before
 *   'chip'    generated but still human-readable (a naming series, a format
 *             expression) — a muted mono chip at the end of the row
 *   'hidden'  pure noise (hash, UUID, autoincrement) — the URL keeps it, the
 *             row does not
 *
 * Crucially, meta only produces a *hint*. `autoname = field:question` says the
 * ID should be the question text, but on this site `Order Complexity Question`
 * carries that autoname over records that are still hash-named (`im3lnqfsrc`) —
 * Frappe falls back to a hash whenever the field's value is missing, too long or
 * already taken, and a DocType that gained its `autoname` after its records
 * existed keeps the old hashes forever. So a `field:`/`prompt` hint is confirmed
 * against the rows actually on screen by `identityFromRows` before anything is
 * hidden or dropped. See `visibleColumnsFor`: the duplicate column is only
 * suppressed once the data has proved it is a duplicate, so the failure mode is
 * the title showing twice, never the title disappearing.
 */

/** Frappe's own generated shapes: `make_autoname("hash")` and a UUID. */
const GENERATED_NAME = /^([0-9a-z]{10}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Enough of the page to believe it, rather than one unlucky row. */
const AGREEMENT = 0.6

/**
 * The field a `field:` autoname claims to copy into `name`. A claim, not a
 * fact — `identityFromRows` is what turns it into one.
 */
export function autonameField(meta) {
  const autoname = String(meta?.autoname ?? '').trim()
  if (!autoname.toLowerCase().startsWith('field:')) return ''
  const fieldname = autoname.slice(6).trim()
  // An autoname naming a field that isn't there cannot be how rows are named.
  return (meta?.fields ?? []).some((f) => f.fieldname === fieldname) ? fieldname : ''
}

/**
 * The mode meta alone suggests, plus whether it still has to be proved.
 *
 * `provisional` is set only where meta claims the ID is a field's value, which
 * is the one claim the data can contradict. A prompt-named DocType has no field
 * to compare against — its names were typed by hand, so they lead.
 */
export function nameModeHint(meta) {
  const autoname = String(meta?.autoname ?? '').trim().toLowerCase()
  const rule = String(meta?.naming_rule ?? '').trim()
  const nameField = autonameField(meta)

  if (nameField) return { mode: 'lead', nameField, provisional: true }
  if (autoname === 'prompt' || rule === 'Set by user') return { mode: 'lead', nameField: '', provisional: false }
  // `field:`/"By fieldname" whose field does not exist: naming falls back to a
  // hash, so treat it as one.
  if (autoname.startsWith('field:') || rule === 'By fieldname') {
    return { mode: 'hidden', nameField: '', provisional: false }
  }

  // `set_new_name` falls through to `make_autoname("hash")` when a DocType
  // declares no naming at all, which is exactly the case that reads worst.
  if (!autoname && !rule) return { mode: 'hidden', nameField: '', provisional: false }
  if (autoname === 'hash' || autoname === 'uuid' || autoname === 'autoincrement') {
    return { mode: 'hidden', nameField: '', provisional: false }
  }
  if (rule === 'Random' || rule === 'UUID' || rule === 'Autoincrement') {
    return { mode: 'hidden', nameField: '', provisional: false }
  }

  // Naming series, format expressions, and anything a controller's own
  // `autoname` produces: generated, but shaped for a human to quote back.
  return { mode: 'chip', nameField: '', provisional: false }
}

/** Kept for readability at call sites that only want the hint's mode. */
export const nameMode = (meta) => nameModeHint(meta).mode

/**
 * The column that says which record this row is.
 *
 * In order of authority:
 *   1. `title_field` — the DocType's own answer.
 *   2. the field a `field:` autoname names — whether or not it worked, that is
 *      the field the DocType considers its identity, and it is never a
 *      throwaway. This is what keeps `Tank Type` / `Port` / `Container Type` /
 *      `DFT Range` (none of which set a title_field) leading with their code
 *      rather than with whichever Link happens to be declared first.
 *   3. the first prose field (Data / Text), then the first Link / Select.
 *      Prose before Link on purpose: a Link column reads as a category, and
 *      a category is not what tells two rows apart.
 */
const PROSE_FIELDTYPES = new Set(['Data', 'Small Text', 'Text', 'Long Text'])

export function leadFieldOf(meta) {
  const usable = usableFields(meta)
  const has = (fieldname) => Boolean(fieldname) && usable.some((f) => f.fieldname === fieldname)

  if (has(meta?.title_field)) return meta.title_field
  const named = autonameField(meta)
  if (has(named)) return named
  const prose = usable.find((f) => PROSE_FIELDTYPES.has(f.fieldtype))
  if (prose) return prose.fieldname
  return usable.find((f) => TEXT_FIELDTYPES.has(f.fieldtype))?.fieldname ?? ''
}

/**
 * Which fields the search box actually searches.
 *
 * The DocType's `search_fields` first — an administrator naming those has said
 * what people look records up by — then the lead column. Text-ish only: a
 * `like` on a Float column matches on its decimal digits, which is noise.
 * `name` is always ORed in by `fetchDocList` on top of these, so pasting an ID
 * still works even when no column shows one.
 */
export function searchFieldsOf(meta, lead = leadFieldOf(meta)) {
  const usable = usableFields(meta).filter((f) => TEXT_FIELDTYPES.has(f.fieldtype))
  const byName = new Map(usable.map((f) => [f.fieldname, f]))
  const out = []

  const add = (fieldname) => {
    const field = byName.get(fieldname)
    if (!field || out.some((f) => f.fieldname === fieldname)) return
    out.push({ fieldname, label: field.label || fieldname })
  }

  add(lead)
  for (const declared of String(meta?.search_fields ?? '').split(',')) add(declared.trim())

  return out.slice(0, 3)
}

/**
 * The Check field, if any, that decides whether a row still counts.
 *
 * Every master in this app spells it one of these ways, and the row is muted
 * when the flag says the record is out of use — otherwise an inactive row and a
 * live one look identical, which is how two rows with the same Sequence end up
 * reading as a duplicate.
 */
const ENABLED_FLAGS = ['is_active', 'active', 'enabled', 'is_enabled', 'is_published', 'published']
const DISABLED_FLAGS = ['disabled', 'is_disabled', 'inactive', 'is_inactive']

export function inactiveFlagOf(meta) {
  const checks = usableFields(meta).filter((f) => f.fieldtype === 'Check')
  const byName = new Map(checks.map((f) => [f.fieldname, f]))

  for (const fieldname of ENABLED_FLAGS) {
    if (byName.has(fieldname)) return { fieldname, inactiveWhen: 'falsy' }
  }
  for (const fieldname of DISABLED_FLAGS) {
    if (byName.has(fieldname)) return { fieldname, inactiveWhen: 'truthy' }
  }
  return null
}

/** True when this row should read as retired. Cancelled counts too. */
export function rowIsInactive(row, flag) {
  if (Number(row?.docstatus) === 2) return true
  if (!flag || !(flag.fieldname in (row ?? {}))) return false
  const value = row[flag.fieldname]
  return flag.inactiveWhen === 'truthy' ? Boolean(Number(value)) : !Number(value)
}

/**
 * Everything the list needs to know about how this DocType identifies a record,
 * from meta alone — the opening guess, refined by `identityFromRows` as soon as
 * there are rows to check it against.
 *
 * `duplicate` starts empty on purpose: no column is ever dropped on a guess.
 */
export function listIdentity(meta) {
  const lead = leadFieldOf(meta)
  const hint = nameModeHint(meta)
  return {
    lead,
    // With no other identifying column there is nothing to demote the ID in
    // favour of, so it stays the lead however it was generated.
    nameMode: lead ? hint.mode : 'lead',
    nameField: hint.nameField,
    provisional: Boolean(lead) && hint.provisional,
    duplicate: '',
    searchFields: searchFieldsOf(meta, lead),
    inactive: inactiveFlagOf(meta),
    orderBy: orderByOf(meta),
    submittable: Boolean(Number(meta?.is_submittable))
  }
}

/**
 * Confirm (or contradict) the meta's claim that the ID is a field's value.
 *
 * Three outcomes, and which one the ambiguous case lands on is the whole point:
 *
 *   confirmed     most rows have `name === row[nameField]` — the ID really is
 *                 the title, so it leads and its column is suppressed as the
 *                 duplicate it is.
 *   contradicted  they don't. If the names look generated, the ID is noise and
 *                 goes; otherwise it keeps a chip. Either way the lead column
 *                 stays.
 *   unprovable    the field is not in the projection (a stored layout picks its
 *                 own columns). The ID demotes to a chip and *nothing is
 *                 dropped* — worst case a value reads twice.
 *
 * An empty page decides nothing and stays provisional, so a list that was empty
 * when it was first opened still gets a proper verdict once it has records.
 * Otherwise idempotent: a page turn re-runs it harmlessly, and once settled the
 * verdict stops moving, which is what keeps the table from re-laying-out under a
 * reader's cursor.
 */
export function identityFromRows(identity, rows = []) {
  if (!identity?.provisional) return identity
  if (!rows.length) return identity

  const field = identity.nameField
  const sample = field ? rows.filter((row) => row && field in row) : []
  if (!sample.length) return { ...identity, nameMode: 'chip', provisional: false, duplicate: '' }

  const agrees = sample.filter((row) => String(row.name) === String(row[field] ?? '')).length
  if (agrees / sample.length >= AGREEMENT) {
    return { ...identity, nameMode: 'lead', provisional: false, duplicate: field }
  }

  const generated = sample.filter((row) => GENERATED_NAME.test(String(row.name))).length
  return {
    ...identity,
    nameMode: generated / sample.length >= AGREEMENT ? 'hidden' : 'chip',
    provisional: false,
    duplicate: ''
  }
}

/**
 * The columns to actually render.
 *
 * Only ever drops the column whose duplication of the ID cell has been proved
 * from data (`identityFromRows`), and only while that ID cell is on screen.
 */
export function visibleColumnsFor(columns = [], identity = {}, { idColumnShown = false } = {}) {
  if (!idColumnShown || identity.nameMode !== 'lead' || !identity.duplicate) return columns
  const kept = columns.filter((col) => col.fieldname !== identity.duplicate)
  // Never leave a table with no columns but an ID.
  return kept.length ? kept : columns
}

/**
 * The DocType's own sort, falling back to newest-first.
 *
 * Masters that declare a `sort_field` (a sequence, a code) then browse in the
 * order they were designed to be read in, rather than reshuffling every time
 * somebody edits a row. Sanitised because it is interpolated into the query's
 * `order_by`.
 */
export function orderByOf(meta) {
  const field = String(meta?.sort_field ?? '').trim()
  if (!field || !/^[a-z0-9_ ,]+$/i.test(field)) return 'modified desc'
  // v15 allows a full clause here ('sequence asc, modified desc'); a bare
  // fieldname takes the DocType's own direction.
  if (/[ ,]/.test(field)) return field
  const order = String(meta?.sort_order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
  return `${field} ${order}`
}

/**
 * Which columns to show.
 *
 * Frappe's own answer is `in_list_view`, so use that first. Plenty of DocTypes
 * flag nothing at all, though — `Transportation` among them — and a table of
 * just IDs is useless, so fall back to the first few plain fields.
 *
 * The lead column (see `leadFieldOf`) is pulled to the front whether or not it
 * is flagged: it is the one column that says which record the row is, and on a
 * hash-named DocType it is the only one. Nothing is dropped here for being a
 * possible duplicate of the ID — that is `visibleColumnsFor`'s job, and only
 * after the data has shown it really is one.
 */
export function listColumns(meta) {
  const usable = usableFields(meta)
  const lead = leadFieldOf(meta)
  const flagged = usable.filter((f) => f.in_list_view)
  const pool = flagged.length ? flagged : usable

  const chosen = []
  const leadField = lead ? usable.find((f) => f.fieldname === lead) : null
  if (leadField) chosen.push(leadField)
  for (const field of pool) {
    if (chosen.length >= 5) break
    if (field.fieldname !== lead) chosen.push(field)
  }

  return chosen.map((f) => ({
    fieldname: f.fieldname,
    label: f.label || f.fieldname,
    fieldtype: f.fieldtype,
    align: isNumericFieldtype(f.fieldtype) ? 'right' : 'left'
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
export async function fetchDocList(
  doctype,
  {
    columns = [],
    filters = [],
    search = '',
    page = 1,
    searchFields = [],
    extraFields = [],
    orderBy = 'modified desc'
  } = {}
) {
  const fields = [
    'name',
    'modified',
    ...columns.map((c) => c.fieldname),
    ...extraFields
  ].filter((f, i, all) => f && all.indexOf(f) === i)

  const term = search?.trim()
  // The title (and whatever else the DocType nominates) first, `name` last:
  // people type what they can read, but a pasted ID must still find its row.
  const or_filters = term
    ? [
        ...searchFields.map((f) => [f.fieldname ?? f, 'like', `%${term}%`]),
        ['name', 'like', `%${term}%`]
      ]
    : undefined

  const [rows, total] = await Promise.all([
    db.get_list(doctype, {
      fields,
      filters,
      or_filters,
      order_by: orderBy || 'modified desc',
      limit_start: (page - 1) * LIST_PAGE_SIZE,
      limit_page_length: LIST_PAGE_SIZE
    }),
    or_filters ? Promise.resolve(null) : db.count(doctype, filters)
  ])

  const list = rows ?? []
  return { rows: list, total: total ?? list.length, exactTotal: total !== null }
}

/**
 * Render a cell without pulling in the SDK's control machinery.
 *
 * Numbers go through `numberByFieldtype`, so a list column carries the same
 * precision the site's System Settings give the desk: Currency 4dp, Float and
 * Percent 6dp, Int a bare count. No currency glyph — a list column is headed
 * by its own label, and the one caller that knows the currency
 * (`DocListView`'s Number Cards) prefixes the code itself.
 *
 * `Check` is the exception: the caller draws it as a pill rather than a word,
 * so this only has to say which of the two it is.
 */
export function formatCell(value, fieldtype) {
  if (value === null || value === undefined || value === '') return '—'
  if (fieldtype === 'Check') return Number(value) ? 'Yes' : 'No'
  if (NUMERIC_FIELDTYPES.has(fieldtype)) return numberByFieldtype(value, fieldtype)
  return String(value)
}
