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
import { loadCustomDashboard } from '@/lib/customDashboard'

/** The custom_ui `Custom UI Dashboard` this page draws (KPI cards, widgets,
 *  header button, title), created by hitech_costing's
 *  `setup/home_dashboard.py` and edited in the desk. Without it (custom_ui
 *  too old, or the record deleted) the page falls back to its built-in
 *  figures from `lib/home.js`. */
const DASHBOARD = 'Hitech Home'

const router = useRouter()
const session = useSessionStore()

const stats = ref(null)
const dash = ref(null)
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

const widgetOfType = (type) => dash.value?.widgets.find((w) => w.type === type) ?? null
const STAGE_COLORS = ['#5E6B7A', '#F59E0B', '#107830', '#107830', '#E63946']

/** Pipeline panel: the dashboard's Performance Tiles widget, or built-in. */
const pipelineView = computed(() => {
  const widget = widgetOfType('performance_tiles')
  if (dash.value && widget) {
    const tiles = widget.data?.tiles ?? []
    return {
      title: widget.title || 'Pipeline',
      total: widget.data?.total ?? tiles.reduce((sum, t) => sum + (Number(t.value) || 0), 0),
      stages: tiles.map((t, i) => ({
        key: t.key ?? t.label,
        label: t.label,
        count: t.value,
        share: Number(t.max) ? (Number(t.value) / Number(t.max)) * 100 : 0,
        color: t.color || STAGE_COLORS[i % STAGE_COLORS.length],
        to: t.route || null
      }))
    }
  }
  if (dash.value) return null
  return {
    title: 'Pipeline by status',
    total: stats.value?.quotationPipelineTotal,
    stages: pipeline.value.map((s) => ({ ...s, to: stageRoute(s.key) }))
  }
})

/** Recent-quotations panel: the dashboard's Recommendations widget, or built-in. */
const recentView = computed(() => {
  const widget = widgetOfType('recommendations')
  if (dash.value && widget) {
    return {
      title: widget.title || 'Recent',
      rows: (widget.data?.rows ?? []).map((r) => ({
        name: r.name,
        customer_name: r.customer,
        status: r.status,
        modified: r.modified,
        missingExchangeRate: r.warning
      }))
    }
  }
  if (dash.value) return null
  return { title: 'Recent quotations', rows: recentQuotations.value }
})

const pageTitle = computed(() =>
  dash.value?.config?.title
    ? dash.value.config.title.replace('{first_name}', greetingName.value)
    : `Welcome back, ${greetingName.value}`
)
const footnote = computed(() =>
  dash.value
    ? dash.value.config.subtitle || ''
    : "Costing figures reflect whatever is in the DocType today. Every rate, band and multiplier behind them is seed data pending the real workbook — see the module's cost-model notes before quoting a real job off these numbers."
)
const headerButtons = computed(() => {
  if (!dash.value) return [{ label: 'New Quotation', icon: 'plus', route: '/quotation/new' }]
  return (dash.value.config.buttons ?? []).filter((b) => b.route && b.placement !== 'selection')
})

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

const KPI_COLORS = {
  primary: { bg: '#E9EFF7', fg: '#0B3465' },
  secondary: { bg: '#F1F5F9', fg: '#475569' },
  success: { bg: 'rgba(16,120,48,.1)', fg: '#107830' },
  info: { bg: '#EFF6FF', fg: '#2563EB' },
  warning: { bg: '#FEF3C7', fg: '#B45309' },
  error: { bg: '#FEF2F2', fg: '#DC2626' }
}

/** A KPI's drill-down: its source doctype's list, with the KPI's simple
 *  filters (`=` and `is set`) as the list's query. */
function kpiRoute(kpi) {
  const doctype = kpi.frappe?.doctype
  if (!doctype) return null
  const query = {}
  for (const f of kpi.frappe?.filters ?? []) {
    const [field, op, value] = f.length === 4 ? f.slice(1) : f
    if (op === '=') query[field] = value
    else if (op === 'is') query[field] = value === 'set' ? '~set' : '~not set'
  }
  return listRoute(doctype, query)
}

function kpiValue(kpi) {
  const v = kpi.value
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v !== 'number') return `${kpi.prefix || ''}${v}`
  if (kpi.prefix === '₹') return moneyCompact(v)
  return `${kpi.prefix || ''}${n(v)}`
}

function dashboardCard(kpi) {
  const palette = KPI_COLORS[kpi.color] ?? KPI_COLORS.secondary
  const active = Number(kpi.value) > 0
  const warning = kpi.color === 'error' && active
  const badge = kpi.badge || ''
  const trend = /^[+-]\d/.test(badge)
  const negative = badge.startsWith('-')
  const [text, ...rest] = trend ? badge.split(' ') : [badge]
  return {
    label: (kpi.title || '').replace('{month}', monthLabel),
    value: kpiValue(kpi),
    icon: kpi.color === 'error' && !active ? 'coins' : kpi.icon || 'circle',
    bg: kpi.color === 'error' && !active ? '#F1F5F9' : palette.bg,
    fg: kpi.color === 'error' && !active ? '#475569' : palette.fg,
    to: kpiRoute(kpi),
    warning,
    note: badge
      ? {
          text: trend ? text : badge,
          suffix: trend ? rest.join(' ') : '',
          icon: trend ? 'trending-up' : warning ? 'triangle-alert' : kpi.color === 'warning' ? 'clock' : 'check-circle-2',
          color: trend ? (negative ? '#E63946' : '#107830') : warning || kpi.color === 'warning' ? palette.fg : '#64748B'
        }
      : null
  }
}

const cards = computed(() => {
  if (dash.value) return dash.value.kpis.map(dashboardCard)
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

const go = (to) => to && router.push(to)

async function load() {
  if (!live.value) return
  loading.value = true
  error.value = ''
  try {
    dash.value = await loadCustomDashboard(DASHBOARD)
    if (!dash.value) stats.value = await fetchHomeStats()
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
        <h1 class="home__title">{{ pageTitle }}</h1>
      </div>
      <div style="display:flex; gap:11px; flex-wrap:wrap; align-items:center;">
        <span v-if="loading" style="font-size:13px; color:#94A0AE; font-weight:600;">Loading…</span>
        <button
          v-for="b in headerButtons"
          :key="b.label"
          @click="go(b.route)"
          style="display:flex; align-items:center; gap:8px; background:#0B3465; color:#fff; border:none; padding:12px 18px; border-radius:11px; font-size:14.5px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(11, 52, 101, .28); font-family:inherit;"
          class="hv1 home__cta"
        >
          <span v-if="b.icon" style="font-size:17px;"><LucideIcon :name="b.icon" /></span> {{ b.label }}
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
          v-if="card.note"
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
      <div v-if="pipelineView" class="panel" style="padding:24px 24px 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
          <h2 style="font-size:16px; font-weight:700; margin:0;">{{ pipelineView.title }}</h2>
          <span style="font-size:13px; color:#94A0AE; font-weight:600;">{{ n(pipelineView.total) }} total</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:2px;">
          <button
            v-for="stage in pipelineView.stages"
            :key="stage.key"
            type="button"
            class="stage"
            :title="`Open ${stage.label} quotations`"
            @click="go(stage.to)"
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
      <div v-if="recentView" class="panel" style="overflow:hidden;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:20px 22px 4px;">
          <h2 style="font-size:16px; font-weight:700; margin:0;">{{ recentView.title }}</h2>
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
                v-for="r in recentView.rows"
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
                  <span :style="worksheetStatusStyle(r.status || 'Draft')">{{ r.status || 'Draft' }}</span>
                </td>
                <td class="recent__modified" style="color:#64748B; white-space:nowrap;">{{ r.modified ? formatDate(String(r.modified).slice(0, 10)) : '—' }}</td>
              </tr>
              <tr v-if="!recentView.rows.length">
                <td colspan="4" style="padding:28px 22px; text-align:center; color:#94A0AE; font-size:13.5px; font-weight:600;">
                  No quotations yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <p v-if="footnote" style="margin-top:22px; font-size:12px; color:#94A0AE; line-height:1.6;">{{ footnote }}</p>
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
  padding: 11px 16px;
  font-size: 12px;
  font-weight: 700;
  color: #64748B;
  background: #F8FAFC;
  border-bottom: 1px solid #EAEEF3;
}
.recent td { padding: 12px 16px; }
/* Four columns in half the page: the ID and date never wrap, the customer
   name does -- the Modified column used to run off the panel's right edge. */
.recent td:nth-child(2) { overflow-wrap: anywhere; }
.recent th:last-child,
.recent td:last-child { white-space: nowrap; padding-right: 18px; }
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
