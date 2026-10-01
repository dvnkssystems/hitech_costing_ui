<script setup>
import { ref, computed, watch } from 'vue'
import { call } from '@/lib/frappe'
import { formRouteFor } from '@/lib/frappeRouting'

const props = defineProps({ frm: { type: Object, required: true }, name: { type: String, required: true } })
const api = 'hitech_costing.hitech_costing.doctype.tank_type.labour_setup.'
const state = ref(null)
const rows = ref([])
const monthlyCost = ref(0)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
let request = 0
const payloadRows = () => rows.value.map(({ name, department_name, impact, no_of_workers, is_active }) => ({
  name, department_name, impact, no_of_workers: Number(no_of_workers), is_active: is_active ? 1 : 0
}))
const dirty = computed(() => state.value && (
  Number(monthlyCost.value) !== Number(state.value.avg_monthly_manpower_cost) ||
  JSON.stringify(payloadRows()) !== JSON.stringify(state.value.departments.map(({ name, department_name, impact, no_of_workers, is_active }) => ({
    name, department_name, impact, no_of_workers: Number(no_of_workers), is_active: is_active ? 1 : 0
  })))
))
const total = computed(() => rows.value.filter(row => row.is_active).reduce((sum, row) => sum + (Number(row.no_of_workers) || 0), 0))
const money = value => Number(value).toLocaleString('en-IN', { maximumFractionDigits: 4 })
const permissions = computed(() => state.value?.permissions ?? {})
const busy = computed(() => loading.value || saving.value)
function accept(data) {
  state.value = data
  rows.value = data.departments.map(row => ({ ...row, is_active: Boolean(row.is_active) }))
  monthlyCost.value = data.avg_monthly_manpower_cost
}
async function load() {
  const ticket = ++request
  const name = props.name
  loading.value = true
  error.value = ''
  notice.value = ''
  state.value = null
  try {
    const data = await call(api + 'get_labour_setup', { tank_type: name })
    if (ticket === request && name === props.name) accept(data)
  } catch (e) {
    if (ticket === request) error.value = e.message || 'Could not load labour setup.'
  } finally {
    if (ticket === request) loading.value = false
  }
}
function addDepartment() {
  rows.value.push({ department_name: '', impact: 'Direct', no_of_workers: 0, is_active: true, can_write: true })
}
async function save() {
  error.value = ''
  notice.value = ''
  if (props.frm.is_dirty?.()) {
    error.value = 'Save the Tank Type changes above before saving labour setup.'
    return
  }
  if (!Number.isFinite(Number(monthlyCost.value)) || Number(monthlyCost.value) < 0) {
    error.value = 'Average monthly cost must be zero or greater.'
    return
  }
  if (rows.value.some(row => !row.department_name.trim() || !Number.isInteger(Number(row.no_of_workers)) || Number(row.no_of_workers) < 0)) {
    error.value = 'Each department needs a name and a whole number of workers, zero or greater.'
    return
  }
  const name = props.name
  saving.value = true
  try {
    const args = { tank_type: name, departments: payloadRows(), expected_version: state.value.version }
    if (Number(monthlyCost.value) !== Number(state.value.avg_monthly_manpower_cost)) args.avg_monthly_manpower_cost = Number(monthlyCost.value)
    const data = await call(api + 'save_labour_setup', args)
    if (name !== props.name) return
    accept(data)
    // Update the existing read-only fields without discarding unsaved form edits.
    for (const [field, value] of Object.entries({ headcount: data.headcount, labour_rate_inr_per_kg: data.derived_rate, labour_basis: data.labour_basis, ...(data.tank_modified ? { modified: data.tank_modified } : {}), ...(data.last_recalculated ? { last_recalculated: data.last_recalculated } : {}) })) {
      props.frm.doc[field] = value
    }
    notice.value = 'Labour setup saved. The calculated rate is updated.'
  } catch (e) {
    if (name === props.name) error.value = e.message || 'Could not save labour setup.'
  } finally {
    saving.value = false
  }
}
watch(() => props.name, load, { immediate: true })
watch(() => props.frm.doc.modified, modified => {
  if (!state.value || modified === state.value.tank_modified || busy.value) return
  if (dirty.value) {
    notice.value = 'Tank Type changed. Discard setup changes and refresh before editing the updated setup.'
  } else {
    load()
  }
})
</script>

<template>
  <section class="labour-panel" aria-labelledby="labour-setup-heading">
    <div class="panel-heading">
      <div><h2 id="labour-setup-heading">Labour setup</h2><p>Manage this product line’s departments and see how its labour rate is calculated.</p></div>
      <button type="button" :disabled="busy" @click="load">{{ dirty ? 'Discard setup changes and refresh' : 'Refresh' }}</button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="success" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">Loading labour setup…</p>
    <template v-if="state">
      <div class="settings-grid">
        <div><span class="label">Production capacity</span><strong>{{ money(state.rated_capacity) }} {{ state.capacity_uom }} / {{ state.capacity_period === 'Annual' ? 'year' : 'month' }}</strong><small>Edit capacity in the Tank Type fields above, then save and refresh.</small></div>
        <label><span class="label">Average monthly cost per worker (₹)</span><input v-model="monthlyCost" type="number" min="0" step="0.01" :disabled="busy || !permissions.settings_write" /><small class="shared-note">Shared across all Tank Types. Changing this recalculates labour rates for all product lines.</small></label>
      </div>
      <div class="table-scroll"><table>
        <thead><tr><th scope="col">Costing Department</th><th scope="col">Impact</th><th scope="col">Workers</th><th scope="col">Active</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody><tr v-for="(row, index) in rows" :key="row.name || `new-${index}`">
          <td>
            <RouterLink v-if="row.name" class="department-link" :to="formRouteFor('Costing Department', row.name)" target="_blank" rel="noopener noreferrer" title="Open Costing Department in a new tab">{{ row.name }}</RouterLink>
            <input v-model="row.department_name" :aria-label="`Department name, row ${index + 1}`" :disabled="busy || !row.can_write" />
          </td>
          <td><select v-model="row.impact" :aria-label="`Impact, row ${index + 1}`" :disabled="busy || !row.can_write"><option>Direct</option><option>Indirect</option></select></td>
          <td><input v-model="row.no_of_workers" type="number" min="0" step="1" :aria-label="`Workers, row ${index + 1}`" :disabled="busy || !row.can_write" /></td>
          <td><input v-model="row.is_active" type="checkbox" :aria-label="`Active, row ${index + 1}`" :disabled="busy || !row.can_write" /></td>
          <td><button v-if="!row.name" type="button" :disabled="busy" @click="rows.splice(index, 1)">Remove</button></td>
        </tr><tr v-if="!rows.length"><td colspan="5">No departments linked to this Tank Type.</td></tr></tbody>
        <tfoot><tr><th colspan="2" scope="row">Total active workers</th><td colspan="3"><strong>{{ total }}</strong></td></tr></tfoot>
      </table></div>
      <p class="hint">Deactivate a department to exclude its workers from the calculation.</p>
      <button v-if="permissions.department_create" type="button" :disabled="busy" @click="addDepartment">Add department</button>
      <div class="rate-grid">
        <div><span class="label">Calculated labour rate</span><strong>₹{{ money(state.derived_rate) }} / kg</strong><small>{{ state.labour_basis }}</small></div>
        <div><span class="label">Client-maintained labour rate</span><strong v-if="!state.can_read_item_price">Requires Item Price read access</strong><strong v-else-if="state.labour_item_rate != null">₹{{ money(state.labour_item_rate) }} / kg</strong><strong v-else>Not set — calculated rate applies</strong><small>A Labour Item Price takes priority over the calculated rate. A worksheet’s manual override takes priority over both.</small></div>
      </div>
      <div class="actions"><small v-if="dirty">Unsaved setup changes. Save to update the calculated rate.</small><button type="button" class="primary" :disabled="busy || !dirty" @click="save">{{ saving ? 'Saving…' : 'Save labour setup' }}</button></div>
    </template>
  </section>
</template>

<style scoped>
.labour-panel { background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:24px; margin:18px 0; color:#334155; }
.panel-heading,.actions { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
h2 { margin:0; font-size:19px; color:#0B3465; } p { font-size:14px; line-height:1.5; }
.settings-grid,.rate-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; margin:22px 0; }
.label { display:block; font-size:13px; font-weight:600; margin-bottom:8px; }
strong { display:block; font-size:16px; } small { display:block; color:#64748B; font-size:12px; line-height:1.5; margin-top:8px; }
.shared-note { color:#92400E; } .table-scroll { overflow:auto; } table { width:100%; border-collapse:collapse; font-size:13px; }
th,td { text-align:left; padding:10px; border-bottom:1px solid #E2E8F0; } th { background:#F8FAFC; } td:nth-child(3) { width:110px; }
input:not([type=checkbox]),select { width:100%; box-sizing:border-box; padding:9px; border:1px solid #CBD5E1; border-radius:6px; font:inherit; color:inherit; background:#fff; }
input:disabled,select:disabled { background:#F8FAFC; } button { padding:9px 14px; background:#fff; border:1px solid #CBD5E1; border-radius:7px; font:inherit; cursor:pointer; }
button:disabled { opacity:.55; cursor:default; } .primary { background:#0B3465; color:white; border-color:#0B3465; }
.hint { color:#64748B; font-size:12px; } .error { color:#991B1B; background:#FEF2F2; padding:12px; border-radius:7px; } .success { color:#065F46; background:#ECFDF5; padding:12px; border-radius:7px; }
.department-link { display:block; margin-bottom:8px; font-weight:600; color:#0B3465; overflow-wrap:anywhere; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); }
@media(max-width:720px) { .settings-grid,.rate-grid { grid-template-columns:1fr; } .labour-panel { padding:16px; } table { min-width:540px; } }
</style>
