import { defineStore } from 'pinia'
import { hasBackend } from '@/lib/frappe'
import {
  fetchNotifications,
  markNotificationRead as apiMarkRead,
  markAllNotificationsRead as apiMarkAllRead
} from '@/lib/notifications'

const SIDEBAR_KEY = 'hitech-costing:sidebar-open'

/** Open by default; guarded for SSR and for browsers refusing storage. */
function readStoredSidebar() {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_KEY) !== '0'
  } catch {
    return true
  }
}

export const useAppStore = defineStore('app', {
  state: () => ({
    // ---- branding ----
    companyName: 'Hitech Costing',
    userName: 'there',

    // ---- notifications ----
    notificationRows: [],
    notificationsLoading: false,
    notificationsError: '',
    notificationsOpen: false,

    // Collapsing the sidebar buys back screen width on the wide SDK forms, so
    // the choice is worth remembering between visits.
    sidebarOpen: readStoredSidebar()
  }),

  getters: {
    /** Badge count — unread only, so reading one ticks it down. */
    notifications(state) {
      return state.notificationRows.filter((n) => !n.read).length
    }
  },

  actions: {
    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen
      try {
        globalThis.localStorage?.setItem(SIDEBAR_KEY, this.sidebarOpen ? '1' : '0')
      } catch {
        // Private mode or storage disabled — the toggle still works for this session.
      }
    },

    // ---- notifications ----
    async loadNotifications() {
      if (!hasBackend) return
      this.notificationsLoading = true
      this.notificationsError = ''
      try {
        this.notificationRows = await fetchNotifications()
      } catch (e) {
        this.notificationsError = e?.message ?? String(e)
      } finally {
        this.notificationsLoading = false
      }
    },

    /** Opening the panel always refetches — a stale bell is worse than a spinner. */
    toggleNotifications() {
      this.notificationsOpen = !this.notificationsOpen
      if (this.notificationsOpen) return this.loadNotifications()
      return Promise.resolve()
    },

    closeNotifications() {
      this.notificationsOpen = false
    },

    async markNotificationRead(id) {
      const row = this.notificationRows.find((n) => n.id === id)
      if (!row || row.read) return
      // Optimistic: the dot clears immediately and rolls back if the write fails.
      row.read = true
      if (!hasBackend) return
      try {
        await apiMarkRead(id)
      } catch (e) {
        row.read = false
        this.notificationsError = e?.message ?? String(e)
      }
    },

    async markAllNotificationsRead() {
      const unread = this.notificationRows.filter((n) => !n.read)
      if (!unread.length) return
      unread.forEach((n) => {
        n.read = true
      })
      if (!hasBackend) return
      try {
        await apiMarkAllRead(unread.map((n) => n.id))
      } catch (e) {
        unread.forEach((n) => {
          n.read = false
        })
        this.notificationsError = e?.message ?? String(e)
      }
    }
  }
})
