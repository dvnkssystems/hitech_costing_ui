<script setup>
import { computed } from 'vue'
import { icons } from './icons'

const props = defineProps({
  // Icon names are kebab-case, matching lucide's public naming.
  name: { type: String, required: true },
  strokeWidth: { type: [Number, String], default: 2 }
})

const component = computed(() => icons[props.name] || icons.circle)
</script>

<template>
  <component :is="component" class="lucide" :stroke-width="strokeWidth" />
</template>
