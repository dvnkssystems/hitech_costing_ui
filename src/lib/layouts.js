/**
 * Which template renders which DocType.
 *
 * The mapping lives here, as `LAYOUT_MAP` below. It used to be data: the
 * backend held `Custom UI Doctype Layout` records and served them from
 * `custom_ui.api.get_layout_map`. `custom_ui` retired those DocTypes and the
 * endpoint with them, so asking for the map only produced a failed request on
 * every screen. A new template was always a component written here anyway;
 * now pointing it at a DocType is one line here too.
 */
import { defineAsyncComponent } from 'vue'

/**
 * List templates. `default` is the generic browser used when a DocType has no
 * list template of its own. Add a bespoke screen here, and name it against its
 * DocType in `LAYOUT_MAP`, the day one earns its own list view.
 */
export const LIST_LAYOUTS = {
  default: defineAsyncComponent(() => import('@/views/DocListView.vue')),
  // Bespoke Quotation list (status tabs + derived worksheet status/product).
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

/**
 * `{ doctype: { list, form } }`. A DocType missing here, or missing a key,
 * gets the generic template for it.
 */
const LAYOUT_MAP = {
  // Status tabs, search and a status derived from the linked worksheets.
  Quotation: { list: 'QuotationListView' }
}

/**
 * The map, as a promise.
 *
 * Still asynchronous although nothing is fetched: the two hosts that call it
 * were written against a request, and keeping the shape means the mapping can
 * move back to the server without touching them.
 */
export const fetchLayoutMap = () => Promise.resolve(LAYOUT_MAP)

export const formLayoutFor = (map, doctype) => map?.[doctype]?.form ?? 'cards'
export const listLayoutFor = (map, doctype) => map?.[doctype]?.list ?? 'default'
