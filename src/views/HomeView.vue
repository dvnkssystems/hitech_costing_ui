<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { hasBackend } from '@/lib/frappe'
import { fetchHomeStats, QUOTATION_PIPELINE_STAGES } from '@/lib/home'
import { formRouteFor } from '@/lib/frappeRouting'
import { formatDate, moneyCompact } from '@/utils/format'
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

const n = (value) => (Number(value) || 0).toLocaleString()
const pct = (value, digits = 1) =>
  value === null || value === undefined ? '—' : `${Number(value).toFixed(digits)}%`

/** Placeholder stages so the pipeline keeps its shape before data lands. */
const emptyPipeline = QUOTATION_PIPELINE_STAGES.map((s) => ({ ...s, count: 0, share: 0 }))
const pipeline = computed(() => stats.value?.quotationPipeline ?? emptyPipeline)
const recentQuotations = computed(() => stats.value?.recentQuotations ?? [])

const monthLabel = new Date().toLocaleDateString(undefined, { month: 'short' })

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
      to: '/list/Quotation',
      note:
        !growth || growth.pct === null
          ? { text: `${n(growth?.current)} created this month`, icon: 'clock', color: '#64748B' }
          : {
              text: `${growth.pct >= 0 ? '+' : ''}${growth.pct.toFixed(1)}%`,
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
      to: '/list/Quotation',
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
      to: '/list/Quotation',
      note: { text: `across ${s ? n(s.openQuotesCount) : '—'} open quotes`, icon: 'clock', color: '#64748B' }
    },
    {
      label: 'Avg margin at deal',
      value: s ? pct(s.avgMarginPercent) : '—',
      icon: 'trending-up',
      bg: '#ECFDF5',
      fg: '#059669',
      to: '/list/Quotation',
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
        to: warn ? '/list/Quotation' : '/list/Currency Exchange Master',
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
  <div style="padding:30px 36px 56px; margin:0 auto;">
    <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:14px; margin-bottom:26px;">
      <div>
        <div style="font-size:13px; color:#94A0AE; font-weight:600;">{{ todayLabel }}</div>
        <h1 style="margin:6px 0 0; font-size:28px; font-weight:800; letter-spacing:-.025em;">
          Welcome back, {{ greetingName }}
        </h1>
      </div>
      <div style="display:flex; gap:11px; flex-wrap:wrap; align-items:center;">
        <span v-if="loading" style="font-size:13px; color:#94A0AE; font-weight:600;">Loading…</span>
        <button
          @click="go('/quotation/new')"
          style="display:flex; align-items:center; gap:8px; background:#0B3465; color:#fff; border:none; padding:12px 18px; border-radius:11px; font-size:14.5px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(11, 52, 101, .28); font-family:inherit;"
          class="hv1"
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
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:18px; margin-bottom:26px;">
      <button
        v-for="card in cards"
        :key="card.label"
        @click="go(card.to)"
        :style="{
          textAlign: 'left',
          background: card.warning ? '#FFF5F5' : '#fff',
          border: `1px solid ${card.warning ? '#FECACA' : '#EAEEF3'}`,
          borderRadius: '8px',
          padding: '22px',
          boxShadow: '0 1px 2px rgba(15,23,42,.04)',
          fontFamily: 'inherit',
          cursor: 'pointer'
        }"
        class="hv3"
      >
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <div style="font-size:13px; color:#64748B; font-weight:600;">{{ card.label }}</div>
            <div :style="{ fontSize: '32px', fontWeight: '800', marginTop: '8px', letterSpacing: '-.02em', color: card.warning ? '#B91C1C' : undefined }">{{ card.value }}</div>
          </div>
          <div
            :style="{ width:'44px', height:'44px', borderRadius:'12px', background: card.bg, color: card.fg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'21px', flex:'none' }"
          >
            <LucideIcon :name="card.icon" />
          </div>
        </div>
        <div
          :style="{ marginTop:'13px', fontSize:'12.5px', color: card.note.color, fontWeight:'600', display:'flex', alignItems:'center', gap:'6px' }"
        >
          <span style="font-size:15px;"><LucideIcon :name="card.note.icon" /></span>
          {{ card.note.text }}
          <span v-if="card.note.suffix" style="color:#94A0AE; font-weight:500;">{{ card.note.suffix }}</span>
        </div>
      </button>
    </div>

    <!-- pipeline + recent quotations -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:18px; align-items:start;">
      <!-- status pipeline -->
      <div style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:24px; box-shadow:0 1px 2px rgba(15,23,42,.04);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:8px;">
          <h2 style="font-size:16px; font-weight:700; margin:0;">Pipeline by status</h2>
          <span style="font-size:13px; color:#94A0AE; font-weight:600;">{{ n(stats?.quotationPipelineTotal) }} total</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:18px;">
          <div v-for="stage in pipeline" :key="stage.key">
            <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:7px;">
              <span style="font-size:13.5px; color:#334155; font-weight:600;">{{ stage.label }}</span>
              <span style="font-size:15px; font-weight:800;">{{ n(stage.count) }}</span>
            </div>
            <div style="height:9px; border-radius:999px; background:#F1F5F9; overflow:hidden;">
              <div :style="{ height:'100%', width: `${stage.share}%`, background: stage.color, borderRadius:'999px' }"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- recent quotations -->
      <div style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; overflow:hidden; box-shadow:0 1px 2px rgba(15,23,42,.04);">
        <div style="padding:20px 22px 4px; font-size:16px; font-weight:700;">Recent quotations</div>
        <table style="width:100%; border-collapse:collapse; font-size:14px; color:#334155; margin-top:8px;">
          <thead>
            <tr style="background:#F8FAFC;">
              <th style="text-align:left; padding:11px 22px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">ID</th>
              <th style="text-align:left; padding:11px 22px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Customer</th>
              <th style="text-align:left; padding:11px 22px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Status</th>
              <th style="text-align:left; padding:11px 22px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Modified</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in recentQuotations"
              :key="r.name"
              @click="go(formRouteFor('Quotation', r.name))"
              style="cursor:pointer; border-bottom:1px solid #F1F5F9;"
              class="hv4"
            >
              <td style="padding:12px 22px; font-weight:700; color:#0F172A;">
                {{ r.name }}
                <span
                  v-if="r.missingExchangeRate"
                  title="A freight leg is costed at ₹0 — no exchange rate for its quarter"
                  style="margin-left:6px; color:#DC2626; font-size:14px; vertical-align:-2px;"
                ><LucideIcon name="triangle-alert" /></span>
              </td>
              <td style="padding:12px 22px;">{{ r.customer_name || r.party_name || '—' }}</td>
              <td style="padding:12px 22px;">
                <span v-if="r.status" :style="worksheetStatusStyle(r.status)">{{ r.status }}</span>
                <span v-else style="color:#94A0AE; font-size:13px;">—</span>
              </td>
              <td style="padding:12px 22px; color:#64748B;">{{ r.modified ? formatDate(String(r.modified).slice(0, 10)) : '—' }}</td>
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

    <p style="margin-top:22px; font-size:12px; color:#94A0AE; line-height:1.6;">
      Costing figures reflect whatever is in the DocType today. Every rate, band and multiplier behind
      them is seed data pending the real workbook — see the module's cost-model notes before quoting a
      real job off these numbers.
    </p>
  </div>
</template>
