/**
 * Two affordances the SDK's controls leave out, added to rendered forms.
 *
 *  - **A clear (×) button on Link fields.** `ControlLink` renders only an
 *    open-document arrow, so the sole way to empty a Link is to select its text
 *    and delete it. The desk offers a clear button; this is the equivalent.
 *
 *  - **A required marker.** The SDK sets `df.reqd` and enforces it on save, but
 *    only a couple of controls (Attach, Table) actually render a marker — Link,
 *    Date, Data and the rest show nothing, so a required field is invisible
 *    until submitting fails. The app's stylesheet already carries the rule for
 *    `.control.reqd`; this puts the class where that rule can find it.
 *
 * Why DOM augmentation rather than custom controls: the SDK resolves controls
 * through an internal `Fs[fieldtype]` map that it never exports — only the
 * `controlFor` *reader* is public — so replacement controls cannot be
 * registered. Patching the dist bundle would be undone by the next install.
 * Adding to the markup the SDK already renders is the smallest intervention
 * that survives a dependency bump.
 *
 * Both run from one MutationObserver: the SDK re-renders a control on every
 * value change, which throws away anything injected into it, so this has to
 * observe rather than run once.
 */

const CLEAR_CLASS = 'link-clear-btn'
const REQD_CLASS = 'reqd'
const EMPTY_CLASS = 'reqd-empty'
const LINK_SELECTOR = 'label.control-link, label.control-dynamic-link'
const CONTROL_SELECTOR = 'label.control[data-fieldname]'

const CLEAR_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M4.28 3.57a.5.5 0 0 0-.71.71L7.3 8l-3.73 3.72a.5.5 0 1 0 .71.71L8 8.71l3.72 3.72a.5.5 0 0 0 .71-.71L8.71 8l3.72-3.72a.5.5 0 1 0-.71-.71L8 7.29 4.28 3.57Z"/></svg>`

/** The live docfield for a rendered control, or null. */
function docfieldFor(label, frm) {
  const fieldname = label.dataset?.fieldname
  if (!fieldname) return null
  // `fields_dict` rather than the static meta, so `toggle_reqd` and
  // `set_df_property` are reflected as they happen.
  return frm?.fields_dict?.[fieldname]?.df ?? null
}

/* ── Required marker ────────────────────────────────────────────────────── */

function syncRequired(label, frm) {
  const df = docfieldFor(label, frm)
  const required = Boolean(df?.reqd) && !df?.hidden
  label.classList.toggle(REQD_CLASS, required)

  // A required field that is still empty is the one worth colouring: it is what
  // is actually blocking the save (or, on the report filter bar, the run). The
  // doc is the authority here rather than the input's value — a Link mid-typing
  // has text in the box but no value set.
  const value = required ? frm?.doc?.[label.dataset.fieldname] : null
  const empty = value === null || value === undefined || value === ''
  label.classList.toggle(EMPTY_CLASS, required && empty)

  // The marker is decorative; this is what a screen reader acts on.
  if (required) label.setAttribute('aria-required', 'true')
  else label.removeAttribute('aria-required')
}

/* ── Link clear button ──────────────────────────────────────────────────── */

/**
 * Whether a Link label should currently carry a clear button.
 *
 * Mirrors the SDK's own rule for the open-document arrow: shown when the field
 * holds a value. Read-only and disabled fields are excluded — offering a clear
 * on a field the user cannot edit would only produce a silent no-op.
 */
function shouldShowClear(label) {
  const input = label.querySelector('input')
  if (!input || input.disabled || input.readOnly) return false
  return Boolean(input.value)
}

/**
 * Empty the field.
 *
 * Routed through `frm.set_value` rather than by clearing the input directly, so
 * that dependent logic runs: `set_value` fires the fieldname trigger, which is
 * what `fetch_from` targets and depends_on conditions re-evaluate against. Just
 * blanking the DOM would leave `frm.doc` untouched entirely.
 *
 * Falls back to a synthetic `input` event when no `frm` was supplied — the SDK's
 * own handler treats an empty input as `setValue(null)`, so the value still
 * clears, just without the trigger.
 */
function clearField(label, frm) {
  const fieldname = label.dataset.fieldname
  const input = label.querySelector('input')
  if (!fieldname) return

  if (frm?.set_value) {
    frm.set_value(fieldname, null)
  } else if (input) {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  // The SDK mirrors `value` into its own ref on change; keep the visible text in
  // step for the case where set_value did not re-render this input.
  if (input) input.value = ''
  input?.focus()
}

/** Add or remove the clear button on one Link label to match its state. */
function syncClear(label, frm) {
  const wrap = label.querySelector('.link-wrap')
  if (!wrap) return

  const existing = wrap.querySelector(`.${CLEAR_CLASS}`)
  if (!shouldShowClear(label)) {
    existing?.remove()
    return
  }
  if (existing) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = CLEAR_CLASS
  button.tabIndex = -1
  button.title = 'Clear'
  button.setAttribute('aria-label', 'Clear')
  button.innerHTML = CLEAR_ICON
  // mousedown, not click: the input's blur handler closes the awesomplete
  // dropdown and can re-render the control, which would destroy this button
  // before a click ever landed. preventDefault also keeps focus in the field.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    clearField(label, frm)
    // Re-sync on the next frame so the button removes itself once empty.
    requestAnimationFrame(() => syncClear(label, frm))
  })

  // Before the open arrow so the two never swap places as the value changes.
  const openBtn = wrap.querySelector('.link-open-btn')
  wrap.insertBefore(button, openBtn ?? null)
}

/* ── Install ────────────────────────────────────────────────────────────── */

/**
 * Keep both enhancements in sync inside `root` while the form is mounted.
 *
 * `input` is watched separately from the observer because typing changes a
 * Link's emptiness without altering the DOM structure the observer sees.
 *
 * Returns a teardown function; call it on unmount.
 */
export function installFormEnhancements(root, getFrm) {
  if (!root || typeof MutationObserver === 'undefined') return () => {}

  const frm = () => (typeof getFrm === 'function' ? getFrm() : getFrm)

  const syncAll = () => {
    const current = frm()
    for (const label of root.querySelectorAll(CONTROL_SELECTOR)) syncRequired(label, current)
    for (const label of root.querySelectorAll(LINK_SELECTOR)) syncClear(label, current)
  }

  const observer = new MutationObserver((records) => {
    // Ignore this module's own writes, or every insert would loop. Class
    // changes are filtered the same way, since syncRequired sets one.
    const relevant = records.some((record) => {
      if (record.type === 'attributes') return record.attributeName !== 'class'
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => !(node.nodeType === 1 && node.classList?.contains(CLEAR_CLASS))
      )
    })
    if (relevant) syncAll()
  })
  observer.observe(root, { childList: true, subtree: true })

  // Editing changes both a Link's emptiness and a required field's filled-ness
  // without necessarily altering the DOM structure the observer watches, so
  // both are re-synced here. `change` as well as `input`: Date and Select
  // controls commit on change only.
  const onEdit = (event) => {
    const label = event.target.closest?.(CONTROL_SELECTOR)
    if (!label) return
    const current = frm()
    syncRequired(label, current)
    if (label.matches(LINK_SELECTOR)) syncClear(label, current)
  }
  root.addEventListener('input', onEdit, true)
  root.addEventListener('change', onEdit, true)

  syncAll()

  return () => {
    observer.disconnect()
    root.removeEventListener('input', onEdit, true)
    root.removeEventListener('change', onEdit, true)
    for (const button of root.querySelectorAll(`.${CLEAR_CLASS}`)) button.remove()
    for (const label of root.querySelectorAll(`.${REQD_CLASS}, .${EMPTY_CLASS}`)) {
      label.classList.remove(REQD_CLASS, EMPTY_CLASS)
      label.removeAttribute('aria-required')
    }
  }
}
