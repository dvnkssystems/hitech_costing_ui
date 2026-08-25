import { createRouter, createWebHistory } from 'vue-router'
import { routes } from './routes'
import { useSessionStore } from '@/stores/session'
import { hasBackend } from '@/lib/frappe'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

/**
 * Send signed-out visitors to /login.
 *
 * Three deliberate escape hatches:
 *  - On the server there is no session to resolve and the SSR render pass must
 *    not make network calls, so the guard is a no-op there.
 *  - With no backend configured the app is a seeded demo with nothing to
 *    authenticate against, so gating it would just lock everyone out.
 *  - Routes marked `meta.public` (login, the customer-facing portal) are always
 *    reachable.
 */
router.beforeEach(async (to) => {
  if (typeof window === 'undefined') return true
  if (!hasBackend) return true
  if (to.meta.public) return true

  const session = useSessionStore()
  // Resolve once per page load so a deep link doesn't bounce to /login before
  // the existing cookie session has been checked.
  if (!session.resolved) await session.resolve()

  if (!session.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  return true
})

export default router
