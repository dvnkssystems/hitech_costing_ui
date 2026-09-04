<script setup>
/**
 * Renders one level of the sidebar tree, recursing into groups.
 *
 * Three renderings, chosen by the record rather than by position:
 *  - Group / Section     — a static header ("MAIN", "EXTERNAL")
 *  - Group / Collapsible — a disclosure ("Reports")
 *  - anything else       — a link, indented once it is inside a disclosure
 *
 * The component references itself by filename, so a Collapsible nested in a
 * Section renders correctly without a flat special case.
 */
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { navItemStyle } from '@/utils/styles'
import { descendants } from '@/lib/sidebar'
import LucideIcon from './LucideIcon.vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  depth: { type: Number, default: 0 }
})

const route = useRoute()

// /list/:doctype is reached ad hoc for any DocType and shares `meta.nav` with
// the generic form route. Keying off the DocType keeps that specific.
const activeNav = computed(() =>
  route.name === 'doc-list' ? `list:${route.params.doctype}` : route.meta.nav
)

/**
 * Reports match on the report name, not the path: `route.path` is
 * percent-encoded ("/report/Operations%20Summary") while `node.route` is not,
 * so comparing the two would never agree for a name containing a space.
 */
function isActive(node) {
  if (node.item_type === 'Group') return false
  if (node.item_type === 'Report') {
    return route.name === 'report' && route.params.name === node.target_report
  }
  if (node.route && node.route === route.path) return true
  return Boolean(node.nav && node.nav === activeNav.value)
}

const containsActive = (node) => descendants(node).some(isActive)

// Per-node disclosure state. Unset means "follow the route", so deep-linking
// into a report opens the group it lives in.
const open = ref({})
const isOpen = (node) => open.value[node.name] ?? containsActive(node)
const toggle = (node) => {
  open.value = { ...open.value, [node.name]: !isOpen(node) }
}

// Navigating into a collapsed group reveals where you are, even if it was
// manually closed earlier.
watch(
  () => route.fullPath,
  () => {
    for (const node of props.nodes) {
      if (node.item_type === 'Group' && node.group_style === 'Collapsible' && containsActive(node)) {
        open.value = { ...open.value, [node.name]: true }
      }
    }
  }
)

const headerStyle = {
  fontSize: '11px',
  fontWeight: '700',
  color: '#94A0AE',
  letterSpacing: '.08em',
  padding: '14px 10px 8px'
}

/** Sub-items indent under their group and take a lighter active treatment. */
function itemStyle(node) {
  if (!props.depth) return navItemStyle(isActive(node))

  const on = isActive(node)
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '9px',
    padding: '8px 10px 8px 38px',
    borderRadius: '10px',
    fontSize: '13px',
    fontWeight: on ? '700' : '500',
    color: on ? '#0B3465' : '#64748B',
    background: on ? '#E9EFF7' : 'transparent',
    cursor: 'pointer'
  }
}
</script>

<template>
  <template v-for="node in nodes" :key="node.name">
    <!-- Section: a static header, children flowing beneath it -->
    <template v-if="node.item_type === 'Group' && node.group_style !== 'Collapsible'">
      <div :style="headerStyle">{{ node.item_label }}</div>
      <div style="display:flex; flex-direction:column; gap:3px;">
        <SidebarNodes :nodes="node.children" :depth="depth" />
      </div>
    </template>

    <!-- Collapsible: a disclosure group -->
    <template v-else-if="node.item_type === 'Group'">
      <button
        @click="toggle(node)"
        :aria-expanded="isOpen(node)"
        :style="{
          ...navItemStyle(containsActive(node)),
          width: '100%',
          border: 'none',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer'
        }"
        class="hv2"
      >
        <span style="font-size:19px;"><LucideIcon :name="node.icon || 'circle'" /></span>
        <span style="flex:1;">{{ node.item_label }}</span>
        <span
          :style="`font-size:15px; color:#94A0AE; display:inline-flex; transition:transform .15s; transform:rotate(${isOpen(node) ? 90 : 0}deg);`"
        >
          <LucideIcon name="chevron-right" />
        </span>
      </button>
      <div v-if="isOpen(node)" style="display:flex; flex-direction:column; gap:2px;">
        <SidebarNodes :nodes="node.children" :depth="depth + 1" />
      </div>
    </template>

    <!-- Link, Page or Report -->
    <RouterLink
      v-else
      :to="node.route || '/'"
      :style="itemStyle(node)"
      :title="node.item_label"
      class="hv2"
    >
      <span :style="depth ? 'font-size:15px; flex:none;' : 'font-size:19px;'">
        <LucideIcon :name="node.icon || 'circle'" />
      </span>
      <span
        :style="depth ? 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;' : ''"
      >{{ node.item_label }}</span>
    </RouterLink>
  </template>
</template>

<style scoped>
a { text-decoration: none; }
</style>
