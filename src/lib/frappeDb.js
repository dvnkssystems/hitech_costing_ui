import { call } from './frappe'

/**
 * Frappe document queries.
 *
 * This mirrors, method for method, the `frappe.db` that
 * `@frappe-vue-sdk/runtime-core`'s `createDb()` builds — same whitelisted
 * endpoints, same argument shapes. It exists because `createFrappe` is not
 * exported from `@frappe-vue-sdk/vue@v0.3.0`: `index.ts` re-exports only the
 * form surface, so a screen with no form on it (a list, a dashboard) has no way
 * to reach the runtime.
 *
 * Once the SDK exports it, this whole module collapses to:
 *
 *     import { createFrappe } from '@frappe-vue-sdk/vue'
 *     export const { db } = createFrappe({ transport: call })
 *
 * Callers use `db.*` either way, so nothing else has to change.
 */
export const db = {
  get_list: (doctype, args) => call('frappe.client.get_list', { doctype, ...(args ?? {}) }),
  get_doc: (doctype, name) => call('frappe.client.get', { doctype, name }),
  get_value: (doctype, filters, fieldname) =>
    call('frappe.client.get_value', { doctype, filters, fieldname }),
  set_value: (doctype, name, fieldname, value) =>
    call('frappe.client.set_value', { doctype, name, fieldname, value }),
  count: (doctype, filters) => call('frappe.client.get_count', { doctype, filters: filters ?? {} }),
  /** Resolves to the record's name, or null when it doesn't exist. */
  exists: (doctype, nameOrFilters) => {
    const filters = typeof nameOrFilters === 'string' ? { name: nameOrFilters } : nameOrFilters
    return call('frappe.client.get_value', { doctype, filters, fieldname: 'name' })
      .then((r) => r?.name ?? null)
      .catch(() => null)
  }
}
