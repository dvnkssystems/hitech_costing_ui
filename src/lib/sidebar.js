/**
 * The sidebar, fetched from the backend.
 *
 * `custom_ui.api.get_sidebar` returns a tree of nodes the signed-in user is
 * allowed to see. Role gates, DocType read access and report permissions are
 * all applied server-side, so whatever arrives here renders as-is — there is
 * deliberately no client-side filtering left to do. That replaces the old
 * `session.loadPermissions()` fan-out, which asked `has_permission` once per
 * DocType and, while those probes were in flight, showed everything.
 *
 * Node shape:
 *   { name, item_label, item_type, icon, route, target_doctype,
 *     target_report, nav, group_style, children[] }
 *
 * `item_type` is one of Group | Link | Page | Report. A Group carries no route
 * and renders either as a static section header or a disclosure, per
 * `group_style`. Every other type carries a ready-to-use `route`.
 */
import { call, hasBackend } from './frappe'

/**
 * @returns {Promise<{items: Array, error: string}>}
 *
 * Fails closed. Falling back to a hardcoded list would put entries on screen
 * that the server never cleared, which is the exact hole moving this to the
 * backend was meant to close — so an outage yields an empty rail plus a
 * message, not a guess.
 */
export async function fetchSidebar() {
  if (!hasBackend) return { items: [], error: '' }

  try {
    const tree = await call('custom_ui.api.get_sidebar')
    return { items: Array.isArray(tree) ? tree : [], error: '' }
  } catch (error) {
    return { items: [], error: error?.message || 'Could not load the sidebar.' }
  }
}

/** Every node beneath `node`, parents before children. */
export function descendants(node) {
  const out = []
  const stack = [...(node.children ?? [])]
  while (stack.length) {
    const next = stack.shift()
    out.push(next)
    stack.unshift(...(next.children ?? []))
  }
  return out
}
