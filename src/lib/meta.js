/**
 * DocType field discovery.
 *
 * Some of what these screens want to show is not guaranteed to exist. The
 * design's Leads board has mode, lane and cargo columns; ERPNext's `Lead` has
 * none of those as standard, so on one site they are custom fields and on
 * another they are simply absent. The same is true of the estimate columns on
 * the job's cost sheet.
 *
 * That matters because `frappe.client.get_list` fails outright on an unknown
 * fieldname — one optional column takes the entire query down with it. So
 * rather than guess, ask the server what is actually there and narrow the field
 * list to the intersection.
 *
 * Cached per DocType, and the *promise* is cached rather than the result, so
 * three panels probing the same DocType on mount share one round trip.
 */

import { call } from './frappe'

const cache = new Map()

/**
 * Every fieldname on a DocType, or `null` when the server would not say.
 *
 * `null` is deliberately distinct from an empty set: "we could not ask" and
 * "it genuinely has no fields" call for opposite fallbacks, and a user with no
 * read access to the DocType hits the former.
 */
export function docFields(doctype) {
  if (!doctype) return Promise.resolve(null)
  if (cache.has(doctype)) return cache.get(doctype)

  const probe = call('frappe.desk.form.load.getdoctype', { doctype, with_parent: 0 })
    .then((result) => {
      // `getdoctype` answers with { docs: [...] } — the DocType itself, plus any
      // child DocTypes it references — and no `message` wrapper.
      const docs = Array.isArray(result?.docs) ? result.docs : []
      const parent = docs.find((doc) => doc?.name === doctype) ?? docs[0]
      const names = (parent?.fields ?? []).map((field) => field.fieldname).filter(Boolean)
      return names.length ? new Set(names) : null
    })
    .catch(() => null)

  cache.set(doctype, probe)
  return probe
}

/**
 * Narrow a wanted field list to what this site actually has.
 *
 * `required` is passed through untouched — those are core fields the screen
 * cannot work without, and if one of them is missing the query *should* fail
 * loudly rather than render a silently empty table. `optional` is kept only
 * when the probe confirms it, and dropped wholesale when the probe could not
 * run: a screen with a blank column beats a screen with no data at all.
 *
 * Returns `{ fields, present }` — `present` being the set of optional
 * fieldnames that survived, so a view can hide a column rather than fill it
 * with em dashes.
 */
export async function pickFields(doctype, { required = [], optional = [] } = {}) {
  const available = await docFields(doctype)
  const present = new Set(available ? optional.filter((f) => available.has(f)) : [])
  return { fields: [...required, ...present], present }
}

/** True when the site has every one of these fields. */
export async function hasFields(doctype, fieldnames = []) {
  const available = await docFields(doctype)
  return Boolean(available) && fieldnames.every((f) => available.has(f))
}
