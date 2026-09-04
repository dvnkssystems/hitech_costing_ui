import { db } from './frappeDb'

const WORKSHEET_DOCTYPE = 'Costing Worksheet'
const QUOTATION_DOCTYPE = 'Quotation'

const iso = (d) => d.toISOString().slice(0, 10)

function monthBounds(offset = 0) {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
  return { from: iso(start), to: iso(end) }
}

/**
 * `status` is a Select on `Costing Worksheet` with exactly these six states.
 * A Quotation carries no approval status of its own — every screen that
 * needs one (this dashboard, `QuotationListView.vue`, `QuotationOutputView.vue`)
 * derives it as the "weakest link" among the Quotation's linked Costing
 * Worksheets: whichever linked worksheet sits earliest in this list order.
 */
export const STATUS_STAGES = [
  { key: 'Draft', label: 'Draft', color: '#5E6B7A' },
  { key: 'Pending BU Head', label: 'Pending BU Head', color: '#F59E0B' },
  { key: 'Pending CFO', label: 'Pending CFO', color: '#F59E0B' },
  { key: 'Approved', label: 'Approved', color: '#107830' },
  { key: 'Quoted', label: 'Quoted', color: '#107830' },
  { key: 'Lost', label: 'Lost', color: '#E63946' }
]

/** `STATUS_STAGES`, bucketed into the stages a Quotation-facing dashboard
 *  shows — "Pending BU Head"/"Pending CFO" collapse into one "Pending
 *  approval" bucket, and a Quotation with no linked worksheet yet reads as
 *  "Draft" rather than falling out of every bucket. */
export const QUOTATION_PIPELINE_STAGES = [
  { key: 'Draft', label: 'Draft', color: '#5E6B7A', match: (s) => !s || s === 'Draft' },
  {
    key: 'Pending approval',
    label: 'Pending approval',
    color: '#F59E0B',
    match: (s) => s === 'Pending BU Head' || s === 'Pending CFO'
  },
  { key: 'Approved', label: 'Approved', color: '#107830', match: (s) => s === 'Approved' },
  { key: 'Quoted', label: 'Quoted', color: '#107830', match: (s) => s === 'Quoted' },
  { key: 'Lost', label: 'Lost', color: '#E63946', match: (s) => s === 'Lost' }
]

/** Weakest-link worksheet status per Quotation `name`, for however many
 *  `names` are asked for. Shared by every stat below that needs one. */
async function worksheetStatusByQuotation(names) {
  const statusFor = new Map()
  if (!names?.length) return statusFor

  const worksheets = await db.get_list(WORKSHEET_DOCTYPE, {
    fields: ['quotation', 'status'],
    filters: [['quotation', 'in', names]],
    limit_page_length: 0
  })
  for (const w of worksheets ?? []) {
    const idx = STATUS_STAGES.findIndex((s) => s.key === w.status)
    const current = statusFor.get(w.quotation)
    if (!current || (idx !== -1 && idx < current.idx)) statusFor.set(w.quotation, { idx, status: w.status })
  }
  return statusFor
}

/** Month-over-month change in Quotations created, as a percentage. */
async function quotationGrowth() {
  const thisMonth = monthBounds(0)
  const lastMonth = monthBounds(-1)
  const [now, prev] = await Promise.all([
    db.count(QUOTATION_DOCTYPE, { creation: ['between', [thisMonth.from, thisMonth.to]] }),
    db.count(QUOTATION_DOCTYPE, { creation: ['between', [lastMonth.from, lastMonth.to]] })
  ])
  const a = Number(now) || 0
  const b = Number(prev) || 0
  // No baseline means no percentage — report the raw count instead of a
  // meaningless "+100%".
  return { current: a, previous: b, pct: b ? ((a - b) / b) * 100 : null }
}

/**
 * Average `pure_margin_percent` across worksheets that actually reached a
 * real deal — `status === 'Quoted'` with a non-placeholder deal price.
 *
 * `pure_margin_percent` is `(deal_price - total_cost) / deal_price * 100`
 * (see `costing_worksheet.py`'s `_calculate_totals`), guarded only against
 * `deal_price_fg_inr_per_kg` being exactly 0 — not against it being a small
 * placeholder typed in before pricing is finalized. A Draft sheet with a
 * fully built-up cost but a stray `0.5` deal price blows this up to
 * something like -2600%, so restrict to Quoted worksheets and drop any row
 * whose deal price still looks like a placeholder.
 */
async function averageMargin() {
  const rows = await db.get_list(WORKSHEET_DOCTYPE, {
    fields: ['pure_margin_percent', 'deal_price_fg_inr_per_kg'],
    filters: [
      ['status', '=', 'Quoted'],
      [WORKSHEET_DOCTYPE, 'pure_margin_percent', 'is', 'set']
    ],
    limit_page_length: 0
  })
  const MIN_DEAL_PRICE = 1 // INR/kg — below this a deal price reads as an unfinished placeholder, not a real quote
  const values = (rows ?? [])
    .filter((r) => Number(r.deal_price_fg_inr_per_kg) >= MIN_DEAL_PRICE)
    .map((r) => Number(r.pure_margin_percent))
    .filter((n) => Number.isFinite(n))
  if (!values.length) return null
  return values.reduce((sum, n) => sum + n, 0) / values.length
}

/**
 * Every Quotation's derived status, bucketed into `QUOTATION_PIPELINE_STAGES`
 * for the dashboard's pipeline bar, plus the approval breakdown and open-
 * pipeline value the stat cards need alongside it. "Open" excludes only
 * Lost — Draft through Quoted still counts toward it.
 */
async function quotationPipeline() {
  const rows = await db.get_list(QUOTATION_DOCTYPE, {
    fields: ['name', 'grand_total'],
    limit_page_length: 0
  })
  const statusFor = await worksheetStatusByQuotation((rows ?? []).map((r) => r.name))

  const stages = QUOTATION_PIPELINE_STAGES.map((stage) => ({ ...stage, count: 0 }))
  let pendingBuHead = 0
  let pendingCfo = 0
  let openValue = 0
  let openCount = 0

  for (const r of rows ?? []) {
    const status = statusFor.get(r.name)?.status ?? null
    const stage = stages.find((s) => s.match(status))
    if (stage) stage.count += 1
    if (status === 'Pending BU Head') pendingBuHead += 1
    if (status === 'Pending CFO') pendingCfo += 1
    if (status !== 'Lost') {
      openValue += Number(r.grand_total) || 0
      openCount += 1
    }
  }

  const total = stages.reduce((sum, s) => sum + s.count, 0)
  return {
    stages: stages.map((s) => ({ ...s, share: total ? (s.count / total) * 100 : 0 })),
    total,
    pendingApproval: pendingBuHead + pendingCfo,
    pendingBuHead,
    pendingCfo,
    openValue,
    openCount
  }
}

/**
 * Last 5 quotations by modified date, for the Dashboard's recent-quotations
 * table, each carrying its weakest-link status.
 */
async function recentQuotations() {
  const rows = await db.get_list(QUOTATION_DOCTYPE, {
    // `customer` isn't a real field on Quotation — the party is `party_name`
    // (a Dynamic Link; `customer_name` is fetched from it and what's shown).
    fields: ['name', 'customer_name', 'party_name', 'modified'],
    order_by: 'modified desc',
    limit_page_length: 5
  })
  if (!rows?.length) return []

  const statusFor = await worksheetStatusByQuotation(rows.map((r) => r.name))
  return rows.map((r) => ({ ...r, status: statusFor.get(r.name)?.status ?? null }))
}

export async function fetchHomeStats() {
  const [avgMargin, growth, pipeline, recentQuotationRows] = await Promise.all([
    averageMargin(),
    quotationGrowth(),
    quotationPipeline(),
    recentQuotations().catch(() => [])
  ])

  return {
    quotationsThisMonth: growth.current,
    quotationGrowth: growth,
    avgMarginPercent: avgMargin,
    pendingApproval: pipeline.pendingApproval,
    pendingBuHead: pipeline.pendingBuHead,
    pendingCfo: pipeline.pendingCfo,
    openQuotesValue: pipeline.openValue,
    openQuotesCount: pipeline.openCount,
    quotationPipeline: pipeline.stages,
    quotationPipelineTotal: pipeline.total,
    recentQuotations: recentQuotationRows ?? []
  }
}
