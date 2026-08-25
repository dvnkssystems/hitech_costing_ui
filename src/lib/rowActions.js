/**
 * The standard set of row buttons.
 *
 * Every list draws the same three affordances — open it, print it, take it
 * forward — so they are described once here rather than retyped per screen.
 * `RowActions` decides how they look; this decides what they are.
 */
import { openPrintView } from './print'
import { msgprint } from '@frappe-vue-sdk/vue'

export const VIEW = { key: 'open', label: 'View', icon: 'eye', color: 'slate' }
export const PRINT = { key: 'print', label: 'Open the print format in a new tab', icon: 'printer', color: 'slate' }

/**
 * The green forward action. Its label differs per screen because what a record
 * turns into differs — a quote becomes a job, a lead becomes a quote — so the
 * caller names it rather than inheriting something vague.
 */
export const forward = (label) => ({
  key: 'forward',
  label,
  icon: 'arrow-right-circle',
  color: 'green'
})

/** View and Print, which mean the same thing for every DocType. */
export const standardActions = (forwardLabel) =>
  forwardLabel ? [VIEW, PRINT, forward(forwardLabel)] : [VIEW, PRINT]

/**
 * Print one record.
 *
 * Reported through a dialog rather than a page-level error banner: that banner
 * describes the list query, and a failed print says nothing about whether the
 * list loaded. Every screen made the same call with the same try/catch, so it
 * lives here now.
 */
export function printRecord(doctype, name) {
  try {
    openPrintView(doctype, name)
  } catch (e) {
    msgprint(e?.message ?? String(e), 'Could not open the print view')
  }
}
