<script setup>
/**
 * Read-only review/output screen for a Quotation that's past Draft.
 *
 * `QuotationOpenView` sends every submitted Quotation here instead of the
 * wizard — there is nothing left to edit through the costing flow once it's
 * submitted, but the estimator still needs to see what went out, its
 * approval state, and get to Print. There is no Quotation-level approval
 * workflow (see `frappeRouting.js`'s comment on `CUSTOM_FORM_ROUTES`) — the
 * "approval" shown here is each linked Costing Worksheet's own real `status`
 * (`src/lib/home.js`'s `STATUS_STAGES`), not something invented for this page.
 *
 * Deliberately reads the doc plainly via `db.get_doc` rather than booting a
 * live SDK `frm` — this page never writes, so there is no form lifecycle to
 * manage.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { db } from '@/lib/frappeDb'
import { hasBackend } from '@/lib/frappe'
import { listRouteFor, formRouteFor } from '@/lib/frappeRouting'
import { printRecord } from '@/lib/rowActions'
import { STATUS_STAGES } from '@/lib/home'
import { worksheetStatusStyle } from '@/utils/styles'
import { money, decimal, formatDate } from '@/utils/format'
import LucideIcon from '@/components/LucideIcon.vue'

const props = defineProps({
  name: { type: String, required: true }
})

const live = computed(() => hasBackend)
const loading = ref(true)
const error = ref('')
const doc = ref(null)
const worksheets = ref([])
const termOptions = ref([])

const WORKSHEET_FIELDS = ['name', 'status', 'tank_type', 'total_deal_value']

/** Earliest-pipeline-stage status across every linked worksheet — the
 *  "weakest link" stands in for a per-quotation status, since none exists. */
const aggregateStatus = computed(() => {
  if (!worksheets.value.length) return null
  let best = null
  for (const w of worksheets.value) {
    const idx = STATUS_STAGES.findIndex((s) => s.key === w.status)
    if (idx === -1) continue
    if (best === null || idx < best) best = idx
  }
  return best === null ? null : STATUS_STAGES[best].key
})

function row(label, value) {
  return value === undefined || value === null || value === '' ? null : { label, value }
}

/** A `row()` the template renders as a red warning block instead of a plain
 *  value — for `hitech_exchange_rate_flags`, whose text means "this leg was
 *  costed at ₹0 because a quarter's rate is missing". */
function warningRow(label, value) {
  const r = row(label, value)
  return r ? { ...r, warning: true } : null
}

/** The quote's own currency (`currency` on the Quotation, INR unless the
 *  wizard's currency picker chose otherwise) and the freight master's
 *  (`hitech_freight_currency`, what the CIF/DAP native legs are priced in) —
 *  every native-currency amount below is formatted with its own code, never
 *  a hardcoded ₹. */
const quoteCurrency = computed(() => String(doc.value?.currency || 'INR').toUpperCase())
const freightCurrency = computed(() => String(doc.value?.hitech_freight_currency || quoteCurrency.value).toUpperCase())

const orderRows = computed(() => {
  if (!doc.value) return []
  const d = doc.value
  return [
    row('Customer', d.customer_name || d.party_name),
    row('Company', d.company),
    row('Order type', d.order_type),
    row('Currency', d.currency),
    row(
      'Conversion rate',
      d.conversion_rate && quoteCurrency.value !== 'INR' ? `1 ${quoteCurrency.value} = ${decimal(d.conversion_rate)} INR` : null
    ),
    row('Date', d.transaction_date ? formatDate(d.transaction_date) : null),
    row('Valid till', d.valid_till ? formatDate(d.valid_till) : null)
  ].filter(Boolean)
})

const itemRows = computed(() => {
  const items = doc.value?.items ?? []
  return items.map((it) => ({
    key: it.name ?? it.item_code,
    itemCode: it.item_code,
    description: it.description,
    qty: it.qty,
    rate: money(it.rate),
    amount: money(it.amount)
  }))
})

const totalsRows = computed(() => {
  if (!doc.value) return []
  const d = doc.value
  return [
    row('Total', d.total !== undefined ? money(d.total) : null),
    row('Discount', d.additional_discount_percentage ? `${decimal(d.additional_discount_percentage)} %` : null),
    row('Net total', d.net_total !== undefined ? money(d.net_total) : null),
    row('Grand total', d.grand_total !== undefined ? money(d.grand_total) : null)
  ].filter(Boolean)
})

const taxRows = computed(() => {
  const taxes = doc.value?.taxes ?? []
  return taxes.map((t) => ({
    key: t.name ?? t.account_head,
    label: t.description || t.account_head,
    rate: t.rate !== undefined ? `${decimal(t.rate)} %` : '—',
    amount: money(t.tax_amount)
  }))
})

const addressRows = computed(() => {
  if (!doc.value) return []
  const d = doc.value
  return [
    row('Billing address', d.customer_address),
    row('Shipping address', d.shipping_address_name)
    // Incoterm/Named place/Port of discharge moved to `eximRows` below —
    // they conceptually belong to Exim now that it exists as its own
    // concept (same split the wizard's ADDRESS_FIELDS/EXIM_FIELDS made).
  ].filter(Boolean)
})

/** Yes/No formatter for the two Check fields — mirrors `row()`'s own
 *  "drop when empty" contract, but a Check field is `0`/`1` (never blank),
 *  so this only ever returns 'Yes'/'No', never null. */
function checkRow(label, value) {
  return row(label, Number(value) ? 'Yes' : 'No')
}

/** Mirrors `addressRows` above, one `row()` per `EXIM_FIELDS` entry (see
 *  `hitech_costing/setup/install.py`'s `EXIM_FIELDS`, which this must stay in
 *  sync with) — this hand-built read-only view shares no code with the
 *  wizard, so the field list/labels are duplicated here rather than
 *  imported from `costingWorksheetWizard.js`. */
const eximRows = computed(() => {
  if (!doc.value) return []
  const d = doc.value
  return [
    row('Incoterm', d.incoterm),
    row('Named place', d.named_place),
    row('Region', d.hitech_region),
    row('Country of origin', d.hitech_country_of_origin),
    row('Country of destination', d.hitech_country_of_destination),
    row('Domestic destination', d.hitech_domestic_destination),
    row('Mode of transport', d.hitech_mode_of_transport),
    row('Vehicle type', d.hitech_vehicle_type),
    row('Port of loading', d.hitech_port_of_loading),
    row('Port of discharge', d.hitech_port_of_discharge),
    row('Pre-carriage by', d.hitech_pre_carriage_by),
    row('Place of pre-carrier', d.hitech_place_of_pre_carrier),
    row('Insurance %', d.hitech_insurance_percent ? `${decimal(d.hitech_insurance_percent)} %` : null),
    row('Insurance value', d.hitech_insurance_value ? money(d.hitech_insurance_value) : null),
    row('Insurance cost', d.hitech_insurance_cost ? money(d.hitech_insurance_cost) : null),
    row('Destination inland cost', d.hitech_destination_inland_cost ? money(d.hitech_destination_inland_cost) : null),
    row('Unloading cost at destination', d.hitech_unloading_cost_at_destination ? money(d.hitech_unloading_cost_at_destination) : null),
    row('Import duty / tax', d.hitech_import_duty_tax ? money(d.hitech_import_duty_tax) : null),
    row('Total gross weight (kg)', d.hitech_total_gross_weight_kg ? decimal(d.hitech_total_gross_weight_kg) : null),
    checkRow('Partial shipment', d.hitech_partial_shipment),
    checkRow('Trans-shipment', d.hitech_trans_shipment),
    row('Sector', d.hitech_sector),
    row('Basic freight', d.hitech_basic_freight ? money(d.hitech_basic_freight) : null),
    row('Containers (estimated)', d.hitech_containers_estimated || null),
    row('Containers (override)', d.hitech_containers_override || null),
    row('Containers (applied)', d.hitech_containers_applied || null),
    row('Freight region', d.hitech_freight_region),
    row('Freight rate source', d.hitech_freight_rate_source),
    // `hitech_fob_cost_applied` and `hitech_region_margin_applied` are
    // deliberately absent: they are engine intermediates, not figures anyone
    // quotes from, and showing them here invited the reader to add them to
    // Total freight cost. Total freight cost alone is the freight number
    // (client call, 17 Sep 2026 — off the Exim tab and off this page).
    row('Total freight cost', d.hitech_total_freight_cost ? money(d.hitech_total_freight_cost) : null),
    row('Freight (INR/kg)', d.hitech_freight_inr_per_kg ? decimal(d.hitech_freight_inr_per_kg) : null)
  ].filter(Boolean)
})

/** The "Currency Conversion" section the backend adds after Freight (INR/kg):
 *  the CIF leg and DAP add-on in the freight master's own currency, the
 *  quarter's Currency Exchange Master rate each was converted with, the INR
 *  result, and the item deal value in INR / the quote currency. Empty
 *  figures are skipped like everywhere else on this page — except
 *  `hitech_exchange_rate_flags`, which is the one thing that must NOT be
 *  quietly dropped: it means a leg was costed at ₹0 for want of a rate. */
const currencyRows = computed(() => {
  if (!doc.value) return []
  const d = doc.value
  const fc = freightCurrency.value
  const qc = quoteCurrency.value
  const fx = (value) => (value ? decimal(value) : null)
  return [
    row('Freight currency', d.hitech_freight_currency),
    // The handover leg (EXW/FCA/FOB/FAS) converts under the CIF rate — it has
    // no rate of its own, which is why only three rows appear for it.
    row(`Handover leg (${fc})`, d.hitech_handover_native ? money(d.hitech_handover_native, fc) : null),
    row('Handover exchange rate', fx(d.hitech_handover_exchange_rate)),
    row('Handover leg (INR)', d.hitech_handover_inr ? money(d.hitech_handover_inr) : null),
    row(`CIF leg (${fc})`, d.hitech_cif_leg_native ? money(d.hitech_cif_leg_native, fc) : null),
    row('CIF exchange rate', fx(d.hitech_cif_exchange_rate)),
    row('CIF leg (INR)', d.hitech_cif_leg_inr ? money(d.hitech_cif_leg_inr) : null),
    row(`DAP add-on (${fc})`, d.hitech_dap_addon_native ? money(d.hitech_dap_addon_native, fc) : null),
    row('DAP exchange rate', fx(d.hitech_dap_exchange_rate)),
    row('DAP add-on (INR)', d.hitech_dap_addon_inr ? money(d.hitech_dap_addon_inr) : null),
    row('Item deal value (INR)', d.hitech_item_deal_value_inr ? money(d.hitech_item_deal_value_inr) : null),
    row('Item exchange rate', fx(d.hitech_item_exchange_rate)),
    row(`Item deal value (${qc})`, d.hitech_item_deal_value_fc ? money(d.hitech_item_deal_value_fc, qc) : null),
    warningRow('Exchange rate missing — affected legs costed at ₹0', d.hitech_exchange_rate_flags)
  ].filter(Boolean)
})

const termsRows = computed(() => {
  if (!doc.value) return []
  const all = doc.value.hitech_quotation_terms ?? []
  const selected = all.filter((t) => t.selected)
  const textByTerm = new Map(termOptions.value.map((o) => [o.name, o.term_text]))
  const selectedTexts = selected.map((t) => textByTerm.get(t.term) ?? t.term)
  const rows = [row('Terms selected', selected.length ? `${selected.length} of ${all.length}` : null)]
  if (selectedTexts.length) rows.push(row('Selected terms', selectedTexts.join('; ')))
  rows.push(row('Notes', doc.value.hitech_terms_notes))
  return rows.filter(Boolean)
})

const sections = computed(() =>
  [
    { key: 'order', n: '01', title: 'Customer & Order', rows: orderRows.value },
    { key: 'taxes', n: '02', title: 'Taxes & Charges', rows: [row('Template', doc.value?.taxes_and_charges), ...totalsRows.value.filter(Boolean)].filter(Boolean) },
    { key: 'address', n: '03', title: 'Address & Delivery', rows: addressRows.value },
    { key: 'exim', n: '04', title: 'Exim / Incoterms', rows: eximRows.value },
    { key: 'currency', n: '05', title: 'Currency Conversion', rows: currencyRows.value },
    { key: 'terms', n: '06', title: 'Terms & Conditions', rows: termsRows.value }
  ].filter((s) => s.rows.length)
)

async function load() {
  loading.value = true
  error.value = ''
  doc.value = null
  worksheets.value = []

  if (!live.value) {
    error.value = 'No Frappe backend configured. Set VITE_FRAPPE_URL in .env to view this Quotation.'
    loading.value = false
    return
  }

  try {
    const [d, w, t] = await Promise.all([
      db.get_doc('Quotation', props.name),
      db.get_list('Costing Worksheet', {
        filters: { quotation: props.name },
        fields: WORKSHEET_FIELDS,
        limit_page_length: 0
      }),
      db.get_list('Quotation Term', { fields: ['name', 'term_text'], limit_page_length: 0 })
    ])
    doc.value = d
    worksheets.value = w ?? []
    termOptions.value = t ?? []
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

function onPrint() {
  printRecord('Quotation', props.name)
}

onMounted(load)
watch(() => props.name, load)
</script>

<template>
  <div style="padding:32px 40px 80px; margin:0 auto; max-width:1200px;">
    <div
      style="font-size:13px; color:#94A0AE; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:8px;"
    >
      <RouterLink to="/" style="color:#64748B;">Dashboard</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <RouterLink :to="listRouteFor('Quotation')" style="color:#64748B;">Quotation</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <span style="color:#0B3465;">{{ name }}</span>
    </div>

    <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:22px; flex-wrap:wrap;">
      <div>
        <h1 style="margin:0; font-size:32px; font-weight:800; letter-spacing:-.02em;">{{ name }}</h1>
        <div v-if="doc" style="font-size:14px; color:#64748B; margin-top:6px;">
          {{ doc.customer_name || doc.party_name }} ·
          {{ doc.docstatus === 2 ? 'Cancelled' : doc.docstatus === 1 ? 'Submitted' : 'Draft' }}
        </div>
      </div>
      <span
        v-if="aggregateStatus"
        :style="{ ...worksheetStatusStyle(aggregateStatus), fontSize: '13px', padding: '7px 14px' }"
      >
        {{ aggregateStatus }}
      </span>
    </div>

    <div
      v-if="!live && !loading"
      style="display:flex; align-items:center; gap:14px; background:#EFF6FF; border:1px solid #BFDBFE; border-radius:13px; padding:15px 18px; margin-bottom:18px; flex-wrap:wrap;"
    >
      <span style="width:34px; height:34px; border-radius:9px; background:#fff; color:#2563EB; display:flex; align-items:center; justify-content:center; font-size:17px; flex:none;"
        ><LucideIcon name="info" /></span
      >
      <div style="font-size:13px; color:#2563EB;">
        Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to view this Quotation.
      </div>
    </div>

    <div
      v-if="error"
      style="display:flex; align-items:flex-start; gap:12px; background:#FEF2F2; border:1px solid #FECACA; border-radius:13px; padding:15px 18px; margin-bottom:18px;"
    >
      <span style="color:#DC2626; font-size:17px; flex:none;"><LucideIcon name="x" /></span>
      <div style="min-width:0;">
        <div style="font-size:14.5px; font-weight:700; color:#991B1B;">Could not load {{ name }}</div>
        <div style="font-size:13px; color:#B91C1C; margin-top:3px; word-break:break-word;">{{ error }}</div>
      </div>
    </div>

    <div
      v-if="loading"
      style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:48px; text-align:center; color:#94A0AE; font-size:14px; font-weight:600;"
    >
      Loading…
    </div>

    <template v-if="doc">
      <!-- Approval — one card per linked Costing Worksheet's own real status. -->
      <div v-if="worksheets.length" style="margin-bottom:18px;">
        <div style="font-size:12px; font-weight:700; color:#94A0AE; letter-spacing:.06em; text-transform:uppercase; margin-bottom:10px;">
          Costing approval
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px;">
          <RouterLink
            v-for="w in worksheets"
            :key="w.name"
            :to="formRouteFor('Costing Worksheet', w.name)"
            style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:16px 18px; text-decoration:none; color:inherit; display:block;"
            class="hv4"
          >
            <div style="font-size:13px; font-weight:700; color:#0F172A;">{{ w.name }}</div>
            <div style="font-size:12.5px; color:#64748B; margin-top:2px;">{{ w.tank_type || '—' }}</div>
            <span :style="{ ...worksheetStatusStyle(w.status), marginTop: '8px' }">{{ w.status }}</span>
          </RouterLink>
        </div>
      </div>

      <!-- Items -->
      <div v-if="itemRows.length" style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(38,38,38,.06); margin-bottom:18px;">
        <div style="padding:16px 20px 4px; font-size:18px; font-weight:800; color:#0F172A;">Items</div>
        <table style="width:100%; border-collapse:collapse; font-size:14px; color:#334155;">
          <thead>
            <tr style="background:#F8FAFC;">
              <th style="text-align:left; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Item</th>
              <th style="text-align:left; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Description</th>
              <th style="text-align:right; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Qty</th>
              <th style="text-align:right; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Rate</th>
              <th style="text-align:right; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in itemRows" :key="it.key" style="border-bottom:1px solid #F1F5F9;">
              <td style="padding:11px 20px; font-weight:600; color:#0F172A;">{{ it.itemCode }}</td>
              <td style="padding:11px 20px; color:#64748B;">{{ it.description || '—' }}</td>
              <td style="padding:11px 20px; text-align:right;">{{ it.qty }}</td>
              <td style="padding:11px 20px; text-align:right;">{{ it.rate }}</td>
              <td style="padding:11px 20px; text-align:right; font-weight:700;">{{ it.amount }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="taxRows.length" style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(38,38,38,.06); margin-bottom:18px;">
        <div style="padding:16px 20px 4px; font-size:18px; font-weight:800; color:#0F172A;">Taxes &amp; charges</div>
        <table style="width:100%; border-collapse:collapse; font-size:14px; color:#334155;">
          <thead>
            <tr style="background:#F8FAFC;">
              <th style="text-align:left; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Charge</th>
              <th style="text-align:right; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Rate</th>
              <th style="text-align:right; padding:11px 20px; font-size:12px; font-weight:700; color:#64748B; border-bottom:1px solid #EAEEF3;">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in taxRows" :key="t.key" style="border-bottom:1px solid #F1F5F9;">
              <td style="padding:11px 20px;">{{ t.label }}</td>
              <td style="padding:11px 20px; text-align:right;">{{ t.rate }}</td>
              <td style="padding:11px 20px; text-align:right; font-weight:700;">{{ t.amount }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-for="sec in sections" :key="sec.key" style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:18px 20px; box-shadow:0 2px 8px rgba(38,38,38,.06); margin-bottom:14px;">
        <div style="display:flex; align-items:baseline; gap:12px; border-bottom:1px solid #EAEEF3; padding-bottom:10px;">
          <span style="font-size:13px; font-weight:600; color:#0B3465; font-variant-numeric:tabular-nums;">{{ sec.n }}</span>
          <span style="font-size:18px; font-weight:800; color:#0F172A;">{{ sec.title }}</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px 22px; margin-top:14px;">
          <div
            v-for="r in sec.rows"
            :key="r.label"
            :style="
              r.warning
                ? 'grid-column:1 / -1; display:flex; flex-direction:column; gap:4px; min-width:0; padding:12px 14px; border-radius:8px; border:1px solid #FECACA; background:#FEF2F2;'
                : 'display:flex; flex-direction:column; gap:2px; min-width:0;'
            "
          >
            <span v-if="r.warning" style="display:flex; align-items:center; gap:6px; font-size:12.5px; font-weight:700; color:#991B1B;">
              <LucideIcon name="triangle-alert" /> {{ r.label }}
            </span>
            <span v-else style="font-size:12px; font-weight:600; color:#94A0AE;">{{ r.label }}</span>
            <span :style="r.warning ? 'font-size:13.5px; color:#B91C1C; white-space:pre-line; overflow-wrap:anywhere;' : 'font-size:15px; color:#0F172A; overflow-wrap:anywhere;'">{{ r.value }}</span>
          </div>
        </div>
      </div>

      <div style="display:flex; align-items:center; gap:12px; border-top:1px solid #EAEEF3; padding-top:18px; margin-top:8px;">
        <button
          type="button"
          @click="onPrint"
          style="display:flex; align-items:center; gap:8px; height:44px; padding:0 20px; border-radius:11px; background:#fff; border:1px solid #E2E8F0; font-size:14px; font-weight:600; color:#475569; cursor:pointer; font-family:inherit;"
          class="hv2"
        >
          <LucideIcon name="printer" /> Print
        </button>
        <button
          type="button"
          disabled
          title="Not available yet"
          style="display:flex; align-items:center; gap:8px; height:44px; padding:0 20px; border-radius:11px; background:#F1F5F9; border:1px solid #E2E8F0; font-size:14px; font-weight:600; color:#94A0AE; cursor:not-allowed; font-family:inherit;"
        >
          <LucideIcon name="mail" /> Email — coming soon
        </button>
      </div>
    </template>
  </div>
</template>
