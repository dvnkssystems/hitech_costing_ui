<script setup>
/**
 * The Activity pull tab and its record feed, for any form.
 *
 * One fixed container pinned to the right edge holding the tab and the panel
 * side by side, so the tab hangs off the panel's left edge and slides with it.
 * Inside: a RECORD FEED header, an Activity / Comments segmented control, and
 * a timeline whose rows are a dot-and-line rail beside **who** did **what**.
 *
 * Everything shown comes from `frappe.desk.form.load.get_docinfo` — see
 * `src/lib/activity.js`. A document that has never been saved has no history,
 * so the tab does not appear rather than opening onto an empty panel.
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { fetchActivity, activityStyle } from '@/lib/activity'
import LucideIcon from '@/components/LucideIcon.vue'

const props = defineProps({
  /** The form's `frm`. Null until it has loaded. */
  frm: { type: Object, default: null }
})

const open = ref(false)
const tab = ref('activity')
const loading = ref(false)
const error = ref('')
const activity = ref([])
const comments = ref([])

const doctype = computed(() => props.frm?.doctype ?? '')
const docname = computed(() => {
  const name = props.frm?.doc?.name
  return !name || String(name).startsWith('new-') ? '' : String(name)
})

/** Nothing to show a history of until the document exists on the server. */
const available = computed(() => Boolean(doctype.value && docname.value))
const count = computed(() => activity.value.length + comments.value.length)

/** The DocType's own wording for a field, so the feed reads like the form. */
const labelFor = (fieldname) => props.frm?.fields_dict?.[fieldname]?.df?.label || ''

async function load() {
  if (!available.value) {
    activity.value = []
    comments.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const result = await fetchActivity(doctype.value, docname.value, { labelFor })
    activity.value = result.activity
    comments.value = result.comments
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

function toggle() {
  open.value = !open.value
  // Re-read on every open: a save made since the last one is exactly the thing
  // someone opens this to check.
  if (open.value) load()
}

const rows = computed(() => (tab.value === 'activity' ? activity.value : comments.value))

const onKeydown = (event) => {
  if (event.key === 'Escape' && open.value) open.value = false
}

// The count sits on the tab, so it has to be right before anyone opens anything.
watch([doctype, docname], load, { immediate: true })

if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown)
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <template v-if="available">
      <Transition name="activity-scrim">
        <div v-if="open" class="activity-scrim" @click="open = false" />
      </Transition>

      <!-- One fixed rail holding tab and panel, as the design has it: the tab
           precedes the panel, so it sits against the panel's left edge and the
           whole rail slides left to open. -->
      <div class="activity-dock" :class="{ 'is-open': open }">
        <button
          type="button"
          class="activity-tab"
          :aria-expanded="open"
          :title="open ? 'Collapse activity' : 'Show activity'"
          @click="toggle"
        >
          <span class="activity-tab__label">ACTIVITY</span>
          <span v-if="count" class="activity-tab__count">{{ count }}</span>
        </button>

        <aside class="activity-panel" role="dialog" :aria-hidden="!open" aria-label="Record feed">
          <div class="activity-panel__head">
            <div class="activity-panel__heading">
              <div class="activity-panel__id-wrap">
                <div class="activity-panel__eyebrow">RECORD FEED</div>
                <div class="activity-panel__id">{{ docname }}</div>
              </div>
              <button type="button" class="activity-panel__close" title="Collapse" @click="open = false">
                <LucideIcon name="panel-left-close" />
              </button>
            </div>

            <div class="activity-switch">
              <button
                type="button"
                :class="['activity-switch__btn', { 'is-on': tab === 'activity' }]"
                @click="tab = 'activity'"
              >
                Activity
              </button>
              <button
                type="button"
                :class="['activity-switch__btn', { 'is-on': tab === 'comments' }]"
                @click="tab = 'comments'"
              >
                Comments<template v-if="comments.length"> ({{ comments.length }})</template>
              </button>
            </div>
          </div>

          <div class="activity-panel__body">
            <p v-if="loading" class="activity-note">Loading…</p>
            <p v-else-if="error" class="activity-note activity-note--error">{{ error }}</p>
            <p v-else-if="!rows.length" class="activity-note">
              <template v-if="tab === 'activity'">
                Nothing has happened to this document yet. Edits, assignments and attachments show
                up here as Frappe records them.
              </template>
              <template v-else>No comments on this document.</template>
            </p>

            <!-- Activity: the design's dot-and-line rail. -->
            <div v-else-if="tab === 'activity'" class="activity-feed">
              <div v-for="(row, i) in rows" :key="row.id" class="activity-row">
                <div class="activity-rail">
                  <span
                    class="activity-dot"
                    :style="{
                      background: activityStyle(row.kind).background,
                      color: activityStyle(row.kind).color
                    }"
                  >
                    <LucideIcon :name="activityStyle(row.kind).icon" />
                  </span>
                  <span v-if="i < rows.length - 1" class="activity-line" />
                </div>
                <div class="activity-row__body">
                  <div class="activity-row__text">
                    <span class="activity-row__who">{{ row.who }}</span> {{ row.text }}
                  </div>
                  <ul v-if="row.detail.length" class="activity-row__detail">
                    <li v-for="(line, n) in row.detail" :key="n">{{ line }}</li>
                  </ul>
                  <div class="activity-row__time">{{ row.time }}</div>
                </div>
              </div>
            </div>

            <!-- Comments: avatar and bubble. -->
            <div v-else class="activity-comments">
              <div v-for="row in rows" :key="row.id" class="activity-comment">
                <span class="activity-comment__avatar">{{ row.initial }}</span>
                <div class="activity-comment__bubble">
                  <div class="activity-comment__meta">
                    <span class="activity-comment__author">{{ row.who }}</span>
                    <span class="activity-comment__time">{{ row.time }}</span>
                  </div>
                  <div class="activity-comment__text">{{ row.text }}</div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </template>
  </Teleport>
</template>
