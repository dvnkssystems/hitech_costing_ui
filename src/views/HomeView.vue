<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { hasBackend } from '@/lib/frappe'
import { fetchHomeStats, monthBounds, QUOTATION_PIPELINE_STAGES } from '@/lib/home'
import { formRouteFor } from '@/lib/frappeRouting'
import { formatDate, moneyCompact, integer, percent } from '@/utils/format'
import { worksheetStatusStyle } from '@/utils/styles'
import LucideIcon from '@/components/LucideIcon.vue'

const router = useRouter()
const session = useSessionStore()

const stats = ref(null)
const loading = ref(false)
const error = ref('')
const live = computed(() => hasBackend)

const todayLabel = new Date().toLocaleDateString(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
})

/** First name where there is one — "Welcome back, Administrator" reads oddly. */
const greetingName = computed(() => {
  const name = session.displayName || 'there'
  return name.includes('@') ? name.split('@')[0] : name.split(' ')[0]
})

const n = (value) => integer(value)
/**
 * Dashboard percentages stay at 1dp on purpose — these are headline tiles
 * ("Avg margin 23.4%"), not costing figures, and the full 6dp the site's
 * float precision allows belongs on the worksheet rail where the number is
 * actually reconciled. The digits are an explicit argument to the shared
 * helper so the narrowing is a decision, not an accident.
 */
const pct = (value, digits = 1) =>
  value === null || value === undefined ? '—' : percent(value, digits)

/** Placeholder stages so the pipeline keeps its shape before data lands. */
const emptyPipeline = QUOTATION_PIPELINE_STAGES.map((s) => ({ ...s, count: 0, share: 0 }))
const pipeline = computed(() => stats.value?.quotationPipeline ?? emptyPipeline)
const recentQuotations = computed(() => stats.value?.recentQuotations ?? [])

const monthLabel = new Date().toLocaleDateString(undefined, { month: 'short' })

/**
 * Drill-downs. Every tile and pipeline row opens the list it was counted
 * from, filtered the way `docList.js`'s query syntax spells it — a filtered
 * URL always lands on the generic list (see `DocListHost.vue`), which shows
 * the condition as a chip the user can clear.
 *
 * A pipeline stage is not a field on `Quotation` — it is derived from the
 * quote's worksheets (see `home.js`). `costing_status` is the derived filter
 * `derivedFilters.js` resolves for the Quotation list, by the same rule the
 * bar was counted with, so "Quoted 14" opens exactly those 14 quotations.
 */
const listRoute = (doctype, query = {}) => ({ name: 'doc-list', params: { doctype }, query })
const stageRoute = (stageKey) => listRoute('Quotation', { costing_status: stageKey })

const cards = computed(() => {
  const s = stats.value
  const growth = s?.quotationGrowth
  return [
    {
      label: 'Quotations this month',
      value: s ? n(s.quotationsThisMonth) : '—',
      icon: 'file-text',
      bg: 'rgba(16,120,48,.1)',
      fg: '#107830',
      to: listRoute('Quotation', { creation: `>=${monthBounds(0).from}` }),
      note:
        !growth || growth.pct === null
          ? { text: `${n(growth?.current)} created this month`, icon: 'clock', color: '#64748B' }
          : {
              text: `${growth.pct >= 0 ? '+' : ''}${pct(growth.pct)}`,
              suffix: 'vs last month',
              icon: 'trending-up',
              color: growth.pct >= 0 ? '#107830' : '#E63946'
            }
    },
    {
      label: 'Pending approval',
      value: s ? n(s.pendingApproval) : '—',
      icon: 'loader',
      bg: '#FEF3C7',
      fg: '#B45309',
      to: stageRoute('Pending approval'),
      note: {
        text: s ? `${n(s.pendingBuHead)} with BU Head · ${n(s.pendingCfo)} with CFO` : 'BU Head or CFO review pending',
        icon: 'clock',
        color: '#B45309'
      }
    },
    {
      label: `Quoted value (${monthLabel})`,
      value: s ? moneyCompact(s.openQuotesValue) : '—',
      icon: 'wallet',
      bg: '#EFF6FF',
      fg: '#2563EB',
      to: listRoute('Quotation'),
      note: { text: `across ${s ? n(s.openQuotesCount) : '—'} open quotes`, icon: 'clock', color: '#64748B' }
    },
    {
      label: 'Avg margin at deal',
      value: s ? pct(s.avgMarginPercent) : '—',
      icon: 'trending-up',
      bg: '#ECFDF5',
      fg: '#059669',
      // The average is taken over Quoted worksheets, which carry the margin —
      // the one tile that opens worksheets rather than quotations.
      to: listRoute('Costing Worksheet', { status: 'Quoted' }),
      note: { text: 'target ≥ 10%', icon: 'check-circle-2', color: '#64748B' }
    },
    // Open quotations whose freight engine found no Currency Exchange Master
    // rate for a quarter it needed (`hitech_exchange_rate_flags` set) — that
    // leg is priced at ₹0 until the rate is entered, so anything > 0 here is
    // a quote going out under-costed. Warning-styled only when it bites.
    (() => {
      const missing = s ? Number(s.missingExchangeRates) || 0 : 0
      const warn = missing > 0
      return {
        label: 'Missing exchange rates',
        value: s ? n(missing) : '—',
        icon: warn ? 'triangle-alert' : 'coins',
        bg: warn ? '#FEF2F2' : '#F1F5F9',
        fg: warn ? '#DC2626' : '#475569',
        to: warn
          ? listRoute('Quotation', { hitech_exchange_rate_flags: '~set' })
          : listRoute('Currency Exchange Master'),
        warning: warn,
        note: warn
          ? { text: 'open quotes with a freight leg costed at ₹0 — add the quarter\'s rate', icon: 'triangle-alert', color: '#DC2626' }
          : { text: 'every open quote has its quarter\'s rates', icon: 'check-circle-2', color: '#64748B' }
      }
    })()
  ]
})

const go = (to) => router.push(to)

async function load() {
  if (!live.value) return
  loading.value = true
  error.value = ''
  try {
    stats.value = await fetchHomeStats()
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="home">
    <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:14px; margin-bottom:26px;">
      <div style="min-width:0;">
        <div style="font-size:13px; color:#94A0AE; font-weight:600;">{{ todayLabel }}</div>
        <h1 class="home__title">Welcome back, {{ greetingName }}</h1>
      </div>
      <div style="display:flex; gap:11px; flex-wrap:wrap; align-items:center;">
        <span v-if="loading" style="font-size:13px; color:#94A0AE; font-weight:600;">Loading…</span>
        <button
          @click="go('/quotation/new')"
          style="display:flex; align-items:center; gap:8px; background:#0B3465; color:#fff; border:none; padding:12px 18px; border-radius:11px; font-size:14.5px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(11, 52, 101, .28); font-family:inherit;"
          class="hv1 home__cta"
        >
          <span style="font-size:17px;"><LucideIcon name="plus" /></span> New Quotation
        </button>
      </div>
    </div>

    <div
      v-if="!live"
      style="display:flex; align-items:center; gap:14px; background:#EFF6FF; border:1px solid #BFDBFE; border-radius:13px; padding:15px 18px; margin-bottom:22px; flex-wrap:wrap;"
    >
      <span
        style="width:34px; height:34px; border-radius:9px; background:#fff; color:#2563EB; display:flex; align-items:center; justify-content:center; font-size:17px; flex:none;"
        ><LucideIcon name="info" /></span
      >
      <div style="font-size:13px; color:#2563EB;">
        No backend configured. Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to load live figures.
      </div>
    </div>

    <div
      v-if="error"
      style="display:flex; align-items:flex-start; gap:12px; background:#FEF2F2; border:1px solid #FECACA; border-radius:13px; padding:15px 18px; margin-bottom:18px;"
    >
      <span style="color:#DC2626; font-size:17px; flex:none;"><LucideIcon name="x" /></span>
      <div style="min-width:0;">
        <div style="font-size:14.5px; font-weight:700; color:#991B1B;">Could not load dashboard</div>
        <div style="font-size:13px; color:#B91C1C; margin-top:3px; word-break:break-word;">{{ error }}</div>
      </div>
    </div>

    <!-- KPI cards -->
    <div class="kpis">
      <button
        v-for="card in cards"
        :key="card.label"
        type="button"
        @click="go(card.to)"
        :style="{
          background: card.warning ? '#FFF5F5' : '#fff',
          border: `1px solid ${card.warning ? '#FECACA' : '#EAEEF3'}`
        }"
        class="kpi hv3"
      >
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
          <div style="min-width:0;">
            <div style="font-size:13px; color:#64748B; font-weight:600;">{{ card.label }}</div>
            <div class="kpi__value" :style="{ color: card.warning ? '#B91C1C' : undefined }">{{ card.value }}</div>
          </div>
          <div class="kpi__icon" :style="{ background: card.bg, color: card.fg }">
            <LucideIcon :name="card.icon" />
          </div>
        </div>
        <div
          :style="{ marginTop:'13px', fontSize:'12.5px', color: card.note.color, fontWeight:'600', display:'flex', alignItems:'flex-start', gap:'6px' }"
        >
          <span style="font-size:15px; flex:none; margin-top:1px;"><LucideIcon :name="card.note.icon" /></span>
          <span style="min-width:0;">
            {{ card.note.text }}
            <span v-if="card.note.suffix" style="color:#94A0AE; font-weight:500;">{{ card.note.suffix }}</span>
          </span>
        </div>
      </button>
    </div>

    <!-- pipeline + recent quotations -->
    <div class="panels">
      <!-- status pipeline -->
      <div class="panel" style="padding:24px 24px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
          <h2 style="font-size:16px; font-weight:700; margin:0;">Pipeline by status</h2>
          <span style="font-size:13px; color:#94A0AE; font-weight:600;">{{ n(stats?.quotationPipelineTotal) }} total</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:2px;">
          <button
            v-for="stage in pipeline"
            :key="stage.key"
            type="button"
            class="stage"
            :title="`Open ${stage.label} quotations`"
            @click="go(stageRoute(stage.key))"
          >
            <span style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:7px;">
              <span style="font-size:13.5px; color:#334155; font-weight:600;">{{ stage.label }}</span>
              <span style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:15px; font-weight:800;">{{ n(stage.count) }}</span>
                <span class="stage__chevron"><LucideIcon name="chevron-right" /></span>
              </span>
            </span>
            <span style="display:block; height:9px; border-radius:999px; background:#F1F5F9; overflow:hidden;">
              <span :style="{ display:'block', height:'100%', width: `${stage.share}%`, background: stage.color, borderRadius:'999px' }"></span>
            </span>
          </button>
        </div>
      </div>

      <!-- recent quotations -->
      <div class="panel" style="overflow:hidden;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:20px 22px 4px;">
          <h2 style="font-size:16px; font-weight:700; margin:0;">Recent quotations</h2>
          <RouterLink :to="listRoute('Quotation')" class="panel__link">
            View all <LucideIcon name="chevron-right" />
          </RouterLink>
        </div>
        <div style="overflow-x:auto;">
          <table class="recent">
            <thead>
              <tr>
                <th>ID</th>
                <th>Customer</th>
                <th>Status</th>
                <th class="recent__modified">Modified</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in recentQuotations"
                :key="r.name"
                tabindex="0"
                role="link"
                :aria-label="`Open quotation ${r.name}`"
                @click="go(formRouteFor('Quotation', r.name))"
                @keydown.enter="go(formRouteFor('Quotation', r.name))"
                class="recent__row hv4"
              >
                <td style="font-weight:700; color:#0F172A; white-space:nowrap;">
                  {{ r.name }}
                  <span
                    v-if="r.missingExchangeRate"
                    title="A freight leg is costed at ₹0 — no exchange rate for its quarter"
                    style="margin-left:6px; color:#DC2626; font-size:14px; vertical-align:-2px; display:inline-block;"
                  ><LucideIcon name="triangle-alert" /></span>
                </td>
                <td>{{ r.customer_name || r.party_name || '—' }}</td>
                <td>
                  <span v-if="r.status" :style="worksheetStatusStyle(r.status)">{{ r.status }}</span>
                  <span v-else style="color:#94A0AE; font-size:13px;">—</span>
                </td>
                <td class="recent__modified" style="color:#64748B; white-space:nowrap;">{{ r.modified ? formatDate(String(r.modified).slice(0, 10)) : '—' }}</td>
              </tr>
              <tr v-if="!recentQuotations.length">
                <td colspan="4" style="padding:28px 22px; text-align:center; color:#94A0AE; font-size:13.5px; font-weight:600;">
                  No quotations yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <p style="margin-top:22px; font-size:12px; color:#94A0AE; line-height:1.6;">
      Costing figures reflect whatever is in the DocType today. Every rate, band and multiplier behind
      them is seed data pending the real workbook — see the module's cost-model notes before quoting a
      real job off these numbers.
    </p>
  </div>
</template>

<style scoped>
/* Sized by the room the page actually has, not the viewport: the sidebar
   takes 252px when open, so a viewport breakpoint would be wrong half the
   time. Every rule below is a container query against `.home`. */
.home {
  container-type: inline-size;
  padding: 30px 36px 56px;
  margin: 0 auto;
}
.home__title {
  margin: 6px 0 0;
  font-size: clamp(21px, 4cqi, 28px);
  font-weight: 800;
  letter-spacing: -.025em;
  overflow-wrap: anywhere;
}

/* ---- KPI tiles ---- */
.kpis {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 18px;
  margin-bottom: 26px;
}
.kpi {
  text-align: left;
  border-radius: 8px;
  padding: 22px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
  font-family: inherit;
  color: inherit;
  cursor: pointer;
  min-width: 0;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.kpi__value {
  font-size: clamp(22px, 2.3cqi, 32px);
  font-weight: 800;
  margin-top: 8px;
  letter-spacing: -.02em;
  overflow-wrap: anywhere;
}
.kpi__icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 21px;
  flex: none;
}

/* ---- panels ---- */
.panels {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.panel {
  background: #fff;
  border: 1px solid #EAEEF3;
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
  min-width: 0;
}
.panel__link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ht-navy);
  text-decoration: none;
  white-space: nowrap;
}
.panel__link:hover { text-decoration: underline; }

/* A pipeline row is one button: the whole bar is the target, not the label. */
.stage {
  display: block;
  width: calc(100% + 20px);
  margin: 0 -10px;
  padding: 9px 10px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  text-align: left;
  font-family: inherit;
  color: inherit;
  cursor: pointer;
}
.stage:hover { background: #F8FAFC; }
.stage__chevron { font-size: 14px; color: #CBD5E1; transition: color .15s ease, transform .15s ease; }
.stage:hover .stage__chevron { color: var(--ht-navy); transform: translateX(2px); }

/* ---- recent quotations ---- */
.recent {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  color: #334155;
  margin-top: 8px;
}
.recent th {
  text-align: left;
  padding: 11px 22px;
  font-size: 12px;
  font-weight: 700;
  color: #64748B;
  background: #F8FAFC;
  border-bottom: 1px solid #EAEEF3;
}
.recent td { padding: 12px 22px; }
.recent__row { cursor: pointer; border-bottom: 1px solid #F1F5F9; }

.kpi:focus-visible,
.stage:focus-visible,
.recent__row:focus-visible,
.panel__link:focus-visible,
.home__cta:focus-visible {
  outline: 2px solid var(--ht-navy);
  outline-offset: 2px;
}
.recent__row:focus-visible { outline-offset: -2px; }

/* Five tiles don't divide into rows of four or three, so the mid layout is a
   six-track grid: three across, then two across — no orphan, no hole. */
@container (max-width: 1180px) {
  .kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .kpi { grid-column: span 2; }
  .kpi:nth-child(n + 4) { grid-column: span 3; }
  .kpi__value { font-size: clamp(24px, 3.4cqi, 32px); }
}
@container (max-width: 900px) {
  .panels { grid-template-columns: minmax(0, 1fr); }
}
@container (max-width: 680px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .kpi,
  .kpi:nth-child(n + 4) { grid-column: span 1; }
  .kpi:last-child { grid-column: span 2; }
  .kpi { padding: 16px; }
  .kpi__value { font-size: 24px; }
  .kpi__icon { width: 36px; height: 36px; border-radius: 10px; font-size: 17px; }
  .recent th,
  .recent td { padding-left: 14px; padding-right: 14px; }
}
@container (max-width: 460px) {
  .recent__modified { display: none; }
  .recent { font-size: 13px; }
  .recent th,
  .recent td { padding-left: 10px; padding-right: 10px; }
  .home__cta { width: 100%; justify-content: center; }
}
@container (max-width: 380px) {
  .kpis { grid-template-columns: minmax(0, 1fr); }
  .kpi:last-child { grid-column: span 1; }
}

/* The page gutter is the one thing that follows the viewport — `.home` can't
   query itself for its own padding. */
@media (max-width: 900px) {
  .home { padding: 22px 20px 40px; }
}
@media (max-width: 560px) {
  .home { padding: 16px 14px 32px; }
}

@media (prefers-reduced-motion: reduce) {
  .kpi, .stage__chevron { transition: none; }
}
</style>
