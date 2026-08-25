/**
 * Compatibility shims for rendering real Frappe DocTypes with the SDK.
 */

/**
 * Re-register custom buttons that `onload` added.
 *
 * `Frm.trigger` clears every custom button whenever the `refresh` event fires,
 * and `run_lifecycle` fires `setup` → `onload` → `refresh`. So anything an
 * `onload` handler registered is wiped before the toolbar ever renders, while
 * buttons added in `refresh` survive. On `Operations` that silently loses
 * "Close" and the whole "Get items from" group, which the desk shows.
 *
 * Re-triggering `onload` after the lifecycle puts them back. `add_custom_button`
 * appends without deduping, so the list is collapsed on label+group afterwards —
 * otherwise a handler registering in both events would double up.
 *
 * Call after `useFrmRemote` resolves. Redundant once the SDK clears buttons
 * before `onload` rather than after.
 */
export async function restoreOnloadCustomButtons(frm) {
  if (!frm?.trigger || !Array.isArray(frm.custom_buttons)) return frm
  try {
    await frm.trigger('onload')
  } catch (e) {
    console.error('[hitech-costing-ui] re-running onload for custom buttons failed:', e)
    return frm
  }

  const seen = new Set()
  const unique = frm.custom_buttons.filter((btn) => {
    const key = `${btn.group ?? ''}::${btn.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  frm.custom_buttons.splice(0, frm.custom_buttons.length, ...unique)
  return frm
}

/** Fieldtypes that carry no value, so "empty" says nothing about them. */
const VALUELESS_FIELDTYPES = new Set([
  'Section Break',
  'Column Break',
  'Tab Break',
  'Button',
  'HTML',
  'Heading',
  'Fold'
])

/**
 * Hide read-only fields that have no value.
 *
 * Frappe's desk does this: a read-only field with nothing in it is dead space,
 * so the form omits it rather than showing a greyed-out empty box. The SDK
 * renders it regardless — on `Operations` that leaves a column of blank
 * disabled inputs among the real ones.
 *
 * Rather than hiding them once at refresh (which would strand a field that
 * gains a value later, from a fetch_from or a script), this leans on the SDK's
 * own reactivity: `fieldState` recomputes `visible` from `depends_on` against
 * the live doc on every render, and `evaluate_depends_on` accepts a bare
 * fieldname as "truthy?". Setting `depends_on` to the field's own name
 * therefore means "show only when filled", and it updates as the value does.
 *
 * Fields that already declare a `depends_on` are left alone — composing two
 * conditions correctly isn't worth the risk of breaking a real one.
 *
 * Note this treats 0 and "" alike, so a read-only Currency showing 0 hides.
 * That matches the desk. Pass `keep` to exempt specific fieldnames.
 */
export function hideEmptyReadOnlyFields(doctype, { keep = [] } = {}) {
  const exempt = new Set(keep)
  return (frappe) => {
    frappe.ui.form.on(doctype, {
      refresh(frm) {
        const meta = frm.frappe?.get_meta?.(frm.doctype)
        for (const df of meta?.fields ?? []) {
          if (!df.fieldname || exempt.has(df.fieldname)) continue
          if (!df.read_only || df.hidden) continue
          if (VALUELESS_FIELDTYPES.has(df.fieldtype)) continue
          if (df.depends_on) continue
          frm.set_df_property(df.fieldname, 'depends_on', df.fieldname)
        }
      }
    })
  }
}

/**
 * Hide specific fields by fieldname.
 *
 * For meta fields the form has no business showing — `naming_series` being the
 * usual one. The desk hides the series selector once a document is saved, since
 * the name is already fixed and changing the series does nothing; the SDK
 * renders it from meta either way, so it shows up as a dead dropdown next to the
 * real inputs.
 *
 * Runs on `refresh` rather than once at load because `Frm.trigger('refresh')`
 * re-runs after every save, and a field hidden only at load would come back.
 * `set_df_property` bumps the field's refreshKey, so the layout reacts
 * immediately — `fieldState.visible` is `!df.hidden && depends_on`.
 *
 * Registered after the native Client Scripts, so this wins if one of them
 * un-hides the same field.
 */
export function hideFields(doctype, fieldnames = []) {
  const targets = Array.isArray(fieldnames) ? fieldnames : [fieldnames]
  return (frappe) => {
    frappe.ui.form.on(doctype, {
      refresh(frm) {
        for (const fieldname of targets) {
          frm.set_df_property(fieldname, 'hidden', 1)
        }
      }
    })
  }
}

/**
 * Force every Table field on the document to hold an array.
 *
 * A Table field should always be a list, but Frappe lets you set a `default` on
 * one, and the SDK's new-document builder copies that default verbatim — so a
 * new doc can arrive with a *string* where a grid is expected. `Operations
 * .container_details` is exactly this: it defaults to `"Container Details"`.
 *
 * `ControlTable`'s `rows` computed only guards with `?? []`, so the string flows
 * through, gets iterated character by character, and each character is handed to
 * a `WeakMap` keyed by row object — which throws `Invalid value used as weak map
 * key`, unmounts the entire `FormView`, and leaves a blank page. Every field on
 * the form disappears because of one bad child-table default.
 *
 * Run this between `useFrmRemote` resolving and handing `frm` to the template.
 *
 * The SDK fixes this upstream on `fix/control-table-non-array-guard`
 * (commit d4e94c7); this can go once that ships and the pin moves.
 */
export function coerceTableFields(frm) {
  if (!frm?.doc) return frm
  const meta = frm.frappe?.get_meta?.(frm.doctype)
  for (const df of meta?.fields ?? []) {
    if (df.fieldtype !== 'Table' && df.fieldtype !== 'Table MultiSelect') continue
    if (!df.fieldname) continue
    if (!Array.isArray(frm.doc[df.fieldname])) {
      frm.doc[df.fieldname] = []
    }
  }
  return frm
}

/**
 * Lock a submitted document, the way Frappe's desk does.
 *
 * **Frappe's rule.** `docstatus` is 0 draft, 1 submitted, 2 cancelled. Once a
 * document is submitted its fields become read-only, *except* those the DocType
 * marks `allow_on_submit` — a status, a remark, a delivery date. A cancelled
 * document is read-only outright. The server enforces the same thing in
 * `_validate_update_after_submit`, so an edit that slips past the UI is
 * rejected on save with "Not allowed to change X after submission".
 *
 * **What the SDK does.** Not this, for the fields on the parent form. Its
 * `frm-core` has the correct rule — `field-state.ts` computes
 * `readOnly = read_only || (docstatus === 1 && !allow_on_submit) || …` — and
 * uses it for child-table rows. But the parent's controls do not go through it:
 * `controls/useField.ts` derives `readOnly` from `df.read_only` alone, and the
 * `fieldState` exported for layouts drops the docstatus term entirely. So a
 * submitted document renders with every field still editable, and the first
 * anyone knows is the server refusing the save.
 *
 * **What this does.** Stamps `df.read_only` to match Frappe's rule, which is
 * exactly the channel the SDK's own child-grid code uses to the same end. The
 * original `read_only` is remembered per field, so amending back to a draft
 * restores the form rather than leaving it permanently locked.
 *
 * Drop this once the SDK's controls read `field-state.ts`.
 */
export function lockOnSubmit(doctype) {
  // The DocType's own `read_only`, before any locking. Keyed by fieldname.
  const original = new Map()

  return (frappe) => {
    frappe.ui.form.on(doctype, {
      refresh(frm) {
        const docstatus = Number(frm.doc?.docstatus ?? 0)
        const meta = frm.frappe?.get_meta?.(frm.doctype)
        if (!meta?.fields || !meta.is_submittable) return

        for (const df of meta.fields) {
          if (!df.fieldname) continue
          if (!original.has(df.fieldname)) original.set(df.fieldname, df.read_only ? 1 : 0)

          const wasReadOnly = original.get(df.fieldname)
          // Submitted: everything but `allow_on_submit`. Cancelled: everything.
          const locked =
            docstatus === 2 || (docstatus === 1 && !df.allow_on_submit)

          frm.set_df_property(df.fieldname, 'read_only', wasReadOnly || locked ? 1 : 0)
        }
      }
    })
  }
}

/**
 * Whether a document is locked against editing, for the views' own chrome.
 *
 * Mirrors the rule above so a banner and the field states cannot disagree.
 */
export function isLocked(frm) {
  const docstatus = Number(frm?.doc?.docstatus ?? 0)
  return docstatus === 1 || docstatus === 2
}

/** 'Draft' | 'Submitted' | 'Cancelled' — the docstatus, in words. */
export function docstatusLabel(frm) {
  return ['Draft', 'Submitted', 'Cancelled'][Number(frm?.doc?.docstatus ?? 0)] ?? 'Draft'
}

/**
 * Hide the naming series.
 *
 * The field is noise on every form in this app, for two different reasons.
 *
 * On a saved document the choice is already spent: the field goes disabled and
 * shows a raw pattern (`{b_abbv}.{abb}.-.YY.-.####`) that says nothing the
 * heading does not already say with the real name.
 *
 * On a *new* one it is rarely a real choice either. `Operations` offers
 * `branch_abb.-.job_type_abb.-.mos_abb.-.YY.-.#####` and two more like it —
 * naming templates built from hidden abbreviation fields, so the name follows
 * from Branch, Job Type and Mode rather than from anything anyone picks. A
 * dropdown of template expressions is not a decision an operator can make.
 *
 * So it is hidden outright and Frappe applies the DocType's default series.
 *
 * **The trade-off:** a DocType whose series *are* meaningful — `Payment Entry`
 * carries BRV, CRV, JBRV, JCRV, RBRV and ACC-PAY — loses the ability to pick a
 * non-default one here. That has to be done from the desk. To bring the picker
 * back for those, gate the call below on `frm.is_new()` and on the options
 * reading as prefixes rather than templates.
 */
export function hideNamingSeries(doctype) {
  return (frappe) => {
    frappe.ui.form.on(doctype, {
      refresh(frm) {
        // Not every DocType has one; those are left alone rather than warned about.
        if (!frm.fields_dict?.naming_series?.df) return
        frm.set_df_property('naming_series', 'hidden', 1)
      }
    })
  }
}

/**
 * Populate the workflow transition buttons `FormToolbar` reads.
 *
 * **The bug.** `FormToolbar.vue` renders Approve/Reject-style buttons from
 * `frm.doc.__workflow_transitions` / `__workflow_state`, on the assumption
 * that "the Frappe server" sets them the way it does inside the desk. Nothing
 * here does: not `frm-core`, not `frappe.client.get`/`save`/`submit`, nothing
 * in this app. So for every workflow-driven DocType — `Costing Worksheet`
 * included — those two properties are simply undefined, and a BU Head or CFO
 * reopening a document sees no Approve/Reject buttons at all.
 *
 * **What desk actually does.** Computes them from the whitelisted
 * `frappe.model.workflow.get_transitions`, called with the current doc.
 *
 * **What this does.** The same call, on `refresh` (so it re-runs after
 * `FormToolbar`'s own `applyWorkflow()` calls `frm.refresh()` post-transition,
 * picking up the next stage's actions). Skipped for a new/unsaved doc —
 * `get_transitions` would just return `[]` for one anyway, since a workflow
 * transition needs a real `docstatus`/state to transition from.
 */
/**
 * Keep `frm.doc` in sync with the doc a workflow transition actually wrote.
 *
 * **The bug.** `FormToolbar.vue`'s `applyWorkflow()` calls
 * `frappe.model.workflow.apply_workflow`, then does
 * `if (result?.doc) { merge result.doc onto frm.doc }`. But
 * `frappe/model/workflow.py`'s `apply_workflow(doc, action)` returns the
 * updated `Document` itself — Frappe's request handler puts that straight on
 * `message`, so once this app's transport unwraps `.message`, `result` *is*
 * the doc, flat. There is no `result.doc` — that branch is always false, and
 * the merge silently never runs. The follow-up `await frm.refresh()` doesn't
 * help either: `Frm.refresh()` just re-fires the `refresh` event, it never
 * re-fetches from the server (see `reload_doc()` for the version that does).
 *
 * **The consequence.** `apply_workflow` calls `doc.save()` (or `.submit()`)
 * server-side, which bumps the row's `modified` timestamp. `frm.doc.modified`
 * never learns about that. The next `frm.save()`, `frm.submit()`, or even
 * `frm.call('calculate')` (its `run_doc_method` endpoint does its own
 * `check_if_latest()` against the client-sent `modified`) then fails with
 * Frappe's "has been modified after you have opened it" error — not because
 * anyone else touched the document, but because the transition itself did and
 * the client was never told.
 *
 * **The fix.** Wrap this runtime's own `frappe.call` once, so that whenever
 * `apply_workflow` resolves, its response — the fresh doc, `modified` and
 * `status`/`workflow_state` included — is merged onto whichever `frm` is
 * currently loaded (`globalThis.cur_frm`, set by `Frm`'s constructor) before
 * `FormToolbar` ever inspects it. Idempotent per `frappe` instance ( one per
 * `useFrmRemote()` load) via `__workflowApplyPatched`.
 */
function patchWorkflowApplyStaleness(frappe) {
  if (frappe.__workflowApplyPatched) return
  frappe.__workflowApplyPatched = true
  const rawCall = frappe.call.bind(frappe)
  frappe.call = async (method, args) => {
    const result = await rawCall(method, args)
    if (method === 'frappe.model.workflow.apply_workflow' && result && typeof result === 'object') {
      const frm = globalThis.cur_frm
      if (frm?.doc && frm.doctype === result.doctype && String(frm.doc.name) === String(result.name)) {
        Object.assign(frm.doc, result)
      }
    }
    return result
  }
}

export function installWorkflowActions(doctype, { stateField = 'workflow_state' } = {}) {
  return (frappe) => {
    patchWorkflowApplyStaleness(frappe)

    frappe.ui.form.on(doctype, {
      async refresh(frm) {
        if (frm.is_new()) {
          frm.doc.__workflow_transitions = []
          frm.doc.__workflow_state = ''
          return
        }
        try {
          const transitions = await frm.frappe.call('frappe.model.workflow.get_transitions', {
            doc: JSON.stringify(frm.doc)
          })
          frm.doc.__workflow_transitions = Array.isArray(transitions) ? transitions : []
        } catch (e) {
          console.error(`[hitech-costing-ui] workflow transitions for ${doctype} failed:`, e)
          frm.doc.__workflow_transitions = []
        }
        frm.doc.__workflow_state = frm.doc[stateField] ?? ''
      }
    })
  }
}
