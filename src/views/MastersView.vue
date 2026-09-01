<script setup>
import LucideIcon from '@/components/LucideIcon.vue'

/** Standalone (non-child-table) setup doctypes from the hitech_costing app. */
const MASTERS = [
  { doctype: 'Tank Type', label: 'Tank Types', desc: 'Base tank definitions and their derived labour rates.', icon: 'container', bg: '#EFF6FF', fg: '#2563EB' },
  { doctype: 'Costing Department', label: 'Costing Departments', desc: 'Departments used to group processing costs.', icon: 'building-2', bg: '#F5F3FF', fg: '#7C3AED' },
  { doctype: 'Material Rate', label: 'Material Rates', desc: 'Per-kg material rates used in worksheet costing.', icon: 'coins', bg: '#F0FDF4', fg: '#16A34A' },
  { doctype: 'Paint Make', label: 'Paint Makes', desc: 'Approved paint brands/makes.', icon: 'paintbrush', bg: '#ECFDF5', fg: '#059669' },
  { doctype: 'Paint System Rate', label: 'Paint System Rates', desc: 'Price per sqm by paint make, method and DFT band.', icon: 'palette', bg: '#FEF2F2', fg: '#DC2626' },
  { doctype: 'Order Complexity Question', label: 'Order Complexity Questions', desc: 'Questions used to score order complexity.', icon: 'list-checks', bg: '#F1F5F9', fg: '#475569' },
  { doctype: 'Quotation Term', label: 'Terms & Conditions', desc: 'The Quotation Wizard\'s Terms & Conditions checklist entries.', icon: 'file-check', bg: '#FEFCE8', fg: '#CA8A04' }
]
</script>

<template>
  <div style="padding:30px 36px 56px; margin:0 auto;">
    <div style="margin-bottom:22px;">
      <h1 style="margin:0; font-size:26px; font-weight:800; letter-spacing:-.025em;">Masters</h1>
      <div style="font-size:13.5px; color:#64748B; margin-top:5px;">
        Setup data behind every Costing Worksheet. Scrap rules, processing cost bands and the
        complexity matrices live inside Costing Settings, not here.
      </div>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:18px;">
      <RouterLink
        v-for="m in MASTERS"
        :key="m.doctype"
        :to="`/ui/${m.doctype}`"
        style="text-align:left; background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:22px; cursor:pointer; display:flex; gap:16px; align-items:flex-start; box-shadow:0 1px 2px rgba(15,23,42,.04); color:inherit;"
        class="hv3"
      >
        <div
          :style="{ width:'46px', height:'46px', borderRadius:'12px', background: m.bg, color: m.fg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:'22px', flex:'none' }"
        >
          <LucideIcon :name="m.icon" />
        </div>
        <div>
          <div style="font-size:15.5px; font-weight:700;">{{ m.label }}</div>
          <div style="font-size:13.5px; color:#64748B; margin-top:4px; line-height:1.5;">{{ m.desc }}</div>
        </div>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
a { text-decoration: none; }
</style>
