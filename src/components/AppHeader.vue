<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useSessionStore } from '@/stores/session'
import { globalSearch, groupByDoctype } from '@/lib/globalSearch'
import { hasBackend } from '@/lib/frappe'
import LucideIcon from './LucideIcon.vue'

const app = useAppStore()
const {
  userName,
  notifications,
  notificationRows,
  notificationsOpen,
  notificationsLoading,
  notificationsError,
  sidebarOpen
} = storeToRefs(app)
const session = useSessionStore()
const { userImage } = storeToRefs(session)
const router = useRouter()
const search = ref('')
const bellRef = ref(null)
// The notifications drawer is teleported to the body, so click-away has to
// check it explicitly — it is no longer a descendant of the bell.
const notifPanelRef = ref(null)

/* ── Global search ──────────────────────────────────────────────────────────
 * Mirrors the desk awesomebar: debounced query, grouped results, arrow-key
 * navigation, Enter to open the highlighted row.
 */
const searchRef = ref(null)
const searchInput = ref(null)
const searchOpen = ref(false)
const searchLoading = ref(false)
const searchError = ref('')
const indexEmpty = ref(false)
const pageHits = ref([])
const docHits = ref([])
const activeIndex = ref(0)

/** Pages first, then documents — the flat order the arrow keys walk. */
const flatHits = computed(() => [...pageHits.value, ...docHits.value])
const docGroups = computed(() => groupByDoctype(docHits.value))
const hasQuery = computed(() => search.value.trim().length > 0)

/** Index of a row within `flatHits`, so highlight survives grouping. */
const indexOf = (hit) => flatHits.value.findIndex((h) => h.id === hit.id)

let searchTimer = null
// Only the newest query may write results — a slow earlier request must not
// overwrite a fresher one when it finally lands.
let searchSeq = 0

function resetSearch() {
  pageHits.value = []
  docHits.value = []
  indexEmpty.value = false
  searchError.value = ''
  activeIndex.value = 0
}

async function runSearch(term) {
  const seq = ++searchSeq
  searchLoading.value = true
  try {
    const { pages, documents, indexEmpty: stale } = await globalSearch(term)
    if (seq !== searchSeq) return
    pageHits.value = pages
    docHits.value = documents
    indexEmpty.value = stale
    searchError.value = ''
    activeIndex.value = 0
  } catch (e) {
    if (seq !== searchSeq) return
    resetSearch()
    searchError.value = e?.message ?? String(e)
  } finally {
    if (seq === searchSeq) searchLoading.value = false
  }
}

// Debounced so typing doesn't fire a full-text query per keystroke.
watch(search, (term) => {
  clearTimeout(searchTimer)
  const text = term.trim()
  if (!text) {
    searchSeq++
    searchLoading.value = false
    resetSearch()
    searchOpen.value = false
    return
  }
  searchOpen.value = true
  searchTimer = setTimeout(() => runSearch(text), 250)
})

function openHit(hit) {
  if (!hit) return
  closeSearch()
  search.value = ''
  router.push(hit.route)
}

function closeSearch() {
  searchOpen.value = false
  clearTimeout(searchTimer)
}

function onSearchKeydown(event) {
  if (event.key === 'Escape') {
    closeSearch()
    searchInput.value?.blur()
    return
  }
  if (!searchOpen.value || !flatHits.value.length) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % flatHits.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + flatHits.value.length) % flatHits.value.length
  } else if (event.key === 'Enter') {
    event.preventDefault()
    openHit(flatHits.value[activeIndex.value])
  }
}

/** Read it, then go to the document it is about (when it names one). */
function openNotification(item) {
  app.markNotificationRead(item.id)
  if (!item.route) return
  app.closeNotifications()
  router.push(item.route)
}

// Click-away and Escape, the way every other dropdown in the app behaves.
function onDocumentClick(event) {
  if (searchOpen.value && !searchRef.value?.contains(event.target)) closeSearch()
  if (!notificationsOpen.value) return
  if (bellRef.value?.contains(event.target)) return
  if (notifPanelRef.value?.contains(event.target)) return
  app.closeNotifications()
}
function onKeydown(event) {
  if (event.key === 'Escape') app.closeNotifications()
  // Frappe opens the awesomebar on Ctrl/Cmd+K; match it.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchInput.value?.focus()
    searchInput.value?.select()
  }
}

onMounted(() => {
  // Fills the badge on first paint; the panel refetches whenever it opens.
  app.loadNotifications()
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKeydown)
  clearTimeout(searchTimer)
})

// Mirror the sidebar: the signed-in Frappe user when there is one, the seeded
// demo identity otherwise.
const initials = computed(() =>
  session.isLoggedIn
    ? session.initials
    : userName.value
        .split(' ')
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
)
</script>

<template>
  <header
    style="height:66px; flex:none; background:#fff; border-bottom:1px solid #EAEEF3; display:flex; align-items:center; gap:16px; padding:0 28px;"
  >
    <button
      @click="app.toggleSidebar()"
      :title="sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'"
      :aria-label="sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'"
      :aria-expanded="sidebarOpen"
      style="width:42px; height:42px; flex:none; border-radius:11px; border:1px solid #E6EBF1; background:#fff; color:#475569; display:flex; align-items:center; justify-content:center; font-size:19px; cursor:pointer;"
      class="hv2"
    >
      <LucideIcon :name="sidebarOpen ? 'panel-left-close' : 'panel-left'" />
    </button>

    <div ref="searchRef" style="position:relative; flex:1; max-width:420px;">
      <span style="position:absolute; left:14px; top:50%; transform:translateY(-50%); color:#94A3B8; font-size:17px;">
        <LucideIcon name="search" />
      </span>
      <input
        ref="searchInput"
        v-model="search"
        @keydown="onSearchKeydown"
        @focus="hasQuery && (searchOpen = true)"
        placeholder="Search worksheets, tank types, rates…"
        aria-label="Global search"
        role="combobox"
        :aria-expanded="searchOpen"
        autocomplete="off"
        style="width:100%; height:42px; border:1px solid #E6EBF1; border-radius:11px; padding:0 76px 0 42px; font-size:14px; background:#F8FAFC;"
      />
      <button
        v-if="hasQuery"
        @click="search = ''; searchInput?.focus()"
        title="Clear search"
        aria-label="Clear search"
        style="position:absolute; right:48px; top:50%; transform:translateY(-50%); width:22px; height:22px; border:none; background:none; color:#94A3B8; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:14px; border-radius:6px;"
        class="hv2"
      >
        <LucideIcon name="x" />
      </button>
      <span
        v-else
        aria-hidden="true"
        style="position:absolute; right:12px; top:50%; transform:translateY(-50%); font-size:11px; font-weight:600; color:#94A3B8; background:#fff; border:1px solid #E6EBF1; border-radius:6px; padding:2px 6px; pointer-events:none;"
        >⌘K</span
      >

      <!-- Results. Mirrors the desk awesomebar: pages first, then documents
           grouped by DocType in Frappe's own relevance order. -->
      <div
        v-if="searchOpen && hasQuery"
        style="position:absolute; top:50px; left:0; right:0; max-height:min(70vh, 460px); overflow-y:auto; background:#fff; border:1px solid #E6EBF1; border-radius:14px; box-shadow:0 18px 44px rgba(15,23,42,.16); z-index:60;"
      >
        <div
          v-if="searchLoading && !flatHits.length"
          style="padding:22px 16px; text-align:center; color:#94A3B8; font-size:13px;"
        >
          Searching…
        </div>

        <div
          v-else-if="searchError"
          style="padding:18px 16px; color:#B91C1C; font-size:13px; line-height:1.5;"
        >
          {{ searchError }}
        </div>

        <div
          v-else-if="!flatHits.length"
          style="padding:26px 16px; text-align:center; color:#94A3B8; font-size:13px;"
        >
          <div style="font-size:22px; color:#CBD5E1; margin-bottom:8px;">
            <LucideIcon name="search" />
          </div>
          No results for “{{ search.trim() }}”.
          <div v-if="!hasBackend" style="margin-top:6px; font-size:12px;">
            Document search needs a Frappe backend — only pages are searched offline.
          </div>
        </div>

        <template v-else>
          <!-- Pages -->
          <template v-if="pageHits.length">
            <div
              style="padding:10px 16px 6px; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#94A3B8;"
            >
              Pages
            </div>
            <button
              v-for="hit in pageHits"
              :key="hit.id"
              @click="openHit(hit)"
              @mousemove="activeIndex = indexOf(hit)"
              :style="`width:100%; text-align:left; display:flex; align-items:center; gap:11px; padding:9px 16px; border:none; cursor:pointer; background:${indexOf(hit) === activeIndex ? '#FFF7ED' : '#fff'};`"
            >
              <span
                style="flex:none; width:28px; height:28px; border-radius:8px; background:#F1F5F9; color:#475569; display:flex; align-items:center; justify-content:center; font-size:14px;"
              >
                <LucideIcon :name="hit.icon" />
              </span>
              <span style="font-size:13.5px; font-weight:600; color:#0F172A;">{{ hit.label }}</span>
            </button>
          </template>

          <!-- Documents, grouped by DocType -->
          <template v-for="group in docGroups" :key="group.doctype">
            <div
              style="padding:10px 16px 6px; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#94A3B8; border-top:1px solid #F1F5F9;"
            >
              {{ group.doctype }}
            </div>
            <button
              v-for="hit in group.items"
              :key="hit.id"
              @click="openHit(hit)"
              @mousemove="activeIndex = indexOf(hit)"
              :style="`width:100%; text-align:left; display:block; padding:9px 16px; border:none; cursor:pointer; background:${indexOf(hit) === activeIndex ? '#FFF7ED' : '#fff'};`"
            >
              <span style="display:block; font-size:13.5px; font-weight:600; color:#0F172A;">{{ hit.label }}</span>
              <span
                v-if="hit.description"
                style="display:block; font-size:12px; color:#64748B; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                >{{ hit.description }}</span
              >
            </button>
          </template>

          <!-- The full-text index found nothing but a name match exists, which
               means __global_search needs rebuilding on the bench. -->
          <div
            v-if="indexEmpty"
            style="padding:9px 16px; border-top:1px solid #F1F5F9; background:#FFFBEB; color:#B45309; font-size:11.5px; line-height:1.5;"
          >
            Matched by document name only. Run
            <code style="font-size:11px;">bench --site &lt;site&gt; rebuild-global-search</code>
            to search field contents too.
          </div>
        </template>
      </div>
    </div>
    <div style="flex:1;"></div>
    <div ref="bellRef" style="position:relative;">
      <button
        @click="app.toggleNotifications()"
        :title="`Notifications${notifications ? ` (${notifications} unread)` : ''}`"
        aria-label="Notifications"
        :aria-expanded="notificationsOpen"
        style="width:42px; height:42px; border-radius:11px; border:1px solid #E6EBF1; background:#fff; color:#475569; display:flex; align-items:center; justify-content:center; font-size:19px; cursor:pointer; position:relative;"
        class="hv2"
      >
        <LucideIcon name="bell" />
        <span
          v-if="notifications"
          style="position:absolute; top:8px; right:9px; min-width:16px; height:16px; padding:0 4px; border-radius:999px; background:#F97316; color:#fff; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; border:2px solid #fff;"
          >{{ notifications }}</span
        >
      </button>

      <!-- The bell opens a right-edge drawer, like Activity and the child-row
           editor, rather than a dropdown hanging off the bell — which on a wide
           screen reads as opening leftwards into the page. Teleported to the
           body so the header's stacking context cannot clip it. -->
      <Teleport to="body">
        <Transition name="notif-scrim">
          <div v-if="notificationsOpen" class="notif-scrim" @click="app.closeNotifications()" />
        </Transition>

        <Transition name="notif-drawer">
          <aside
            v-if="notificationsOpen"
            ref="notifPanelRef"
            class="notif-drawer"
            role="dialog"
            aria-label="Notifications"
          >
            <header class="notif-drawer__head">
              <div style="font-size:15px; font-weight:700; color:#0F172A;">Notifications</div>
              <span
                v-if="notifications"
                style="background:#FFF1E7; color:#C2410C; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px;"
                >{{ notifications }} new</span
              >
              <div style="flex:1;"></div>
              <button
                v-if="notifications"
                @click="app.markAllNotificationsRead()"
                style="border:none; background:none; color:#F97316; font-size:12px; font-weight:600; cursor:pointer; padding:2px 4px;"
              >
                Mark all read
              </button>
              <button
                type="button"
                class="notif-drawer__close"
                title="Close notifications"
                aria-label="Close notifications"
                @click="app.closeNotifications()"
              >
                <LucideIcon name="x" />
              </button>
            </header>

            <div class="notif-drawer__body">
              <div
                v-if="notificationsLoading && !notificationRows.length"
                style="padding:26px 16px; text-align:center; color:#94A3B8; font-size:13px;"
              >
                Loading…
              </div>
              <div
                v-else-if="notificationsError"
                style="padding:20px 16px; color:#B91C1C; font-size:13px; line-height:1.5;"
              >
                {{ notificationsError }}
              </div>
              <div
                v-else-if="!notificationRows.length"
                style="padding:30px 16px; text-align:center; color:#94A3B8; font-size:13px;"
              >
                <div style="font-size:22px; color:#CBD5E1; margin-bottom:8px;">
                  <LucideIcon name="bell" />
                </div>
                You're all caught up.
              </div>

              <button
                v-for="item in notificationRows"
                :key="item.id"
                @click="openNotification(item)"
                :style="`width:100%; text-align:left; display:flex; gap:12px; padding:13px 16px; border:none; border-bottom:1px solid #F1F5F9; cursor:pointer; background:${item.read ? '#fff' : '#FFFBF7'};`"
                class="hv2"
              >
                <span
                  :style="`flex:none; width:32px; height:32px; border-radius:9px; display:flex; align-items:center; justify-content:center; font-size:15px; background:${item.color}14; color:${item.color};`"
                >
                  <LucideIcon :name="item.icon" />
                </span>
                <span style="flex:1; min-width:0;">
                  <span
                    :style="`display:block; font-size:13px; line-height:1.45; color:#0F172A; font-weight:${item.read ? 500 : 700};`"
                    >{{ item.subject }}</span
                  >
                  <span
                    v-if="item.body"
                    style="display:block; font-size:12px; color:#64748B; line-height:1.45; margin-top:2px;"
                    >{{ item.body }}</span
                  >
                  <span
                    style="display:flex; align-items:center; gap:6px; margin-top:5px; font-size:11px; color:#94A3B8;"
                  >
                    <span v-if="item.reference" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ item.reference }}</span>
                    <span v-if="item.reference && item.age">·</span>
                    <span v-if="item.age" style="flex:none;">{{ item.age }}</span>
                  </span>
                </span>
                <span
                  v-if="!item.read"
                  style="flex:none; width:8px; height:8px; border-radius:50%; background:#F97316; margin-top:6px;"
                ></span>
              </button>
            </div>
          </aside>
        </Transition>
      </Teleport>
    </div>
    <div style="display:flex; align-items:center; gap:10px; padding-left:6px;">
      <RouterLink to="/profile" title="Profile and sign out" style="display:flex;">
        <img
          v-if="userImage"
          :src="userImage"
          alt="Profile"
          style="width:40px; height:40px; border-radius:50%; object-fit:cover;"
        />
        <div
          v-else
          style="width:40px; height:40px; border-radius:50%; background:#0F172A; color:#fff; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700;"
        >
          {{ initials }}
        </div>
      </RouterLink>
    </div>
  </header>
</template>
