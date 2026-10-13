/**
 * A custom_ui `Custom UI Dashboard` record, loaded with every figure it needs.
 *
 * `custom_ui.api.get_dashboard` returns the configuration (permission-
 * filtered server-side); the figures are then fetched the way custom_ui's
 * own portal fetches them:
 *  - a computed KPI (Formula / Method) from `custom_ui.api.get_kpi_value`;
 *  - an Aggregate KPI by counting / aggregating its source doctype here;
 *  - a widget by calling its (allow-listed) method with its params.
 * A KPI or widget that fails shows as empty rather than failing the page.
 *
 * Resolves to null when there is no such dashboard (or custom_ui can't serve
 * it), so the caller can fall back to its own built-in page.
 */
import { call } from '@/lib/frappe'
import { db } from '@/lib/frappeDb'

async function aggregateKpi(kpi) {
  const { doctype, method, field, filters } = kpi.frappe ?? {}
  if (!doctype) return { value: null }
  if (!method || method === 'count') return { value: await db.count(doctype, filters ?? []) }
  const rows = await db.get_list(doctype, {
    fields: [`${method}(\`${field}\`) as value`],
    filters: filters ?? [],
    limit_page_length: 1
  })
  return { value: rows?.[0]?.value ?? null }
}

async function kpiFigure(dashboard, kpi) {
  try {
    if (kpi.computed) {
      const out = await call('custom_ui.api.get_kpi_value', { dashboard, kpi_key: kpi.key })
      return { value: out?.value ?? null, badge: out?.badge_text ?? null }
    }
    return await aggregateKpi(kpi)
  } catch {
    return { value: null, badge: null, failed: true }
  }
}

async function widgetData(widget) {
  try {
    return await call(widget.method, widget.params ?? {})
  } catch {
    return null
  }
}

export async function loadCustomDashboard(name) {
  let config
  try {
    config = await call('custom_ui.api.get_dashboard', { name })
  } catch {
    return null
  }
  if (!config) return null

  const kpis = config.kpis ?? []
  const widgets = config.widgets ?? []
  const [figures, data] = await Promise.all([
    Promise.all(kpis.map((kpi) => kpiFigure(name, kpi))),
    Promise.all(widgets.map(widgetData))
  ])
  return {
    config,
    kpis: kpis.map((kpi, i) => ({ ...kpi, ...figures[i] })),
    widgets: widgets.map((widget, i) => ({ ...widget, data: data[i] }))
  }
}
