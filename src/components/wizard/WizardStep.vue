<script setup>
/**
 * One wizard step's fields, rendered with the SDK's own controls.
 *
 * A trimmed `FormSections.vue`: no section cards or tabs, just the bare list
 * of fieldnames the caller hands it, in order. Reuses `controlFor` and
 * `fieldState` exactly as the generic form does, so Link autocomplete,
 * `depends_on`, mandatory marking and Client Scripts all keep working —
 * including for `volumes` / `complexity_ratings`, which render as the real
 * grid because `controlFor('Table')` doesn't know it's inside a wizard.
 *
 * `readOnlyFilter` lets the same component serve both halves of the
 * Quotation-Wizard-style layout: the caller renders the step's editable
 * fields in the main card (`"exclude"`) and its read-only/calculated ones
 * in the side rail (`"only"`), off the DocType's own `read_only` flag rather
 * than a hand-picked field list.
 */
import { controlFor, fieldState } from '@frappe-vue-sdk/vue'
import { isWide } from '@/lib/formSections'

const props = defineProps({
  frm: { type: Object, required: true },
  fields: { type: Array, required: true },
  readOnlyFilter: { type: String, default: 'all' } // 'all' | 'exclude' | 'only'
})

function fieldDf(fieldname) {
  return props.frm.fields_dict?.[fieldname]?.df ?? null
}

function matchesReadOnlyFilter(df) {
  if (props.readOnlyFilter === 'exclude') return !df.read_only
  if (props.readOnlyFilter === 'only') return Boolean(df.read_only)
  return true
}

function isVisible(fieldname) {
  const df = fieldDf(fieldname)
  if (!df || !matchesReadOnlyFilter(df)) return false
  try {
    return fieldState(props.frm, df).visible
  } catch {
    return false
  }
}

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
  <div class="job-grid">
    <template v-for="fieldname in fields" :key="fieldname">
      <template v-if="isVisible(fieldname)">
        <div :class="{ 'job-grid-wide': isWide(fieldDf(fieldname)) }">
          <component
            :is="controlFor(fieldDf(fieldname).fieldtype)"
            :ref="setWrapper(fieldname)"
            :frm="frm"
            :fieldname="fieldname"
          />
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.job-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 16px;
  align-items: start;
}

.job-grid-wide {
  grid-column: 1 / -1;
}
</style>
