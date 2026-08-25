import { call } from './frappe'
import { db } from './frappeDb'
import { formRouteFor } from './frappeRouting'
import { timeAgo } from '@/utils/format'

/**
 * Notifications come from Frappe's own `Notification Log` — the same records
 * the desk bell reads — so assignments, mentions, shares and Notification-rule
 * alerts raised anywhere in the site show up here with no extra plumbing.
 */
export const NOTIFICATION_DOCTYPE = 'Notification Log'
export const NOTIFICATION_LIMIT = 20

const LIST_FIELDS = [
  'name',
  'subject',
  'type',
  'document_type',
  'document_name',
  'from_user',
  'read',
  'creation'
]

/** Icon and accent per Notification Log `type`. */
const TYPE_META = {
  Mention: { icon: 'message-square-plus', color: '#7C3AED' },
  Assignment: { icon: 'user', color: '#2563EB' },
  Share: { icon: 'send', color: '#0EA5E9' },
  'Energy Point': { icon: 'star', color: '#F97316' },
  Alert: { icon: 'info', color: '#16A34A' }
}
const DEFAULT_META = { icon: 'bell', color: '#64748B' }

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'"
}

/**
 * Frappe subjects and email bodies are HTML fragments ("<b>JOB-2402</b> was
 * assigned to you"). The panel renders text nodes, not markup — flatten them
 * rather than trusting server HTML into v-html.
 */
export function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim()
}

/** Shape one Notification Log row for the header panel. */
export function toNotification(row, now = Date.now()) {
  const meta = TYPE_META[row.type] ?? DEFAULT_META
  const doctype = row.document_type || ''
  const docname = row.document_name || ''
  const body = stripHtml(row.email_content)
  return {
    id: row.name,
    subject: stripHtml(row.subject) || row.type || 'Notification',
    // Long alert bodies would push the list past a screen; one line is enough
    // to tell two notifications on the same document apart.
    body: body.length > 120 ? `${body.slice(0, 119)}…` : body,
    type: row.type || 'Alert',
    icon: meta.icon,
    color: meta.color,
    doctype,
    docname,
    reference: doctype && docname ? `${doctype} · ${docname}` : '',
    // Deliberately not `row.link`: that is a desk path (/app/...) which would
    // navigate out of this SPA. Route through the app's own form resolver.
    route: doctype && docname ? formRouteFor(doctype, docname) : '',
    read: Boolean(row.read),
    createdAt: row.creation,
    age: timeAgo(row.creation, now)
  }
}

/**
 * Every notification for the signed-in user, newest first.
 *
 * Prefers the desk's own whitelisted reader — it already scopes to the session
 * user — and falls back to a plain list read on sites where that method isn't
 * exposed.
 */
export async function fetchNotifications({ limit = NOTIFICATION_LIMIT, user } = {}) {
  try {
    const result = await call(
      'frappe.desk.doctype.notification_log.notification_log.get_notification_logs',
      { limit }
    )
    const rows = Array.isArray(result?.notification_logs)
      ? result.notification_logs
      : Array.isArray(result)
        ? result
        : null
    if (rows) return rows.map((row) => toNotification(row))
  } catch {
    // Method missing or blocked — fall through to the list read below.
  }

  const rows = await db.get_list(NOTIFICATION_DOCTYPE, {
    fields: LIST_FIELDS,
    filters: user ? { for_user: user } : {},
    order_by: 'creation desc',
    limit_page_length: limit
  })
  return (rows ?? []).map((row) => toNotification(row))
}

/** Mark one notification read. */
export async function markNotificationRead(name) {
  try {
    await call('frappe.desk.doctype.notification_log.notification_log.mark_as_read', {
      docname: name
    })
  } catch {
    await db.set_value(NOTIFICATION_DOCTYPE, name, 'read', 1)
  }
}

/** Mark everything read; `ids` is the per-record fallback when the bulk method is unavailable. */
export async function markAllNotificationsRead(ids = []) {
  try {
    await call('frappe.desk.doctype.notification_log.notification_log.mark_all_as_read')
  } catch {
    await Promise.all(ids.map((id) => markNotificationRead(id).catch(() => {})))
  }
}
