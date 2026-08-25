<script setup>
/**
 * Picks the list template for a DocType and renders it.
 *
 * `/list/:doctype` (and its `/ui/:doctype` alias) used to go straight to
 * `DocListView`. Now the backend decides: `Operations` is mapped to the `jobs`
 * template, so browsing it lands on the job board rather than a generic table.
 * Anything unmapped stays on `DocListView`, which works for any DocType.
 *
 * One exception, and it is what makes every dashboard drill-down work: when the
 * URL carries field filters, the generic list renders regardless of the
 * mapping. A bespoke template has its own fixed filter model — the job board
 * filters by status card — and cannot express what a tile counted
 * (`etd_date is not set`, `eta_date < today`). Handing it a filtered URL used
 * to show the *unfiltered* board, so a bar labelled 180 opened onto all 1,400
 * jobs. `DocListView` honours every operator and shows the filter as a chip you
 * can clear, which lands you back on the bespoke screen.
 */
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import DocListView from '@/views/DocListView.vue'
import { fetchLayoutMap, listComponentFor, listLayoutFor } from '@/lib/layouts'
import { parseListFilters } from '@/lib/docList'

const props = defineProps({ doctype: { type: String, required: true } })

const route = useRoute()
const map = ref(null)
onMounted(async () => {
  map.value = await fetchLayoutMap()
})

const layoutName = computed(() => listLayoutFor(map.value, props.doctype))

/** A drill-down: the URL names conditions the bespoke screen cannot express. */
const filtered = computed(() => parseListFilters(route.query).length > 0)

/**
 * Null until the map arrives, and null for unmapped DocTypes — both mean
 * "render the generic list". A name with no registered component also lands
 * here, so a record naming a template this build does not ship degrades
 * instead of breaking.
 */
const bespoke = computed(() =>
  map.value && !filtered.value ? listComponentFor(layoutName.value) : null
)
</script>

<template>
  <component :is="bespoke" v-if="bespoke" />
  <DocListView v-else :doctype="doctype" />
</template>
