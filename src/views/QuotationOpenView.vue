<script setup>
/**
 * "Open this Quotation" resolver.
 *
 * `frappeRouting.js`'s `CUSTOM_FORM_ROUTES.Quotation` sends every "open a
 * Quotation" action here (list rows, global search, breadcrumbs, a native
 * client script's `frappe.set_route('Form', 'Quotation', name)`) instead of
 * straight to a form. A Draft Quotation was built by the Costing Worksheet
 * wizard and should be resumed there; anything past Draft is already
 * submitted and gets the read-only review screen instead. This page renders
 * nothing lasting — it decides which and replaces itself immediately.
 */
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '@/lib/frappeDb'
import { hasBackend } from '@/lib/frappe'
import { listRouteFor } from '@/lib/frappeRouting'
import LucideIcon from '@/components/LucideIcon.vue'

const props = defineProps({
  name: { type: String, required: true }
})

const router = useRouter()
const live = computed(() => hasBackend)
const error = ref('')

async function resolve() {
  error.value = ''

  if (!live.value) {
    error.value = 'No Frappe backend configured. Set VITE_FRAPPE_URL in .env to open this Quotation.'
    return
  }

  try {
    const result = await db.get_value('Quotation', props.name, 'docstatus')
    const docstatus = result?.docstatus
    if (docstatus === 0) {
      router.replace({ path: '/wizard/costing-worksheet', query: { quotation: props.name } })
    } else {
      router.replace(`/quotation/${encodeURIComponent(props.name)}/review`)
    }
  } catch (e) {
    error.value = e?.message ?? String(e)
  }
}

onMounted(resolve)
watch(() => props.name, resolve)
</script>

<template>
  <div style="padding:30px 36px 80px; margin:0 auto;">
    <div
      style="font-size:13px; color:#94A3B8; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:8px;"
    >
      <RouterLink to="/" style="color:#64748B;">Dashboard</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <RouterLink :to="listRouteFor('Quotation')" style="color:#64748B;">Quotation</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <span style="color:#16A34A;">{{ name }}</span>
    </div>

    <div
      v-if="error"
      style="display:flex; align-items:flex-start; gap:12px; background:#FEF2F2; border:1px solid #FECACA; border-radius:13px; padding:15px 18px;"
    >
      <span style="color:#DC2626; font-size:17px; flex:none;"><LucideIcon name="x" /></span>
      <div style="min-width:0;">
        <div style="font-size:14.5px; font-weight:700; color:#991B1B;">Could not open {{ name }}</div>
        <div style="font-size:13px; color:#B91C1C; margin-top:3px; word-break:break-word;">{{ error }}</div>
      </div>
    </div>

    <div
      v-else
      style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:48px; text-align:center; color:#94A3B8; font-size:14px; font-weight:600;"
    >
      Opening {{ name }}…
    </div>
  </div>
</template>
