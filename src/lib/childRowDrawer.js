/**
 * Child table rows, edited in a drawer instead of in the grid.
 *
 * The SDK's `ControlTable` puts every `in_list_view` field into a cell and the
 * rest behind a `▸` expander that opens a detail strip *inside* the table. Two
 * problems with that on this app's forms:
 *
 *  1. The expander only renders when the child DocType has fields the grid is
 *     not already showing. `Shipment Parcel` marks all nine `in_list_view`, so
 *     the column is there and permanently empty — there is no way to open a row.
 *  2. Even when it does render, the detail strip pushes the rest of the grid
 *     down and inherits the table's cramped cell widths, which is the layout
 *     the grid already has rather than a relief from it.
 *
 * So every row gets an expander, and it opens a right-hand drawer carrying the
 * *whole* row — grid fields included, at full width, in one column.
 *
 * Why this is DOM augmentation rather than a replacement control: the SDK
 * resolves controls through an internal map it never exports, so `ControlTable`
 * cannot be swapped out — the same constraint `formEnhance.js` documents. What
 * *is* exported is `controlFor`, which is enough to render the drawer's fields
 * with the SDK's own controls, so a Link in the drawer searches exactly as it
 * does in the grid.
 */

import { reactive } from 'vue'

/** Fieldtypes that are layout or are meaningless in a child row. Mirrors the
 *  set `ControlTable` itself skips, so the drawer shows neither more nor less
 *  than the grid could. */
const LAYOUT_FIELDTYPES = new Set([
  'Section Break',
  'Column Break',
  'Tab Break',
  'HTML',
  'Button',
  'Table'
])

/**
 * Fields on a child DocType that stay out of the drawer even though they're
 * real, visible columns in the grid — an internal identifier, or a value
 * already shown more readably by a sibling field on the same row. The grid,
 * the real desk view and the DocType itself are untouched; this only trims
 * what this app's own drawer renders.
 */
const DRAWER_HIDDEN_FIELDS = {
  // `question` is the raw Order Complexity Question link (an opaque id) —
  // `question_text` ("Parameter") already shows its readable text. `weight`
  // and `weighted_score` are calculate()'s own working numbers behind the
  // Order Complexity Score shown on the step's Calculated rail, not something
  // to review or edit per question. `actual_value` is edited through the
  // Score picker's own probe input (see ChildRowDrawer.vue), not a separate
  // generic control.
  'Costing Worksheet Complexity Rating': new Set(['question', 'unit', 'weight', 'weighted_score', 'actual_value'])
}

/* ── Complexity rating legend ────────────────────────────────────────────── */

/**
 * `Costing Worksheet Complexity Rating.rating` is a plain `1`/`2`/`3` Select —
 * enough for `calculate()` server-side (`Order Complexity Question.get(f"rating_{n}_label")`,
 * `costing_worksheet.py`'s `_calculate_complexity`) but meaningless to look at:
 * the user has to pick blind, then check Result to see if it's the row they
 * meant. The three `rating_N_label` texts that describe what each number
 * means for THIS row's question already live on its `Order Complexity
 * Question` master (the same text `_calculate_complexity` copies into
 * Result) — fetch them so the drawer can show the picker with its meaning
 * attached instead. Cached per question id: the same question is reused
 * across every item's costing sheet in one wizard session.
 */
const RATING_LABEL_FIELDS = ['rating_1_label', 'rating_2_label', 'rating_3_label']
const ratingLabelCache = new Map()

export function fetchRatingLabels(frm, questionId) {
  if (!questionId) return Promise.resolve(null)
  if (!ratingLabelCache.has(questionId)) {
    ratingLabelCache.set(
      questionId,
      frm.frappe
        .call('frappe.client.get_value', {
          doctype: 'Order Complexity Question',
          filters: questionId,
          fieldname: RATING_LABEL_FIELDS
        })
        .then((r) => r ?? null)
        .catch(() => null)
    )
  }
  return ratingLabelCache.get(questionId)
}

/**
 * Parse a `rating_N_label` into a numeric band, for the `%`/`no` unit
 * questions (No of components, In-house execution %, Scrap generation %) —
 * the source workbook's own Rating reference column phrases these as ranges
 * ("0-25", "26 - 75", "Less than 20%", ">75") rather than descriptions, so
 * the user has a number in hand (a count, a percentage) and expects the
 * matching band picked FOR them, not to guess which of three prose options
 * their number falls under. Returns null for anything else (the RM
 * availability / welding process style text options, which stay pick-only).
 */
export function parseRatingRange(label) {
  if (!label) return null
  const text = String(label).trim()
  let m
  if ((m = text.match(/^less than\s+([\d.]+)/i))) {
    return { min: -Infinity, max: Number(m[1]), maxExclusive: true }
  }
  if ((m = text.match(/^>\s*([\d.]+)/))) {
    return { min: Number(m[1]), minExclusive: true, max: Infinity }
  }
  if ((m = text.match(/^([\d.]+)\s*%?\s*(?:-|to)\s*([\d.]+)/i))) {
    return { min: Number(m[1]), max: Number(m[2]) }
  }
  return null
}

/** The score (as `"1"`/`"2"`/`"3"`) whose band a raw number falls into,
 *  given a row's three rating labels — or null if `value` isn't a number or
 *  falls outside every parseable band. */
export function matchRatingScore(value, labels) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (Number.isNaN(n)) return null
  for (const score of [1, 2, 3]) {
    const range = parseRatingRange(labels?.[`rating_${score}_label`])
    if (!range) continue
    const aboveMin = range.minExclusive ? n > range.min : n >= range.min
    const belowMax = range.maxExclusive ? n < range.max : n <= range.max
    if (aboveMin && belowMax) return String(score)
  }
  return null
}

const TABLE_SELECTOR = '.control-table[data-fieldname]'
const EXPAND_CLASS = 'btn-expand-row'
/** Marks the expanders this module injected, so teardown removes only those and
 *  the observer does not treat its own writes as a reason to run again. */
const INJECTED_ATTR = 'data-drawer-expander'

/* ── The row's frm ───────────────────────────────────────────────────────── */

/**
 * A frm-like object for one child row.
 *
 * The SDK's controls ask for very little — `fields_dict[fieldname].df`,
 * `doc[fieldname]` and `set_value` — and `ControlTable` already builds exactly
 * this per row internally to render its cells. That class is not exported, so
 * this is the same shape rebuilt in app code.
 *
 * Cached per row object: a control's identity depends on the frm it is handed,
 * so returning a fresh one on each render would tear down and remount every
 * field on every keystroke.
 */
const ROW_FRMS = new WeakMap()

export function rowFrmFor(frm, fieldname, row) {
  if (!frm || !row) return null
  const cached = ROW_FRMS.get(row)
  if (cached) return cached

  const doctype = frm.fields_dict?.[fieldname]?.df?.options
  const meta = doctype ? frm.frappe?.get_meta?.(doctype) : null
  if (!meta) return null

  const fields_dict = {}
  for (const df of meta.fields ?? []) {
    if (LAYOUT_FIELDTYPES.has(df.fieldtype)) continue
    // Reactive so `toggle_reqd`-style writes from a client script reach the
    // rendered control, matching what the SDK does for its own cells.
    fields_dict[df.fieldname] = { df: reactive({ ...df }), refreshKey: 0, refresh: () => {} }
  }

  const rowFrm = {
    frappe: frm.frappe,
    doc: row,
    doctype,
    docname: String(row.name ?? ''),
    fields_dict,
    async set_value(field, value) {
      const pairs = field && typeof field === 'object' ? Object.entries(field) : [[field, value]]
      for (const [key, next] of pairs) {
        if (row[key] === next) continue
        row[key] = next
        // Writing the whole table back is what marks the parent dirty and
        // re-renders the grid cell behind the drawer. It is also precisely what
        // ControlTable's own rows do on change.
        frm.set_value(fieldname, frm.doc[fieldname])
        await frm.frappe?.model?.trigger?.(key, next, row)
      }
    }
  }

  ROW_FRMS.set(row, rowFrm)
  return rowFrm
}

/** The fields a drawer shows for `fieldname`'s child DocType, in meta order. */
export function rowFields(frm, fieldname) {
  const doctype = frm?.fields_dict?.[fieldname]?.df?.options
  const meta = doctype ? frm.frappe?.get_meta?.(doctype) : null
  if (!meta) return []
  const hidden = DRAWER_HIDDEN_FIELDS[doctype]
  return (meta.fields ?? []).filter(
    (df) => !LAYOUT_FIELDTYPES.has(df.fieldtype) && !df.hidden && !hidden?.has(df.fieldname)
  )
}

/** The child DocType's label for the drawer heading. */
export function tableLabel(frm, fieldname) {
  const df = frm?.fields_dict?.[fieldname]?.df
  return df?.label || df?.options || fieldname
}

/* ── Wiring the grid ─────────────────────────────────────────────────────── */

/** The row's real index, from the `#` cell the SDK renders as `index + 1`. */
function indexOfRow(tr) {
  const text = tr?.querySelector('td.col-srno')?.textContent?.trim()
  const n = Number.parseInt(text ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n - 1 : -1
}

function injectExpanders(root) {
  for (const table of root.querySelectorAll(TABLE_SELECTOR)) {
    for (const cell of table.querySelectorAll('tbody td.col-expand')) {
      if (cell.querySelector(`.${EXPAND_CLASS}`)) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = EXPAND_CLASS
      button.setAttribute(INJECTED_ATTR, '')
      button.title = 'Open this row'
      button.setAttribute('aria-label', 'Open this row')
      button.textContent = '▸'
      cell.appendChild(button)
    }
  }
}

/**
 * Route every row expander — the SDK's and this module's alike — to `open`.
 *
 * Returns a teardown function; call it on unmount.
 *
 * `open` is called with the table's fieldname and the row's index.
 */
export function installRowDrawer(root, open) {
  if (!root || typeof MutationObserver === 'undefined') return () => {}

  const observer = new MutationObserver((records) => {
    // Ignore this module's own insertions, or injecting would retrigger the
    // observer that injected.
    const relevant = records.some((record) =>
      [...record.addedNodes].some(
        (node) => !(node.nodeType === 1 && node.hasAttribute?.(INJECTED_ATTR))
      )
    )
    if (relevant) injectExpanders(root)
  })
  observer.observe(root, { childList: true, subtree: true })

  // Capture, so the SDK's own expander opens the drawer rather than the inline
  // detail strip it was bound to. Stopping propagation here means its handler
  // never runs and no row is ever expanded in place.
  const onClick = (event) => {
    const button = event.target.closest?.(`.${EXPAND_CLASS}`)
    if (!button || !root.contains(button)) return
    const table = button.closest(TABLE_SELECTOR)
    const index = indexOfRow(button.closest('tr'))
    if (!table || index < 0) return
    event.preventDefault()
    event.stopPropagation()
    open(table.dataset.fieldname, index)
  }
  root.addEventListener('click', onClick, true)

  injectExpanders(root)

  return () => {
    observer.disconnect()
    root.removeEventListener('click', onClick, true)
    for (const button of root.querySelectorAll(`[${INJECTED_ATTR}]`)) button.remove()
  }
}
