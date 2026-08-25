/**
 * The stored column set for a DocType's list.
 *
 * `Custom UI Doctype Layout` decides *which template* renders a DocType — that
 * is `layouts.js`. This is the other half: `Custom UI List Layout` decides
 * *which columns* that template shows, and it binds by its own `target_doctype`
 * field rather than by a link, so there is nothing to look up but the DocType.
 *
 * A DocType with no record gets `{ fallback: true }`, which is the signal to
 * keep deriving columns from meta. That is deliberate — most DocTypes will
 * never have a layout record, and browsing them must still work.
 */
import { call, hasBackend } from './frappe'

const FALLBACK = { fallback: true }

const cache = new Map()

/**
 * Fetch a DocType's list layout once per session.
 *
 * Memoised on the promise rather than the value so the first paint's concurrent
 * callers share one request instead of racing.
 */
export function fetchListLayout(doctype) {
  if (!hasBackend || !doctype) return Promise.resolve(FALLBACK)

  if (!cache.has(doctype)) {
    cache.set(
      doctype,
      call('custom_ui.api.get_list_layout', { doctype })
        .then((layout) => {
          // No record, or a record whose every column was dropped as unreadable —
          // either way there is nothing to render, so stay on meta.
          if (!layout || layout.fallback || !layout.columns?.length) return FALLBACK
          return layout
        })
        // A failed fetch must not blank the screen; meta-derived columns work
        // for any DocType.
        .catch(() => FALLBACK)
    )
  }

  return cache.get(doctype)
}

/** Signing in as somebody else changes which columns are readable. */
export function resetListLayouts() {
  cache.clear()
}

/**
 * One page of records, projected by the layout.
 *
 * Unlike `fetchDocList`, the field list is not sent — the server picks it from
 * the same layout record, so a caller cannot widen the projection past what the
 * layout exposes.
 */
export async function fetchLayoutList(
  doctype,
  { filters = [], search = '', page = 1, pageSize = 20, orderBy = '', selections = {}, card = '' } = {}
) {
  const result = await call('custom_ui.api.get_list', {
    doctype,
    filters,
    selections,
    card: card || undefined,
    search: search?.trim() || undefined,
    order_by: orderBy || undefined,
    limit_start: (page - 1) * pageSize,
    limit_page_length: pageSize
  })

  // The count is a real COUNT(*), never an estimate, so the caller never has to
  // render a "500+".
  return { rows: result?.rows ?? [], total: result?.total ?? 0, exactTotal: true }
}

/**
 * Counts and totals for the filter cards.
 *
 * Deliberately not given the current selection: a card reading "Expired 17"
 * must mean 17 expired records, not 17 of whatever is on screen. Failure is
 * swallowed — a header without numbers is worth more than a blank page.
 */
export async function fetchListStats(doctype, { filters = [], search = '' } = {}) {
  const empty = { groups: {}, cards: {} }
  try {
    const result = await call('custom_ui.api.get_list_stats', {
      doctype,
      filters,
      search: search?.trim() || undefined
    })
    return { ...empty, ...(result ?? {}) }
  } catch {
    return empty
  }
}

/**
 * A Sum option is a metric, not a filter — "Pipeline Value" answers how much,
 * not which. It renders as a card but takes no part in the selection.
 */
export const isMetric = (option) => option.aggregate === 'Sum'

/** The option each group starts on. */
export function defaultSelections(groups = []) {
  const selections = {}
  for (const group of groups) {
    const chosen = group.options.find((option) => option.is_default && !isMetric(option))
    if (chosen) selections[group.key] = chosen.key
  }
  return selections
}

/** The layout's own ordering, in the `field direction` form the API expects. */
export const orderByFor = (layout) =>
  layout?.settings?.default_sort_field
    ? `${layout.settings.default_sort_field} ${layout.settings.default_sort_order ?? 'desc'}`
    : ''

/**
 * Badge palette for Derived columns.
 *
 * The layout stores a colour name rather than a hex pair so a layout written
 * today still matches the app after a restyle.
 */
const BADGE_COLORS = {
  green: { bg: '#DCFCE7', fg: '#15803D' },
  red: { bg: '#FEE2E2', fg: '#B91C1C' },
  amber: { bg: '#FEF3C7', fg: '#B45309' },
  blue: { bg: '#DBEAFE', fg: '#1D4ED8' },
  grey: { bg: '#F1F5F9', fg: '#475569' }
}

export const badgeStyle = (color) => {
  const { bg, fg } = BADGE_COLORS[color] ?? BADGE_COLORS.grey
  return {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: '999px',
    background: bg,
    color: fg,
    fontSize: '12px',
    fontWeight: '600'
  }
}
