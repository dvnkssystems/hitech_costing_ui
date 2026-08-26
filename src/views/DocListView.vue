<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { hasBackend } from '@/lib/frappe'
import { formRouteFor, defaultListActionRouteFor } from '@/lib/frappeRouting'
import { seedPendingDoc } from '@/lib/mappedDoc'
import {
  fetchDocTypeMeta,
  fetchDocList,
  listColumns,
  formatCell,
  parseListFilters,
  describeFilter,
  LIST_PAGE_SIZE
} from '@/lib/docList'
import {
  fetchListLayout,
  fetchLayoutList,
  fetchListStats,
  defaultSelections,
  isMetric,
  orderByFor,
  badgeStyle
} from '@/lib/listLayout'
import LucideIcon from '@/components/LucideIcon.vue'
import RowActions from '@/components/RowActions.vue'
import { printRecord } from '@/lib/rowActions'
import { call } from '@/lib/frappe'
import { msgprint } from '@frappe-vue-sdk/vue'

/**
 * A list view for any DocType.
 *
 * The SDK renders forms, not lists, so this is the app's own — enough to browse
 * records and open or create one. Query params become filters, which is how a
 * connection tile hands off ("show me the Transportation rows for this job").
 *
 * Columns come from the DocType's `Custom UI List Layout` when one exists, and
 * from its meta when it does not. The stored layout wins because it is the only
 * one of the two an administrator can change without a deploy.
 */
const props = defineProps({ doctype: { type: String, required: true } })

const router = useRouter()
const route = useRoute()

const layout = ref(null)
const columns = ref([])
const selections = ref({})
const stats = ref({})
const rows = ref([])
const total = ref(0)
const exactTotal = ref(true)
const loading = ref(false)
const error = ref('')
const search = ref('')
const page = ref(1)

const live = computed(() => hasBackend)

/** Configured when a layout is stored, the module default otherwise. */
const pageSize = computed(() => layout.value?.settings?.page_length || LIST_PAGE_SIZE)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

/**
 * A layout is free to list `name` as a column of its own. When it does, the
 * standing ID column would be a duplicate of it, so it stands down and the
 * layout's column becomes the one that opens the record.
 */
const hasNameColumn = computed(() => columns.value.some((col) => col.fieldname === 'name'))

const filterGroups = computed(() => layout.value?.filter_groups ?? [])

/**
 * Frappe Number Cards linked to this layout. They carry their own function,
 * filters and currency, so one built for a dashboard renders here unchanged.
 */
const cards = computed(() => layout.value?.cards ?? [])
const selectedCard = ref('')

function cardValue(card) {
  const value = stats.value?.cards?.[card.name]
  if (value === undefined || value === null) return '—'

  // A Count is a tally; every other function is a quantity, and the card says
  // in which currency.
  if (card.function === 'Count') return Number(value).toLocaleString()

  const amount = card.show_full_number
    ? Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : formatCell(value, 'Currency')

  return card.currency ? `${card.currency} ${amount}` : amount
}

/** Only a card marked as a filter toggles; the rest are read-only metrics. */
function pickCard(card) {
  if (!card.acts_as_filter) return
  selectedCard.value = selectedCard.value === card.name ? '' : card.name
  page.value = 1
  load()
}

const cardGroups = computed(() =>
  filterGroups.value.filter((g) => g.display === 'Cards' || g.display === 'Cards and Chips')
)
const chipGroups = computed(() =>
  filterGroups.value.filter((g) => g.display === 'Chips' || g.display === 'Cards and Chips')
)
const dropdownGroups = computed(() => filterGroups.value.filter((g) => g.display === 'Dropdown'))

/** A metric card shows a number but is not one of the choices. */
const choicesOf = (group) => group.options.filter((option) => !isMetric(option))

const statFor = (group, option) => stats.value?.groups?.[group.key]?.[option.key]

function statText(group, option) {
  const value = statFor(group, option)
  if (value === undefined) return ''
  return isMetric(option)
    ? formatCell(value, 'Currency')
    : Number(value).toLocaleString()
}

function choose(group, optionKey) {
  selections.value = { ...selections.value, [group.key]: optionKey }
  page.value = 1
  load()
}

/**
 * Everything except our own params is treated as a field filter.
 *
 * Values may carry an operator (`<2026-07-31`, `~notset`, `!=Billed`) so a
 * dashboard tile can link straight to the list it counted — see
 * parseListFilters in src/lib/docList.js.
 */
const filters = computed(() => parseListFilters(route.query))

const filterSummary = computed(() =>
  filters.value.map((filter) => describeFilter(filter))
)

const emptyMessage = computed(
  () =>
    layout.value?.settings?.empty_state_message ||
    `No ${props.doctype} records${filterSummary.value.length ? ' match this filter' : ' yet'}.`
)

/**
 * Heading, subtitle and create button, from the layout when it defines them.
 *
 * Falling back to the DocType name keeps every unmapped DocType browsable, which
 * is the same bargain the column list makes.
 */
const chrome = computed(() => ({
  title: layout.value?.chrome?.title || props.doctype,
  subtitle: layout.value?.chrome?.subtitle || `Live from the ${props.doctype} DocType.`,
  actionLabel: layout.value?.chrome?.primary_action_label || `New ${props.doctype}`,
  actionRoute: layout.value?.chrome?.primary_action_route || defaultListActionRouteFor(props.doctype),
  searchPlaceholder: layout.value?.chrome?.search_placeholder || `Search ${props.doctype} by ID…`
}))

/**
 * Bumped on every call so a load that is still in flight when the doctype (or
 * any other input) changes again can tell it has been superseded. Without
 * this, two overlapping calls — the tail of the one for the doctype just
 * navigated away from, and the fresh one for the doctype just navigated to —
 * write to the same `columns`/`layout`/`rows` refs in whichever order their
 * network calls happen to resolve. The stale call would then send the *new*
 * doctype's query using the *old* doctype's field names (or vice versa),
 * which the server correctly rejects with "Field not permitted in query".
 */
let loadRequest = 0

async function load() {
  if (!live.value) return
  const requestId = ++loadRequest
  // Snapshot once: `props.doctype` can change again while this call is still
  // awaiting a response, and every use below must stay pinned to the doctype
  // this particular call started for.
  const doctype = props.doctype
  loading.value = true
  error.value = ''
  try {
    let columnsForRequest = columns.value
    let layoutForRequest = layout.value

    if (!columnsForRequest.length) {
      const stored = await fetchListLayout(doctype)
      if (requestId !== loadRequest) return // superseded while awaiting
      layoutForRequest = stored.fallback ? null : stored
      columnsForRequest = stored.fallback
        ? listColumns(await fetchDocTypeMeta(doctype))
        : stored.columns
      if (requestId !== loadRequest) return // superseded while awaiting
      layout.value = layoutForRequest
      columns.value = columnsForRequest
      selections.value = defaultSelections(stored.filter_groups)
    }

    // The stored layout projects server-side; without one the client still has
    // to name the fields it wants.
    const result = layoutForRequest
      ? await fetchLayoutList(doctype, {
          filters: filters.value,
          selections: selections.value,
          card: selectedCard.value,
          search: search.value,
          page: page.value,
          pageSize: pageSize.value,
          orderBy: orderByFor(layoutForRequest)
        })
      : await fetchDocList(doctype, {
          columns: columnsForRequest,
          filters: filters.value,
          search: search.value,
          page: page.value
        })

    if (requestId !== loadRequest) return // superseded while awaiting

    rows.value = result.rows
    total.value = result.total
    exactTotal.value = result.exactTotal

    // Independent of the selection, so it rides along rather than blocking.
    if (filterGroups.value.length || cards.value.length) {
      fetchListStats(doctype, { filters: filters.value, search: search.value }).then((fresh) => {
        if (requestId === loadRequest) stats.value = fresh
      })
    }
  } catch (e) {
    if (requestId !== loadRequest) return // superseded — a newer load owns the error state now
    error.value = e?.message ?? String(e)
    rows.value = []
    total.value = 0
  } finally {
    if (requestId === loadRequest) loading.value = false
  }
}

let searchTimer = null
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    load()
  }, 300)
})

// A different doctype means a different layout and different columns.
watch(
  () => props.doctype,
  () => {
    layout.value = null
    columns.value = []
    page.value = 1
    load()
  }
)
watch(filters, () => {
  page.value = 1
  load()
})

function open(name) {
  router.push(formRouteFor(props.doctype, name))
}

/* ── Row actions ──────────────────────────────────────────────────────────
 * Configured on the layout; a layout that defines none still gets a single
 * Open button, so no list is ever a table you cannot open.
 */

const busyAction = ref('')

const rowActions = computed(
  () => layout.value?.row_actions ?? [{ label: 'Open', icon: 'eye', action_type: 'Open', color: 'slate' }]
)

/** Hide a button whose Show When condition does not hold for this row. */
function matches(condition, row) {
  if (!condition) return true
  const [field, operator, expected] = condition
  const actual = row[field]

  if (operator === '=') return String(actual ?? '') === String(expected ?? '')
  if (operator === '!=') return String(actual ?? '') !== String(expected ?? '')
  if (operator === 'is set') return actual !== null && actual !== undefined && actual !== ''
  if (operator === 'is not set') return actual === null || actual === undefined || actual === ''
  return true
}

const actionsFor = (row) =>
  rowActions.value
    .map((action, index) => ({ ...action, index, key: `${index}`, busy: busyAction.value === `${row.name}:${index}` }))
    .filter((action) => matches(action.depends_on, row))

async function runAction(action, row) {
  if (action.action_type === 'Open') return open(row.name)

  if (action.action_type === 'Print') return printRecord(props.doctype, row.name)

  if (action.action_type === 'Route') {
    return router.push(action.route.replaceAll('{name}', encodeURIComponent(row.name)))
  }

  if (action.confirm && !window.confirm(`${action.label}?`)) return

  busyAction.value = `${row.name}:${action.index}`
  try {
    // The index goes to the server, not a method path — the layout decides what
    // actually runs.
    await call('custom_ui.api.run_action', { doctype: props.doctype, index: action.index, name: row.name })
    await load()
  } catch (e) {
    msgprint(e?.message ?? String(e), action.label)
  } finally {
    busyAction.value = ''
  }
}

/**
 * New records inherit whatever the list is filtered by.
 *
 * Only plain equality carries over: "eta_date before today" or "ata_date not
 * set" describe a range, not a value a new document could be prefilled with.
 */
function create() {
  const defaults = Object.fromEntries(
    filters.value.filter(([, op]) => op === '=').map(([field, , value]) => [field, value])
  )
  if (Object.keys(defaults).length) {
    seedPendingDoc(props.doctype, { doctype: props.doctype, ...defaults })
  }
  // A layout may send creation to a bespoke form (`/quotes/new`) rather than
  // the generic one.
  router.push(chrome.value.actionRoute || formRouteFor(props.doctype))
}

function goPage(target) {
  const next = Math.min(Math.max(1, target), pageCount.value)
  if (next === page.value) return
  page.value = next
  load()
}

const clearFilters = () => router.replace({ path: route.path })

onMounted(load)
</script>

<template>
  <div style="padding:30px 36px 56px; margin:0 auto;">
    <div
      style="font-size:13px; color:#94A3B8; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:8px;"
    >
      <RouterLink to="/" style="color:#64748B;">Home</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <span style="color:#F97316;">{{ doctype }}</span>
    </div>

    <div
      style="display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:14px; margin-bottom:22px;"
    >
      <div>
        <h1 style="margin:0; font-size:26px; font-weight:800; letter-spacing:-.025em;">{{ chrome.title }}</h1>
        <div style="font-size:13.5px; color:#64748B; margin-top:5px;">
          {{ chrome.subtitle }}
        </div>
      </div>
      <button
        v-if="live"
        @click="create"
        style="display:flex; align-items:center; gap:8px; background:#F97316; color:#fff; border:none; padding:12px 18px; border-radius:11px; font-size:14.5px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(249,115,22,.28); font-family:inherit;"
        class="hv1"
      >
        <span style="font-size:17px;"><LucideIcon name="plus" /></span> {{ chrome.actionLabel }}
      </button>
    </div>

    <div
      v-if="!live"
      style="display:flex; align-items:center; gap:14px; background:#EFF6FF; border:1px solid #BFDBFE; border-radius:13px; padding:15px 18px; flex-wrap:wrap;"
    >
      <span
        style="width:34px; height:34px; border-radius:9px; background:#fff; color:#2563EB; display:flex; align-items:center; justify-content:center; font-size:17px; flex:none;"
        ><LucideIcon name="info" /></span
      >
      <div style="font-size:13px; color:#2563EB;">
        No backend configured. Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to browse records.
      </div>
    </div>

    <template v-else>
      <!-- Frappe Number Cards. Only those marked as filters are clickable. -->
      <div
        v-if="cards.length"
        style="display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin-bottom:16px;"
      >
        <component
          v-for="card in cards"
          :key="card.name"
          :is="card.acts_as_filter ? 'button' : 'div'"
          @click="pickCard(card)"
          :style="{
            background: '#fff',
            border: `1px solid ${selectedCard === card.name ? '#F97316' : '#EAEEF3'}`,
            boxShadow: selectedCard === card.name ? '0 0 0 3px rgba(249,115,22,.12)' : 'none',
            borderRadius: '14px',
            padding: '16px 18px',
            textAlign: 'left',
            fontFamily: 'inherit',
            cursor: card.acts_as_filter ? 'pointer' : 'default'
          }"
        >
          <div style="font-size:12.5px; color:#64748B; font-weight:600;">{{ card.label }}</div>
          <div
            :style="{ fontSize:'22px', fontWeight:'800', marginTop:'4px', color: card.color || '#0F172A' }"
          >
            {{ cardValue(card) }}
          </div>
        </component>
      </div>

      <!-- Stat cards. A metric (Sum) shows its number but is not a choice. -->
      <div
        v-for="group in cardGroups"
        :key="`cards-${group.key}`"
        style="display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin-bottom:16px;"
      >
        <component
          v-for="option in group.options"
          :key="option.key"
          :is="isMetric(option) ? 'div' : 'button'"
          :title="option.hint || ''"
          @click="isMetric(option) ? null : choose(group, option.key)"
          :style="{
            background: '#fff',
            border: `1px solid ${selections[group.key] === option.key ? '#F97316' : '#EAEEF3'}`,
            boxShadow: selections[group.key] === option.key ? '0 0 0 3px rgba(249,115,22,.12)' : 'none',
            borderRadius: '14px',
            padding: '16px 18px',
            textAlign: 'left',
            fontFamily: 'inherit',
            cursor: isMetric(option) ? 'default' : 'pointer'
          }"
        >
          <div style="font-size:12.5px; color:#64748B; font-weight:600;">{{ option.label }}</div>
          <div
            :style="{ fontSize: '22px', fontWeight: '800', marginTop: '4px', color: badgeStyle(option.color).color }"
          >
            {{ statText(group, option) || '—' }}
          </div>
        </component>
      </div>

      <div
        style="background:#fff; border:1px solid #EAEEF3; border-radius:14px; padding:14px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:16px;"
      >
        <div style="position:relative; flex:1; min-width:220px;">
          <span style="position:absolute; left:13px; top:50%; transform:translateY(-50%); color:#94A3B8; font-size:16px;">
            <LucideIcon name="search" />
          </span>
          <input
            v-model="search"
            :placeholder="chrome.searchPlaceholder"
            style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px 0 38px; font-size:14px; background:#F8FAFC;"
          />
        </div>
        <span
          v-for="f in filterSummary"
          :key="f"
          style="display:inline-flex; align-items:center; height:42px; padding:0 12px; border-radius:999px; background:#FFF7ED; color:#EA580C; font-size:12.5px; font-weight:600;"
          >{{ f }}</span
        >
        <button
          v-if="filterSummary.length"
          @click="clearFilters"
          style="height:42px; padding:0 14px; border-radius:10px; border:1px solid #E6EBF1; background:#fff; color:#475569; font-size:13.5px; font-weight:600; cursor:pointer; font-family:inherit;"
          class="hv2"
        >
          Clear
        </button>
        <select
          v-for="group in dropdownGroups"
          :key="`dd-${group.key}`"
          :value="selections[group.key]"
          @change="choose(group, $event.target.value)"
          style="height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px; font-size:13.5px; background:#fff; color:#334155; font-family:inherit; cursor:pointer;"
        >
          <option v-for="option in choicesOf(group)" :key="option.key" :value="option.key">
            {{ option.label }}
          </option>
        </select>
        <span v-if="loading" style="font-size:13px; color:#94A3B8; font-weight:600;">Loading…</span>
      </div>

      <!-- Chips are the same groups as the cards, drawn as a row of buttons. -->
      <div
        v-for="group in chipGroups"
        :key="`chips-${group.key}`"
        style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px;"
      >
        <button
          v-for="option in choicesOf(group)"
          :key="option.key"
          @click="choose(group, option.key)"
          :title="option.hint || ''"
          :style="{
            padding: '8px 16px',
            borderRadius: '9px',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: '13.5px',
            fontWeight: '600',
            background: selections[group.key] === option.key ? '#0F172A' : '#fff',
            color: selections[group.key] === option.key ? '#fff' : '#475569',
            boxShadow: selections[group.key] === option.key ? 'none' : 'inset 0 0 0 1px #EAEEF3'
          }"
        >
          {{ option.label }}
        </button>
      </div>

      <div
        v-if="error"
        style="display:flex; align-items:flex-start; gap:12px; background:#FEF2F2; border:1px solid #FECACA; border-radius:13px; padding:15px 18px; margin-bottom:16px;"
      >
        <span style="color:#DC2626; font-size:17px; flex:none;"><LucideIcon name="x" /></span>
        <div style="min-width:0;">
          <div style="font-size:14.5px; font-weight:700; color:#991B1B;">Could not load {{ doctype }}</div>
          <div style="font-size:13px; color:#B91C1C; margin-top:3px; word-break:break-word;">{{ error }}</div>
        </div>
      </div>

      <div
        style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; overflow:hidden; box-shadow:0 1px 2px rgba(15,23,42,.04);"
      >
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; min-width:700px;">
            <thead>
              <tr style="background:#F8FAFC; border-bottom:1px solid #EAEEF3;">
                <th v-if="!hasNameColumn" style="text-align:left; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em;">ID</th>
                <th
                  v-for="col in columns"
                  :key="col.fieldname"
                  :style="{ textAlign: col.align || 'left', width: col.width ? `${col.width}px` : undefined, minWidth: col.width ? `${col.width}px` : undefined, padding:'13px 18px', fontSize:'12px', fontWeight:'700', color:'#64748B', letterSpacing:'.04em', textTransform:'uppercase' }"
                >
                  {{ col.label }}
                </th>
                <!-- `width:1%` with nowrap shrinks the column to its content
                     instead of absorbing every spare pixel, which is what left
                     a wide empty band beside the configured columns. It has to
                     size to its content because the number of buttons is
                     configured, not fixed. -->
                <th style="text-align:right; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em; width:1%; white-space:nowrap;">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.name" style="border-bottom:1px solid #F1F5F9;" class="hv4">
                <td v-if="!hasNameColumn" style="padding:14px 18px;">
                  <button
                    @click="open(row.name)"
                    style="background:none; border:none; padding:0; font-family:inherit; font-size:14px; font-weight:700; color:#0F172A; cursor:pointer;"
                    class="hv5"
                  >
                    {{ row.name }}
                  </button>
                </td>
                <td
                  v-for="col in columns"
                  :key="col.fieldname"
                  :style="{ textAlign: col.align || 'left', padding:'14px 18px', fontSize:'14px', color:'#334155' }"
                >
                  <button
                    v-if="col.fieldname === 'name'"
                    @click="open(row.name)"
                    style="background:none; border:none; padding:0; font-family:inherit; font-size:14px; font-weight:700; color:#0F172A; cursor:pointer;"
                    class="hv5"
                  >
                    {{ row.name }}
                  </button>
                  <!-- A Derived column arrives as {label, color}, not a scalar. -->
                  <span
                    v-else-if="col.column_type === 'Derived'"
                    :style="badgeStyle(row[col.fieldname]?.color)"
                  >
                    {{ row[col.fieldname]?.label || '—' }}
                  </span>
                  <template v-else>{{ formatCell(row[col.fieldname], col.fieldtype) }}</template>
                </td>
                <td style="padding:14px 18px; text-align:right; width:1%; white-space:nowrap;">
                  <RowActions :actions="actionsFor(row)" @run="(action) => runAction(action, row)" />
                </td>
              </tr>
              <tr v-if="!rows.length && !loading">
                <td
                  :colspan="columns.length + (hasNameColumn ? 1 : 2)"
                  style="padding:44px 18px; text-align:center; color:#94A3B8; font-size:14px; font-weight:600;"
                >
                  {{ emptyMessage }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-top:1px solid #EAEEF3; flex-wrap:wrap; gap:10px;"
        >
          <span style="font-size:13px; color:#64748B;">
            Showing {{ rows.length }} of {{ total.toLocaleString() }}{{ exactTotal ? '' : '+' }}
          </span>
          <div style="display:flex; gap:6px; align-items:center;">
            <button
              :disabled="page <= 1 || loading"
              @click="goPage(page - 1)"
              :style="{ height:'34px', padding:'0 12px', borderRadius:'9px', border:'1px solid #E6EBF1', background:'#fff', color: page <= 1 ? '#CBD5E1' : '#475569', fontSize:'13.5px', fontWeight:'600', cursor: page <= 1 ? 'not-allowed' : 'pointer', fontFamily:'inherit' }"
            >
              Prev
            </button>
            <span style="font-size:13.5px; color:#64748B; font-weight:600; padding:0 4px;">{{ page }} / {{ pageCount }}</span>
            <button
              :disabled="page >= pageCount || loading"
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

<style scoped>
a {
  text-decoration: none;
}
</style>
