/**
 * The standard set of row buttons.
 *
 * Every list draws the same three affordances — open it, print it, take it
 * forward — so they are described once here rather than retyped per screen.
 * `RowActions` decides how they look; this decides what they are.
 */
import { downloadPdf, openPrintView } from './print'
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

/** A PDF failure in words a user can act on. The server's PDF engine
 *  (wkhtmltopdf) reports its own network faults verbatim -- "Exit with code 1
 *  due to network error: HostNotFoundError" when it cannot reach the site to
 *  fetch styles and images -- which is a server setting, not anything the user
 *  did (2026-10-13). Other messages pass through. */
export function pdfErrorMessage(e) {
  const text = String(e?.message || '')
  if (/network error|HostNotFound|ConnectionRefused|Exit with code/i.test(text)) {
    return 'The server could not build the PDF: its PDF engine cannot reach this site to load the quotation\'s styles and images. Use Print in the meantime, and ask your administrator to check the PDF / site host settings.'
  }
  return text || 'The server could not produce the PDF.'
}

/** Download one record's PDF; a failure is reported the way `printRecord` does. */
export async function downloadRecordPdf(doctype, name) {
  try {
    await downloadPdf(doctype, name)
  } catch (e) {
    msgprint(pdfErrorMessage(e), 'Could not download the PDF')
  }
}
