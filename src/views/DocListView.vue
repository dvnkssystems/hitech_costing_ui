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
  listIdentity,
  identityFromRows,
  visibleColumnsFor,
  isNumericFieldtype,
  isTextFieldtype,
  rowIsInactive,
  formatCell,
  parseListFilters,
  LIST_PAGE_SIZE
} from '@/lib/docList'
import { describeListFilter, isDerivedFilter, resolveListFilters } from '@/lib/derivedFilters'
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
import { decimal, integer } from '@/utils/format'
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
 *
 * What the row *leads* with is decided from meta either way (see `listIdentity`
 * in src/lib/docList.js): a DocType named after something a person typed leads
 * with that ID, and a hash-named one leads with its title field and keeps the
 * hash out of the table altogether. This screen renders every Setup/master
 * DocType in the sidebar, so none of that is allowed to be per-DocType code.
 */
const props = defineProps({ doctype: { type: String, required: true } })

const router = useRouter()
const route = useRoute()

const layout = ref(null)
const columns = ref([])
/**
 * Lead column, what to do with `name`, what to search, what marks a row retired.
 *
 * Guessed from meta and then *confirmed against the rows that come back*: meta
 * claims `Order Complexity Question` is named after its question text, and its
 * records are hash-named regardless (see `identityFromRows`). This is what the
 * starting state looks like — and what a DocType with unreadable meta keeps.
 */
const blankIdentity = () => ({
  lead: '',
  nameMode: 'lead',
  nameField: '',
  provisional: false,
  duplicate: '',
  searchFields: [],
  inactive: null,
  orderBy: 'modified desc',
  submittable: false
})

const identity = ref(blankIdentity())
/** Layout + meta settled for the current doctype, so a list that legitimately
 *  has no columns doesn't re-resolve them on every page turn. */
const resolved = ref(false)
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

/** Lead the row with the ID only where the ID means something. */
const showIdColumn = computed(() => !hasNameColumn.value && identity.value.nameMode === 'lead')
/** Generated but quotable (a naming series): a muted chip at the row's end. */
const showIdChip = computed(() => !hasNameColumn.value && identity.value.nameMode === 'chip')

/**
 * `columns` minus the one the ID cell has been *shown* to repeat.
 *
 * The suppression is confirmed from data, never inferred from `autoname`:
 * dropping the question text because meta claimed the hash *was* the question
 * text is the one failure this screen must not have.
 */
const visibleColumns = computed(() =>
  visibleColumnsFor(columns.value, identity.value, { idColumnShown: showIdColumn.value })
)

/**
 * Which cell carries the record's identity, and so gets the heavier type.
 * The ID column when there is one, the meta's lead field otherwise, and
 * failing both the first column — a row always has one anchor.
 */
const leadKey = computed(() => {
  if (showIdColumn.value || hasNameColumn.value) return 'name'
  const lead = identity.value.lead
  if (lead && visibleColumns.value.some((col) => col.fieldname === lead)) return lead
  return visibleColumns.value[0]?.fieldname ?? 'name'
})

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
  if (card.function === 'Count') return integer(value)

  // `show_full_number` only means "don't abbreviate" — the precision is the
  // site's currency precision either way (see utils/format).
  const amount = card.show_full_number ? decimal(value) : formatCell(value, 'Currency')

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
  return isMetric(option) ? formatCell(value, 'Currency') : integer(value)
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
  filters.value.map((filter) => describeListFilter(props.doctype, filter))
)

const filtered = computed(() => filterSummary.value.length > 0 || Boolean(search.value.trim()))

const emptyMessage = computed(
  () =>
    layout.value?.settings?.empty_state_message ||
    (filtered.value
      ? 'Nothing matches what you are looking for.'
      : `No ${props.doctype} records yet.`)
)

/**
 * What the heading's second line says.
 *
 * It used to read "Live from the … DocType", which tells the reader something
 * only a developer wanted to know. A count is the one fact that changes with
 * what they just did.
 */
const countLine = computed(() => {
  if (loading.value && !rows.value.length) return 'Loading…'
  if (!total.value) return filtered.value ? 'No matching records' : 'No records yet'
  const suffix = exactTotal.value ? '' : '+'
  const noun = total.value === 1 ? 'record' : 'records'
  return `${integer(total.value)}${suffix} ${noun}${filtered.value ? ' matching this filter' : ''}`
})

/** "Search by Question…" — never "by ID", which nobody can type. */
const searchPlaceholder = computed(() => {
  const labels = identity.value.searchFields.slice(0, 2).map((f) => f.label)
  if (!labels.length) return `Search ${props.doctype}…`
  return `Search by ${labels.join(' or ')}…`
})

/**
 * Heading, subtitle and create button, from the layout when it defines them.
 *
 * Falling back to the DocType name keeps every unmapped DocType browsable, which
 * is the same bargain the column list makes.
 */
const chrome = computed(() => ({
  title: layout.value?.chrome?.title || props.doctype,
  subtitle: layout.value?.chrome?.subtitle || countLine.value,
  // The heading already names the DocType, so the button does not have to
  // ("+ New Order Complexity Question" was wider than the column it created).
  actionLabel: layout.value?.chrome?.primary_action_label || 'New',
  actionRoute: layout.value?.chrome?.primary_action_route || defaultListActionRouteFor(props.doctype),
  searchPlaceholder: layout.value?.chrome?.search_placeholder || searchPlaceholder.value
}))

/* ── Cells ────────────────────────────────────────────────────────────────── */

/** Numbers right, everything else left, unless the layout says otherwise. */
const alignOf = (col) => col.align || (isNumericFieldtype(col.fieldtype) ? 'right' : 'left')

/**
 * Text cells get a ceiling so one long question ("No of components in the
 * design (tank, cover, cable box…)") truncates instead of wrapping to two
 * lines and breaking the rhythm of every row below it. The full value is on the
 * cell's `title`.
 */
function maxWidthOf(col) {
  if (col.width) return `${col.width}px`
  if (!isTextFieldtype(col.fieldtype)) return undefined
  return col.fieldname === leadKey.value ? '380px' : '260px'
}

/**
 * What to call this row out loud (the screen-reader label on the row link).
 * A Derived column's value is `{label, color}`, not a string, so it cannot just
 * be read off the row.
 */
function rowLabel(row) {
  const value = row[leadKey.value]
  const text = value && typeof value === 'object' ? value.label : value
  return String(text ?? '').trim() || row.name
}

const cellText = (row, col) => formatCell(row[col.fieldname], col.fieldtype)

/** Only worth a tooltip when there is something a truncation could hide. */
const cellTitle = (row, col) => {
  const text = cellText(row, col)
  return isTextFieldtype(col.fieldtype) && text !== '—' ? text : undefined
}

function textStyle(col, isLead) {
  return {
    display: 'block',
    maxWidth: maxWidthOf(col),
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: isLead ? '700' : '500',
    color: isLead ? '#0F172A' : '#33414F',
    // Equal-width digits, so a right-aligned column of rates lines up decimal
    // point under decimal point rather than drifting with the glyphs.
    fontVariantNumeric: isNumericFieldtype(col.fieldtype) ? 'tabular-nums' : undefined
  }
}

/** Any `Check` column: a pill, green when set, muted when not. */
const checkPill = (value) => badgeStyle(Number(value) ? 'green' : 'grey')

const isInactive = (row) => rowIsInactive(row, identity.value.inactive)

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
    let identityForRequest = identity.value
    let selectionsForRequest = selections.value

    if (!resolved.value) {
      // Meta is wanted either way: the layout decides the columns, meta decides
      // what identifies a row and what the search box looks in. Both are
      // memoised, so this is one round trip per doctype per session.
      const [stored, meta] = await Promise.all([
        fetchListLayout(doctype),
        fetchDocTypeMeta(doctype).catch(() => null)
      ])
      if (requestId !== loadRequest) return // superseded while awaiting

      layoutForRequest = stored.fallback ? null : stored
      columnsForRequest = stored.fallback ? listColumns(meta) : stored.columns
      identityForRequest = listIdentity(meta)
      selectionsForRequest = defaultSelections(stored.filter_groups)
      // Nothing is published to the template yet — see the commit below, which
      // lands the columns, the identity verdict and the rows in one tick.
    }

    // A derived filter (`?costing_status=Quoted` on Quotation) names no real
    // column; it becomes the record names it stands for before anything is
    // asked of the server. Plain filters pass through untouched.
    const serverFilters = await resolveListFilters(doctype, filters.value)
    if (requestId !== loadRequest) return // superseded while awaiting

    // The stored layout projects server-side; without one the client still has
    // to name the fields it wants.
    const result = layoutForRequest
      ? await fetchLayoutList(doctype, {
          filters: serverFilters,
          selections: selectionsForRequest,
          card: selectedCard.value,
          search: search.value,
          page: page.value,
          // Read off the request's own layout: `pageSize` reads `layout.value`,
          // which is deliberately not assigned until the rows are in.
          pageSize: layoutForRequest.settings?.page_length || LIST_PAGE_SIZE,
          orderBy: orderByFor(layoutForRequest)
        })
      : await fetchDocList(doctype, {
          columns: columnsForRequest,
          filters: serverFilters,
          search: search.value,
          page: page.value,
          searchFields: identityForRequest.searchFields,
          // Fetched for the row's own styling, not for a column of its own: a
          // retired row is muted whether or not its flag is on screen.
          extraFields: [
            identityForRequest.inactive?.fieldname,
            // The field meta claims the ID is a copy of. Fetched so
            // `identityFromRows` can check that claim against real rows even
            // when it is not one of the columns.
            identityForRequest.nameField,
            identityForRequest.submittable ? 'docstatus' : null
          ].filter(Boolean),
          orderBy: identityForRequest.orderBy
        })

    if (requestId !== loadRequest) return // superseded while awaiting

    /*
     * One commit, one render. The columns, the verdict on what identifies a row
     * and the rows themselves all land together: publishing the columns earlier
     * would paint a header — with or without an ID column — that the rows could
     * then contradict, which is a visible relayout on every first load. And
     * because the verdict is read off the rows already fetched, confirming it
     * costs no extra request.
     */
    if (!resolved.value) {
      layout.value = layoutForRequest
      columns.value = columnsForRequest
      selections.value = selectionsForRequest
      resolved.value = true
    }
    identity.value = identityFromRows(identityForRequest, result.rows)
    rows.value = result.rows
    total.value = result.total
    exactTotal.value = result.exactTotal

    // Independent of the selection, so it rides along rather than blocking.
    if (filterGroups.value.length || cards.value.length) {
      fetchListStats(doctype, { filters: serverFilters, search: search.value }).then((fresh) => {
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

// A different doctype means a different layout, different columns and a
// different answer to "what identifies a row".
watch(
  () => props.doctype,
  () => {
    layout.value = null
    columns.value = []
    identity.value = blankIdentity()
    resolved.value = false
    rows.value = []
    total.value = 0
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
 * Configured on the layout. A layout that configures none gets no buttons at
 * all now — the whole row opens the record, and the chevron at its end says so
 * — so the column is there for genuinely extra verbs (Print, Approve), not for
 * the one the row already does.
 */

const busyAction = ref('')

const rowActions = computed(() => layout.value?.row_actions ?? [])

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
    filters.value
      // A derived filter is not a field — nothing to prefill a new record with.
      .filter((filter) => filter[1] === '=' && !isDerivedFilter(props.doctype, filter))
      .map(([field, , value]) => [field, value])
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

/** Columns + ID + chevron, for the empty/loading row's colspan. */
const columnCount = computed(
  () => visibleColumns.value.length + (showIdColumn.value ? 1 : 0) + (showIdChip.value ? 1 : 0) + 1
)

/** Placeholder rows, so the first paint is a table rather than a blank card. */
const skeletonRows = computed(() => (loading.value && !rows.value.length ? [0, 1, 2, 3, 4] : []))

/** From the first page's records — the widest a skeleton bar should look. */
const skeletonWidth = (index) => `${[70, 55, 62, 48, 66][index % 5]}%`

onMounted(load)
</script>

<template>
  <div style="padding:30px 36px 56px; margin:0 auto;">
    <div
      style="font-size:13px; color:#94A0AE; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:8px;"
    >
      <RouterLink to="/" style="color:#64748B;">Dashboard</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <span style="color:#0B3465;">{{ doctype }}</span>
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
        :title="`New ${doctype}`"
        style="display:flex; align-items:center; gap:8px; background:#0B3465; color:#fff; border:none; padding:12px 18px; border-radius:11px; font-size:14.5px; font-weight:600; cursor:pointer; box-shadow:0 4px 12px rgba(11, 52, 101, .28); font-family:inherit;"
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
            border: `1px solid ${selectedCard === card.name ? '#0B3465' : '#EAEEF3'}`,
            boxShadow: selectedCard === card.name ? '0 0 0 3px rgba(11, 52, 101, .12)' : 'none',
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
            border: `1px solid ${selections[group.key] === option.key ? '#0B3465' : '#EAEEF3'}`,
            boxShadow: selections[group.key] === option.key ? '0 0 0 3px rgba(11, 52, 101, .12)' : 'none',
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
        style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:14px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:16px;"
      >
        <div style="position:relative; flex:1; min-width:200px;">
          <span style="position:absolute; left:13px; top:50%; transform:translateY(-50%); color:#94A0AE; font-size:16px;">
            <LucideIcon name="search" />
          </span>
          <input
            v-model="search"
            :placeholder="chrome.searchPlaceholder"
            :aria-label="chrome.searchPlaceholder"
            style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:10px; padding:0 12px 0 38px; font-size:14px; background:#F8FAFC;"
          />
        </div>
        <span
          v-for="f in filterSummary"
          :key="f"
          style="display:inline-flex; align-items:center; height:42px; padding:0 12px; border-radius:999px; background:#E9EFF7; color:#0B3465; font-size:12.5px; font-weight:600;"
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
        <span v-if="loading" style="font-size:13px; color:#94A0AE; font-weight:600;">Loading…</span>
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
        style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; overflow:hidden; box-shadow:0 1px 2px rgba(15,23,42,.04);"
      >
        <!-- The table scrolls inside the card at narrow widths; the page itself
             never gains a horizontal scrollbar. -->
        <div style="overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; min-width:560px;">
            <thead>
              <tr style="background:#F8FAFC; border-bottom:1px solid #EAEEF3;">
                <th
                  v-if="showIdColumn"
                  style="text-align:left; padding:13px 18px; font-size:12px; font-weight:700; color:#64748B; letter-spacing:.04em; text-transform:uppercase;"
                >
                  ID
                </th>
                <th
                  v-for="col in visibleColumns"
                  :key="col.fieldname"
                  :style="{ textAlign: alignOf(col), width: col.width ? `${col.width}px` : undefined, minWidth: col.width ? `${col.width}px` : undefined, padding:'13px 18px', fontSize:'12px', fontWeight:'700', color:'#64748B', letterSpacing:'.04em', textTransform:'uppercase', whiteSpace:'nowrap' }"
                >
                  {{ col.label }}
                </th>
                <!-- The ID of a generated-but-quotable name (a naming series)
                     rides at the end, out of the reading path. A hash gets no
                     column at all — it is in the URL of the record it opens. -->
                <th
                  v-if="showIdChip"
                  style="text-align:right; padding:13px 18px; font-size:12px; font-weight:700; color:#94A0AE; letter-spacing:.04em; text-transform:uppercase; width:1%; white-space:nowrap;"
                >
                  ID
                </th>
                <!-- `width:1%` with nowrap shrinks the column to its content
                     instead of absorbing every spare pixel, which is what left
                     a wide empty band beside the configured columns. It has to
                     size to its content because the number of buttons is
                     configured, not fixed. -->
                <th style="width:1%; white-space:nowrap; padding:13px 18px;"></th>
              </tr>
            </thead>
            <tbody>
              <!-- The whole row opens the record; Enter/Space does the same for
                   the keyboard, and `:focus-visible` shows where you are. Row
                   actions stop propagation of their own clicks. -->
              <tr
                v-for="row in rows"
                :key="row.name"
                class="hv4 ht-row"
                tabindex="0"
                role="link"
                :aria-label="`Open ${rowLabel(row)}`"
                :style="{
                  borderBottom: '1px solid #F1F5F9',
                  cursor: 'pointer',
                  opacity: isInactive(row) ? 0.55 : 1
                }"
                @click="open(row.name)"
                @keydown.enter.prevent="open(row.name)"
                @keydown.space.prevent="open(row.name)"
              >
                <td v-if="showIdColumn" style="padding:14px 18px; font-size:14px;">
                  <span :style="textStyle({ fieldname: 'name', fieldtype: 'Data' }, true)" :title="row.name">
                    {{ row.name }}
                  </span>
                </td>
                <td
                  v-for="col in visibleColumns"
                  :key="col.fieldname"
                  :style="{ textAlign: alignOf(col), padding:'14px 18px', fontSize:'14px', color:'#33414F', verticalAlign:'middle' }"
                >
                  <span
                    v-if="col.fieldname === 'name'"
                    :style="textStyle(col, true)"
                    :title="row.name"
                  >
                    {{ row.name }}
                  </span>
                  <!-- A Derived column arrives as {label, color}, not a scalar. -->
                  <span
                    v-else-if="col.column_type === 'Derived'"
                    :style="badgeStyle(row[col.fieldname]?.color)"
                  >
                    {{ row[col.fieldname]?.label || '—' }}
                  </span>
                  <!-- A flag reads as state, not as the word "Yes". -->
                  <span v-else-if="col.fieldtype === 'Check'" :style="checkPill(row[col.fieldname])">
                    {{ Number(row[col.fieldname]) ? 'Yes' : 'No' }}
                  </span>
                  <span
                    v-else
                    :style="textStyle(col, col.fieldname === leadKey)"
                    :title="cellTitle(row, col)"
                  >
                    {{ cellText(row, col) }}
                  </span>
                </td>
                <td
                  v-if="showIdChip"
                  style="padding:14px 18px; text-align:right; width:1%; white-space:nowrap;"
                >
                  <span
                    :title="row.name"
                    style="font-family:var(--ht-font-mono); font-size:11.5px; color:#94A0AE; background:#F4F6F9; border-radius:4px; padding:3px 7px;"
                    >{{ row.name }}</span
                  >
                </td>
                <td style="padding:14px 18px; text-align:right; width:1%; white-space:nowrap;">
                  <div style="display:flex; align-items:center; gap:8px; justify-content:flex-end;">
                    <RowActions
                      v-if="actionsFor(row).length"
                      :actions="actionsFor(row)"
                      @run="(action) => runAction(action, row)"
                    />
                    <span class="ht-row__go" style="color:#C2CBD6; font-size:17px; display:flex;">
                      <LucideIcon name="chevron-right" />
                    </span>
                  </div>
                </td>
              </tr>

              <!-- Loading: the shape of the table, so nothing flashes blank. -->
              <tr v-for="i in skeletonRows" :key="`skel-${i}`" style="border-bottom:1px solid #F1F5F9;">
                <td
                  v-for="c in columnCount"
                  :key="`skel-${i}-${c}`"
                  style="padding:16px 18px;"
                >
                  <span
                    class="ht-skel"
                    :style="{ display:'block', height:'10px', borderRadius:'5px', width: skeletonWidth(c) }"
                  />
                </td>
              </tr>

              <tr v-if="!rows.length && !loading">
                <td :colspan="columnCount" style="padding:40px 18px 44px; text-align:center;">
                  <span
                    style="width:42px; height:42px; border-radius:11px; background:#F4F6F9; color:#94A0AE; display:inline-flex; align-items:center; justify-content:center; font-size:19px;"
                  >
                    <LucideIcon :name="filtered ? 'search' : 'inbox'" />
                  </span>
                  <div style="font-size:14.5px; font-weight:700; color:#5E6B7A; margin-top:12px;">
                    {{ emptyMessage }}
                  </div>
                  <div style="margin-top:12px; display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
                    <button
                      v-if="filterSummary.length"
                      @click="clearFilters"
                      style="height:36px; padding:0 14px; border-radius:9px; border:1px solid #E6EBF1; background:#fff; color:#475569; font-size:13.5px; font-weight:600; cursor:pointer; font-family:inherit;"
                      class="hv2"
                    >
                      Clear filter
                    </button>
                    <button
                      @click="create"
                      style="height:36px; padding:0 14px; border-radius:9px; border:1px solid #0B3465; background:#fff; color:#0B3465; font-size:13.5px; font-weight:700; cursor:pointer; font-family:inherit;"
                      class="hv10"
                    >
                      New {{ doctype }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          v-if="rows.length || total"
          style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-top:1px solid #EAEEF3; flex-wrap:wrap; gap:10px;"
        >
          <span style="font-size:13px; color:#64748B;">
            Showing {{ rows.length }} of {{ integer(total) }}{{ exactTotal ? '' : '+' }}
          </span>
          <div v-if="pageCount > 1" style="display:flex; gap:6px; align-items:center;">
            <button
              :disabled="page <= 1 || loading"
              @click="goPage(page - 1)"
              :style="{ height:'34px', padding:'0 12px', borderRadius:'9px', border:'1px solid #E6EBF1', background:'#fff', color: page <= 1 ? '#CBD5E1' : '#475569', fontSize:'13.5px', fontWeight:'600', cursor: page <= 1 ? 'not-allowed' : 'pointer', fontFamily:'inherit' }"
            >
              Prev
            </button>
            <span style="font-size:13.5px; color:#64748B; font-weight:600; padding:0 4px;">
              Page {{ page }} of {{ pageCount }}
            </span>
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

/* The row is the button, so it needs the focus ring a button would have. */
.ht-row:focus-visible {
  outline: 2px solid var(--ht-navy);
  outline-offset: -2px;
}

/* The chevron is the affordance: muted until the row is under the pointer. */
.ht-row:hover .ht-row__go,
.ht-row:focus-visible .ht-row__go {
  color: var(--ht-navy);
}

.ht-skel {
  background: linear-gradient(90deg, #EDF1F6 25%, #F6F8FB 50%, #EDF1F6 75%);
  background-size: 400% 100%;
  animation: ht-skel-shimmer 1.4s ease-in-out infinite;
}

@keyframes ht-skel-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ht-skel {
    animation: none;
  }
}
</style>
