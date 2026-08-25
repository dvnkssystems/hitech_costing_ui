<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAppStore } from '@/stores/app'
import { useSessionStore } from '@/stores/session'
import { fetchSidebar } from '@/lib/sidebar'
import LucideIcon from './LucideIcon.vue'
import SidebarNodes from './SidebarNodes.vue'

const route = useRoute()
const { companyName, userName } = storeToRefs(useAppStore())
const session = useSessionStore()
const { userImage } = storeToRefs(session)

/**
 * The whole nav now comes from `Custom UI Sidebar Item` records.
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
    <div style="padding:22px 20px 18px; display:flex; align-items:center; gap:11px;">
      <div
        style="width:38px; height:38px; border-radius:11px; background:#F97316; display:flex; align-items:center; justify-content:center; color:#fff; font-size:21px; box-shadow:0 4px 12px rgba(249,115,22,.3);"
      >
        <LucideIcon name="calculator" />
      </div>
      <div>
        <div style="font-size:16px; font-weight:800; letter-spacing:-.02em; line-height:1;">{{ companyName }}</div>
        <div style="font-size:11px; color:#94A3B8; font-weight:600; letter-spacing:.06em; margin-top:3px;">
          TANK &amp; RADIATOR COSTING
        </div>
      </div>
    </div>

    <!-- Sections, groups and entries all come from the server; see lib/sidebar.js. -->
    <nav style="padding:6px 14px; flex:1; overflow-y:auto;">
      <div
        v-if="sidebarError"
        style="margin:14px 4px; padding:10px 12px; border-radius:10px; background:#FEF2F2; color:#B91C1C; font-size:12.5px; line-height:1.45;"
      >
        {{ sidebarError }}
      </div>
      <SidebarNodes :nodes="items" />
    </nav>

    <RouterLink
      to="/profile"
      :style="{
        margin: '14px',
        padding: '13px',
        borderRadius: '13px',
        background: activeNav === 'profile' ? '#FFF7ED' : '#F6F8FB',
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
        style="width:38px; height:38px; border-radius:50%; background:#0F172A; color:#fff; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; flex:none;"
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
  </aside>
</template>

<style scoped>
a { text-decoration: none; }
</style>
