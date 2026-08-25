<script setup>
/**
 * Phone-setup-style wizard for authoring a Costing Worksheet.
 *
 * Fills the same `frm` the generic form (`DocFormView.vue`) would build via
 * `useFrmRemote` — same scripts, same post-resolve wiring — just paced across
 * focused steps instead of one long page. See `src/lib/costingWorksheetWizard.js`
 * for the step field lists and `docs/quotation-wizard-flow.md` (hitech_costing
 * app) for why the flow is shaped this way.
 *
 * Save strategy: no step before Commercials ever calls `frm.save()`. Frappe
 * validates every mandatory field on every save, not just the current step's,
 * and `deal_price_fg_inr_per_kg` (Commercials, no default) would fail every
 * earlier attempt. The Commercials → Review transition is the first, and only,
 * point that fires a real save — by then every mandatory field is filled.
 * Everything the user sees update live before that (surface areas, weights,
 * paint cost, totals) comes from the native client script's own `calculate()`
 * triggers, which run against the still-unsaved doc — no extra code here.
 */
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { FormToolbar, fieldState, useFrmRemote } from '@frappe-vue-sdk/vue'
import ChildRowDrawer from '@/components/ChildRowDrawer.vue'
import WizardStep from '@/components/wizard/WizardStep.vue'
import WizardProgress from '@/components/wizard/WizardProgress.vue'
import LucideIcon from '@/components/LucideIcon.vue'
import { WIZARD_STEPS, REVIEW_STEP_INDEX, GATED_STEP_INDEXES, stepIsComplete } from '@/lib/costingWorksheetWizard'
import { call, metaFetcher, hasBackend } from '@/lib/frappe'
import { installFormEnhancements } from '@/lib/formEnhance'
import { installRouting, renderTextEditorsAsHtml, listRouteFor } from '@/lib/frappeRouting'
import { nativeClientScripts } from '@/lib/clientScripts'
import {
  coerceTableFields,
  hideEmptyReadOnlyFields,
  lockOnSubmit,
  hideNamingSeries,
  restoreOnloadCustomButtons,
  installWorkflowActions
} from '@/lib/frmCompat'
import { installDeskApis, installAmend, takePendingDoc } from '@/lib/mappedDoc'
import { money, decimal, formatDate } from '@/utils/format'

const DOCTYPE = 'Costing Worksheet'

const props = defineProps({
  name: { type: String, default: '' }
})

const router = useRouter()

const frm = shallowRef(null)
const loading = ref(true)
const error = ref('')
const live = computed(() => hasBackend)

const activeStepIndex = ref(0)
const unlockedSteps = ref(new Set([0]))
const stepError = ref('')
const saving = ref(false)

const commercialsStepIndex = REVIEW_STEP_INDEX - 1
const activeStep = computed(() => WIZARD_STEPS[activeStepIndex.value])
const isReviewStep = computed(() => activeStepIndex.value === REVIEW_STEP_INDEX)

const heading = computed(() => {
  const docname = frm.value?.doc?.name
  if (!docname || String(docname).startsWith('New ')) return 'New Costing Worksheet'
  return docname
})

const saveState = computed(() => {
  if (!frm.value) return ''
  if (frm.value.is_new?.()) return `Not saved yet — saves at "${WIZARD_STEPS[commercialsStepIndex].title}"`
  return `Saved as ${frm.value.doc.name}`
})

/** Whether any field in `step` is read-only — i.e. worth its own calculated-values rail. */
function hasDerivedFields(step) {
  if (!frm.value) return false
  return step.fields.some((fieldname) => frm.value.fields_dict?.[fieldname]?.df?.read_only)
}

function reviewDisplayValue(df, raw) {
  if (raw === undefined || raw === null || raw === '') return '—'
  switch (df.fieldtype) {
    case 'Currency':
      return money(raw)
    case 'Float':
    case 'Percent':
      return decimal(raw)
    case 'Int':
      return Number(raw).toLocaleString()
    case 'Check':
      return raw ? 'Yes' : 'No'
    case 'Date':
      return formatDate(raw)
    default:
      return String(raw)
  }
}

/**
 * Every step before Review, as a read-only recap card — real field labels
 * and current `frm.doc` values, not a hand-picked summary. A Table field
 * collapses to a row count (`volumes` would otherwise need its own grid
 * squeezed into a label/value card).
 */
const reviewSections = computed(() => {
  if (!frm.value) return []
  return WIZARD_STEPS.slice(0, REVIEW_STEP_INDEX).map((step, index) => {
    const rows = step.fields
      .map((fieldname) => {
        const df = frm.value.fields_dict?.[fieldname]?.df
        if (!df) return null
        try {
          if (!fieldState(frm.value, df).visible) return null
        } catch {
          return null
        }
        if (df.fieldtype === 'Table') {
          const tableRows = frm.value.doc?.[fieldname]
          return { label: df.label || fieldname, value: `${Array.isArray(tableRows) ? tableRows.length : 0} row(s)` }
        }
        return { label: df.label || fieldname, value: reviewDisplayValue(df, frm.value.doc?.[fieldname]) }
      })
      .filter(Boolean)
    return { index, n: String(index + 1).padStart(2, '0'), title: step.title, rows }
  })
})

const wizardEl = ref(null)
let teardownEnhancements = null
watch(wizardEl, (el) => {
  teardownEnhancements?.()
  teardownEnhancements = el ? installFormEnhancements(el, () => frm.value) : null
})
onBeforeUnmount(() => teardownEnhancements?.())

async function load() {
  loading.value = true
  error.value = ''
  frm.value = null

  if (!live.value) {
    error.value = 'No Frappe backend configured. Set VITE_FRAPPE_URL in .env to use the wizard.'
    loading.value = false
    return
  }

  try {
    // Set by `/quotation/new` when the user picked a Tank Type there — see
    // mappedDoc.js's `seedPendingDoc` / `takePendingDoc`.
    const initialDoc = props.name ? null : takePendingDoc(DOCTYPE)
    const result = await useFrmRemote({
      transport: call,
      metaFetcher,
      doctype: DOCTYPE,
      name: props.name || null,
      initialDoc,
      autoBoot: true,
      scripts: [
        nativeClientScripts(DOCTYPE),
        renderTextEditorsAsHtml(DOCTYPE),
        hideEmptyReadOnlyFields(DOCTYPE),
        lockOnSubmit(DOCTYPE),
        hideNamingSeries(DOCTYPE),
        installWorkflowActions(DOCTYPE, { stateField: 'status' })
      ]
    })
    installRouting(router, result.frappe)
    installDeskApis(result.frappe, router)
    await restoreOnloadCustomButtons(result.frm)
    installAmend(result.frm, router)
    frm.value = coerceTableFields(result.frm)

    // Already decided on the picker — Product Line shouldn't ask again.
    if (initialDoc?.tank_type) {
      frm.value.set_df_property('tank_type', 'read_only', 1)
    }

    if (props.name) {
      // An existing doc already passed the Commercials gate at least once.
      activeStepIndex.value = REVIEW_STEP_INDEX
      unlockedSteps.value = new Set(WIZARD_STEPS.map((_, i) => i))
    } else {
      activeStepIndex.value = 0
      unlockedSteps.value = new Set([0])
    }
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

function goToStep(i) {
  if (i === activeStepIndex.value) return
  if (i > activeStepIndex.value && !unlockedSteps.value.has(i)) return
  stepError.value = ''
  activeStepIndex.value = i
}

function back() {
  if (activeStepIndex.value === 0) return
  stepError.value = ''
  activeStepIndex.value -= 1
}

/** The native client script's own buttons — reused rather than reimplemented. */
function loadComplexityQuestions() {
  const btn = frm.value?.custom_buttons?.find((b) => b.label === 'Load Complexity Questions')
  if (btn) btn.action()
}

/** Manual escape hatch alongside the automatic per-field recalculation — same
 *  `docstatus === 0` gate as the native script's own "Recalculate" button. */
function recalculate() {
  const btn = frm.value?.custom_buttons?.find((b) => b.label === 'Recalculate')
  if (btn) btn.action()
}

async function next() {
  if (!frm.value) return
  stepError.value = ''

  if (GATED_STEP_INDEXES.has(activeStepIndex.value) && !stepIsComplete(frm.value, activeStep.value, fieldState)) {
    stepError.value = 'Fill in the required fields before continuing.'
    return
  }

  // The only real save in the whole wizard: every mandatory field is
  // guaranteed filled by the end of Commercials, and not before.
  if (activeStepIndex.value === commercialsStepIndex) {
    saving.value = true
    error.value = ''
    const wasNew = frm.value.is_new()
    try {
      await frm.value.save()
    } catch (e) {
      error.value = e?.message ?? String(e)
      saving.value = false
      return
    }
    saving.value = false
    if (wasNew) {
      router.replace(`/wizard/costing-worksheet/${encodeURIComponent(frm.value.doc.name)}`)
    }
  }

  const nextIndex = activeStepIndex.value + 1
  unlockedSteps.value = new Set(unlockedSteps.value).add(nextIndex)
  activeStepIndex.value = nextIndex
}

onMounted(load)
watch(() => props.name, load)
</script>

<template>
  <div class="qw-wizard">
    <div class="qw-crumbtrail">
      <RouterLink to="/" class="qw-crumbtrail__link">Home</RouterLink>
      <LucideIcon name="chevron-right" />
      <RouterLink :to="listRouteFor('Costing Worksheet')" class="qw-crumbtrail__link">Costing Worksheet</RouterLink>
      <LucideIcon name="chevron-right" />
      <span class="qw-crumbtrail__current">{{ heading }}</span>
    </div>

    <h1 class="qw-heading">{{ heading }}</h1>

    <div v-if="!live && !loading" class="qw-notice">
      Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to use the wizard.
    </div>

    <div v-if="error" class="qw-error-banner">
      <span class="qw-error-banner__icon"><LucideIcon name="x" /></span>
      <div style="min-width:0;">
        <div class="qw-error-banner__title">Could not save</div>
        <div class="qw-error-banner__body">{{ error }}</div>
      </div>
    </div>

    <div v-if="loading" class="qw-loading">Loading…</div>

    <template v-if="frm">
      <div class="qw-topline">
        <WizardProgress
          :steps="WIZARD_STEPS"
          :active-index="activeStepIndex"
          :unlocked-steps="unlockedSteps"
          @select="goToStep"
        />
        <span class="qw-save-pill">{{ saveState }}</span>
      </div>

      <div ref="wizardEl" class="frappe-form">
        <template v-for="(step, i) in WIZARD_STEPS" :key="step.key">
          <section v-show="i === activeStepIndex" :inert="i !== activeStepIndex">
            <div class="qw-step-layout">
              <div class="qw-step-main">
                <template v-if="i === REVIEW_STEP_INDEX">
                  <div v-for="sec in reviewSections" :key="sec.index" class="qw-review-card">
                    <div class="qw-review-card__head">
                      <span class="qw-review-card__n">{{ sec.n }}</span>
                      <span class="qw-review-card__title">{{ sec.title }}</span>
                      <button type="button" class="qw-review-card__edit" @click="goToStep(sec.index)">
                        Edit section
                      </button>
                    </div>
                    <div class="qw-review-card__rows">
                      <div v-for="row in sec.rows" :key="row.label" class="qw-review-card__row">
                        <span class="qw-review-card__k">{{ row.label }}</span>
                        <span class="qw-review-card__v">{{ row.value }}</span>
                      </div>
                    </div>
                  </div>
                </template>

                <div class="qw-step-card">
                  <h2 class="qw-step-title">
                    <span class="qw-step-title__n">{{ String(i + 1).padStart(2, '0') }}</span>
                    {{ step.title }}
                  </h2>

                  <WizardStep :frm="frm" :fields="step.fields" read-only-filter="exclude" />

                  <div v-if="step.key === 'complexity'" class="qw-step-actions">
                    <button type="button" @click="loadComplexityQuestions" class="qw-ghost-btn">
                      Load default questions
                    </button>
                    <button type="button" @click="recalculate" class="qw-ghost-btn">Recalculate</button>
                  </div>

                  <FormToolbar v-if="i === REVIEW_STEP_INDEX" :frm="frm" @error="error = $event" />
                </div>
              </div>

              <aside v-if="hasDerivedFields(step)" class="qw-derived">
                <div class="qw-derived__eyebrow">Calculated</div>
                <div class="qw-derived__hint">Recalculates live as you edit this step's fields.</div>
                <WizardStep :frm="frm" :fields="step.fields" read-only-filter="only" />
              </aside>
            </div>
          </section>
        </template>

        <div v-if="stepError" class="qw-step-error">{{ stepError }}</div>

        <div v-if="!isReviewStep" class="qw-footer">
          <button type="button" :disabled="activeStepIndex === 0" @click="back" class="qw-back-btn">
            ← Back
          </button>
          <button type="button" :disabled="saving" @click="next" class="qw-next-btn">
            {{ saving ? 'Saving…' : (activeStepIndex === commercialsStepIndex ? 'Save & Review' : 'Next') }}
          </button>
        </div>
      </div>

      <ChildRowDrawer :frm="frm" :root="wizardEl" />
    </template>
  </div>
</template>

<style scoped>
/* Quotation-Wizard visual design (Nunito / IBM Plex Mono, orange-on-cream
   palette), scoped to this page only — the rest of the app keeps its
   Inter / indigo-orange theme untouched. See index.html for the font links
   and frappe-form.css for the SDK-control tokens re-tinted below. */
.qw-wizard {
  --qw-primary: #fe4d00;
  --qw-primary-dark: #b03400;
  --qw-primary-hover: #fe5900;
  --qw-primary-tint: #ffece5;
  --qw-border: #e4dcd6;
  --qw-row-border: #f2ede9;
  --qw-text: #1c1714;
  --qw-body: #3a322d;
  --qw-muted: #6e635b;
  --qw-faint: #a79c94;
  font-family: 'Nunito', system-ui, sans-serif;
  color: var(--qw-body);
  padding: 30px 36px 80px;
  margin: 0 auto;
  max-width: 1400px;
}

.qw-crumbtrail {
  display: flex;
  align-items: center;
  gap: 6px;
  font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--qw-faint);
  margin-bottom: 10px;
}

.qw-crumbtrail__link {
  color: var(--qw-muted);
}

.qw-crumbtrail__link:hover {
  color: var(--qw-primary-dark);
}

.qw-crumbtrail__current {
  color: var(--qw-primary-dark);
}

.qw-heading {
  margin: 0 0 22px;
  font: 900 32px/1.15 'Nunito', system-ui, sans-serif;
  letter-spacing: -0.02em;
  color: var(--qw-text);
}

.qw-notice {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #fff7f2;
  border: 1px solid var(--qw-border);
  border-radius: 12px;
  padding: 15px 18px;
  margin-bottom: 18px;
  font-size: 13px;
  color: var(--qw-primary-dark);
}

.qw-error-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 12px;
  padding: 15px 18px;
  margin-bottom: 18px;
}

.qw-error-banner__icon {
  color: #e63946;
  font-size: 17px;
  flex: none;
}

.qw-error-banner__title {
  font-size: 14.5px;
  font-weight: 700;
  color: #991b1b;
}

.qw-error-banner__body {
  font-size: 13px;
  color: #b91c1c;
  margin-top: 3px;
  word-break: break-word;
}

.qw-loading {
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 16px;
  padding: 48px;
  text-align: center;
  color: var(--qw-faint);
  font-size: 14px;
  font-weight: 600;
}

.qw-topline {
  display: flex;
  align-items: center;
  gap: 14px;
}

.qw-topline :deep(.wizard-crumbs) {
  flex: 1;
  margin-bottom: 0;
}

.qw-save-pill {
  flex: none;
  font: 700 11px/1 'Nunito', system-ui, sans-serif;
  color: var(--qw-muted);
  background: var(--qw-row-border);
  border-radius: 999px;
  padding: 8px 12px;
  white-space: nowrap;
}

.qw-step-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  margin-top: 22px;
}

@media (min-width: 1080px) {
  .qw-step-layout {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
}

.qw-step-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.qw-step-card {
  min-width: 0;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
}

.qw-review-card {
  min-width: 0;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 16px;
  padding: 18px 20px;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
}

.qw-review-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--qw-border);
  padding-bottom: 10px;
}

.qw-review-card__n {
  font: 500 14px/1 'IBM Plex Mono', monospace;
  color: var(--qw-primary);
  font-variant-numeric: tabular-nums;
  margin-right: 12px;
}

.qw-review-card__title {
  font: 800 20px/1.2 'Nunito', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-review-card__edit {
  margin-left: auto;
  background: transparent;
  border: none;
  padding: 6px 10px;
  border-radius: 8px;
  font: 700 13px/1 'Nunito', system-ui, sans-serif;
  color: var(--qw-primary-dark);
  cursor: pointer;
}

.qw-review-card__edit:hover {
  background: var(--qw-primary-tint);
}

.qw-review-card__rows {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px 22px;
  margin-top: 14px;
}

.qw-review-card__row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.qw-review-card__k {
  font: 600 12px/16px 'Nunito', system-ui, sans-serif;
  color: var(--qw-faint);
}

.qw-review-card__v {
  font: 400 15px/20px 'Nunito', system-ui, sans-serif;
  color: var(--qw-text);
  overflow-wrap: anywhere;
}

.qw-step-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 18px;
  font: 800 20px/1.2 'Nunito', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-step-title__n {
  font: 500 14px/1 'IBM Plex Mono', monospace;
  color: var(--qw-primary);
  font-variant-numeric: tabular-nums;
}

.qw-derived {
  min-width: 0;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
}

.qw-derived__eyebrow {
  font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: 0.1em;
  color: var(--qw-primary-dark);
}

.qw-derived__hint {
  font: 400 12px/17px 'Nunito', system-ui, sans-serif;
  color: var(--qw-faint);
  margin: 5px 0 14px;
}

.qw-step-actions {
  margin-top: 16px;
  display: flex;
  gap: 10px;
}

.qw-ghost-btn {
  background: transparent;
  color: var(--qw-muted);
  border: 1px solid var(--qw-border);
  padding: 9px 15px;
  border-radius: 10px;
  font: 600 13.5px/1 'Nunito', system-ui, sans-serif;
  cursor: pointer;
}

.qw-ghost-btn:hover {
  background: var(--qw-row-border);
}

.qw-step-error {
  color: #e63946;
  font-size: 13px;
  font-weight: 600;
  margin: 18px 0 0;
}

.qw-footer {
  position: sticky;
  bottom: 0;
  margin-top: 18px;
  background: #fff;
  border-top: 1px solid var(--qw-border);
  padding: 14px 4px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  box-shadow: 0 -2px 8px rgba(38, 38, 38, 0.05);
}

.qw-back-btn {
  background: #fff;
  color: var(--qw-primary-dark);
  border: 2px solid var(--qw-primary);
  padding: 11px 20px;
  border-radius: 10px;
  font: 700 14px/1 'Nunito', system-ui, sans-serif;
  cursor: pointer;
}

.qw-back-btn:hover:not(:disabled) {
  background: var(--qw-primary-tint);
}

.qw-back-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.qw-next-btn {
  background: var(--qw-primary);
  color: #fff;
  border: none;
  padding: 11px 22px;
  border-radius: 10px;
  font: 700 14px/1 'Nunito', system-ui, sans-serif;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(254, 77, 0, 0.3);
}

.qw-next-btn:hover:not(:disabled) {
  background: var(--qw-primary-hover);
}

.qw-next-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Re-tint the SDK-rendered form controls (WizardStep -> controlFor(...)) to
   this page's palette, scoped to .qw-wizard only. `:deep()` is required here
   because these inputs are rendered deep inside child/SDK components, not in
   this component's own template. */
.qw-wizard :deep(.frappe-form) {
  --fv-primary: #fe4d00;
  --fv-border: #e4dcd6;
  --fv-radius: 8px;
  --app-input-h: 44px;
  --app-label: #3a322d;
  --app-muted: #6e635b;
  --app-faint: #a79c94;
  --app-card-border: #e4dcd6;
  --app-row-border: #f2ede9;
  --app-head-bg: #f2ede9;
}

.qw-wizard :deep(.control input:disabled),
.qw-wizard :deep(.control select:disabled),
.qw-wizard :deep(.control textarea:disabled) {
  background: var(--qw-row-border);
  color: var(--qw-faint);
}
</style>
