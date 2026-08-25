/**
 * Laying any Frappe form out as the design's numbered section cards.
 *
 * The design draws a document as a stack of cards, each with a numbered badge.
 * The SDK's `FormLayout` renders the DocType's own sections as small uppercase
 * headings instead, which is why every form that was not the job looked
 * different from the rest of the app.
 *
 * **The cards come from the DocType, not from a list in here.** The SDK hands
 * over the real meta through `frm.frappe.get_meta()`; this walks it, splits on
 * Tab Break and Section Break, and applies the card treatment to each group.
 * Add a field on the server and it appears in its own card on the next load.
 *
 * Tabs are preserved rather than flattened. `Sales Invoice` has 210 fields
 * across 5 tabs and `Purchase Invoice` 193 across 5 — rendering those as one
 * column of 34 cards would be unusable.
 *
 * Fields are rendered by the SDK's own controls (`controlFor`), so Link
 * autocomplete, `depends_on`, validation, mandatory marking and every Client
 * Script keep working exactly as they do in `FormLayout`.
 */

/**
 * DocTypes that get a bespoke form template on top of the card layout.
 *
 * None yet for hitech_costing — every DocType renders the plain card
 * treatment. Add an entry here (and a matching template name check in the
 * caller) the day a DocType earns its own read-only document view.
 */
export const JOB_DOCTYPES = []

export const isJobDoctype = (doctype) => JOB_DOCTYPES.includes(String(doctype ?? ''))

/** Per-DocType section renames — none needed yet. */
const JOB_TITLES = {}

/** Fieldtypes that structure a form rather than hold a value. */
const BREAKS = new Set(['Column Break', 'Fold'])
// `Button` is deliberately absent: DocTypes use Button fields for real actions
// — Calculate Weight, Add Template — which the design shows as buttons.
const NON_INPUT = new Set(['HTML', 'Heading', 'Image', 'Barcode'])

const isInput = (df) =>
  Boolean(df?.fieldname) &&
  !BREAKS.has(df.fieldtype) &&
  !NON_INPUT.has(df.fieldtype) &&
  df.fieldtype !== 'Section Break' &&
  df.fieldtype !== 'Tab Break'

/** A Table renders a grid, so it takes the full card width rather than a cell. */
export const isWide = (df) => df?.fieldtype === 'Table' || df?.fieldtype === 'Table MultiSelect'

/**
 * Name a section the DocType left unlabelled.
 *
 * Several sections exist only to hold one child table — `cost_table`,
 * `document_table` — and carry no label. The table's own label is the honest
 * name for that card.
 */
function titleFor(sectionLabel, fields, titles) {
  if (sectionLabel) return titles[sectionLabel] ?? sectionLabel

  // An unlabelled section that exists only to hold one child table takes that
  // table's name — `cost_table` becomes "Cost Sheet", `document_table`
  // "Documents". Anything else falls back to a neutral heading: naming a
  // fourteen-field card after whatever field happens to come first produced
  // titles like "Date", which say less than nothing.
  const tables = fields.filter(isWide)
  if (tables.length === 1 && tables[0].label) return titles[tables[0].label] ?? tables[0].label
  return 'Details'
}

/**
 * Group a DocType's fields into tabs of cards.
 *
 * Returns `{ tabs, total }`. Each tab is `{ label, sections }`, each section
 * `{ n, title, fields }`, numbered within its tab. A DocType with no Tab Breaks
 * comes back as a single unlabelled tab, which the view renders without a tab
 * bar.
 *
 * Every input field the DocType declares lands in exactly one card, so a
 * mandatory field can never go missing and surface later as a save failure.
 * Runtime visibility (`hidden`, `depends_on`, Client Scripts) is not decided
 * here — the view asks the SDK's `fieldState` per field at render time.
 */
export function buildSections(frm, isJob = isJobDoctype(frm?.doctype)) {
  const fields = frm?.frappe?.get_meta?.(frm.doctype)?.fields ?? []
  if (!fields.length) return { tabs: [], total: 0 }

  // The caller passes the mapped template so the renames follow the backend's
  // `Custom UI Doctype Layout` record. The default keeps the old behaviour for
  // any caller that has not been given a layout name.
  const titles = isJob ? JOB_TITLES : {}

  // Walk once, opening a new tab at every Tab Break and a new group at every
  // Section Break. Fields before the first break belong to an implicit opener.
  const tabs = [{ label: '', groups: [{ label: '', fields: [] }] }]
  const lastTab = () => tabs[tabs.length - 1]
  const lastGroup = () => {
    const t = lastTab()
    return t.groups[t.groups.length - 1]
  }

  for (const df of fields) {
    if (df.fieldtype === 'Tab Break') {
      tabs.push({ label: df.label ?? '', groups: [{ label: '', fields: [] }] })
      continue
    }
    if (df.fieldtype === 'Section Break') {
      lastTab().groups.push({ label: df.label ?? '', fields: [] })
      continue
    }
    if (isInput(df)) lastGroup().fields.push(df)
  }

  const built = tabs
    .map((tab) => {
      const groups = tab.groups

      // An unlabelled opening group is the document's identity — naming series,
      // id, status. It belongs at the top of the first real card, not in a
      // nameless one of its own.
      if (groups.length > 1 && !groups[0].label && groups[1].fields.length) {
        groups[1].fields = [...groups[0].fields, ...groups[1].fields]
        groups[0].fields = []
      }

      return {
        label: tab.label,
        sections: groups
          .filter((g) => g.fields.length)
          .map((g, i) => ({ n: i + 1, title: titleFor(g.label, g.fields, titles), fields: g.fields }))
      }
    })
    .filter((tab) => tab.sections.length)

  return { tabs: built, total: fields.filter(isInput).length }
}
