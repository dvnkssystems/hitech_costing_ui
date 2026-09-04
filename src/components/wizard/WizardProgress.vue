<script setup>
/**
 * Quotation-Wizard-style step crumbs: a bordered row of numbered buttons,
 * one per step, filled solid for the active step and tinted for done ones.
 *
 * Purely presentational — the parent owns `activeIndex`/`unlockedSteps` and
 * decides whether a click on an unlocked crumb is honoured.
 */
defineProps({
  steps: { type: Array, required: true },
  activeIndex: { type: Number, required: true },
  unlockedSteps: { type: Object, required: true } // Set<number>
})

defineEmits(['select'])
</script>

<template>
  <div class="wizard-crumbs" role="list">
    <button
      v-for="(step, i) in steps"
      :key="step.key"
      type="button"
      role="listitem"
      class="wizard-crumb"
      :class="{
        'is-active': i === activeIndex,
        'is-done': i < activeIndex,
        'is-locked': !unlockedSteps.has(i)
      }"
      :disabled="!unlockedSteps.has(i)"
      :aria-current="i === activeIndex ? 'step' : undefined"
      @click="$emit('select', i)"
    >
      <span class="wizard-crumb__n">{{ String(i + 1).padStart(2, '0') }}</span>
      <span class="wizard-crumb__label">{{ step.title }}</span>
    </button>
  </div>
</template>

<style scoped>
.wizard-crumbs {
  display: flex;
  flex-wrap: wrap;
  border: 1px solid #D7DEE8;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  margin-bottom: 26px;
}

.wizard-crumb {
  flex: 1 1 116px;
  min-width: 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 6px;
  padding: 12px 8px;
  border: none;
  border-right: 1px solid #D7DEE8;
  background: #fff;
  color: #5E6B7A;
  font: 600 12px/1 'Raleway', system-ui, sans-serif;
  letter-spacing: 0.02em;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

.wizard-crumb:last-child {
  border-right: none;
}

.wizard-crumb__n {
  flex: none;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.wizard-crumb__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.wizard-crumb.is-done {
  background: #E9EFF7;
  color: #0B3465;
}

.wizard-crumb.is-active {
  background: #0B3465;
  color: #fff;
}

.wizard-crumb:not(:disabled):hover {
  background: #E9EFF7;
}

.wizard-crumb.is-active:not(:disabled):hover {
  background: #0E4079;
}

.wizard-crumb.is-locked {
  cursor: not-allowed;
  opacity: 0.55;
}

.wizard-crumb.is-locked:hover {
  background: #fff;
}
</style>
