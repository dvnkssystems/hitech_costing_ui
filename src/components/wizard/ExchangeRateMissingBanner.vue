<script setup>
/**
 * "Please set the exchange rate first" — the one loud warning for a quote
 * whose currency has no rate for the quotation's quarter.
 *
 * The manual Exchange Rate inputs are gone from the wizard (client,
 * 2026-10-12), so the only fix is a row in Exchange Rates (Currency Exchange
 * Master). Until then the affected figures convert at 0, and Submit refuses
 * (see `submitAll()`), so this sits at the top of every step those figures
 * appear on rather than as a line of small print under them.
 */
import LucideIcon from '@/components/LucideIcon.vue'

defineProps({
  /** One line per missing rate, e.g. "USD → INR (Item) for Q4 2026". */
  missing: { type: Array, required: true },
  /** Re-run the rate lookups after a rate has been added in another tab. */
  checking: { type: Boolean, default: false }
})
defineEmits(['recheck'])
</script>

<template>
  <div class="qw-rate-banner" role="alert">
    <span class="qw-rate-banner__icon"><LucideIcon name="triangle-alert" /></span>
    <div class="qw-rate-banner__body">
      <div class="qw-rate-banner__title">Please set the exchange rate first</div>
      <p class="qw-rate-banner__text">
        This quotation can't be priced until these rates are added in Exchange Rates. Until then the figures that
        need them are converted at 0, and the quotation can't be submitted.
      </p>
      <ul class="qw-rate-banner__list">
        <li v-for="line in missing" :key="line">{{ line }}</li>
      </ul>
      <div class="qw-rate-banner__actions">
        <RouterLink to="/list/Currency Exchange Master" target="_blank" class="qw-rate-banner__primary">
          Set exchange rate
        </RouterLink>
        <button type="button" class="qw-rate-banner__secondary" :disabled="checking" @click="$emit('recheck')">
          {{ checking ? 'Checking…' : "I've added it — check again" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qw-rate-banner {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  margin: 0 0 18px;
  padding: 16px 18px;
  border: 1.5px solid #e5484d;
  border-radius: 12px;
  background: #fff1f1;
  color: #7a1d1d;
}
.qw-rate-banner__icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: #e5484d;
  color: #fff;
  font-size: 18px;
}
.qw-rate-banner__body {
  min-width: 0;
}
.qw-rate-banner__title {
  font-size: 16px;
  font-weight: 800;
  color: #a1181d;
}
.qw-rate-banner__text {
  margin: 4px 0 8px;
  font-size: 13.5px;
  line-height: 1.5;
}
.qw-rate-banner__list {
  margin: 0 0 12px;
  padding-left: 18px;
  font-size: 13.5px;
  font-weight: 700;
}
.qw-rate-banner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.qw-rate-banner__primary,
.qw-rate-banner__secondary {
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: 13.5px;
  font-weight: 700;
  font-family: inherit;
  text-decoration: none;
  cursor: pointer;
}
.qw-rate-banner__primary {
  border: 1px solid #a1181d;
  background: #a1181d;
  color: #fff;
}
.qw-rate-banner__secondary {
  border: 1px solid #e5b4b5;
  background: #fff;
  color: #7a1d1d;
}
.qw-rate-banner__secondary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
