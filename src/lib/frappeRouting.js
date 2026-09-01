/**
 * Navigation for SDK-rendered forms.
 *
 * The SDK owns no routing on purpose: the "open linked document" arrow on a
 * Link field, and any native client script calling `frappe.set_route(...)`,
 * both defer to a global `frappe.set_route` shim that the host app installs.
 * Without one the arrow silently does nothing, because ControlLink calls it
 * with optional chaining.
 *
 * `useFrmRemote` — unlike `useFrm` — does not assign `globalThis.frappe`, so
 * there is no global for scripts to reach for either. This installs both.
 */

/**
 * DocTypes this app renders on a bespoke screen rather than the generic form.
 * None yet — every DocType uses `/form/:doctype/:name`.
 */
const CUSTOM_FORM_ROUTES = {
  // A Draft Quotation should resume in the same wizard that built it; a
  // submitted one should open the read-only review/output screen instead.
  // `QuotationOpenView` is the resolver that decides which — see
  // `src/views/QuotationOpenView.vue`.
  Quotation: (name) => `/quotation/${encodeURIComponent(name)}`
}

/**
 * DocTypes this app browses on a bespoke screen rather than the generic list.
 *
 * `/list/:doctype` still works for all of them — it is how a filtered
 * drill-down is expressed, and how any DocType with no screen of its own is
 * browsed. This map is only about where *navigation* should land: a
 * breadcrumb, a connection link or a client script calling
 * `set_route('List', …)` should reach a bespoke screen when one exists.
 * None yet for hitech_costing.
 */
const CUSTOM_LIST_ROUTES = {}

export function formRouteFor(doctype, name) {
  const custom = CUSTOM_FORM_ROUTES[doctype]
  if (custom && name) return custom(name)
  return name
    ? `/form/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`
    : `/form/${encodeURIComponent(doctype)}`
}

export function listRouteFor(doctype) {
  return CUSTOM_LIST_ROUTES[doctype] ?? `/list/${encodeURIComponent(doctype)}`
}

/**
 * Client-side default for a list's "+ New" action, when the backend has no
 * `Custom UI List Layout.primary_action_route` of its own yet (see
 * `DocListView.vue`'s `chrome`). Deliberately narrower than
 * `CUSTOM_FORM_ROUTES`: Duplicate, mapped-doc creation and "add from
 * Connections" all want a plain blank form regardless, so they keep calling
 * `formRouteFor` directly rather than this.
 */
const DEFAULT_LIST_ACTION_ROUTES = {
  // A real Quotation is never hand-created here — it only comes from
  // `Costing Worksheet.create_quotation()` once a worksheet is Approved.
  // Route "+ New Quotation" to the wizard's own front door instead of a
  // blank Quotation form nobody should be filling in by hand.
  Quotation: '/quotation/new'
}

export function defaultListActionRouteFor(doctype) {
  return DEFAULT_LIST_ACTION_ROUTES[doctype] ?? ''
}

/**
 * Wire `frappe.set_route` to vue-router, on both the runtime instance and the
 * global the SDK's controls actually read.
 */
export function installRouting(router, frappe) {
  const setRoute = (...args) => {
    const [first, second, third] = args

    // set_route('Form', doctype, name)
    if (first === 'Form' && second) return router.push(formRouteFor(second, third))
    // set_route('List', doctype)
    if (first === 'List' && second) return router.push(listRouteFor(second))
    // set_route('/some/path') — Frappe also accepts a plain path.
    if (typeof first === 'string' && first.startsWith('/')) return router.push(first)

    return Promise.resolve()
  }

  if (frappe) {
    frappe.set_route = setRoute
    // Mirror the runtime globally the way useFrm does, so native scripts and
    // the SDK's own controls find it. Browser-only by construction — these
    // views never run during SSR.
    globalThis.frappe = frappe
  } else {
    globalThis.frappe = globalThis.frappe ?? {}
  }
  globalThis.frappe.set_route = setRoute

  return setRoute
}

/**
 * Render Text Editor fields as formatted HTML instead of raw markup.
 *
 * The SDK's ControlTextEditor only runs its content through `v-html` when the
 * field is read-only; while editable it puts the HTML source into a plain
 * textarea, so a terms block shows up as `<div class="ql-editor">…` instead of
 * the formatted text Frappe's desk renders. The SDK ships no rich-text control,
 * so marking these read-only is what gets the correct presentation.
 *
 * Trade-off: those fields become read-only in this app. For `Quote.terms_content`
 * that is fine — it is populated from `terms_template`. Drop this script once
 * the SDK gains a WYSIWYG control.
 */
export function renderTextEditorsAsHtml(doctype) {
  return (frappe) => {
    frappe.ui.form.on(doctype, {
      refresh(frm) {
        const meta = frm.frappe?.get_meta?.(frm.doctype)
        for (const df of meta?.fields ?? []) {
          if (df.fieldtype === 'Text Editor' && df.fieldname) {
            frm.toggle_enable(df.fieldname, false)
          }
        }
      }
    })
  }
}
