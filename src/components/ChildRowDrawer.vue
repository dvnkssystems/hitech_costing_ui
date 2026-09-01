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
import {
  installRowDrawer,
  rowFrmFor,
  rowFields,
  tableLabel,
  fetchRatingLabels,
  parseRatingRange,
  matchRatingScore
} from '@/lib/childRowDrawer'

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

/** Whether the open row is a Complexity Rating — the one child table whose
 *  `rating` field gets the descriptive picker below instead of the SDK's
 *  plain `1`/`2`/`3` Select. */
const isComplexityRating = computed(() => rowFrm.value?.doctype === 'Costing Worksheet Complexity Rating')
const ratingLabels = ref(null)
watch(
  () => (isComplexityRating.value ? row.value?.question : null),
  async (questionId) => {
    ratingLabels.value = questionId ? await fetchRatingLabels(props.frm, questionId) : null
  },
  { immediate: true }
)

/**
 * The `%`/`no` unit questions (In-house execution %, No of components, Scrap
 * generation %) phrase their Rating reference as numeric bands ("0-25",
 * "Less than 20%", ">75") rather than descriptions — so once the labels are
 * in hand, offer a raw-number field that resolves straight to the matching
 * score instead of making the user match their own number against three
 * ranges by eye. Falls back to pick-only when no band on this row parses (a
 * mis-typed reference, or a genuinely descriptive `%`/`no` question).
 */
const canProbeValue = computed(
  () =>
    ['%', 'no'].includes(row.value?.unit) &&
    Boolean(ratingLabels.value) &&
    [1, 2, 3].some((n) => parseRatingRange(ratingLabels.value[`rating_${n}_label`]))
)
/** Seeded from the row's own stored `actual_value` whenever the open row
 *  changes (first open, Next/Previous, or a different row entirely) — so a
 *  value entered earlier shows back up instead of looking cleared. */
const probeValue = ref('')
watch(row, (r) => {
  probeValue.value = r?.actual_value ?? ''
})

/** Some questions (Additional Shunt Welding, Welding Process) only define
 *  two bands on their `Order Complexity Question` master — `rating_3_label`
 *  is blank. Score is still hard-coded to three slots everywhere else
 *  (`Costing Worksheet Complexity Rating.rating`'s own Select options,
 *  `_calculate_complexity`'s `{1: "Low", 2: "Medium", 3: "High"}` map), so a
 *  literal `[1, 2, 3]` here would offer a "3 — " option that sets a Score
 *  with no defined meaning. Only offer the bands this question actually has. */
const availableScores = computed(() => [1, 2, 3].filter((n) => ratingLabels.value?.[`rating_${n}_label`]))
function onProbeInput() {
  const num = probeValue.value === '' ? null : Number(probeValue.value)
  rowFrm.value.set_value('actual_value', Number.isFinite(num) ? num : null)
  const matched = matchRatingScore(probeValue.value, ratingLabels.value)
  if (matched) rowFrm.value.set_value('rating', matched)
}

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

// A frm swap (e.g. the wizard switching which item tab is active) while the
// drawer is open must never leave it silently showing a row from the OLD
// frm's table — if the new frm's same-named table happens to have enough
// rows to stay in-bounds, the watch above alone would miss it.
watch(() => props.frm, () => close())

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
          <template v-for="df in fields" :key="df.fieldname">
            <div v-if="isComplexityRating && df.fieldname === 'rating' && ratingLabels" class="control child-drawer__rating-field">
              <span>{{ df.label }}</span>
              <div v-if="canProbeValue" class="child-drawer__rating-probe">
                <input
                  type="number"
                  v-model="probeValue"
                  @input="onProbeInput"
                  :placeholder="row.unit === '%' ? 'Enter the actual %' : 'Enter the actual count'"
                />
                <span class="child-drawer__rating-probe-hint">Picks the matching band below</span>
              </div>
              <div class="child-drawer__rating-options">
                <button
                  v-for="n in availableScores"
                  :key="n"
                  type="button"
                  class="child-drawer__rating-option"
                  :class="{ 'is-selected': String(row.rating) === String(n) }"
                  @click="rowFrm.set_value('rating', String(n))"
                >
                  <span class="child-drawer__rating-option-n">{{ n }}</span>
                  <span class="child-drawer__rating-option-text">{{ ratingLabels[`rating_${n}_label`] }}</span>
                </button>
              </div>
            </div>
            <component v-else :is="controlFor(df.fieldtype)" :frm="rowFrm" :fieldname="df.fieldname" />
          </template>
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
