import { defineStore } from 'pinia'
import { call, login as apiLogin, logout as apiLogout, hasBackend } from '@/lib/frappe'

/**
 * Who is signed in to the Frappe backend.
 *
 * With no backend configured the app runs as a seeded demo, so `resolve()`
 * short-circuits and the sidebar keeps showing the placeholder identity from
 * the app store. Every guard checks `hasBackend` first for the same reason.
 */
export const useSessionStore = defineStore('session', {
  state: () => ({
    user: null,
    fullName: '',
    userImage: null,
    // Whether we've asked the server yet — the router guard waits on this so a
    // deep link doesn't bounce to /login before the session is known.
    resolved: false,
    pending: false,
    error: '',
    /**
     * Read access per DocType, as `{ Operations: true, Quote: false }`.
     *
     * Populated once per session from `frappe.client.has_permission`, which
     * accepts an empty docname and answers for the DocType as a whole. Drives
     * the sidebar: an entry the user cannot open is not worth offering.
     */
    permissions: {},
    permissionsLoaded: false
  }),

  getters: {
    isLoggedIn: (state) => Boolean(state.user) && state.user !== 'Guest',
    /**
     * Whether the user may read a DocType.
     *
     * Unknown means "not asked yet", and defaults to allowed on purpose: the
     * alternative is a sidebar that flickers empty on load, or that hides the
     * whole app because one probe failed. Opening a forbidden screen still
     * shows its own no-access state.
     */
    can: (state) => (doctype) =>
      !doctype || !state.permissionsLoaded ? true : state.permissions[doctype] !== false,
    displayName: (state) => state.fullName || state.user || '',
    initials() {
      const source = this.displayName
      if (!source) return '?'
      // An email login has no spaces to split on — fall back to its first letters.
      const parts = source.includes('@') ? [source] : source.trim().split(/\s+/)
      return parts
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    }
  },

  actions: {
    reset() {
      this.user = null
      this.fullName = ''
      this.userImage = null
      this.permissions = {}
      this.permissionsLoaded = false
    },

    /**
     * Ask the server which DocTypes this user may read.
     *
     * One call per DocType, but only a handful and only once a session — far
     * cheaper than letting every screen discover it by failing.
     */
    async loadPermissions(doctypes = []) {
      if (!hasBackend || !this.isLoggedIn) {
        this.permissionsLoaded = true
        return
      }
      const wanted = doctypes.filter((dt) => !(dt in this.permissions))
      if (!wanted.length) {
        this.permissionsLoaded = true
        return
      }

      const results = await Promise.all(
        wanted.map((doctype) =>
          call('frappe.client.has_permission', { doctype, docname: '', perm_type: 'read' })
            .then((r) => [doctype, Boolean(r?.has_permission)])
            // A failed probe must not hide the entry — assume allowed and let
            // the screen itself report the problem if there is one.
            .catch(() => [doctype, true])
        )
      )
      this.permissions = { ...this.permissions, ...Object.fromEntries(results) }
      this.permissionsLoaded = true
    },

    /** Ask the server who we are. Safe to call repeatedly. */
    async resolve(force = false) {
      if (!hasBackend) {
        this.resolved = true
        return
      }
      if (this.resolved && !force) return
      this.pending = true
      try {
        const user = await call('frappe.auth.get_logged_user')
        if (user && user !== 'Guest') {
          this.user = user
          await this.loadProfile()
        } else {
          this.reset()
        }
      } catch {
        // A guest session throws 403 here — that just means "not logged in".
        this.reset()
      } finally {
        this.pending = false
        this.resolved = true
      }
    },

    async loadProfile() {
      try {
        const values = await call('frappe.client.get_value', {
          doctype: 'User',
          filters: { name: this.user },
          fieldname: ['full_name', 'user_image']
        })
        this.fullName = values?.full_name ?? ''
        this.userImage = values?.user_image ?? null
      } catch {
        // Non-fatal: fall back to showing the user id.
        this.fullName = ''
      }
    },

    async login(usr, pwd) {
      this.error = ''
      this.pending = true
      try {
        const payload = await apiLogin(usr, pwd)
        this.user = usr
        this.fullName = payload?.full_name ?? ''
        this.resolved = true
        // `usr` may be a username rather than the User docname — re-resolve so
        // `user` holds the real record id the profile form needs.
        await this.resolve(true)
        return true
      } catch (e) {
        this.error = e?.message ?? 'Could not sign in.'
        this.reset()
        return false
      } finally {
        this.pending = false
      }
    },

    async logout() {
      this.pending = true
      try {
        await apiLogout()
      } catch {
        // Even if the server call fails, drop local state — the user asked to
        // sign out and leaving them "logged in" would be worse.
      } finally {
        this.reset()
        this.resolved = true
        this.pending = false
      }
    }
  }
})
