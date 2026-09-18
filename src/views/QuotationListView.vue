<script setup>
/**
 * Bespoke Quotation list — status tabs, search, and a status/product column
 * derived from each Quotation's linked Costing Worksheet(s), since Quotation
 * itself carries no approval status of its own (see `QuotationOutputView.vue`'s
 * doc comment on why that's derived rather than a real field).
 *
 * Only renders once the backend's `Custom UI Doctype Layout` record for
 * `Quotation` has its `list` field set to `QuotationListView` (see
 * `src/lib/layouts.js`) — until then `DocListHost.vue` keeps using the
 * generic `DocListView`.
 *
 * Filtering/paging is done client-side over the full Quotation + linked-
 * worksheet result set, not server-side pages: a status tab is a filter on a
 * DERIVED value (the worksheet join), which the backend has no field for, so
 * there's no way to ask the server for "page 2 of Pending approval" directly.
 * Reasonable while the quotation count stays in the hundreds; if it grows
 * much further this should become a backend report instead.
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '@/lib/frappeDb'
import { hasBackend } from '@/lib/frappe'
import { formRouteFor, defaultListActionRouteFor } from '@/lib/frappeRouting'
import { STATUS_STAGES } from '@/lib/home'
import { worksheetStatusStyle } from '@/utils/styles'
import { money, formatDate } from '@/utils/format'
import LucideIcon from '@/components/LucideIcon.vue'

const DOCTYPE = 'Quotation'
const PAGE_SIZE = 20

const router = useRouter()
const live = computed(() => hasBackend)

const loading = ref(false)
const error = ref('')
const allRows = ref([])
const owners = ref([]) // [{ name, label }], from linked User records
const search = ref('')
const activeTab = ref('All')
const filterProduct = ref('All')
const filterBranch = ref('All')
const filterOwner = ref('All')
const filterModified = ref('any')
const page = ref(1)

const TABS = [
  { key: 'All', label: 'All' },
  { key: 'Draft', label: 'Draft', match: (s) => s === 'Draft' },
  { key: 'Pending approval', label: 'Pending approval', match: (s) => s === 'Pending BU Head' || s === 'Pending CFO' },
  { key: 'Approved', label: 'Approved', match: (s) => s === 'Approved' },
  // "Rejected" is a UI label over the worksheet's "Lost" status — there's no
  // separate Rejected status anywhere in the data model.
  { key: 'Rejected', label: 'Rejected', match: (s) => s === 'Lost' }
]

const MODIFIED_RANGES = [
  { key: 'any', label: 'Any time' },
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: 'month', label: 'This month' }
]

function withinModifiedRange(modified, key) {
  if (key === 'any' || !modified) return true
  const modifiedDate = new Date(modified)
  const now = new Date()
  if (key === 'month') {
    return modifiedDate.getFullYear() === now.getFullYear() && modifiedDate.getMonth() === now.getMonth()
  }
  const days = Number(key)
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return modifiedDate >= cutoff
}

function tabMatches(tab, status) {
  return tab.key === 'All' || (tab.match ? tab.match(status) : status === tab.key)
}

async function load() {
  if (!live.value) return
  loading.value = true
  error.value = ''
  try {
    const [quotations, worksheetRows] = await Promise.all([
      db.get_list(DOCTYPE, {
        // `customer` isn't a real field on Quotation — the party is
        // `party_name` (a Dynamic Link); `customer_name` is what's fetched
        // from it and shown.
        fields: ['name', 'customer_name', 'party_name', 'transaction_date', 'grand_total', 'docstatus', 'modified', 'owner'],
        order_by: 'modified desc',
        limit_page_length: 0
      }),
      db.get_list('Costing Worksheet', {
        // There's no real "branch" field on either doctype — `region`
        // (Domestic/Export) is the closest thing the data model has, so it
        // stands in for the "Branch" filter.
        fields: ['name', 'quotation', 'status', 'tank_type', 'region'],
        filters: [['quotation', 'is', 'set']],
        limit_page_length: 0
      })
    ])

    // Weakest-link status + a representative product/region per quotation,
    // from whichever linked worksheet is earliest in the real pipeline.
    const byQuotation = new Map()
    for (const w of worksheetRows ?? []) {
      const idx = STATUS_STAGES.findIndex((s) => s.key === w.status)
      const current = byQuotation.get(w.quotation)
      if (!current || (idx !== -1 && idx < current.stageIndex)) {
        byQuotation.set(w.quotation, { status: w.status, stageIndex: idx, product: w.tank_type, branch: w.region })
      }
    }

    allRows.value = (quotations ?? []).map((q) => {
      const agg = byQuotation.get(q.name)
      return {
        ...q,
        status: agg?.status ?? null,
        product: agg?.product ?? null,
        branch: agg?.branch ?? null
      }
    })

    const ownerNames = [...new Set(allRows.value.map((r) => r.owner).filter(Boolean))]
    const users = ownerNames.length
      ? await db.get_list('User', { filters: [['name', 'in', ownerNames]], fields: ['name', 'full_name'], limit_page_length: 0 })
      : []
    const fullNameByOwner = new Map((users ?? []).map((u) => [u.name, u.full_name || u.name]))
    owners.value = ownerNames
      .map((name) => ({ name, label: fullNameByOwner.get(name) ?? name }))
      .sort((a, b) => a.label.localeCompare(b.label))
  } catch (e) {
    error.value = e?.message ?? String(e)
    allRows.value = []
  } finally {
    loading.value = false
  }
}

const tabCounts = computed(() => {
  const counts = {}
  for (const tab of TABS) counts[tab.key] = allRows.value.filter((r) => tabMatches(tab, r.status)).length
  return counts
})

const productOptions = computed(() => [...new Set(allRows.value.map((r) => r.product).filter(Boolean))].sort())
const branchOptions = computed(() => [...new Set(allRows.value.map((r) => r.branch).filter(Boolean))].sort())

const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase()
  return allRows.value.filter((r) => {
    if (!tabMatches(TABS.find((t) => t.key === activeTab.value), r.status)) return false
    if (filterProduct.value !== 'All' && r.product !== filterProduct.value) return false
    if (filterBranch.value !== 'All' && r.branch !== filterBranch.value) return false
    if (filterOwner.value !== 'All' && r.owner !== filterOwner.value) return false
    if (!withinModifiedRange(r.modified, filterModified.value)) return false
    if (!q) return true
    return (r.name + ' ' + (r.customer_name || '')).toLowerCase().includes(q)
  })
})

function clearAll() {
  search.value = ''
  activeTab.value = 'All'
  filterProduct.value = 'All'
  filterBranch.value = 'All'
  filterOwner.value = 'All'
  filterModified.value = 'any'
  page.value = 1
}

const pageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / PAGE_SIZE)))
const pageRows = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return filteredRows.value.slice(start, start + PAGE_SIZE)
})

function pickTab(key) {
  activeTab.value = key
  page.value = 1
}
function goPage(target) {
  page.value = Math.min(Math.max(1, target), pageCount.value)
}
function open(name) {
  router.push(formRouteFor(DOCTYPE, name))
}
function create() {
  router.push(defaultListActionRouteFor(DOCTYPE) || formRouteFor(DOCTYPE))
}

onMounted(load)
</script>

<template>
  <div style="padding:30px 36px 56px; margin:0 auto;">
    <div
      style="font-size:13px; color:#94A0AE; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:8px;"
    >
      <RouterLink to="/" style="color:#64748B;">Dashboard</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <span style="color:#0B3465;">Quotation</span>
    </div>

    <div style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:14px; margin-bottom:22px;">
      <div>
        <h1 style="margin:0; font-size:26px; font-weight:800; letter-spacing:-.025em;">Quotation</h1>
        <div style="font-size:13.5px; color:#64748B; margin-top:5px;">Live from the Quotation DocType.</div>
      </div>
      <button
        v-if="live"
        @click="create"
        style="display:flex; align-items:center; gap:8px; background:#0B3465; color:#fff; border:none; padding:12px 18px; border-radius:11px; font-size:14.5px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(11,52,101,.28); font-family:inherit;"
        class="hv1"
      >
        <LucideIcon name="plus" /> New Quotation
      </button>
    </div>

    <div
      v-if="!live"
      style="display:flex; align-items:center; gap:14px; background:#EFF6FF; border:1px solid #BFDBFE; border-radius:13px; padding:15px 18px; flex-wrap:wrap;"
    >
      <span style="width:34px; height:34px; border-radius:9px; background:#fff; color:#2563EB; display:flex; align-items:center; justify-content:center; font-size:17px; flex:none;"
        ><LucideIcon name="info" /></span
      >
      <div style="font-size:13px; color:#2563EB;">
        No backend configured. Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to browse records.
      </div>
    </div>

    <template v-else>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          @click="pickTab(tab.key)"
          :style="{
            padding: '9px 16px', borderRadius: '999px', cursor: 'pointer', fontFamily: 'inherit',
            fontSize: '13px', fontWeight: '600', border: 'none',
            background: activeTab === tab.key ? '#0B3465' : '#fff',
            color: activeTab === tab.key ? '#fff' : '#475569',
            boxShadow: activeTab === tab.key ? '0 4px 12px rgba(11,52,101,.25)' : 'inset 0 0 0 1px #E6EBF1'
          }"
        >
          {{ tab.label }} {{ tabCounts[tab.key] ?? 0 }}
        </button>
      </div>

      <div style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:16px; display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:14px; align-items:end; margin-bottom:16px;">
        <div>
          <label style="display:block; font-size:12.5px; font-weight:600; color:#64748B; margin-bottom:6px;">Search</label>
          <div style="position:relative;">
            <span style="position:absolute; left:13px; top:50%; transform:translateY(-50%); color:#94A0AE; font-size:16px;">
              <LucideIcon name="search" />
            </span>
            <input
              v-model="search"
              placeholder="ID or customer"
              style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px 0 38px; font-size:14px; background:#F8FAFC; box-sizing:border-box;"
              @input="page = 1"
            />
          </div>
        </div>

        <div>
          <label style="display:block; font-size:12.5px; font-weight:600; color:#64748B; margin-bottom:6px;">Product</label>
          <select v-model="filterProduct" @change="page = 1" style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px; font-size:13.5px; background:#fff; color:#334155; font-family:inherit; cursor:pointer;">
            <option value="All">All products</option>
            <option v-for="p in productOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>

        <div>
          <label style="display:block; font-size:12.5px; font-weight:600; color:#64748B; margin-bottom:6px;">Branch</label>
          <select v-model="filterBranch" @change="page = 1" style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px; font-size:13.5px; background:#fff; color:#334155; font-family:inherit; cursor:pointer;">
            <option value="All">All branches</option>
            <option v-for="b in branchOptions" :key="b" :value="b">{{ b }}</option>
          </select>
        </div>

        <div>
          <label style="display:block; font-size:12.5px; font-weight:600; color:#64748B; margin-bottom:6px;">Owner</label>
          <select v-model="filterOwner" @change="page = 1" style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px; font-size:13.5px; background:#fff; color:#334155; font-family:inherit; cursor:pointer;">
            <option value="All">All owners</option>
            <option v-for="o in owners" :key="o.name" :value="o.name">{{ o.label }}</option>
          </select>
        </div>

        <div>
          <label style="display:block; font-size:12.5px; font-weight:600; color:#64748B; margin-bottom:6px;">Modified</label>
          <select v-model="filterModified" @change="page = 1" style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px; font-size:13.5px; background:#fff; color:#334155; font-family:inherit; cursor:pointer;">
            <option v-for="range in MODIFIED_RANGES" :key="range.key" :value="range.key">{{ range.label }}</option>
          </select>
        </div>

        <div style="display:flex; align-items:center; gap:12px; height:42px;">
          <button
            @click="clearAll"
            style="background:none; border:none; color:#0B3465; font-size:13.5px; font-weight:700; cursor:pointer; font-family:inherit; padding:0;"
          >
            Clear
          </button>
          <span v-if="loading" style="font-size:13px; color:#94A0AE; font-weight:600;">Loading…</span>
        </div>
      </div>

      <div
        v-if="error"
        style="display:flex; align-items:flex-start; gap:12px; background:#FEF2F2; border:1px solid #FECACA; border-radius:13px; padding:15px 18px; margin-bottom:16px;"
      >
        <span style="color:#DC2626; font-size:17px; flex:none;"><LucideIcon name="x" /></span>
        <div style="min-width:0;">
          <div style="font-size:14.5px; font-weight:700; color:#991B1B;">Could not load Quotation</div>
          <div style="font-size:13px; color:#B91C1C; margin-top:3px; word-break:break-word;">{{ error }}</div>
        </div>
      </div>

      <div style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; overflow:hidden; box-shadow:0 1px 2px rgba(15,23,42,.04);">
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; min-width:700px;">
            <thead>
              <tr style="background:#F8FAFC; border-bottom:1px solid #EAEEF3;">
                <th style="text-align:left; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em;">ID</th>
                <th style="text-align:left; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em;">Customer</th>
                <th style="text-align:left; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em;">Product</th>
                <th style="text-align:left; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em;">Date</th>
                <th style="text-align:right; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em;">Grand Total</th>
                <th style="text-align:left; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em;">Status</th>
                <th style="width:1%; white-space:nowrap; border-bottom:1px solid #EAEEF3;"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in pageRows" :key="r.name" @click="open(r.name)" style="cursor:pointer; border-bottom:1px solid #F1F5F9;" class="hv4">
                <td style="padding:14px 18px; font-weight:700; color:#0F172A;">{{ r.name }}</td>
                <td style="padding:14px 18px; color:#334155;">{{ r.customer_name || r.party_name || '—' }}</td>
                <td style="padding:14px 18px; color:#334155;">{{ r.product || '—' }}</td>
                <td style="padding:14px 18px; color:#334155;">{{ r.transaction_date ? formatDate(r.transaction_date) : '—' }}</td>
                <td style="padding:14px 18px; text-align:right; color:#334155;">{{ money(r.grand_total) }}</td>
                <!-- The costing flow never submits its Quotation — costing_worksheet.py
                     inserts it and marks the *worksheet* "Quoted" — so docstatus is 0 on
                     every row and a Draft/Submitted badge here would be permanent noise.
                     The worksheet-derived pipeline status is the only status this list
                     can meaningfully show. -->
                <td style="padding:14px 18px;">
                  <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <span v-if="r.status" :style="worksheetStatusStyle(r.status)">{{ r.status }}</span>
                    <span v-else style="color:#94A0AE; font-size:13px;">—</span>
                  </div>
                </td>
                <td style="padding:14px 18px; text-align:right; color:#A79C94; white-space:nowrap;">Open →</td>
              </tr>
              <tr v-if="!pageRows.length && !loading">
                <td colspan="7" style="padding:44px 18px; text-align:center; color:#94A0AE; font-size:14px; font-weight:600;">
                  No Quotation records{{ search || activeTab !== 'All' ? ' match this filter' : ' yet' }}.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-top:1px solid #EAEEF3; flex-wrap:wrap; gap:10px;">
          <span style="font-size:13px; color:#64748B;">Showing {{ pageRows.length }} of {{ filteredRows.length }}</span>
          <div style="display:flex; gap:6px; align-items:center;">
            <button
              :disabled="page <= 1"
              @click="goPage(page - 1)"
              :style="{ height:'34px', padding:'0 12px', borderRadius:'9px', border:'1px solid #E6EBF1', background:'#fff', color: page <= 1 ? '#CBD5E1' : '#475569', fontSize:'13.5px', fontWeight:'600', cursor: page <= 1 ? 'not-allowed' : 'pointer', fontFamily:'inherit' }"
            >
              Prev
            </button>
            <span style="font-size:13.5px; color:#64748B; font-weight:600; padding:0 4px;">{{ page }} / {{ pageCount }}</span>
            <button
              :disabled="page >= pageCount"
              @click="goPage(page + 1)"
              :style="{ height:'34px', padding:'0 12px', borderRadius:'9px', border:'1px solid #E6EBF1', background:'#fff', color: page >= pageCount ? '#CBD5E1' : '#475569', fontSize:'13.5px', fontWeight:'600', cursor: page >= pageCount ? 'not-allowed' : 'pointer', fontFamily:'inherit' }"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
