/**
 * Run a DocType's native Frappe Client Scripts.
 *
 * The SDK does not load them: `useFrmRemote` only executes the `scripts` array
 * the host passes in, and nothing in the SDK ever reads a `Client Script`
 * record. So conditional show/hide, computed fields and custom buttons that
 * live in Client Scripts simply never run — the form renders, but behaves as if
 * the DocType had no scripting at all.
 *
 * Frappe ships them inside the `getdoctype` payload as **`__custom_js`** — the
 * concatenated source of every enabled `view: "Form"` Client Script for that
 * DocType. (`__js` is a different thing: JS shipped in an app's doctype folder,
 * which a UI-created DocType has none of.) `metaFetcher` in lib/frappe.js
 * already caches the whole payload into `globalThis.locals.DocType`, so the
 * source is on hand by the time these run.
 */

/** Frappe's `cint`: coerce anything to an integer, defaulting to 0. */
export function cint(value) {
  if (value === true) return 1
  if (value === false || value === null || value === undefined || value === '') return 0
  const n = Number.parseInt(String(value), 10)
  return Number.isNaN(n) ? 0 : n
}

/** Frappe's `flt`: coerce to float, tolerating grouped/currency-formatted input. */
export function flt(value, decimals) {
  if (value === null || value === undefined || value === '') return 0
  let n = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[^\d.eE+-]/g, ''))
  if (Number.isNaN(n)) n = 0
  if (decimals === null || decimals === undefined) return n
  const factor = 10 ** cint(decimals)
  return Math.round((n + Number.EPSILON) * factor) / factor
}

/** Frappe's `cstr`. */
export function cstr(value) {
  return value === null || value === undefined ? '' : String(value)
}

const toArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])

/** Frappe's `has_common`: do these two lists share at least one member? */
export function has_common(a, b) {
  const first = toArray(a)
  const second = new Set(toArray(b))
  return first.some((item) => second.has(item))
}

/**
 * Frappe client scripts are written against globals (`frappe`, `locals`, `flt`,
 * `cint`, `cur_frm`), not against imports. `useFrmRemote` — unlike `useFrm` —
 * assigns none of them, so they have to be installed before any script is
 * evaluated. Existing values win, so this never clobbers the SDK's own.
 */
export function installFrappeGlobals(frappe) {
  // Native scripts use `frappe.flags` as a scratch namespace — commonly to
  // register a handler only once. The SDK runtime has no such property, so
  // reading through it throws before the script can register anything.
  frappe.flags = frappe.flags ?? {}
  // Same idea, carried across a desk route change — Frappe's own user.js reads
  // `frappe.route_flags.unsaved` in its refresh handler.
  frappe.route_flags = frappe.route_flags ?? {}
  globalThis.frappe = frappe
  // metaFetcher caches each DocType (and its `__custom_js`) into the runtime's
  // locals, so point the global at that same object. Assigning a fresh one here
  // would throw the cache away right before the scripts need it.
  globalThis.locals = frappe.locals ?? globalThis.locals ?? {}
  globalThis.flt = globalThis.flt ?? flt
  globalThis.cint = globalThis.cint ?? cint
  globalThis.cstr = globalThis.cstr ?? cstr
  // Some scripts wrap user-facing strings; without a shim they throw on load.
  // Frappe's real `__(text, args)` also substitutes `{0}`, `{1}`, … from
  // `args` (Container Fit Plan's headline relies on it: "Fits: {0} tanks").
  globalThis.__ = globalThis.__ ?? translate
  // Frappe's array helpers. `user.js` calls has_common() to decide whether the
  // current roles allow editing, and without it the whole handler dies.
  globalThis.has_common = globalThis.has_common ?? has_common
  globalThis.in_list = globalThis.in_list ?? ((list, value) => toArray(list).includes(value))
  globalThis.$ = globalThis.$ ?? jqueryStub
  globalThis.jQuery = globalThis.jQuery ?? globalThis.$

  installRuntimeShims(frappe)
}

/**
 * Reshape parts of the runtime that desk scripts assume.
 *
 * These must be in place *before* `run_lifecycle`, because refresh handlers hit
 * them immediately — installing after `useFrmRemote` resolves is already too
 * late. Router-dependent APIs (new_doc, mapped docs) can wait, since those only
 * fire on a click.
 */
/** `__('Fits {0} tanks', [4])` -> 'Fits 4 tanks'. No translation here —
 *  only the placeholder substitution Frappe's own `__` does. */
function translate(text, args) {
  const str = text === undefined || text === null ? '' : String(text)
  if (!Array.isArray(args) || !args.length) return str
  return str.replace(/\{(\d+)\}/g, (match, index) => {
    const value = args[Number(index)]
    return value === undefined || value === null ? match : String(value)
  })
}

function installRuntimeShims(frappe) {
  // `frappe.datetime.get_today` — the SDK names it `now_date`.
  try {
    if (frappe.datetime && typeof frappe.datetime.get_today !== 'function') {
      frappe.datetime.get_today = () => frappe.datetime.now_date()
    }
  } catch {
    // Frozen namespace; the script falls back to its own default.
  }

  // `frappe.get_meta(dt).permissions` — the SDK's meta is a trimmed shape with
  // no permissions, and Frappe's own user.js does
  // `get_meta("User").permissions.filter(...)`. metaFetcher has already cached
  // the full DocType doc, so borrow it.
  try {
    if (frappe.get_meta && !frappe.__metaWithPerms) {
      const bare = frappe.get_meta.bind(frappe)
      frappe.get_meta = (doctype) => {
        const meta = bare(doctype)
        if (meta && !Array.isArray(meta.permissions)) {
          meta.permissions = globalThis.locals?.DocType?.[doctype]?.permissions ?? []
        }
        return meta
      }
      frappe.__metaWithPerms = true
    }
  } catch {
    // Leave the runtime alone rather than half-patch it.
  }

  // `frappe.db.get_value` — the SDK resolves to the unwrapped value per its
  // transport contract; desk resolves to the raw response and scripts read
  // `r.message.<field>`, which is undefined here. That loses values silently.
  try {
    if (frappe.db?.get_value && !frappe.db.__deskShaped) {
      const unwrapped = frappe.db.get_value.bind(frappe.db)
      frappe.db.get_value = (...args) => unwrapped(...args).then((value) => ({ message: value }))
      frappe.db.__deskShaped = true
    }
  } catch {
    // Same.
  }
}

/**
 * Minimal jQuery stand-in.
 *
 * Desk scripts reach for `$` to poke at the form's DOM — `Operations.onload`
 * does `$("[data-doctype='Freight']").hide()` when a flag is off. There is no
 * jQuery here, so that throws a ReferenceError and takes the rest of the
 * handler with it, including any custom buttons registered below it.
 *
 * Mutations are no-ops that keep the chain going. Accessors deliberately return
 * `undefined` rather than the chain: a script branching on `$(x).val()` should
 * see an empty value, not a truthy object that sends it down the wrong path.
 * This does not make DOM-manipulating scripts *work* — it stops them taking
 * everything else down with them.
 */
const JQUERY_ACCESSORS = new Set(['val', 'text', 'html', 'attr', 'prop', 'css', 'data'])

function jqueryStub() {
  const chain = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'length') return 0
        if (prop === Symbol.iterator) return function* () {}
        if (typeof prop === 'string' && JQUERY_ACCESSORS.has(prop)) {
          // Getter form (no args) yields undefined; setter form stays chainable.
          return (...args) => (args.length ? chain : undefined)
        }
        return () => chain
      }
    }
  )
  return chain
}

/**
 * Build a `scripts` entry for `useFrmRemote` that evaluates the DocType's
 * Client Scripts.
 *
 * The SDK runs these after `new Frm(...)` (so `cur_frm` exists, which many
 * native scripts read at their top level) and before the refresh lifecycle, so
 * handlers registered here do receive the first `refresh`.
 *
 * A broken script is contained: it's reported and the form still renders,
 * rather than taking the whole page down.
 */
export function nativeClientScripts(doctype) {
  return (frappe) => {
    installFrappeGlobals(frappe)

    const meta = globalThis.locals?.DocType?.[doctype]
    if (!meta) return

    // Desk order: the app's own doctype JS first, then Client Script records,
    // so a Client Script can override what the app shipped.
    for (const [key, label] of [
      ['__js', 'doctype JS'],
      ['__custom_js', 'Client Script']
    ]) {
      const source = meta[key]
      if (!source || !String(source).trim()) continue
      try {
        // Evaluated at global scope so `frappe`, `flt` and friends resolve to
        // the shims above — the same contract the desk gives these scripts.
        // eslint-disable-next-line no-new-func
        new Function(source)()
      } catch (e) {
        console.error(`[hitech-costing-ui] ${label} for ${doctype} failed to load:`, e)
      }
    }
  }
}
