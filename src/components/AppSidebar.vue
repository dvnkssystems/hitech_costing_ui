<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAppStore } from '@/stores/app'
import { useSessionStore } from '@/stores/session'
import { fetchSidebar } from '@/lib/sidebar'
import { navItemStyle } from '@/utils/styles'
import LucideIcon from './LucideIcon.vue'
import SidebarNodes from './SidebarNodes.vue'
import httLogo from '@/assets/brand/htt-logo.png'

/**
 * Costing masters, hardcoded here rather than server-driven.
 *
 * Every other nav entry comes from `custom_ui.api.get_sidebar` (permission-
 * filtered per user, per the doc comment below) — these don't, because
 * adding them there means a backend `Custom UI Sidebar Item` record this
 * frontend repo has no access to create. Until that exists, list the app's
 * own real setup DocTypes (the same ones `MastersView.vue` links to — not
 * the reference design's fictional "Product Category") so they're reachable
 * without a role check. Move this to the backend list the day someone can
 * add those records; `MASTER_NAV` and `MastersView.vue`'s `MASTERS` would
 * then both want trimming to whichever one place keeps the list.
 *
 * Tank Type / Costing Department / Paint Make / Paint System Rate / DFT
 * Range, and the "Costing Masters" group header itself, were removed from
 * this nav on request — they still exist as DocTypes/routes, just not
 * linked from the sidebar.
 */
const MASTER_NAV = [
  { doctype: 'Order Complexity Question', label: 'Complexity Questions', icon: 'list-checks' },
  { doctype: 'Quotation Term', label: 'Terms & Conditions', icon: 'file-check' },
  { doctype: 'Item Price Master', label: 'Item Price Master', icon: 'tag' },
  { doctype: 'Currency Exchange Master', label: 'Exchange Rates', icon: 'coins' },
  { doctype: 'International Freight Rate Master', label: 'Freight Rates', icon: 'ship' },
  { doctype: 'Container Type', label: 'Container Types', icon: 'container' }
  // Container Fit Plan is a transaction, not a master: it lives under MAIN via
  // the server-side Custom UI Sidebar Item record, next to Quotation.
].map((m) => ({ ...m, route: `/list/${m.doctype}` }))
// Singles (one record each, opened straight on their form). Packing Settings
// sits next to Costing Settings: both are the app's own global knobs.
const SETTINGS_NAV = [
  { label: 'Costing Settings', icon: 'settings', route: '/form/Costing Settings/Costing Settings' },
  { label: 'Packing Settings', icon: 'package', route: '/form/Packing Settings/Packing Settings' }
]
// Same header treatment SidebarNodes.vue uses for a server-driven "Section"
// group (e.g. MAIN) — kept in sync by eye since this one's hardcoded.
const setupHeaderStyle = {
  fontSize: '11px',
  fontWeight: '700',
  color: '#94A0AE',
  letterSpacing: '.08em',
  padding: '14px 10px 8px'
}

const route = useRoute()
const { userName } = storeToRefs(useAppStore())
const session = useSessionStore()
const { userImage } = storeToRefs(session)

/**
 * Most of the nav comes from `Custom UI Sidebar Item` records (the
 * `MASTER_NAV`/`SETTINGS_NAV` block above is the one hardcoded exception).
 *
 * What used to live here as MAIN_LINKS / REPORTS / EXTERNAL_LINKS is data, and
 * the permission filtering that went with it is gone: `get_sidebar()` applies
 * role gates, DocType read access and report permissions on the server and
 * returns only what this user may see. One request replaces the old
 * per-DocType `has_permission` fan-out.
 */
const items = ref([])
const sidebarError = ref('')

async function loadSidebar() {
  const { items: next, error } = await fetchSidebar()
  items.value = next
  sidebarError.value = error
}

onMounted(loadSidebar)

// Signing in as somebody else changes the answers.
watch(() => session.user, loadSidebar)

// Only the profile card still needs this; entries own their own highlight.
const activeNav = computed(() => route.meta.nav)

// `route.path` comes back percent-encoded ("/list/Tank%20Type"); every
// doctype name here has a space, so this needs decoding to ever match —
// see `SidebarNodes.vue`'s own note on the same issue for report names.
const isMasterActive = (nav) => decodeURIComponent(route.path) === nav.route

// Prefer the signed-in Frappe user; fall back to the seeded demo identity when
// there is no backend to ask.
const displayName = computed(() => session.displayName || userName.value)
// The user id is only worth a second line when it says something the name
// doesn't — "Administrator / Administrator" is just noise.
const subtitle = computed(() => {
  if (!session.isLoggedIn) return 'Costing Team'
  return session.user === displayName.value ? 'Signed in' : session.user
})
const initials = computed(() =>
  session.isLoggedIn
    ? session.initials
    : userName.value
        .split(' ')
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
)
</script>

<template>
  <aside
    style="width:252px; flex:none; background:#fff; border-right:1px solid #EAEEF3; display:flex; flex-direction:column; height:100%;"
  >
    <div style="padding:20px 20px 16px; display:flex; flex-direction:column; gap:6px;">
      <img :src="httLogo" alt="HTT Innovations" style="height:46px; width:auto; display:block;" />
      <div style="font-size:11px; color:#94A0AE; font-weight:600; letter-spacing:.06em;">
        TANK &amp; RADIATOR COSTING
      </div>
    </div>

    <RouterLink
      to="/profile"
      :style="{
        margin: '0 14px 14px',
        padding: '13px',
        borderRadius: '13px',
        background: activeNav === 'profile' ? '#E9EFF7' : '#F4F6F9',
        display: 'flex',
        alignItems: 'center',
        gap: '11px',
        cursor: 'pointer',
        color: 'inherit'
      }"
      class="hv4"
      title="Profile and sign out"
    >
      <img
        v-if="userImage"
        :src="userImage"
        alt=""
        style="width:38px; height:38px; border-radius:50%; object-fit:cover; flex:none;"
      />
      <div
        v-else
        style="width:38px; height:38px; border-radius:50%; background:#0E1B2B; color:#fff; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; flex:none;"
      >
        {{ initials }}
      </div>
      <div style="min-width:0; flex:1;">
        <div style="font-size:13.5px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          {{ displayName }}
        </div>
        <div style="font-size:12px; color:#94A3B8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          {{ subtitle }}
        </div>
      </div>
      <span style="color:#CBD5E1; font-size:16px; flex:none;"><LucideIcon name="chevron-right" /></span>
    </RouterLink>

    <!-- Sections, groups and entries all come from the server; see lib/sidebar.js
         — except Costing Masters/Settings just below, hardcoded for now (see
         the doc comment on MASTER_NAV above). -->
    <nav style="padding:6px 14px; flex:1; overflow-y:auto;">
      <div
        v-if="sidebarError"
        style="margin:14px 4px; padding:10px 12px; border-radius:10px; background:rgba(230,57,70,.1); color:#E63946; font-size:12.5px; line-height:1.45;"
      >
        {{ sidebarError }}
      </div>
      <SidebarNodes :nodes="items" />

      <div :style="setupHeaderStyle">Setup</div>
      <div style="display:flex; flex-direction:column; gap:3px;">
        <RouterLink
          v-for="m in MASTER_NAV"
          :key="m.doctype"
          :to="m.route"
          :style="navItemStyle(isMasterActive(m))"
          :title="m.label"
          class="hv2"
        >
          <span style="font-size:19px;"><LucideIcon :name="m.icon" /></span>
          <span>{{ m.label }}</span>
        </RouterLink>
        <RouterLink
          v-for="s in SETTINGS_NAV"
          :key="s.route"
          :to="s.route"
          :style="navItemStyle(isMasterActive(s))"
          :title="s.label"
          class="hv2"
        >
          <span style="font-size:19px;"><LucideIcon :name="s.icon" /></span>
          <span>{{ s.label }}</span>
        </RouterLink>
      </div>
    </nav>
  </aside>
</template>

<style scoped>
a { text-decoration: none; }
</style>
