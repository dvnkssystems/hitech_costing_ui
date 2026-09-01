<script setup>
/**
 * Any Frappe form, laid out as numbered section cards.
 *
 * Used by every `/form/:doctype/:name`, so a Costing Worksheet, a Tank Type
 * and a User all read the same way.
 *
 * The cards are the DocType's own tabs and sections, read through the SDK's
 * meta — see `lib/formSections.js`. Fields are rendered by the SDK's own
 * controls via `controlFor`, exactly as `FormLayout` does, so Link
 * autocomplete, `depends_on`, validation, mandatory marking and every Client
 * Script keep working. Only the arrangement changes.
 *
 * This renders the fields but *not* the toolbar: Save, Submit, Cancel, Amend
 * and Duplicate live in the SDK's `FormToolbar`, and the caller decides whether
 * to show it.
 */
import { computed, ref, watch } from 'vue'
import { FormLayout, controlFor, fieldState } from '@frappe-vue-sdk/vue'
import { buildSections, isWide } from '@/lib/formSections'
import { isLocked, docstatusLabel } from '@/lib/frmCompat'
import LucideIcon from '@/components/LucideIcon.vue'

const props = defineProps({
  frm: { type: Object, required: true },
  // Which form template the backend mapped this DocType to. `cards` is the
  // only one today — the plain treatment that works for any DocType.
  layoutName: { type: String, default: 'cards' }
})

const layout = computed(() => buildSections(props.frm))

/**
 * A submitted or cancelled document is read-only — see `lockOnSubmit` in
 * lib/frmCompat.js for the rule and why the SDK does not apply it itself.
 * Saying so beats leaving the user to work out why every field went grey.
 */
const locked = computed(() => isLocked(props.frm))
const statusWord = computed(() => docstatusLabel(props.frm))
const tabs = computed(() => layout.value.tabs)

/**
 * Fall back to the SDK's own layout when the meta yields nothing — a DocType
 * with no fields, or meta that has not arrived. A working form matters more
 * than a layout.
 */
const useCards = computed(() => tabs.value.length > 0)

const activeTab = ref(0)
// A different document can have fewer tabs than the one before it.
watch(tabs, (list) => {
  if (activeTab.value >= list.length) activeTab.value = 0
})
const sections = computed(() => tabs.value[activeTab.value]?.sections ?? [])

/** `depends_on` and Client Scripts hide fields at runtime; respect that. */
function isVisible(fieldname) {
  const f = props.frm
  if (!f) return false
  try {
    return fieldState(f, f.fields_dict[fieldname].df).visible
  } catch {
    // A field with no entry in fields_dict is not one the form can render.
    return false
  }
}

/**
 * Hand each control's root element back to the form as that field's wrapper.
 *
 * `FormLayout` does this too, and Client Scripts depend on it — `frm.toggle_
 * display` and friends reach for the wrapper element. The callbacks are cached
 * per fieldname because Vue invokes a ref function on every re-render, and a
 * fresh closure each time would null the wrapper out and re-set it constantly.
 */
const wrapperRefs = new Map()
function setWrapper(fieldname) {
  let cb = wrapperRefs.get(fieldname)
  if (!cb) {
    cb = (component) => {
      const el = component?.$el
      props.frm?.set_field_wrapper?.(fieldname, el instanceof HTMLElement ? el : null)
    }
    wrapperRefs.set(fieldname, cb)
  }
  return cb
}
</script>

<template>
  <template v-if="useCards">
    <div
      v-if="locked"
      :style="{
        display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px',
        padding: '14px 18px', borderRadius: '13px',
        background: statusWord === 'Cancelled' ? '#FEF2F2' : '#F8FAFC',
        border: `1px solid ${statusWord === 'Cancelled' ? '#FECACA' : '#E2E8F0'}`
      }"
    >
      <span
        :style="{ fontSize: '17px', flex: 'none', color: statusWord === 'Cancelled' ? '#DC2626' : '#64748B' }"
      >
        <LucideIcon name="lock" />
      </span>
      <div style="font-size:13.5px; line-height:1.55; color:#475569;">
        <strong>{{ statusWord }}.</strong>
        <template v-if="statusWord === 'Cancelled'"> This document can no longer be edited. Amend it to make changes.</template>
        <template v-else>
          Fields are locked. Only those the DocType marks <em>Allow on Submit</em> can still be changed; the server
          rejects anything else.
        </template>
      </div>
    </div>

    <!-- Tab bar, only when the DocType actually declares tabs. Uses the SDK's
         own class names so the app's form theme applies unchanged. -->
    <nav v-if="tabs.length > 1" class="form-tabs" style="display:flex; margin-bottom:18px; flex-wrap:wrap;">
      <button
        v-for="(tab, i) in tabs"
        :key="i"
        type="button"
        class="form-tab"
        :class="{ active: activeTab === i }"
        @click="activeTab = i"
      >
        {{ tab.label || 'Details' }}
      </button>
    </nav>

    <section
      v-for="section in sections"
      :key="`${activeTab}-${section.n}`"
      style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:24px; margin-bottom:18px; box-shadow:0 1px 2px rgba(15,23,42,.04);"
    >
      <div style="display:flex; align-items:center; gap:11px; margin-bottom:18px;">
        <span
          style="width:28px; height:28px; border-radius:8px; background:#F0FDF4; color:#16A34A; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:800; flex:none;"
          >{{ section.n }}</span
        >
        <h2 style="margin:0; font-size:16px; font-weight:700;">{{ section.title }}</h2>
      </div>

      <div class="job-grid">
        <template v-for="df in section.fields" :key="df.fieldname">
          <template v-if="isVisible(df.fieldname)">
            <div :class="{ 'job-grid-wide': isWide(df) }">
              <component
                :is="controlFor(df.fieldtype)"
                :ref="setWrapper(df.fieldname)"
                :frm="frm"
                :fieldname="df.fieldname"
              />
            </div>
          </template>
        </template>
      </div>
    </section>
  </template>

  <!-- No sections came back from the meta — see useCards. -->
  <div
    v-else
    style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:8px 20px 20px; box-shadow:0 1px 2px rgba(15,23,42,.04);"
  >
    <FormLayout :frm="frm" />
  </div>
</template>

<style scoped>
/* The design's field grid: columns that collapse as the pane narrows. The SDK
   control supplies its own label and input, so a cell only reserves space. */
.job-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 16px;
  align-items: start;
}

/* Grids run the full width rather than sitting in one column. */
.job-grid-wide {
  grid-column: 1 / -1;
}
</style>
