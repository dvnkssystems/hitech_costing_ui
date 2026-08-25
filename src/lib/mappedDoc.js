import { prompt, msgprint } from '@frappe-vue-sdk/vue'
import { call } from './frappe'
import { formRouteFor } from './frappeRouting'

/**
 * ERPNext's mapped-document helpers.
 *
 * Desk scripts drive "Get items from …" and "Create → …" through two globals
 * that live in ERPNext's desk bundle, not in Frappe core and not in the SDK:
 *
 *   erpnext.utils.map_current_doc()  — pick a source, merge it into this doc
 *   frappe.model.open_mapped_doc()   — build a new doc from this one and open it
 *
 * Without them the buttons throw `erpnext is not defined` the moment they're
 * clicked. The SDK is a Frappe SDK and deliberately ships no ERPNext surface,
 * so the host has to supply it. These are deliberately thin: they do the server
 * round-trip and the navigation, and leave the mapping to the whitelisted
 * method — which is where it belongs.
 */

/** Server-managed fields that must never be copied onto an existing document. */
const NON_MAPPABLE = new Set([
  'name',
  'owner',
  'creation',
  'modified',
  'modified_by',
  'docstatus',
  'idx',
  'doctype',
  '__islocal',
  '__unsaved',
  '__onload',
  '__last_sync_on'
])

/** New documents produced by open_mapped_doc, handed to the target route. */
const pendingDocs = new Map()

/** Park a document for the target route to open as a new, unsaved record. */
export function seedPendingDoc(doctype, doc) {
  pendingDocs.set(doctype, doc)
}

export function takePendingDoc(doctype) {
  const doc = pendingDocs.get(doctype)
  pendingDocs.delete(doctype)
  return doc ?? null
}

/**
 * Merge a mapped document back onto the open form.
 *
 * Child tables are assigned wholesale — the server has already built the rows,
 * and merging them row-by-row would need identity we don't have.
 */
async function applyMappedDoc(frm, mapped) {
  if (!frm || !mapped) return
  for (const [fieldname, value] of Object.entries(mapped)) {
    if (NON_MAPPABLE.has(fieldname)) continue
    if (value === null || value === undefined) continue
    try {
      if (Array.isArray(value)) {
        frm.doc[fieldname] = value
      } else {
        await frm.set_value(fieldname, value)
      }
    } catch {
      // A field the target doesn't have, or one that's read-only. Skip it
      // rather than abandon the rest of the mapping.
    }
  }
  await frm.trigger?.('refresh')
}

/**
 * Pick a source document, then map it onto the current one.
 *
 * Desk shows a multi-select grid with filters; this asks for one source through
 * the SDK's own Link control, which reuses its search and permissions. Enough
 * for the "Get items from" flows here, which map a single source.
 */
export async function mapCurrentDoc(opts = {}) {
  const { method, source_doctype, target, get_query_filters, setters } = opts
  const frm = target?.doc ? target : globalThis.cur_frm
  if (!method || !source_doctype || !frm) return

  // Desk's `setters` pre-filter the picker; carry them through as link filters.
  const linkFilters = { ...(get_query_filters ?? {}) }
  for (const setter of setters ?? []) {
    if (setter?.fieldname && setter?.default) linkFilters[setter.fieldname] = setter.default
  }

  prompt(
    [
      {
        fieldtype: 'Link',
        fieldname: 'source_name',
        label: source_doctype,
        options: source_doctype,
        reqd: 1,
        link_filters: linkFilters
      }
    ],
    async (values) => {
      const sourceName = values?.source_name
      if (!sourceName) return
      try {
        const mapped = await call(method, {
          source_name: sourceName,
          // The server merges into this rather than building a fresh document.
          target_doc: JSON.stringify(frm.doc)
        })
        await applyMappedDoc(frm, mapped)
      } catch (e) {
        msgprint(e?.message ?? String(e), `Could not map from ${source_doctype}`)
      }
    },
    `Get items from ${source_doctype}`,
    'Get items'
  )
}

/**
 * Build a new document from the current one and open it.
 *
 * The result is parked in `pendingDocs` and picked up by the target route,
 * which seeds it through `useFrmRemote`'s `initialDoc` — the option the SDK
 * documents for exactly this flow.
 */
export async function openMappedDoc(opts = {}) {
  const { method, frm: source, source_name } = opts
  const frm = source?.doc ? source : globalThis.cur_frm
  const name = source_name ?? frm?.doc?.name
  if (!method || !name) return

  try {
    const mapped = await call(method, { source_name: name })
    const doctype = mapped?.doctype
    if (!doctype) {
      msgprint('The server returned no document to open.', 'Nothing to create')
      return
    }
    pendingDocs.set(doctype, mapped)
    const router = globalThis.__hitechRouter
    if (router) router.push(formRouteFor(doctype))
  } catch (e) {
    msgprint(e?.message ?? String(e), 'Could not create the document')
  }
}

/**
 * Install the desk APIs that native scripts assume are global.
 *
 * Everything here exists in Frappe's or ERPNext's desk bundle and nowhere in
 * the SDK, so a script calling one gets a TypeError mid-handler and whatever
 * followed never runs.
 */
export function installDeskApis(frappe, router) {
  if (router) globalThis.__hitechRouter = router

  // ── mapped documents ────────────────────────────────────────────
  frappe.model = frappe.model ?? {}
  frappe.model.open_mapped_doc = openMappedDoc

  const erpnext = (globalThis.erpnext = globalThis.erpnext ?? {})
  erpnext.utils = erpnext.utils ?? {}
  erpnext.utils.map_current_doc = mapCurrentDoc
  // Scripts occasionally reach for it through the runtime too. `frappe.utils`
  // is an ES module namespace object (the SDK does `import * as utils`), so
  // it's non-extensible — assigning onto it directly throws "Cannot assign
  // to property ... of [object Module]". Replace it with a plain-object copy
  // instead of mutating it in place.
  frappe.utils = { ...(frappe.utils ?? {}), map_current_doc: mapCurrentDoc }

  // ── frappe.new_doc + frappe.route_options ───────────────────────
  // Desk's idiom for "open a blank form with these values pre-filled" is to
  // assign `frappe.route_options` and then call `new_doc`. Route the seed
  // through the same pending-doc channel the mapped-doc flow uses.
  frappe.new_doc = (doctype, opts) => {
    if (!doctype) return
    const seed = opts && typeof opts === 'object' ? opts : frappe.route_options
    if (seed && typeof seed === 'object') {
      seedPendingDoc(doctype, { doctype, ...seed })
    }
    frappe.route_options = null
    if (globalThis.frappe) globalThis.frappe.route_options = null
    const target = globalThis.__hitechRouter
    if (target) target.push(formRouteFor(doctype))
  }

  // Runtime-shape shims (frappe.datetime.get_today, get_meta().permissions,
  // desk-shaped db.get_value) deliberately live in installFrappeGlobals
  // instead: refresh handlers reach for those during `run_lifecycle`, which has
  // already finished by the time this runs.
}

/** @deprecated Kept so existing call sites keep working. */
export const installMappedDocHelpers = installDeskApis

/**
 * Make the toolbar's Amend button work.
 *
 * **The bug.** `Frm.amend_doc()` calls `frappe.client.amend_doc`, which does
 * not exist — not in `frappe/client.py`, not anywhere in the framework. Every
 * Amend fails with "module 'frappe.client' has no attribute 'amend_doc'".
 *
 * **What Frappe actually does.** Amend is a *client-side* operation
 * (`form.js#amend_doc`): check the DocType has an `amended_from` field, ask
 * `frappe.client.is_document_amended` whether this document already has an
 * amendment, copy the document, set `amended_from` to the cancelled name, and
 * open the copy as a new unsaved draft. Nothing is written until you save it.
 *
 * **What this does.** Exactly that, then hands the copy to the router the same
 * way Duplicate does. The SDK already ships the hard part — `frm.copy_doc()`
 * strips `name`, `amended_from`, `amendment_date` and `no_copy` fields — so
 * this only has to add the amendment bookkeeping.
 *
 * Patches the method on the instance rather than adding a second button, so
 * the SDK's own Amend keeps working and disappears with it when the SDK is
 * fixed. Drop this once `Frm.amend_doc` stops calling a phantom endpoint.
 */
export function installAmend(frm, router) {
  if (!frm) return

  frm.amend_doc = async () => {
    const meta = frm.frappe?.get_meta?.(frm.doctype)
    const hasAmendedFrom = meta?.fields?.some((f) => f.fieldname === 'amended_from')
    if (!hasAmendedFrom) {
      throw new Error(
        `${frm.doctype} has no "amended_from" field, so it cannot be amended. Add one to the DocType.`
      )
    }

    // Frappe refuses a second amendment of the same document — the chain has to
    // stay linear, or two drafts both claim to supersede the same cancelled doc.
    const already = await frm.frappe
      .call('frappe.client.is_document_amended', {
        doctype: frm.doctype,
        docname: frm.doc.name
      })
      .catch(() => null)
    if (already) {
      throw new Error(
        `${frm.doc.name} has already been amended (see ${already}). A cancelled document can only be amended once.`
      )
    }

    const copy = frm.copy_doc()
    copy.amended_from = frm.doc.name
    // A fresh amendment is a draft, whatever the source's docstatus was.
    copy.docstatus = 0
    if (meta.fields.some((f) => f.fieldname === 'amendment_date')) {
      copy.amendment_date = new Date().toISOString().slice(0, 10)
    }

    seedPendingDoc(copy.doctype ?? frm.doctype, copy)
    await router.push(`/form/${encodeURIComponent(frm.doctype)}`)
  }
}
