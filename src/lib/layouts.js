/**
 * Which template renders which DocType.
 *
 * The backend holds the mapping as `Custom UI Doctype Layout` records and
 * serves it from `custom_ui.api.get_layout_map` as
 * `{ doctype: { list, form } }`. The names in that map are meaningless on
 * their own — the registries below turn a name into a component.
 *
 * That split is the whole point: pointing an existing template at another
 * DocType is a record, not a deploy. A *new* template is still a component
 * written here plus a `Custom UI Layout` record naming it.
 */
import { defineAsyncComponent } from 'vue'
import { call, hasBackend } from './frappe'

/**
 * List templates. `default` is the generic browser used when a DocType has no
 * list template of its own — every hitech_costing DocType, today. Add a
 * bespoke screen here (and a matching `Custom UI Doctype Layout` record) the
 * day one earns its own list view.
 */
export const LIST_LAYOUTS = {
  default: defineAsyncComponent(() => import('@/views/DocListView.vue')),
  // Bespoke Quotation list (status tabs + derived worksheet status/product).
  // Takes over only once the backend's `Custom UI Doctype Layout` record for
  // Quotation has `list` set to this key — see `QuotationListView.vue`.
  QuotationListView: defineAsyncComponent(() => import('@/views/QuotationListView.vue'))
}

/**
 * Form templates.
 *
 * `cards` is `FormSections` — it derives its fields from the DocType's meta,
 * which is why one template serves any number of DocTypes.
 */
export const FORM_LAYOUTS = ['cards']

/** Only bespoke screens take over the route; `default` means "stay generic". */
export const listComponentFor = (name) =>
  name && name !== 'default' ? (LIST_LAYOUTS[name] ?? null) : null

/** The map used when no backend is configured — nothing to map to offline. */
const OFFLINE_MAP = {}

let pending = null

/**
 * Fetch the map once per session.
 *
 * Memoised on the promise, not the value, so concurrent callers during the
 * first paint share a single request instead of racing.
 */
export function fetchLayoutMap() {
  if (!hasBackend) return Promise.resolve(OFFLINE_MAP)

  pending ??= call('custom_ui.api.get_layout_map')
    .then((map) => (map && typeof map === 'object' ? map : {}))
    // A failed fetch must not blank every screen — fall back to the generic
    // templates, which work for any DocType.
    .catch(() => ({}))

  return pending
}

/** Signing in as somebody else changes which DocTypes are in the map. */
export function resetLayoutMap() {
  pending = null
}

/**
 * Built-in fallback when the backend has no `Custom UI Doctype Layout`
 * record for a DocType yet. A record still wins whenever one exists — this
 * only fills the gap before that record gets created, so `QuotationListView`
 * (status tabs, search, derived worksheet status) renders on `/list/Quotation`
 * out of the box instead of silently degrading to the generic table.
 */
const DEFAULT_LIST_LAYOUT = {
  Quotation: 'QuotationListView'
}

export const formLayoutFor = (map, doctype) => map?.[doctype]?.form ?? 'cards'
export const listLayoutFor = (map, doctype) =>
  map?.[doctype]?.list ?? DEFAULT_LIST_LAYOUT[doctype] ?? 'default'
