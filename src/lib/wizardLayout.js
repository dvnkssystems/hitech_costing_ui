/**
 * Backend-configured field layout for a wizard: custom_ui's
 * `Custom UI Wizard Layout` record, read through `custom_ui.api.get_wizard_layout`.
 *
 * Each wizard section asks `fields(section, builtIn)` for what to render. A
 * section with rows in the record shows exactly those rows, in order, minus
 * the Hidden ones; a section with none (or no record at all, or the request
 * failing) keeps its built-in list, so the wizard never depends on the record
 * existing. Label and Read Only are applied onto each frm's own field
 * definitions by `applyTo()`.
 */
import { reactive } from 'vue'
import { call } from '@/lib/frappe'

export function createWizardLayout(wizard) {
  const state = reactive({ sections: {}, loaded: false })

  async function load() {
    try {
      const result = await call('custom_ui.api.get_wizard_layout', { wizard })
      state.sections = result?.sections ?? {}
    } catch {
      state.sections = {}
    } finally {
      state.loaded = true
    }
  }

  function rows(section) {
    const list = state.sections[section]
    return Array.isArray(list) && list.length ? list : null
  }

  /** The fieldnames `section` renders, in order. */
  function fields(section, builtIn) {
    const list = rows(section)
    return list ? list.filter((row) => !row.hidden).map((row) => row.fieldname) : builtIn
  }

  /** Fields the record marks Read Only in `section`: shown as read-only even
   *  on an editable card, which otherwise drops read-only fields. */
  function readOnly(section) {
    const list = rows(section)
    return list ? list.filter((row) => !row.hidden && row.read_only).map((row) => row.fieldname) : []
  }

  /** Every visible, editable field the record places on `doctype` — what a
   *  header payload must carry for an added field to be saved. */
  function editableFields(doctype) {
    const out = new Set()
    for (const list of Object.values(state.sections)) {
      for (const row of list) if (row.doctype === doctype && !row.hidden && !row.read_only) out.add(row.fieldname)
    }
    return [...out]
  }

  /** Puts the record's Label / Read Only onto `frm`'s field definitions. */
  function applyTo(frm, doctype) {
    if (!frm?.set_df_property) return
    for (const list of Object.values(state.sections)) {
      for (const row of list) {
        if (row.doctype !== doctype || !frm.fields_dict?.[row.fieldname]) continue
        const df = frm.fields_dict[row.fieldname].df
        if (row.label && df.label !== row.label) frm.set_df_property(row.fieldname, 'label', row.label)
        if (row.read_only && !df.read_only) frm.set_df_property(row.fieldname, 'read_only', 1)
      }
    }
  }

  return { state, load, fields, readOnly, editableFields, applyTo }
}
