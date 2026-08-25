<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAppStore } from '@/stores/app'
import AppSidebar from '@/components/AppSidebar.vue'
import AppHeader from '@/components/AppHeader.vue'

const route = useRoute()
// The login screen renders full-bleed; every other screen gets the shell.
const showChrome = computed(() => route.meta.chrome !== false)
const { sidebarOpen } = storeToRefs(useAppStore())
</script>

<template>
  <div v-if="showChrome" style="display:flex; height:100vh; width:100%; overflow:hidden;">
    <!-- Collapsed by width rather than v-if, so the sidebar keeps its scroll
         position and the transition has something to animate. `overflow:hidden`
         stops its 252px of content spilling out while it closes. -->
    <div
      :style="{
        width: sidebarOpen ? '252px' : '0px',
        flex: 'none',
        overflow: 'hidden',
        transition: 'width .2s ease'
      }"
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
