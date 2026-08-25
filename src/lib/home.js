import { db } from './frappeDb'

const WORKSHEET_DOCTYPE = 'Costing Worksheet'

const iso = (d) => d.toISOString().slice(0, 10)

function monthBounds(offset = 0) {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
  return { from: iso(start), to: iso(end) }
}

/**
 * `status` is a Select on `Costing Worksheet` with exactly these six states,
 * so the pipeline is a straight count per value rather than anything derived.
 */
export const STATUS_STAGES = [
  { key: 'Draft', label: 'Draft', color: '#94A3B8' },
  { key: 'Pending BU Head', label: 'Pending BU Head', color: '#F59E0B' },
  { key: 'Pending CFO', label: 'Pending CFO', color: '#F59E0B' },
  { key: 'Approved', label: 'Approved', color: '#2563EB' },
  { key: 'Quoted', label: 'Quoted', color: '#22C55E' },
  { key: 'Lost', label: 'Lost', color: '#EF4444' }
]

/** Month-over-month change in worksheets created, as a percentage. */
async function worksheetGrowth() {
  const thisMonth = monthBounds(0)
  const lastMonth = monthBounds(-1)
  const [now, prev] = await Promise.all([
    db.count(WORKSHEET_DOCTYPE, { creation: ['between', [thisMonth.from, thisMonth.to]] }),
    db.count(WORKSHEET_DOCTYPE, { creation: ['between', [lastMonth.from, lastMonth.to]] })
  ])
  const a = Number(now) || 0
  const b = Number(prev) || 0
  // No baseline means no percentage — report the raw count instead of a
  // meaningless "+100%".
  return { current: a, previous: b, pct: b ? ((a - b) / b) * 100 : null }
}

/** Average `pure_margin_percent` across worksheets that have one. */
async function averageMargin() {
  const rows = await db.get_list(WORKSHEET_DOCTYPE, {
    fields: ['pure_margin_percent'],
    filters: [[WORKSHEET_DOCTYPE, 'pure_margin_percent', 'is', 'set']],
    limit_page_length: 0
  })
  const values = (rows ?? [])
    .map((r) => Number(r.pure_margin_percent))
    .filter((n) => Number.isFinite(n))
  if (!values.length) return null
  return values.reduce((sum, n) => sum + n, 0) / values.length
}

export async function fetchHomeStats() {
  const [totalWorksheets, draft, pendingBuHead, pendingCfo, approved, quoted, avgMargin, growth, statusPipeline] =
    await Promise.all([
      db.count(WORKSHEET_DOCTYPE, {}),
      db.count(WORKSHEET_DOCTYPE, { status: 'Draft' }),
      db.count(WORKSHEET_DOCTYPE, { status: 'Pending BU Head' }),
      db.count(WORKSHEET_DOCTYPE, { status: 'Pending CFO' }),
      db.count(WORKSHEET_DOCTYPE, { status: 'Approved' }),
      db.count(WORKSHEET_DOCTYPE, { status: 'Quoted' }),
      averageMargin(),
      worksheetGrowth(),
      Promise.all(
        STATUS_STAGES.map(async (stage) => ({
          ...stage,
          count: Number(await db.count(WORKSHEET_DOCTYPE, { status: stage.key }).catch(() => 0)) || 0
        }))
      )
    ])

  const total = Number(totalWorksheets) || 0
  const awaitingApproval = (Number(pendingBuHead) || 0) + (Number(pendingCfo) || 0)
  const approvedQuoted = (Number(approved) || 0) + (Number(quoted) || 0)
  const pipelineTotal = statusPipeline.reduce((sum, s) => sum + s.count, 0)

  return {
    totalWorksheets: total,
    draftWorksheets: Number(draft) || 0,
    awaitingApproval,
    approvedQuoted,
    avgMarginPercent: avgMargin,
    growth,
    statusPipeline: statusPipeline.map((s) => ({
      ...s,
      share: pipelineTotal ? (s.count / pipelineTotal) * 100 : 0
    })),
    pipelineTotal
  }
}
