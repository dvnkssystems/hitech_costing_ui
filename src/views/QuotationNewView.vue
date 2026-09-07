<script setup>
/**
 * "What type of quotation?" — front door in front of the Costing Worksheet
 * wizard, styled after the Quotation Wizard design.
 *
 * The cards are `Quotation`'s real `custom_type` Select options (Tank /
 * Radiator — see hitech_costing's `costing_worksheet.py`
 * `QUOTATION_HEADER_FIELDS`). Both are clickable and run the exact same
 * eight-step costing wizard — a real Tank Type record named "Radiator Line"
 * already exists, so Radiator isn't a different set of fields, just a
 * different label on the resulting Quotation. `custom_type` carries that
 * label through; nothing about the wizard itself branches on it.
 *
 * This screen used to ask about `order_type` (Sales / Maintenance / Shopping
 * Cart) instead — that field is real too, but `Costing Worksheet.
 * create_quotation()` (the only thing in this app that ever creates a
 * `Quotation`) hardcodes `order_type = "Sales"` regardless, so asking about
 * it here was a dead choice. `custom_type` (Tank/Radiator) is the question
 * that actually matters to this app, so it replaces `order_type` here.
 *
 * Picking a Tank Type here pre-seeds it onto the wizard through
 * `seedPendingDoc`, the same "park a new document for the target route"
 * channel `frappe.new_doc` and mapped-doc creation already use —
 * `CostingWorksheetWizard.vue` picks it up via
 * `takePendingDoc('Costing Worksheet')` as `useFrmRemote`'s `initialDoc`.
 * The chosen `custom_type` rides the same channel, keyed by `'Quotation'`
 * instead, and lands on `quotationHeaderFrm`'s initial doc there.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '@/lib/frappeDb'
import { hasBackend } from '@/lib/frappe'
import { seedPendingDoc } from '@/lib/mappedDoc'
import { listRouteFor } from '@/lib/frappeRouting'
import { timeAgo } from '@/utils/format'
import LucideIcon from '@/components/LucideIcon.vue'

/**
 * In-progress wizard draft detection (read-only from here).
 *
 * `CostingWorksheetWizard.vue` autosaves a brand-new "New Quotation" session
 * to `localStorage` under `DRAFT_STORAGE_KEY` (same value below) and offers
 * to restore it itself when `/wizard/costing-worksheet` boots fresh — see
 * that file's own doc comment above its `DRAFT_STORAGE_KEY`. This front door
 * used to have no idea that draft existed: a user who navigated away mid-wizard
 * and came back through here (rather than a direct URL/back-button) saw only
 * the blank Tank/Radiator picker, and `startWizard()` would seed a brand-new
 * session on top of it. This banner surfaces that draft here too, so "Resume"
 * is possible from the front door as well as from a direct wizard re-visit.
 */
const DRAFT_STORAGE_KEY = 'hitech-costing:quotation-draft'
/** One-shot signal for `CostingWorksheetWizard.vue`'s `load()`: when set, it
 *  restores its own draft without asking again (the user already chose
 *  "Resume" here) -- read once and cleared there. */
const DRAFT_RESUME_FLAG = 'hitech-costing:quotation-draft-resume'

function readInProgressDraft() {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Minimal shape check against `buildDraftSnapshot()`'s real shape in
    // CostingWorksheetWizard.vue -- anything that doesn't look like it came
    // from there (stale pre-field format, corrupted write, etc.) is treated
    // as "no draft" rather than risking a broken banner.
    if (!parsed || typeof parsed !== 'object' || typeof parsed.savedAt !== 'string') {
      throw new Error('unrecognized draft shape')
    }
    return parsed
  } catch {
    try {
      globalThis.localStorage?.removeItem(DRAFT_STORAGE_KEY)
    } catch {
      // Private mode or storage disabled -- nothing to clean up either way.
    }
    return null
  }
}

/** Own key, separate from CostingWorksheetWizard.vue's `DRAFT_STORAGE_KEY`
 *  (`hitech-costing:quotation-draft`) -- this is just the Tank/Radiator pick
 *  on this front-door screen, not the wizard's own field draft. */
const TYPE_STORAGE_KEY = 'hitech-costing:quotation-new-type'

function readSavedType() {
  try {
    return globalThis.localStorage?.getItem(TYPE_STORAGE_KEY) || null
  } catch {
    return null
  }
}
function writeSavedType(value) {
  try {
    if (value) globalThis.localStorage?.setItem(TYPE_STORAGE_KEY, value)
    else globalThis.localStorage?.removeItem(TYPE_STORAGE_KEY)
  } catch {
    // Private mode or storage disabled -- the picker still works for this
    // session, it just won't survive a navigate-away-and-back.
  }
}
function clearSavedType() {
  try {
    globalThis.localStorage?.removeItem(TYPE_STORAGE_KEY)
  } catch {
    // ditto
  }
}

const router = useRouter()
const live = computed(() => hasBackend)

/** Quotation's real `custom_type` Select options — both run the same wizard. */
const PRODUCT_TYPES = [
  {
    key: 'Tank',
    desc: 'Costed product quote. Runs the eight-step wizard and lands on a costing worksheet.',
    enabled: true
  },
  {
    key: 'Radiator',
    desc: 'Costed product quote, same wizard — pick a radiator Tank Type (e.g. "Radiator Line") below.',
    enabled: true
  }
]

const type = ref(readSavedType()) // null | 'Tank' | 'Radiator'
const tankTypes = ref([])
const loading = ref(false)
const error = ref('')

const inProgressDraft = ref(readInProgressDraft())
const draftCustomerLabel = computed(() => inProgressDraft.value?.order?.customer || null)
const draftSavedAgo = computed(() => (inProgressDraft.value ? timeAgo(inProgressDraft.value.savedAt) || 'a moment ago' : ''))

function resumeDraft() {
  try {
    globalThis.sessionStorage?.setItem(DRAFT_RESUME_FLAG, '1')
  } catch {
    // Private mode or storage disabled -- the wizard just falls back to its
    // own "restore it?" prompt instead of skipping it, still not broken.
  }
  router.push('/wizard/costing-worksheet')
}

function discardDraft() {
  try {
    globalThis.localStorage?.removeItem(DRAFT_STORAGE_KEY)
  } catch {
    // ditto
  }
  inProgressDraft.value = null
}

watch(type, (value) => writeSavedType(value))

async function loadTankTypes() {
  if (!live.value) return
  loading.value = true
  error.value = ''
  try {
    tankTypes.value = await db.get_list('Tank Type', {
      fields: ['name'],
      limit_page_length: 0,
      order_by: 'name asc'
    })
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

function pickType(productType) {
  if (!productType.enabled) return
  type.value = productType.key
  if (!tankTypes.value.length && !loading.value) loadTankTypes()
}

function startWizard(tankTypeName) {
  if (tankTypeName) {
    seedPendingDoc('Costing Worksheet', { doctype: 'Costing Worksheet', tank_type: tankTypeName })
  }
  seedPendingDoc('Quotation', { doctype: 'Quotation', custom_type: type.value })
  clearSavedType()
  router.push('/wizard/costing-worksheet')
}

onMounted(() => {
  if (type.value) loadTankTypes()
})
</script>

<template>
  <div class="qw-wizard qw-new">
    <div class="qw-crumbtrail">
      <RouterLink to="/" class="qw-crumbtrail__link">Dashboard</RouterLink>
      <LucideIcon name="chevron-right" />
      <RouterLink :to="listRouteFor('Quotation')" class="qw-crumbtrail__link">Quotation</RouterLink>
      <LucideIcon name="chevron-right" />
      <span class="qw-crumbtrail__current">New quote</span>
    </div>

    <div v-if="inProgressDraft" class="qw-draft-banner">
      <div class="qw-draft-banner__icon"><LucideIcon name="clock" /></div>
      <div class="qw-draft-banner__body">
        <div class="qw-draft-banner__title">
          You have an in-progress quotation from {{ draftSavedAgo }}<template v-if="draftCustomerLabel"> for {{ draftCustomerLabel }}</template>.
        </div>
        <div class="qw-draft-banner__desc">
          It was never saved — pick up where you left off, or discard it and start a fresh quote below.
        </div>
      </div>
      <div class="qw-draft-banner__actions">
        <button type="button" class="qw-btn-primary" @click="resumeDraft">Resume</button>
        <button type="button" class="qw-ghost-btn" @click="discardDraft">Discard &amp; start new</button>
      </div>
    </div>

    <template v-else>
      <h1 class="qw-heading">What type of quotation?</h1>
      <p class="qw-lede">
        These are Quotation's real Type values. Both run the same costing wizard and create the
        Quotation from an approved worksheet — Type just labels which one this quote is.
      </p>

      <div class="qw-type-grid">
        <button
          v-for="(pt, i) in PRODUCT_TYPES"
          :key="pt.key"
          type="button"
          class="qw-type-card"
          :class="{ 'is-active': type === pt.key, 'is-disabled': !pt.enabled }"
          :disabled="!pt.enabled"
          :title="pt.enabled ? '' : 'No flow built for this type yet'"
          @click="pickType(pt)"
        >
          <div class="qw-type-card__eyebrow">TYPE {{ String(i + 1).padStart(2, '0') }}</div>
          <div class="qw-type-card__name">{{ pt.key }}</div>
          <div class="qw-type-card__desc">{{ pt.desc }}</div>
        </button>
      </div>

      <div v-if="type" class="qw-tank-section">
        <h2 class="qw-section-title">Tank type</h2>
        <p class="qw-lede">
          Optional — pre-fills step 2's Tank type field from a real
          <RouterLink :to="listRouteFor('Tank Type')">Tank Type</RouterLink> record. You can change it in the
          wizard either way.
        </p>

        <div v-if="!live" class="qw-notice">
          Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to load Tank Type records.
        </div>
        <div v-else-if="error" class="qw-error-banner">
          <span class="qw-error-banner__icon"><LucideIcon name="x" /></span>
          <div style="min-width:0;">
            <div class="qw-error-banner__title">Could not load Tank Type</div>
            <div class="qw-error-banner__body">{{ error }}</div>
          </div>
        </div>
        <div v-else-if="loading" class="qw-loading">Loading tank types…</div>
        <div v-else-if="!tankTypes.length" class="qw-notice">
          No Tank Type records yet — start blank and pick a tank type inside the wizard.
        </div>
        <div v-else class="qw-tank-grid">
          <button
            v-for="t in tankTypes"
            :key="t.name"
            type="button"
            class="qw-tank-tile"
            @click="startWizard(t.name)"
          >
            {{ t.name }}
          </button>
        </div>

        <button type="button" class="qw-ghost-btn" style="margin-top:16px;" @click="startWizard(null)">
          Start blank →
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Shares the Quotation Wizard palette with CostingWorksheetWizard.vue — see
   the tokens and rationale there. Duplicated rather than extracted: only
   these two screens use it. */
.qw-wizard {
  --qw-primary: #0B3465;
  --qw-primary-dark: #0B3465;
  --qw-primary-hover: #0E4079;
  --qw-primary-tint: #E9EFF7;
  --qw-border: #D7DEE8;
  --qw-row-border: #EDF1F6;
  --qw-text: #0E1B2B;
  --qw-body: #33414F;
  --qw-muted: #5E6B7A;
  --qw-faint: #94A0AE;
  font-family: 'Raleway', system-ui, sans-serif;
  color: var(--qw-body);
  padding: 30px 36px 80px;
  margin: 0 auto;
  max-width: 1120px;
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
  margin: 0 0 8px;
  font: 900 32px/1.15 'Raleway', system-ui, sans-serif;
  letter-spacing: -0.02em;
  color: var(--qw-text);
}

.qw-lede {
  margin: 0 0 22px;
  font: 400 15px/22px 'Raleway', system-ui, sans-serif;
  color: var(--qw-muted);
  max-width: 68ch;
}

.qw-lede a {
  color: var(--qw-primary-dark);
}

.qw-draft-banner {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  background: var(--qw-primary-tint);
  border: 1px solid var(--qw-border);
  border-radius: 10px;
  padding: 20px 22px;
  margin-bottom: 26px;
}

.qw-draft-banner__icon {
  flex: none;
  color: var(--qw-primary-dark);
  margin-top: 2px;
}

.qw-draft-banner__body {
  flex: 1;
  min-width: 0;
}

.qw-draft-banner__title {
  font: 700 15.5px/1.4 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-draft-banner__desc {
  font: 400 13.5px/20px 'Raleway', system-ui, sans-serif;
  color: var(--qw-muted);
  margin-top: 4px;
}

.qw-draft-banner__actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: none;
}

.qw-btn-primary {
  background: var(--qw-primary);
  color: #fff;
  border: 1px solid var(--qw-primary);
  padding: 9px 18px;
  border-radius: 10px;
  font: 700 13.5px/1 'Raleway', system-ui, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}

.qw-btn-primary:hover {
  background: var(--qw-primary-hover);
  border-color: var(--qw-primary-hover);
}

.qw-type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.qw-type-card {
  text-align: left;
  cursor: pointer;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 20px;
  font-family: inherit;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.qw-type-card:not(.is-disabled):hover,
.qw-type-card.is-active {
  border-color: var(--qw-primary);
  box-shadow: 0 8px 24px rgba(11, 52, 101, 0.15);
}

.qw-type-card.is-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.qw-type-card__eyebrow {
  font: 500 11px/1 'IBM Plex Mono', monospace;
  color: var(--qw-faint);
  letter-spacing: 0.1em;
}

.qw-type-card__name {
  font: 800 24px/1.2 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
  margin: 8px 0 6px;
}

.qw-type-card__desc {
  font: 400 15px/22px 'Raleway', system-ui, sans-serif;
  color: var(--qw-muted);
}

.qw-tank-section {
  border-top: 1px solid var(--qw-border);
  padding-top: 26px;
  margin-top: 30px;
}

.qw-section-title {
  margin: 0 0 6px;
  font: 800 24px/1.2 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
}

.qw-tank-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 14px;
}

.qw-tank-tile {
  text-align: left;
  cursor: pointer;
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 16px;
  font: 700 15px/1.3 'Raleway', system-ui, sans-serif;
  color: var(--qw-text);
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.qw-tank-tile:hover {
  border-color: var(--qw-primary);
  box-shadow: 0 8px 24px rgba(11, 52, 101, 0.15);
}

.qw-notice {
  background: var(--qw-primary-tint);
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 15px 18px;
  font-size: 13px;
  color: var(--qw-primary-dark);
}

.qw-loading {
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 8px;
  padding: 24px;
  text-align: center;
  color: var(--qw-faint);
  font-size: 14px;
  font-weight: 600;
}

.qw-error-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 15px 18px;
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

.qw-ghost-btn {
  background: transparent;
  color: var(--qw-muted);
  border: 1px solid var(--qw-border);
  padding: 9px 15px;
  border-radius: 10px;
  font: 600 13.5px/1 'Raleway', system-ui, sans-serif;
  cursor: pointer;
}

.qw-ghost-btn:hover {
  background: var(--qw-row-border);
}
</style>
