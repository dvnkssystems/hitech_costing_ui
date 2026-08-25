<script setup>
/**
 * "What kind of quotation?" — front door in front of the Costing Worksheet
 * wizard, styled after the Quotation Wizard design.
 *
 * The three cards are `Quotation`'s real `order_type` Select options (Sales /
 * Maintenance / Shopping Cart — see erpnext's quotation.json), not invented
 * ones. Only Sales is clickable: `Costing Worksheet.create_quotation()` (the
 * only thing in this app that ever creates a `Quotation`) hardcodes
 * `order_type = "Sales"`, and there is no Maintenance or Shopping Cart flow
 * anywhere in hitech_costing, so this screen doesn't pretend they work.
 *
 * Picking a Tank Type here pre-seeds it onto the wizard through
 * `seedPendingDoc`, the same "park a new document for the target route"
 * channel `frappe.new_doc` and mapped-doc creation already use —
 * `CostingWorksheetWizard.vue` picks it up via
 * `takePendingDoc('Costing Worksheet')` as `useFrmRemote`'s `initialDoc`.
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '@/lib/frappeDb'
import { hasBackend } from '@/lib/frappe'
import { seedPendingDoc } from '@/lib/mappedDoc'
import { listRouteFor } from '@/lib/frappeRouting'
import LucideIcon from '@/components/LucideIcon.vue'

const router = useRouter()
const live = computed(() => hasBackend)

/** Quotation's real `order_type` Select options — only Sales has a flow behind it. */
const ORDER_TYPES = [
  {
    key: 'Sales',
    desc: 'Costed product quote. Runs the eight-step wizard and lands on a costing worksheet.',
    enabled: true
  },
  {
    key: 'Maintenance',
    desc: 'A real Quotation order type — no costing flow built for it in this app yet.',
    enabled: false
  },
  {
    key: 'Shopping Cart',
    desc: "Set by the customer portal's own checkout, not chosen here.",
    enabled: false
  }
]

const type = ref(null) // null | 'Sales'
const tankTypes = ref([])
const loading = ref(false)
const error = ref('')

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

function pickType(orderType) {
  if (!orderType.enabled) return
  type.value = orderType.key
  if (!tankTypes.value.length && !loading.value) loadTankTypes()
}

function startWizard(tankTypeName) {
  if (tankTypeName) {
    seedPendingDoc('Costing Worksheet', { doctype: 'Costing Worksheet', tank_type: tankTypeName })
  }
  router.push('/wizard/costing-worksheet')
}

onMounted(() => {
  if (type.value === 'Sales') loadTankTypes()
})
</script>

<template>
  <div class="qw-wizard qw-new">
    <div class="qw-crumbtrail">
      <RouterLink to="/" class="qw-crumbtrail__link">Home</RouterLink>
      <LucideIcon name="chevron-right" />
      <RouterLink :to="listRouteFor('Costing Worksheet')" class="qw-crumbtrail__link">Costing Worksheet</RouterLink>
      <LucideIcon name="chevron-right" />
      <span class="qw-crumbtrail__current">New quote</span>
    </div>

    <h1 class="qw-heading">What kind of quotation?</h1>
    <p class="qw-lede">
      These are Quotation's real Order Type values. Only Sales has a flow behind it in this app — it runs
      the costing wizard and creates the Quotation from an approved worksheet.
    </p>

    <div class="qw-type-grid">
      <button
        v-for="(ot, i) in ORDER_TYPES"
        :key="ot.key"
        type="button"
        class="qw-type-card"
        :class="{ 'is-active': type === ot.key, 'is-disabled': !ot.enabled }"
        :disabled="!ot.enabled"
        :title="ot.enabled ? '' : 'No flow built for this order type yet'"
        @click="pickType(ot)"
      >
        <div class="qw-type-card__eyebrow">ORDER TYPE {{ String(i + 1).padStart(2, '0') }}</div>
        <div class="qw-type-card__name">{{ ot.key }}</div>
        <div class="qw-type-card__desc">{{ ot.desc }}</div>
      </button>
    </div>

    <div v-if="type === 'Sales'" class="qw-tank-section">
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
  </div>
</template>

<style scoped>
/* Shares the Quotation Wizard palette with CostingWorksheetWizard.vue — see
   the tokens and rationale there. Duplicated rather than extracted: only
   these two screens use it. */
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
  font: 900 32px/1.15 'Nunito', system-ui, sans-serif;
  letter-spacing: -0.02em;
  color: var(--qw-text);
}

.qw-lede {
  margin: 0 0 22px;
  font: 400 15px/22px 'Nunito', system-ui, sans-serif;
  color: var(--qw-muted);
  max-width: 68ch;
}

.qw-lede a {
  color: var(--qw-primary-dark);
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
  border-radius: 16px;
  padding: 20px;
  font-family: inherit;
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.qw-type-card:not(.is-disabled):hover,
.qw-type-card.is-active {
  border-color: var(--qw-primary);
  box-shadow: 0 8px 24px rgba(254, 77, 0, 0.15);
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
  font: 800 24px/1.2 'Nunito', system-ui, sans-serif;
  color: var(--qw-text);
  margin: 8px 0 6px;
}

.qw-type-card__desc {
  font: 400 15px/22px 'Nunito', system-ui, sans-serif;
  color: var(--qw-muted);
}

.qw-tank-section {
  border-top: 1px solid var(--qw-border);
  padding-top: 26px;
  margin-top: 30px;
}

.qw-section-title {
  margin: 0 0 6px;
  font: 800 24px/1.2 'Nunito', system-ui, sans-serif;
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
  border-radius: 12px;
  padding: 16px;
  font: 700 15px/1.3 'Nunito', system-ui, sans-serif;
  color: var(--qw-text);
  box-shadow: 0 2px 8px rgba(38, 38, 38, 0.08);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.qw-tank-tile:hover {
  border-color: var(--qw-primary);
  box-shadow: 0 8px 24px rgba(254, 77, 0, 0.15);
}

.qw-notice {
  background: #fff7f2;
  border: 1px solid var(--qw-border);
  border-radius: 12px;
  padding: 15px 18px;
  font-size: 13px;
  color: var(--qw-primary-dark);
}

.qw-loading {
  background: #fff;
  border: 1px solid var(--qw-border);
  border-radius: 12px;
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
  border-radius: 12px;
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
  font: 600 13.5px/1 'Nunito', system-ui, sans-serif;
  cursor: pointer;
}

.qw-ghost-btn:hover {
  background: var(--qw-row-border);
}
</style>
