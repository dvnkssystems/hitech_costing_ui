/**
 * A document's activity, from Frappe's own record of it.
 *
 * Nothing here is invented or logged by this app. `get_docinfo` is the exact
 * call the desk's form makes to build its timeline, so what the drawer shows is
 * what the desk shows: the same comments, the same field-level history, the
 * same assignment and attachment trail — for changes made from the desk, from
 * this app, from the API, or by a server script.
 *
 * The field history comes from `Version`, which Frappe writes on every save
 * that changed something. Its `data` is a JSON blob of five lists:
 *
 *   changed      [[fieldname, old, new], …]
 *   added        [[parentfield, {row}], …]           child table rows
 *   removed      [[parentfield, {row}], …]
 *   row_changed  [[parentfield, idx, rowname, [[fieldname, old, new], …]], …]
 *   data_import  set when the change came from an import rather than a person
 *
 * Turning that into a sentence is this module's real work. The design writes
 * each line as **who** + what they did — "Alex Morgan changed Status from Draft
 * to Open" — so that is the shape returned: `who` and `text` separately, not
 * one string the view has to take apart again.
 */

import { call } from './frappe'
import { timeAgo } from '@/utils/format'

/** Comment rows Frappe files under these docinfo keys are already prose. */
const LOG_KEYS = [
  ['info_logs', 'info'],
  ['assignment_logs', 'assignment'],
  ['attachment_logs', 'attachment'],
  ['workflow_logs', 'workflow']
]

/* The design's timeline dot: a lucide glyph on a tinted disc, one per kind. */
const KIND_STYLE = {
  comment: { icon: 'message-square-plus', color: '#7C3AED', background: '#F5F3FF' },
  change: { icon: 'pencil', color: '#2563EB', background: '#EFF6FF' },
  email: { icon: 'mail', color: '#0EA5E9', background: '#F0F9FF' },
  assignment: { icon: 'user-plus', color: '#0B3465', background: '#E9EFF7' },
  attachment: { icon: 'paperclip', color: '#64748B', background: '#F1F5F9' },
  workflow: { icon: 'workflow', color: '#0B3465', background: '#E9EFF7' },
  info: { icon: 'clock', color: '#64748B', background: '#F1F5F9' }
}

export const activityStyle = (kind) => KIND_STYLE[kind] ?? KIND_STYLE.info

/* ── Reading a value ─────────────────────────────────────────────────────── */

/** Frappe stores rich text and long text in ordinary fields; a timeline line
 *  wants neither markup nor three paragraphs. */
function readable(value, limit = 60) {
  if (value === null || value === undefined || value === '') return '—'
  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return '—'
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** `posting_date` reads better as "Posting Date" than as itself. */
const humanize = (fieldname) =>
  String(fieldname ?? '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()

/** The person, named the way the desk names them. `get_docinfo` ships a
 *  `user_info` map precisely so a timeline need not show raw addresses. */
const nameFor = (userInfo, email) =>
  userInfo?.[email]?.fullname || String(email ?? '').split('@')[0] || 'Someone'

/* ── Versions into sentences ─────────────────────────────────────────────── */

/**
 * One `Version` row as a sentence and its supporting lines.
 *
 * A single changed field says what it was and what it became, because that is
 * the whole story. Several is a count with the detail underneath — a line
 * listing fourteen fields is not a line.
 */
function describeVersion(data, labelFor) {
  const label = (fieldname) => labelFor?.(fieldname) || humanize(fieldname)
  const changed = Array.isArray(data.changed) ? data.changed : []
  const added = Array.isArray(data.added) ? data.added : []
  const removed = Array.isArray(data.removed) ? data.removed : []
  const rowChanged = Array.isArray(data.row_changed) ? data.row_changed : []

  const lines = changed.map(
    ([fieldname, from, to]) => `${label(fieldname)}: ${readable(from)} → ${readable(to)}`
  )

  // Child tables are counted rather than enumerated: adding six parcels is one
  // action to the person who did it, not six.
  const tableCounts = new Map()
  const bump = (parentfield, verb) => {
    const key = `${verb}|${parentfield}`
    tableCounts.set(key, (tableCounts.get(key) ?? 0) + 1)
  }
  for (const [parentfield] of added) bump(parentfield, 'added')
  for (const [parentfield] of removed) bump(parentfield, 'removed')
  for (const [parentfield] of rowChanged) bump(parentfield, 'edited')

  const tableLines = [...tableCounts.entries()].map(([key, count]) => {
    const [verb, parentfield] = key.split('|')
    return `${verb} ${count} row${count === 1 ? '' : 's'} in ${label(parentfield)}`
  })

  const all = [...lines, ...tableLines]
  if (!all.length) return null

  if (all.length === 1) {
    // A lone table line is already a sentence ("added 3 rows in Cost Table");
    // a lone field change needs the verb in front of it.
    const only = all[0]
    return { text: tableLines.length ? only : `changed ${only}`, detail: [] }
  }

  const what = changed.length && !tableLines.length ? 'fields' : 'things'
  return { text: `updated ${all.length} ${what}`, detail: all }
}

/* ── The timeline ────────────────────────────────────────────────────────── */

/**
 * Split into the drawer's two tabs.
 *
 * Activity is the record's own history — edits, assignments, attachments,
 * workflow moves, emails. Comments are what people wrote, which is a different
 * kind of thing to read and gets its own tab in the design.
 */
function toFeeds(docinfo, labelFor, now) {
  const userInfo = docinfo.user_info ?? {}
  const activity = []
  const comments = []

  const event = (row, kind, who, text, detail = []) => ({
    id: `${kind}:${row.name}`,
    kind,
    who,
    text,
    detail,
    at: row.creation,
    time: timeAgo(row.creation, now)
  })

  for (const row of docinfo.comments ?? []) {
    const email = row.comment_email || row.owner
    comments.push({
      ...event(row, 'comment', nameFor(userInfo, email), readable(row.content, 600)),
      initial: (nameFor(userInfo, email)[0] ?? '?').toUpperCase()
    })
  }

  for (const row of docinfo.versions ?? []) {
    let data = {}
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {})
    } catch {
      // A Version whose payload will not parse is not worth a broken line.
      continue
    }
    const described = describeVersion(data, labelFor)
    if (!described) continue
    activity.push(
      event(row, 'change', nameFor(userInfo, row.owner), described.text, described.detail)
    )
  }

  for (const row of docinfo.communications ?? []) {
    const at = row.communication_date || row.creation
    activity.push(
      event(
        { ...row, creation: at },
        'email',
        nameFor(userInfo, row.sender || row.owner),
        `emailed “${readable(row.subject, 90)}”`,
        row.recipients ? [`To ${readable(row.recipients, 90)}`] : []
      )
    )
  }

  for (const [key, kind] of LOG_KEYS) {
    for (const row of docinfo[key] ?? []) {
      activity.push(
        event(row, kind, nameFor(userInfo, row.owner), readable(row.content, 180) || humanize(row.comment_type))
      )
    }
  }

  // Newest first, which is the order a timeline is read in.
  const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at))
  activity.sort(newestFirst)
  comments.sort(newestFirst)
  return { activity, comments }
}

/**
 * Everything Frappe knows about what happened to one document.
 *
 * `labelFor` maps a fieldname to its label — pass `frm`'s, so the timeline says
 * "Mode Of Shipment" where the DocType does. Falls back to humanising the
 * fieldname when no resolver is given.
 *
 * An unsaved document has no history and is not asked about: `get_docinfo` on a
 * name that does not exist raises, and "nothing yet" is the honest answer
 * without a round trip.
 */
export async function fetchActivity(doctype, name, { labelFor, now = Date.now() } = {}) {
  if (!doctype || !name || String(name).startsWith('new-')) {
    return { activity: [], comments: [], unsaved: true }
  }

  const response = await call('frappe.desk.form.load.get_docinfo', { doctype, name })
  // `get_docinfo` answers on `docinfo`, not as the message itself.
  const docinfo = response?.docinfo ?? response ?? {}
  return { ...toFeeds(docinfo, labelFor, now), unsaved: false }
}

export { describeVersion, readable, humanize, nameFor }
