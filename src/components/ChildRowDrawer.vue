<script setup>
/**
 * One child-table row, opened as a right-hand drawer.
 *
 * Mount this once beside a rendered form and hand it the form's wrapper
 * element; it wires every child table inside that wrapper itself. See
 * `src/lib/childRowDrawer.js` for why the grid is augmented rather than
 * replaced.
 *
 * Edits are live — a control writes straight through to the row, so the grid
 * behind the drawer updates as you type and the parent form goes dirty the same
 * way it would from a cell. There is deliberately no Save button here: the row
 * has no independent existence to save, and one on the drawer would imply the
 * parent had been written when it has not.
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { controlFor } from '@frappe-vue-sdk/vue'
import { installRowDrawer, rowFrmFor, rowFields, tableLabel } from '@/lib/childRowDrawer'

const props = defineProps({
  /** The parent form's `frm`. Null until the form has loaded. */
  frm: { type: Object, default: null },
  /** The wrapper element holding the rendered form. */
  root: { type: Object, default: null }
})

const fieldname = ref('')
const index = ref(-1)
// `rowFrm` is null when the child DocType's meta has not been fetched — the
// SDK's controls dereference the frm they are handed, so an unopenable row must
// not open at all rather than open onto a crash.
const open = computed(() => Boolean(row.value) && Boolean(rowFrm.value))

const rows = computed(() =>
  fieldname.value ? (props.frm?.doc?.[fieldname.value] ?? []) : []
)
const row = computed(() => rows.value[index.value] ?? null)
const rowFrm = computed(() =>
  row.value ? rowFrmFor(props.frm, fieldname.value, row.value) : null
)
const fields = computed(() =>
  fieldname.value ? rowFields(props.frm, fieldname.value) : []
)
const label = computed(() =>
  fieldname.value ? tableLabel(props.frm, fieldname.value) : ''
)

const panel = ref(null)
let lastFocused = null

function openRow(name, i) {
  lastFocused = document.activeElement
  fieldname.value = name
  index.value = i
}

function close() {
  fieldname.value = ''
  index.value = -1
  // Back to the expander that opened it, so keyboard users are not dropped at
  // the top of the document.
  lastFocused?.focus?.()
  lastFocused = null
}

/** Step to an adjacent row without closing — the drawer is a row editor, and
 *  filling three parcels should not mean opening it three times. */
function step(delta) {
  const next = index.value + delta
  if (next >= 0 && next < rows.value.length) index.value = next
}

const onKeydown = (event) => {
  if (event.key === 'Escape') close()
}

// Focus the panel when it opens so Escape and Tab land inside it.
watch(open, async (isOpen) => {
  if (!isOpen) return
  await new Promise((resolve) => requestAnimationFrame(resolve))
  panel.value?.focus?.()
})

// A row deleted from the grid while its drawer is open leaves nothing to edit.
watch(rows, (list) => {
  if (fieldname.value && index.value >= list.length) close()
})

let teardown = null
watch(
  () => props.root,
  (el) => {
    teardown?.()
    teardown = el ? installRowDrawer(el, openRow) : null
    if (!el) close()
  },
  { immediate: true }
)
onBeforeUnmount(() => teardown?.())
</script>

<template>
  <Teleport to="body">
    <Transition name="child-drawer">
      <div v-if="open" class="child-drawer-scrim" @click="close" />
    </Transition>
    <Transition name="child-drawer-panel">
      <aside
        v-if="open"
        ref="panel"
        class="child-drawer"
        role="dialog"
        aria-modal="true"
        :aria-label="`${label} row ${index + 1}`"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="child-drawer__head">
          <div>
            <div class="child-drawer__eyebrow">{{ label }}</div>
            <div class="child-drawer__title">Row {{ index + 1 }} of {{ rows.length }}</div>
          </div>
          <button type="button" class="child-drawer__close" title="Close" @click="close">✕</button>
        </header>

        <!-- `frappe-form` so the app's control stylesheet reaches these fields:
             the drawer is teleported to the body, outside the form it edits. -->
        <div class="child-drawer__body frappe-form">
          <component
            :is="controlFor(df.fieldtype)"
            v-for="df in fields"
            :key="df.fieldname"
            :frm="rowFrm"
            :fieldname="df.fieldname"
          />
          <p v-if="!fields.length" class="child-drawer__empty">
            This table's DocType has no editable fields.
          </p>
        </div>

        <footer class="child-drawer__foot">
          <button type="button" class="child-drawer__nav" :disabled="index === 0" @click="step(-1)">
            ← Previous
          </button>
          <button
            type="button"
            class="child-drawer__nav"
            :disabled="index >= rows.length - 1"
            @click="step(1)"
          >
            Next →
          </button>
          <button type="button" class="child-drawer__done" @click="close">Done</button>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
