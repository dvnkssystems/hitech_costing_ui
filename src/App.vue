<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAppStore } from '@/stores/app'
import AppSidebar from '@/components/AppSidebar.vue'
import AppHeader from '@/components/AppHeader.vue'

const route = useRoute()
// The login screen renders full-bleed; every other screen gets the shell.
const showChrome = computed(() => route.meta.chrome !== false)
const app = useAppStore()
const { sidebarOpen } = storeToRefs(app)

/**
 * Below this width a 252px sidebar leaves the page too little room to lay
 * anything out, so it stops pushing the content and slides over it instead:
 * closed by default, dismissed by the scrim or by navigating. Neither of those
 * closes is remembered — the stored open/closed choice belongs to wide screens
 * and comes back when the window does.
 */
const NARROW_QUERY = '(max-width: 900px)'
const narrow = ref(false)
let media = null

function onMediaChange(event) {
  narrow.value = event.matches
  if (event.matches) app.closeSidebar()
  else app.restoreSidebar()
}

onMounted(() => {
  media = window.matchMedia(NARROW_QUERY)
  onMediaChange(media)
  media.addEventListener('change', onMediaChange)
})
onBeforeUnmount(() => media?.removeEventListener('change', onMediaChange))

watch(
  () => route.fullPath,
  () => {
    if (narrow.value) app.closeSidebar()
  }
)
</script>

<template>
  <div v-if="showChrome" style="display:flex; height:100vh; width:100%; overflow:hidden;">
    <Transition name="shell-scrim">
      <div v-if="narrow && sidebarOpen" class="shell-scrim" @click="app.closeSidebar()" />
    </Transition>
    <!-- Collapsed by width rather than v-if, so the sidebar keeps its scroll
         position and the transition has something to animate. `overflow:hidden`
         stops its 252px of content spilling out while it closes. -->
    <div
      :class="['shell-sidebar', { 'shell-sidebar--overlay': narrow, 'shell-sidebar--open': sidebarOpen }]"
      :style="{ width: sidebarOpen ? '252px' : '0px' }"
    >
      <AppSidebar />
    </div>
    <div style="flex:1; min-width:0; display:flex; flex-direction:column; height:100%;">
      <AppHeader />
      <main style="flex:1; overflow-y:auto;">
        <RouterView />
      </main>
    </div>
  </div>

  <RouterView v-else />
</template>

<style scoped>
.shell-sidebar {
  flex: none;
  overflow: hidden;
  transition: width .2s ease;
}
/* Sits under the Activity (55/56) and notifications (58/59) drawers. */
.shell-sidebar--overlay {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 53;
}
.shell-sidebar--overlay.shell-sidebar--open {
  box-shadow: 0 18px 44px rgba(15, 23, 42, .22);
}
.shell-scrim {
  position: fixed;
  inset: 0;
  z-index: 52;
  background: rgba(15, 23, 42, .32);
}
.shell-scrim-enter-active,
.shell-scrim-leave-active { transition: opacity .2s ease; }
.shell-scrim-enter-from,
.shell-scrim-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .shell-sidebar,
  .shell-scrim-enter-active,
  .shell-scrim-leave-active { transition: none; }
}
</style>
