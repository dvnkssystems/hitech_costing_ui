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
  <!-- A real list of real buttons: `role="listitem"` on the <button> itself
       replaced its button role, so keyboard / screen-reader users (and
       automated checks) could not see the steps as controls. -->
  <ol class="wizard-crumbs" aria-label="Quotation steps">
    <li v-for="(step, i) in steps" :key="step.key" class="wizard-crumbs__item">
    <button
      type="button"
      class="wizard-crumb"
      :class="{
        'is-active': i === activeIndex,
        'is-done': i < activeIndex,
        'is-locked': !unlockedSteps.has(i)
      }"
      :disabled="!unlockedSteps.has(i)"
      :aria-current="i === activeIndex ? 'step' : undefined"
      :title="step.title"
      @click="$emit('select', i)"
    >
      <span class="wizard-crumb__n">{{ String(i + 1).padStart(2, '0') }}</span>
      <span class="wizard-crumb__label">{{ step.title }}</span>
    </button>
    </li>
  </ol>
</template>

<style scoped>
.wizard-crumbs {
  display: flex;
  list-style: none;
  padding: 0;
  border: 1px solid #D7DEE8;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  margin-bottom: 26px;
}

.wizard-crumbs__item {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  border-right: 1px solid #D7DEE8;
}

.wizard-crumbs__item:last-child {
  border-right: none;
}

/* Names wrap onto a second line rather than being cut ("03 Items &
   Prici…"), and the row never breaks in two: eight equal shares of
   whatever width there is. */
.wizard-crumb {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 8px;
  border: none;
  background: #fff;
  color: #5E6B7A;
  font: 600 12px/1 'Nunito', system-ui, sans-serif;
  letter-spacing: 0.02em;
  line-height: 1.25;
  text-align: center;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.wizard-crumb__n {
  flex: none;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.wizard-crumb__label {
  overflow-wrap: anywhere;
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
