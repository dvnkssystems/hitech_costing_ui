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
 *
 * `unit` rides along too rather than trusting the row's own copy of it:
 * `load_complexity_questions()` (costing_worksheet.py) only ever stamps
 * `unit` onto a row the moment it's first added, and never backfills it for
 * rows a worksheet already had — so any Costing Worksheet whose questions
 * were loaded before a question's `unit` was set (or before this field
 * existed at all) carries a permanently blank `row.unit`, which reads as
 * neither `'text'` nor a numeric unit and silently falls back to a bare
 * number box with none of this module's behaviour. The master's own `unit`
 * is never stale that way, so prefer it wherever a row's `unit` is read.
 */
const RATING_LABEL_FIELDS = ['rating_1_label', 'rating_2_label', 'rating_3_label', 'unit']
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

/** `Order Complexity Question.unit`'s real Select options — `""`, `"text"`,
 *  `"%"` and `"no"` (see the DocType JSON). The numeric-band ones, grouped
 *  for the two places below that treat them alike. */
export const NUMERIC_UNITS = ['%', 'no']

/** The unit that actually decides a row's Actual Value control: the fetched
 *  master's own `unit` when it's known, falling back to the row's own copy
 *  only when the master hasn't resolved yet (e.g. no network) — see
 *  `RATING_LABEL_FIELDS`'s doc comment for why the master, not the row, is
 *  the one to trust. */
export function resolveUnit(row, labels) {
  return labels?.unit || row?.unit || ''
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

/* ── Actual-value → Score sync in the grid ───────────────────────────────── */

const ACTUAL_VALUE_SELECTOR = 'label.control[data-fieldname="actual_value"]'

/**
 * Band-matching a typed number to its Score is currently wired to only one of
 * `actual_value`'s two entry points: `ChildRowDrawer.vue`'s probe input. The
 * same number typed straight into the grid's own "Actual Value" column (the
 * real, `in_list_view` field, edited by the SDK's own control) left `rating`
 * untouched, so the row's Score/Result/Weighted Score kept showing stale
 * numbers until the user also opened the drawer and retyped the value there.
 * This mirrors `onProbeInput` for that second entry point.
 *
 * Listens on the bubble phase (unlike `installRowDrawer`'s click handler)
 * so the SDK's own control has already committed the keystroke to `frm.doc`
 * by the time this reads it — a capture-phase listener on `root` would run
 * before that commit and always see the row's previous value.
 *
 * Returns a teardown function; call it on unmount.
 */
export function installActualValueSync(root, getFrm) {
  if (!root) return () => {}

  const onEdit = async (event) => {
    const label = event.target.closest?.(ACTUAL_VALUE_SELECTOR)
    const tr = label?.closest('tr')
    const table = label?.closest(TABLE_SELECTOR)
    if (!label || !tr || !table) return

    const frm = typeof getFrm === 'function' ? getFrm() : getFrm
    const fieldname = table.dataset.fieldname
    const doctype = frm?.fields_dict?.[fieldname]?.df?.options
    if (doctype !== 'Costing Worksheet Complexity Rating') return

    const row = frm.doc?.[fieldname]?.[indexOfRow(tr)]
    if (!row) return

    const labels = await fetchRatingLabels(frm, row.question)
    if (!NUMERIC_UNITS.includes(resolveUnit(row, labels))) return
    const matched = matchRatingScore(row.actual_value, labels)
    if (matched && String(row.rating) !== matched) {
      rowFrmFor(frm, fieldname, row).set_value('rating', matched)
    }
  }

  root.addEventListener('input', onEdit)
  root.addEventListener('change', onEdit)
  return () => {
    root.removeEventListener('input', onEdit)
    root.removeEventListener('change', onEdit)
  }
}

/* ── Actual-value column: shape by unit ──────────────────────────────────── */

/** Marks the `<select>` this module injects in place of the SDK's own numeric
 *  input, so the mutation observer below can tell its own writes apart from
 *  ones worth reacting to (same idea as `INJECTED_ATTR` above). */
const UNIT_SELECT_ATTR = 'data-unit-select'
/** Class toggled on the `label.control` cell for a `percentage` row, purely
 *  for the `%` suffix in `frappe-form.css` — no behavioural meaning. */
const UNIT_PERCENT_CLASS = 'unit-percentage'

/**
 * Shapes the grid's own "Actual Value" cell to match each row's `unit`,
 * instead of the one plain numeric box the SDK renders for every row alike
 * (`Costing Worksheet Complexity Rating.actual_value` is a single field with
 * a single fieldtype in its DocType — the grid has no per-row hook to vary
 * the control it picks by a sibling field's value):
 *
 *  - `text` rows (RM availability, Welding Process…) are answered by picking
 *    one of the question's three Rating Labels, not typing a number — a
 *    `<select>` of that row's own labels replaces the numeric box. Picking
 *    one writes the label text to `actual_value` (same field, same
 *    `set_value` path any other control uses) and the matching score to
 *    `rating`, the same pairing `ChildRowDrawer.vue`'s picker buttons write.
 *  - `percentage` rows keep the numeric box but bound it to 0–100 and mark it
 *    with a `%` suffix, so a percentage can't be typed as e.g. 500.
 *  - `number` rows (and anything unrecognised) are left exactly as the SDK
 *    renders them.
 *
 * DOM augmentation for the same reason `installRowDrawer` is (see the module
 * doc comment): `ControlTable` is not exported, so there is nothing to
 * subclass or wrap — only its rendered output to adjust after the fact.
 *
 * Returns a teardown function; call it on unmount.
 */
export function installActualValueUnitControl(root, getFrm) {
  if (!root || typeof MutationObserver === 'undefined') return () => {}

  async function syncCell(label) {
    const tr = label.closest('tr')
    const table = label.closest(TABLE_SELECTOR)
    if (!tr || !table) return

    const frm = typeof getFrm === 'function' ? getFrm() : getFrm
    const fieldname = table.dataset.fieldname
    const doctype = frm?.fields_dict?.[fieldname]?.df?.options
    if (doctype !== 'Costing Worksheet Complexity Rating') return

    const row = frm.doc?.[fieldname]?.[indexOfRow(tr)]
    const input = label.querySelector('input')
    if (!row || !input) return

    // Fetched before branching on unit, not after: `resolveUnit` prefers the
    // master's own `unit` over the row's copy (see its doc comment), and
    // that copy is exactly what's missing on a worksheet whose questions
    // were loaded before `unit` existed — branching on `row.unit` alone
    // silently drops those rows to a bare number box forever.
    const labels = await fetchRatingLabels(frm, row.question)
    const unit = resolveUnit(row, labels)

    if (unit !== 'text') {
      label.querySelector(`select[${UNIT_SELECT_ATTR}]`)?.remove()
      input.style.display = ''
      label.classList.toggle(UNIT_PERCENT_CLASS, unit === '%')
      if (unit === '%') {
        input.min = '0'
        input.max = '100'
      }
      return
    }

    label.classList.remove(UNIT_PERCENT_CLASS)
    const options = [1, 2, 3]
      .map((n) => ({ n, text: labels?.[`rating_${n}_label`] }))
      .filter((o) => o.text)
    // No parseable labels (question not yet resolved, or a mis-set row) —
    // fall back to the plain numeric box rather than an empty dropdown.
    if (!options.length) {
      label.querySelector(`select[${UNIT_SELECT_ATTR}]`)?.remove()
      input.style.display = ''
      return
    }

    input.style.display = 'none'
    // Re-query rather than reuse a pre-`await` snapshot: `sync()` can run
    // again (another mutation batch) while this same cell's `syncCell` is
    // still awaiting `fetchRatingLabels` above, and a stale `existingSelect`
    // captured before the await would race that second call into appending
    // its own `<select>` alongside it — the "select shows up multiple times"
    // bug. Querying fresh here means whichever call runs its synchronous
    // continuation first (microtasks never interleave) is the one and only
    // one that creates the element; the other finds it and reuses it.
    let select = label.querySelector(`select[${UNIT_SELECT_ATTR}]`)
    if (!select) {
      select = document.createElement('select')
      select.setAttribute(UNIT_SELECT_ATTR, '')
      select.addEventListener('change', (event) => {
        // Read the chosen `<option>` itself rather than re-matching
        // `event.target.value` against the `options` array this closure was
        // created with — that array is a snapshot from whenever THIS select
        // was first built, and options are only rebuilt (see below) when
        // `select.dataset.optionsFor` goes stale, which a listener attached
        // once at creation would never see.
        const chosen = event.target.selectedOptions[0]
        if (!chosen || !chosen.value) return
        // Re-resolve `frm`/`row` here rather than close over the `frm`/`row`
        // this listener was created with: `calculate()`'s own recalculation
        // (triggered by every pick, via the `rating` field's native-script
        // handler) round-trips through the backend and comes back with a
        // freshly rebuilt `complexity_ratings` array — new row objects, same
        // `row.name`s, so Vue keeps this exact `<select>` (and its listener)
        // mounted via its `:key`, but the *row object* the very first pick's
        // listener closed over is now a detached copy nothing reads from
        // anymore. Writing to it "worked" (no error, `select.value` even
        // updates), but `calculate()` reruns against the LIVE array, which
        // never saw the write — so Score/Result/Criticality silently stop
        // updating from the second pick onward. Resolving fresh each time,
        // the same way the grid's plain-number sync and the drawer's own
        // picker already do, means there is never a stale row to write into.
        const currentFrm = typeof getFrm === 'function' ? getFrm() : getFrm
        const currentRow = currentFrm?.doc?.[fieldname]?.[indexOfRow(tr)]
        if (!currentRow) return
        select.dataset.pendingRating = chosen.value
        rowFrmFor(currentFrm, fieldname, currentRow).set_value({ actual_value: chosen.text, rating: chosen.value })
      })
      label.appendChild(select)
    }
    if (select.dataset.optionsFor !== String(row.question)) {
      const placeholder = new Option('Select…', '', true, true)
      placeholder.disabled = true
      select.replaceChildren(placeholder, ...options.map((o) => new Option(o.text, String(o.n))))
      select.dataset.optionsFor = String(row.question)
    }
    const settledRating = row.rating ? String(row.rating) : ''
    if (select.dataset.pendingRating) {
      if (select.dataset.pendingRating === settledRating) delete select.dataset.pendingRating
      else if (select.value === select.dataset.pendingRating) return
    }
    if (select.value !== settledRating) select.value = settledRating
  }

  function sync() {
    for (const label of root.querySelectorAll(ACTUAL_VALUE_SELECTOR)) syncCell(label)
  }

  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      // `replaceChildren()` above populating its own `<option>`s is this
      // module's own write, keyed on its `<select>` parent rather than the
      // `<option>` nodes themselves (which don't carry `UNIT_SELECT_ATTR`) —
      // without this, every populate re-triggers `sync()`, which re-awaits
      // `fetchRatingLabels` for every cell again on the same tick.
      if (record.target?.nodeType === 1 && record.target.hasAttribute?.(UNIT_SELECT_ATTR)) return false
      return [...record.addedNodes].some((node) => !(node.nodeType === 1 && node.hasAttribute?.(UNIT_SELECT_ATTR)))
    })
    if (relevant) sync()
  })
  observer.observe(root, { childList: true, subtree: true })

  sync()

  return () => observer.disconnect()
}
