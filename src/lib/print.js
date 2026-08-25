/**
 * Printing, via Frappe's own print view.
 *
 * Opens `/printview` in a new browser tab — the same page the desk's Print
 * button ends at. The user sees the rendered print format and drives it from
 * there: that page carries its own "Print" and "Get PDF" links, so both the
 * browser print dialog and a server-rendered PDF are one click away.
 *
 * The print format is deliberately *not* resolved here. `get_print_format_doc`
 * already falls back to `meta.default_print_format or "Standard"` when the
 * `format` parameter is absent, so omitting it gets the DocType's configured
 * default straight from the server. Duplicating that lookup client-side would
 * only add a round trip and a second place to keep in sync. Pass `format` to
 * override for a specific button.
 *
 * `/printview` is proxied to the backend in dev alongside /api and /assets —
 * see vite.config.js. In production the app is served from the Frappe site, so
 * the same relative path resolves without any proxy.
 */

import { hasBackend } from './frappe'

const PRINTVIEW_PATH = '/printview'

/** Build the print view URL for a document. */
export function printViewUrl(doctype, name, { format = null, noLetterhead = false } = {}) {
  const params = new URLSearchParams({ doctype, name })
  // Omitted on purpose when null — that is what selects the DocType default.
  if (format) params.set('format', format)
  if (noLetterhead) params.set('no_letterhead', '1')
  return `${PRINTVIEW_PATH}?${params.toString()}`
}

/**
 * Open the print format for a document in a new tab.
 *
 * Synchronous by design. Any `await` before `window.open` costs the user-gesture
 * token the browser grants a click, and the pop-up gets blocked — so there is
 * deliberately no permission pre-flight here. A 403 instead lands as Frappe's
 * own "not permitted" page in the new tab, which says the same thing in the
 * place the user is already looking.
 *
 * Throws rather than failing quietly, so callers can surface the reason.
 */
export function openPrintView(doctype, name, options = {}) {
  if (!doctype || !name) {
    throw new Error('Nothing to print — save the document first.')
  }
  if (!hasBackend) {
    throw new Error('Printing needs a Frappe backend. Set VITE_FRAPPE_URL in .env.')
  }

  // No 'noopener' in the feature string: Chrome returns null for it even on
  // success, which would read as a blocked pop-up. Sever the link afterwards
  // instead — same effect, and the return value stays meaningful.
  const view = window.open(printViewUrl(doctype, name, options), '_blank')
  if (!view) {
    throw new Error('The print view was blocked — allow pop-ups for this site and try again.')
  }
  try {
    view.opener = null
  } catch {
    // Not worth failing the print over; the target is our own origin anyway.
  }
  return view
}
