/**
 * Minimal Frappe HTTP client.
 *
 * The SDK deliberately owns no HTTP and no auth — it takes a `transport`
 * function and treats whatever that resolves to as the final value. This module
 * is that seam: it handles the URL, credentials, CSRF and Frappe's `.message`
 * envelope, and hands the SDK a plain value.
 *
 * Requests are same-origin and relative (`/api/method/...`). In dev, Vite
 * proxies them to VITE_FRAPPE_URL (see vite.config.js), so the browser keeps
 * one origin and Frappe's session cookie works with no CORS setup. In
 * production, serve this app from the Frappe site so the same paths resolve.
 */

const API_KEY = import.meta.env.VITE_FRAPPE_API_KEY
const API_SECRET = import.meta.env.VITE_FRAPPE_API_SECRET

/**
 * Whether a Frappe backend is reachable at all. Drives the form route's
 * fallback to bundled meta, so the app still runs with no bench running.
 */
export const hasBackend =
  Boolean(import.meta.env.VITE_FRAPPE_URL) ||
  // A production build served from the Frappe site talks to it over relative
  // paths. The `window` check keeps SSR and the Node test runner — which build
  // in production mode but have no backend — on the offline path.
  (import.meta.env.PROD && typeof window !== 'undefined')

/**
 * Frappe rejects POSTs from a logged-in cookie session without a CSRF token.
 * Token auth is exempt, which is why it is the easier route for a standalone
 * dev setup. When the app is served from inside the Frappe site, the desk
 * bootinfo puts a token on `window.frappe` and we reuse it.
 */
function csrfToken() {
  return globalThis.frappe?.boot?.csrf_token ?? globalThis.csrf_token ?? null
}

function authHeaders() {
  const headers = {}
  if (API_KEY && API_SECRET) {
    headers.Authorization = `token ${API_KEY}:${API_SECRET}`
  } else {
    const token = csrfToken()
    if (token) headers['X-Frappe-CSRF-Token'] = token
  }
  return headers
}

/**
 * Frappe's messages are HTML — `<strong>` around the user and DocType, and
 * sometimes a whole `<details>` block. Anything showing one as text needs it
 * flattened, or the tags appear literally on screen.
 */
function stripHtml(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|details|summary)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Frappe reports failures in several shapes depending on how deep the error
 * was raised. Pull out the most specific human-readable one available.
 */
async function toError(response) {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // Non-JSON body (an HTML error page, typically) — fall through to status.
  }

  const serverMessage = (() => {
    try {
      const messages = JSON.parse(payload?._server_messages ?? '[]')
      const first = messages[0]
      return typeof first === 'string' ? (JSON.parse(first).message ?? first) : null
    } catch {
      return null
    }
  })()

  // Order matters: `message` is Frappe's human-readable string ("Invalid login
  // credentials"), `exception` is the raw Python class path
  // ("frappe.exceptions.AuthenticationError"). Prefer the former and keep the
  // latter only as a last resort.
  const plainMessage = typeof payload?.message === 'string' ? payload.message : null
  const message = stripHtml(
    serverMessage ?? plainMessage ?? payload?.exception ?? `${response.status} ${response.statusText}`
  )

  const error = new Error(message)
  error.status = response.status
  error.excType = payload?.exc_type
  error.payload = payload

  // A 403 means one of two quite different things, and telling them apart
  // matters: "sign in" is useless advice to somebody who is already signed in.
  // Frappe raises PermissionError once a session exists but the user's roles
  // fall short, and AuthenticationError when there is no session at all.
  const isPermission =
    payload?.exc_type === 'PermissionError' || /does not have|not permitted/i.test(message)

  if (response.status === 403 && isPermission) {
    error.isPermissionError = true
    error.message = `${message} Ask an administrator to grant your user a role with read access.`
  } else if (response.status === 403 && !API_KEY) {
    error.message = `${message} — not logged in to Frappe. Sign in at the bench site in this browser, or set VITE_FRAPPE_API_KEY / VITE_FRAPPE_API_SECRET.`
  }
  if (payload?.exc_type === 'CSRFTokenError') {
    error.message = `${message} — CSRF rejected. Use VITE_FRAPPE_API_KEY / VITE_FRAPPE_API_SECRET, or serve this app from the Frappe site.`
  }
  return error
}

/**
 * Call a whitelisted Frappe method and return its unwrapped result.
 * This is the function handed to the SDK as its `transport`.
 */
async function post(method, args = {}) {
  const response = await fetch(`/api/method/${method}`, {
    method: 'POST',
    credentials: 'include',
    // Deliberately no X-Frappe-Site-Name: Frappe resolves the site from that
    // header in preference to Host, and the browser's hostname here is the dev
    // server's (`localhost`), not the bench site's. Let Host decide.
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...authHeaders()
    },
    body: JSON.stringify(args)
  })

  if (!response.ok) throw await toError(response)
  return response.json()
}

/**
 * Link search results, with their descriptions made readable.
 *
 * `search_link` builds each row's description by joining the DocType's search
 * fields with ", ". When one of those is edited with a Text Editor — an Item's
 * `description` is, on this site — the markup comes through with it, and the
 * SDK's dropdown renders descriptions as text, so the tags show up literally:
 *
 *   SEA FREIGHT CHARGES, <div><p>SEA FREIGHT CHARGES AS PER QUOTE </p></div>, …
 *
 * Fixed here rather than in the dropdown because every Link control on every
 * screen — grid cell, drawer, report filter — goes through this one call, and
 * the SDK's `LinkDropdown` cannot be replaced from outside the package.
 *
 * The separator tidy-up is part of the same job: stripping `<p>…</p>` leaves the
 * space that was inside the tag stranded in front of the comma that followed it.
 */
export function readableSearchResults(rows) {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => {
    if (!row?.description) return row
    const description = stripHtml(row.description)
      .replace(/\s+([,;])/g, '$1')
      .replace(/(?:,\s*){2,}/g, ', ')
      .replace(/^[,;\s]+|[,;\s]+$/g, '')
    return { ...row, description }
  })
}

export async function call(method, args = {}) {
  const payload = await post(method, args)
  // `run_doc_method` carries the method's return value in `.message` *and* any
  // updated docs in a sibling `.docs` — unwrapping to just `.message` (below)
  // throws `.docs` away. `frm.call()` (frm-core's `_call`) reads `result.docs`
  // to sync a doc method's server-side changes back onto the local doc, so any
  // method that both mutates the doc and returns a value (unlike e.g.
  // `calculate()`, which returns nothing and so never hit this) would run
  // successfully but never show its own effect. Same class of bug the login
  // response comment below already flags — kept as a special case rather than
  // widened further since every *other* whitelisted method genuinely is just
  // `{ message: value }`.
  if (method === 'run_doc_method') return payload
  // The SDK's transport contract: resolve to the already-unwrapped value.
  const value = payload?.message !== undefined ? payload.message : payload
  return method === 'frappe.desk.search.search_link' ? readableSearchResults(value) : value
}

/**
 * Sign in and start a Frappe session cookie.
 *
 * Kept off `call()` because the login response carries `full_name` and
 * `home_page` alongside `message`, and `call()` would unwrap to just the
 * "Logged In" string and throw the rest away.
 */
export function login(usr, pwd) {
  return post('login', { usr, pwd })
}

export function logout() {
  return post('logout')
}

/**
 * Meta fetcher for `useFrmRemote`.
 *
 * The SDK's default fetcher calls `getdoctype` and then reads the result out of
 * `globalThis.locals.DocType` — which is how it works inside the Frappe desk,
 * where desk JS populates `locals` as a side effect. In a standalone SPA nothing
 * does that, so the default falls back to `frappe.client.get` on the DocType.
 * That returns the field list but leaves `locals` empty, and the SDK reads
 * `locals` for two more things:
 *
 *   - `is_submittable` / `issingle` / `autoname` on the parent meta — without it
 *     a submittable DocType renders with no Submit button.
 *   - the side-loaded child DocTypes — without them every Table field falls back
 *     to a placeholder instead of a grid.
 *
 * `getdoctype` already returns all of that in one response, so this populates
 * `locals` from it and hands back the parent's fields.
 */
// Several `useFrmRemote()` boots for the SAME doctype (e.g. one per item tab in
// the Costing Worksheet wizard) each get their OWN, private `frappe.locals` —
// caching just the network round-trip here (not per-call) still means every
// boot's own `locals.DocType` store gets correctly populated below, including
// `__custom_js`, without re-fetching identical metadata from the server.
const getdoctypeCache = new Map()

export async function metaFetcher(doctype, frappe) {
  let cachedDocs = getdoctypeCache.get(doctype)
  if (!cachedDocs) {
    const result = await frappe.call('frappe.desk.form.load.getdoctype', {
      doctype,
      with_parent: 1
    })
    // `getdoctype` responds with { docs: [...] } — the parent DocType followed
    // by every child DocType it references — and no `message` wrapper.
    cachedDocs = Array.isArray(result?.docs) ? result.docs : []
    getdoctypeCache.set(doctype, cachedDocs)
  }
  // Deep-cloned per call, never the cached array's own objects: downstream
  // code (e.g. `lockOnSubmit`) mutates field defs in place (`set_df_property`
  // writes straight onto `meta.fields[i]`), and this cache is shared across
  // every simultaneously-open frm of the same doctype (every item tab in the
  // wizard) — sharing the raw objects would let one item's lock-on-submit (or
  // any other in-place meta mutation) bleed into every other item's fields.
  const docs = structuredClone(cachedDocs)

  // Write into THIS call's own locals (private per frm/frappe instance) and
  // mirror that same object onto the global, rather than keeping a detached
  // one here: anything that later assigns `globalThis.locals = frappe.locals`
  // (installing globals for native client scripts) would otherwise silently
  // drop everything cached below — including each DocType's `__custom_js`.
  // This write-back has to run on every call, cache hit or not: skipping it
  // on a hit would leave THIS frm's own locals without the doctype it just
  // asked for, even though some earlier, unrelated frm's locals has it.
  const locals = frappe?.locals ?? (globalThis.locals ??= {})
  const store = (locals.DocType ??= {})
  for (const doc of docs) {
    if (doc?.name) store[doc.name] = doc
  }
  globalThis.locals = locals

  const fields = store[doctype]?.fields
  if (Array.isArray(fields)) return fields

  // Fall back to the DocType document itself if getdoctype gave us nothing.
  const dt = await frappe.call('frappe.client.get', { doctype: 'DocType', name: doctype })
  return Array.isArray(dt?.fields) ? dt.fields : []
}

/** Upload handler for the SDK's Attach and Image controls. */
export async function uploadFile(file, opts = {}) {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('is_private', String(opts.is_private ?? 0))
  if (opts.doctype) form.append('doctype', opts.doctype)
  if (opts.docname) form.append('docname', opts.docname)
  if (opts.fieldname) form.append('fieldname', opts.fieldname)
  if (opts.folder) form.append('folder', opts.folder)

  const response = await fetch('/api/method/upload_file', {
    method: 'POST',
    credentials: 'include',
    // No Content-Type — the browser must set the multipart boundary itself.
    headers: { Accept: 'application/json', ...authHeaders() },
    body: form
  })

  if (!response.ok) throw await toError(response)

  const payload = await response.json()
  const doc = payload?.message ?? payload
  return { file_url: doc.file_url, name: doc.name }
}

export default { call, uploadFile, hasBackend }
