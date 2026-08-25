/**
 * Sign-up and password reset.
 *
 * Signing *in* lives in `stores/session.js`, because it produces session state.
 * These two produce nothing but a message, so they are plain functions.
 *
 * Both are Frappe's own guest-allowed endpoints, verified against this bench
 * rather than assumed — the exact signatures below are what the server accepts.
 */

import { call } from './frappe'

/**
 * Whether to offer "Continue with Google".
 *
 * There is no way to ask the server: `Social Login Key` is not readable by
 * Guest (`frappe.client.get_list` is not whitelisted for them), so the app
 * cannot detect whether a provider is configured. And an unconfigured
 * `login_via_google` does not fail politely — it returns a 500 page.
 *
 * So this is opt-in. Set `VITE_ENABLE_GOOGLE_LOGIN=1` once the site has a
 * Social Login Key for Google with social login enabled.
 */
export const googleLoginEnabled = import.meta.env.VITE_ENABLE_GOOGLE_LOGIN === '1'

/** Frappe's OAuth entry point. A full page navigation, not a fetch. */
export function googleLoginUrl(redirectTo = '/') {
  return `/api/method/frappe.integrations.oauth2_logins.login_via_google?redirect_to=${encodeURIComponent(redirectTo)}`
}

/**
 * Register a new user.
 *
 * `frappe.core.doctype.user.user.sign_up(email, full_name, redirect_to)` — all
 * three arguments are required; omitting `redirect_to` is a TypeError, not a
 * default.
 *
 * **It takes no password.** Frappe emails a verification link and the user sets
 * their own password from it. That is why this app's register form collects a
 * name and an email and nothing else: a password field here would be collected
 * and then silently thrown away.
 *
 * Returns `[code, message]`. Frappe uses the code loosely — `[0, "Already
 * Registered"]` is not an error so much as an outcome — so the message is what
 * gets shown, and `ok` reflects whether an account was actually created.
 */
export async function signUp({ email, fullName, redirectTo = '/' }) {
  const result = await call('frappe.core.doctype.user.user.sign_up', {
    email,
    full_name: fullName,
    redirect_to: redirectTo
  })

  const [code, message] = Array.isArray(result) ? result : [0, String(result ?? '')]
  return {
    ok: code === 1,
    // "Already Registered" is worth routing back to the sign-in form rather
    // than leaving the user staring at the register one.
    alreadyRegistered: /already registered/i.test(message ?? ''),
    message: message || 'Sign-up did not return a message.'
  }
}

/**
 * Send a password reset link.
 *
 * `frappe.core.doctype.user.user.reset_password(user)`. It answers the same way
 * whether or not the address exists — deliberately, so the endpoint cannot be
 * used to enumerate accounts — and it replies through `_server_messages` rather
 * than `message`, so `call()` hands back the whole envelope.
 */
export async function requestPasswordReset(user) {
  const payload = await call('frappe.core.doctype.user.user.reset_password', { user })
  return { message: firstServerMessage(payload) }
}

/** Pull the human-readable string out of Frappe's `_server_messages` envelope. */
function firstServerMessage(payload) {
  try {
    const messages = JSON.parse(payload?._server_messages ?? '[]')
    const first = messages[0]
    const parsed = typeof first === 'string' ? JSON.parse(first) : first
    return parsed?.message ?? ''
  } catch {
    return ''
  }
}
