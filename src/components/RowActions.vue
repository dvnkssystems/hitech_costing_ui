<script setup>
/**
 * The buttons on the right of a list row.
 *
 * Every list screen drew its own — same 32px square, same border, but three
 * slightly different copies, and `display:flex` on two of them against
 * `inline-flex` on the third. One definition here instead, so a change to the
 * button is a change everywhere rather than a change in one screen and a
 * discrepancy in the others.
 *
 * Each action is `{ label, icon, color, disabled, busy }`. The parent decides
 * what a click means; this only decides what it looks like.
 */
import LucideIcon from '@/components/LucideIcon.vue'

defineProps({
  actions: { type: Array, default: () => [] }
})

const emit = defineEmits(['run'])

/**
 * Named rather than raw hex so a layout written today still matches the app
 * after a restyle — the same bargain the badge colours make.
 */
const COLORS = {
  slate: '#475569',
  green: '#107830',
  red: '#DC2626',
  amber: '#B45309',
  blue: '#1D4ED8'
}

/**
 * A raw hex passes through. Config uses the names above, but some buttons carry
 * row state rather than a setting — the favourite star is orange because that
 * job is a favourite — and that colour has no name to give it.
 */
const colorFor = (action) =>
  typeof action.color === 'string' && action.color.startsWith('#')
    ? action.color
    : (COLORS[action.color] ?? COLORS.slate)

const styleFor = (action) => ({
  width: '32px',
  height: '32px',
  borderRadius: '8px',
  border: '1px solid #E6EBF1',
  background: '#fff',
  color: colorFor(action),
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '15px',
  cursor: action.disabled ? 'not-allowed' : 'pointer',
  opacity: action.disabled ? 0.5 : 1
})
</script>

<template>
  <div style="display:flex; gap:6px; justify-content:flex-end;">
    <button
      v-for="(action, index) in actions"
      :key="action.key ?? index"
      :title="action.label"
      :disabled="action.disabled || action.busy"
      :style="styleFor(action)"
      class="hv6"
      @click.stop="emit('run', action, index)"
    >
      <LucideIcon :name="action.busy ? 'loader' : action.icon" />
    </button>
  </div>
</template>
