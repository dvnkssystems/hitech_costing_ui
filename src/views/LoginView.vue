<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useSessionStore } from '@/stores/session'
import { useAppStore } from '@/stores/app'
import { hasBackend } from '@/lib/frappe'
import { signUp, requestPasswordReset, googleLoginEnabled, googleLoginUrl } from '@/lib/auth'
import LucideIcon from '@/components/LucideIcon.vue'

const router = useRouter()
const route = useRoute()
const session = useSessionStore()
const { pending, error } = storeToRefs(session)
const { companyName } = storeToRefs(useAppStore())

/** 'login' | 'register' | 'forgot' — the design's three panes, one at a time. */
const mode = ref('login')

const usr = ref('')
const pwd = ref('')
const showPassword = ref(false)
const rememberEmail = ref(false)

const regFirst = ref('')
const regLast = ref('')
const regEmail = ref('')
const regTerms = ref(false)
const regBusy = ref(false)
const regResult = ref(null)

const resetEmail = ref('')
const resetBusy = ref(false)
const resetSentTo = ref('')
const resetMessage = ref('')
const localError = ref('')

const live = computed(() => hasBackend)
const canSubmit = computed(() => usr.value.trim() && pwd.value && !pending.value && live.value)
const canRegister = computed(
  () => regFirst.value.trim() && regEmail.value.trim() && regTerms.value && !regBusy.value && live.value
)
const canReset = computed(() => resetEmail.value.trim() && !resetBusy.value && live.value)

// Where to land after signing in — set by the router guard on the way here.
const redirect = computed(() =>
  typeof route.query.redirect === 'string' ? route.query.redirect : '/'
)

/**
 * The left panel's feature strip.
 *
 * These describe real, load-bearing invariants of the costing module rather
 * than business figures — there is no session on the login screen, so nothing
 * here could be queried even in principle, and unlike a stats strip these
 * claims don't need real numbers behind them.
 */
const FEATURES = [
  { icon: 'palette', text: 'One paint lookup, keyed on make and DFT band together — never two ways to price it' },
  { icon: 'calculator', text: 'Labour rate derived per tank type, from that type\'s own departments and capacity' },
  { icon: 'shield-check', text: 'BU Head, then CFO — no quotation reaches a customer before both approve it' }
]

const REMEMBER_KEY = 'hitech-costing:last-user'

/* ── Actions ────────────────────────────────────────────────────────────── */

async function submit() {
  if (!canSubmit.value) return
  const id = usr.value.trim()
  const ok = await session.login(id, pwd.value)
  if (!ok) return

  // Persist only the identifier, never the password. Cleared as soon as the box
  // is unticked so the choice is reversible from the same screen.
  try {
    if (rememberEmail.value) localStorage.setItem(REMEMBER_KEY, id)
    else localStorage.removeItem(REMEMBER_KEY)
  } catch {
    // Private browsing or a blocked store — remembering is a convenience, not a
    // reason to fail the sign-in that already succeeded.
  }
  router.replace(redirect.value)
}

async function register() {
  if (!canRegister.value) return
  regBusy.value = true
  localError.value = ''
  regResult.value = null
  try {
    regResult.value = await signUp({
      email: regEmail.value.trim(),
      fullName: [regFirst.value.trim(), regLast.value.trim()].filter(Boolean).join(' '),
      redirectTo: redirect.value
    })
    if (regResult.value.alreadyRegistered) usr.value = regEmail.value.trim()
  } catch (e) {
    localError.value = e?.message ?? String(e)
  } finally {
    regBusy.value = false
  }
}

async function sendReset() {
  if (!canReset.value) return
  resetBusy.value = true
  localError.value = ''
  try {
    const { message } = await requestPasswordReset(resetEmail.value.trim())
    resetSentTo.value = resetEmail.value.trim()
    resetMessage.value = message
  } catch (e) {
    localError.value = e?.message ?? String(e)
  } finally {
    resetBusy.value = false
  }
}

const goGoogle = () => {
  globalThis.location.href = googleLoginUrl(redirect.value)
}

function go(next) {
  mode.value = next
  localError.value = ''
  regResult.value = null
  session.error = ''
  if (next !== 'forgot') resetSentTo.value = ''
}

// A message from one pane should not linger over another.
watch(mode, () => {
  showPassword.value = false
})

onMounted(() => {
  // Already signed in (e.g. hit /login directly) — don't make them do it twice.
  if (session.isLoggedIn) {
    router.replace(redirect.value)
    return
  }
  try {
    const remembered = localStorage.getItem(REMEMBER_KEY)
    if (remembered) {
      usr.value = remembered
      rememberEmail.value = true
    }
  } catch {
    // No store available — start blank.
  }
})

/* ── Shared inline styles ───────────────────────────────────────────────── */

const fieldStyle =
  'width:100%; height:46px; border:1px solid #E6EBF1; border-radius:11px; padding:0 14px; font-size:14.5px; background:#FCFDFE; font-family:inherit;'
const labelStyle = 'display:block; font-size:13px; font-weight:600; color:#475569; margin-bottom:7px;'
const linkButton =
  'background:none; border:none; padding:0; font-weight:700; color:#EA580C; cursor:pointer; font-family:inherit;'
const backButton =
  'display:inline-flex; align-items:center; gap:7px; background:none; border:none; padding:0; margin-bottom:16px; font-size:13px; font-weight:600; color:#64748B; cursor:pointer; font-family:inherit;'

const primaryStyle = (enabled) => ({
  width: '100%',
  height: '48px',
  border: 'none',
  borderRadius: '12px',
  background: enabled ? '#F97316' : '#FDBA74',
  color: '#fff',
  fontSize: '15px',
  fontWeight: '700',
  cursor: enabled ? 'pointer' : 'not-allowed',
  fontFamily: 'inherit',
  boxShadow: enabled ? '0 6px 16px rgba(249,115,22,.28)' : 'none'
})

const year = new Date().getFullYear()
</script>

<template>
  <div class="auth-shell">
    <!-- ── LEFT: brand panel ─────────────────────────────────────────────
         The design puts a port photograph behind this. There is no asset in
         the repo, and the mock's own image slot is empty, so the gradient
         stands alone over the slate ground — which is what the design shows
         with no photo dropped in. Add one behind `.auth-art` when there is a
         licensed image to use. -->
    <div class="auth-art">
      <div
        style="position:absolute; inset:0; background:linear-gradient(160deg, rgba(15,23,42,.86) 0%, rgba(15,23,42,.62) 45%, rgba(249,115,22,.34) 100%); pointer-events:none;"
      ></div>
      <div
        style="position:relative; height:100%; overflow-y:auto; display:flex; flex-direction:column; justify-content:space-between; gap:34px; padding:40px 46px; color:#fff;"
      >
        <div style="display:flex; align-items:center; gap:12px;">
          <div
            style="width:40px; height:40px; border-radius:12px; background:#F97316; display:flex; align-items:center; justify-content:center; font-size:22px; box-shadow:0 6px 18px rgba(249,115,22,.4);"
          >
            <LucideIcon name="calculator" />
          </div>
          <div>
            <div style="font-size:17px; font-weight:800; letter-spacing:-.02em; line-height:1;">{{ companyName }}</div>
            <div style="font-size:11px; color:rgba(255,255,255,.62); font-weight:600; letter-spacing:.08em; margin-top:4px;">
              TANK &amp; RADIATOR COSTING
            </div>
          </div>
        </div>

        <div style="max-width:460px;">
          <div
            style="display:inline-flex; align-items:center; gap:7px; background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.2); padding:6px 13px; border-radius:999px; font-size:12.5px; font-weight:600; margin-bottom:18px;"
          >
            <LucideIcon name="shield-check" /> Geometry to quotation, one worksheet
          </div>
          <h1 style="margin:0 0 14px; font-size:40px; line-height:1.1; font-weight:800; letter-spacing:-.03em;">
            One costing sheet, the same rules every time.
          </h1>
          <p style="margin:0 0 26px; font-size:15.5px; line-height:1.65; color:rgba(255,255,255,.78);">
            Material, labour, paint and complexity roll up into one worksheet, gated by a BU Head and CFO
            approval before it ever becomes a quotation.
          </p>
          <div style="display:flex; flex-direction:column; gap:11px;">
            <div
              v-for="f in FEATURES"
              :key="f.icon"
              style="display:flex; align-items:center; gap:11px; font-size:14px; color:rgba(255,255,255,.9);"
            >
              <span
                style="width:24px; height:24px; flex:none; border-radius:7px; background:rgba(255,255,255,.16); display:flex; align-items:center; justify-content:center; font-size:14px;"
              >
                <LucideIcon :name="f.icon" />
              </span>
              {{ f.text }}
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- ── RIGHT: forms ─────────────────────────────────────────────────── -->
    <div style="flex:1 1 52%; min-width:0; display:flex; flex-direction:column; overflow-y:auto; background:#fff;">
      <div style="flex:1; display:flex; align-items:center; justify-content:center; padding:48px 30px;">
        <div style="width:100%; max-width:410px;">
          <!-- Offline notice applies to every pane. -->
          <div
            v-if="!live"
            style="display:flex; align-items:flex-start; gap:11px; background:#EFF6FF; border:1px solid #BFDBFE; border-radius:12px; padding:13px 15px; margin-bottom:20px;"
          >
            <span style="color:#2563EB; font-size:16px; flex:none;"><LucideIcon name="info" /></span>
            <div style="font-size:12.5px; color:#2563EB; line-height:1.5;">
              No backend configured, so there is nothing to sign in to. Set <code>VITE_FRAPPE_URL</code> in
              <code>.env</code> to enable login.
            </div>
          </div>

          <div
            v-if="error || localError"
            style="display:flex; align-items:flex-start; gap:11px; background:#FEF2F2; border:1px solid #FECACA; border-radius:12px; padding:13px 15px; margin-bottom:18px;"
          >
            <span style="color:#DC2626; font-size:16px; flex:none;"><LucideIcon name="x" /></span>
            <div style="font-size:12.5px; color:#B91C1C; line-height:1.5; word-break:break-word;">
              {{ error || localError }}
            </div>
          </div>

          <!-- ══ LOGIN ══ -->
          <form v-if="mode === 'login'" @submit.prevent="submit">
            <h2 style="margin:0 0 7px; font-size:27px; font-weight:800; letter-spacing:-.03em;">Welcome back</h2>
            <p style="margin:0 0 26px; font-size:14.5px; color:#64748B; line-height:1.6;">
              Sign in to your {{ companyName }} workspace.
            </p>

            <template v-if="googleLoginEnabled">
              <button
                type="button"
                @click="goGoogle"
                style="width:100%; height:48px; display:flex; align-items:center; justify-content:center; gap:10px; background:#fff; border:1px solid #E2E8F0; border-radius:12px; font-size:14.5px; font-weight:600; color:#0F172A; cursor:pointer; font-family:inherit;"
                class="hv4"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.5 5.5 0 0 1-2.4 3.6v3h3.88c2.27-2.09 3.57-5.17 3.57-8.79z"/>
                  <path fill="#34A853" d="M12 24c3.24 0 5.96-1.08 7.94-2.92l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24z"/>
                  <path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.28a12 12 0 0 0 0 10.76l4.01-3.1z"/>
                  <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.18 15.24 0 12 0A12 12 0 0 0 1.28 6.62l4.01 3.1C6.23 6.88 8.88 4.77 12 4.77z"/>
                </svg>
                Continue with Google
              </button>
              <div style="display:flex; align-items:center; gap:14px; margin:22px 0;">
                <div style="flex:1; height:1px; background:#EAEEF3;"></div>
                <span style="font-size:12px; font-weight:600; color:#94A3B8; letter-spacing:.04em;">OR</span>
                <div style="flex:1; height:1px; background:#EAEEF3;"></div>
              </div>
            </template>

            <div style="display:flex; flex-direction:column; gap:16px;">
              <div>
                <label for="login-usr" :style="labelStyle">Email or username</label>
                <input
                  id="login-usr"
                  v-model="usr"
                  type="text"
                  autocomplete="username"
                  placeholder="you@company.com"
                  :disabled="!live"
                  :style="fieldStyle"
                />
              </div>

              <div>
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:7px;">
                  <label for="login-pwd" style="font-size:13px; font-weight:600; color:#475569;">Password</label>
                  <button type="button" @click="go('forgot')" :style="linkButton" style="font-size:12.5px;" class="hv5">
                    Forgot password?
                  </button>
                </div>
                <div style="position:relative;">
                  <input
                    id="login-pwd"
                    v-model="pwd"
                    :type="showPassword ? 'text' : 'password'"
                    autocomplete="current-password"
                    placeholder="••••••••"
                    :disabled="!live"
                    :style="fieldStyle"
                    style="padding-right:46px;"
                  />
                  <button
                    type="button"
                    :aria-label="showPassword ? 'Hide password' : 'Show password'"
                    @click="showPassword = !showPassword"
                    style="position:absolute; right:6px; top:50%; transform:translateY(-50%); width:34px; height:34px; border:none; background:none; color:#94A3B8; font-size:17px; display:flex; align-items:center; justify-content:center; cursor:pointer; border-radius:8px;"
                    class="hv2"
                  >
                    <LucideIcon :name="showPassword ? 'eye-off' : 'eye'" />
                  </button>
                </div>
              </div>

              <!-- Not "keep me signed in": Frappe's session lifetime is a
                   server setting and its login endpoint takes no per-request
                   flag, so a checkbox promising that would do nothing. This
                   remembers the identifier only, which it genuinely does. -->
              <label style="display:flex; align-items:center; gap:9px; font-size:13.5px; font-weight:600; color:#475569; cursor:pointer;">
                <input type="checkbox" v-model="rememberEmail" style="width:16px; height:16px; accent-color:#F97316;" />
                Remember my email on this device
              </label>

              <button type="submit" :disabled="!canSubmit" :style="primaryStyle(canSubmit)">
                {{ pending ? 'Signing in…' : 'Sign in' }}
              </button>
            </div>

            <div style="margin-top:24px; font-size:13.5px; color:#64748B; text-align:center;">
              New to {{ companyName }}?
              <button type="button" @click="go('register')" :style="linkButton" style="font-size:13.5px;" class="hv5">
                Create an account
              </button>
            </div>
          </form>

          <!-- ══ REGISTER ══ -->
          <form v-else-if="mode === 'register'" @submit.prevent="register">
            <button type="button" @click="go('login')" :style="backButton">
              <LucideIcon name="arrow-left" /> Back to sign in
            </button>
            <h2 style="margin:0 0 7px; font-size:27px; font-weight:800; letter-spacing:-.03em;">Create your account</h2>
            <p style="margin:0 0 24px; font-size:14.5px; color:#64748B; line-height:1.6;">
              We'll email you a link to verify the address and set your own password.
            </p>

            <!-- Outcome replaces the form: there is nothing useful to do with
                 it still on screen. -->
            <div v-if="regResult" style="margin-bottom:20px;">
              <div
                :style="{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '16px 18px',
                  borderRadius: '13px',
                  background: regResult.ok ? '#F0FDF4' : '#FFFBEB',
                  border: `1px solid ${regResult.ok ? '#BBF7D0' : '#FDE68A'}`
                }"
              >
                <span :style="{ color: regResult.ok ? '#15803D' : '#B45309', fontSize: '18px', flex: 'none' }">
                  <LucideIcon :name="regResult.ok ? 'mail-check' : 'info'" />
                </span>
                <div :style="{ fontSize: '13.5px', lineHeight: '1.6', color: regResult.ok ? '#14532D' : '#78350F' }">
                  {{ regResult.message }}
                </div>
              </div>
              <button
                type="button"
                @click="go('login')"
                style="margin-top:14px; background:#0F172A; border:none; color:#fff; padding:12px 22px; border-radius:11px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit;"
              >
                Back to sign in
              </button>
            </div>

            <div v-else style="display:flex; flex-direction:column; gap:15px;">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div>
                  <label for="reg-first" :style="labelStyle">First name</label>
                  <input id="reg-first" v-model="regFirst" placeholder="Alex" :disabled="!live" :style="fieldStyle" />
                </div>
                <div>
                  <label for="reg-last" :style="labelStyle">Last name</label>
                  <input id="reg-last" v-model="regLast" placeholder="Morgan" :disabled="!live" :style="fieldStyle" />
                </div>
              </div>
              <div>
                <label for="reg-email" :style="labelStyle">Work email</label>
                <input
                  id="reg-email"
                  v-model="regEmail"
                  type="email"
                  autocomplete="email"
                  placeholder="you@company.com"
                  :disabled="!live"
                  :style="fieldStyle"
                />
              </div>

              <label style="display:flex; align-items:flex-start; gap:9px; font-size:13px; font-weight:500; color:#64748B; cursor:pointer; line-height:1.55;">
                <input type="checkbox" v-model="regTerms" style="width:16px; height:16px; margin-top:2px; accent-color:#F97316;" />
                <span>I agree to the Terms of Service and Privacy Policy.</span>
              </label>

              <button type="submit" :disabled="!canRegister" :style="primaryStyle(canRegister)">
                {{ regBusy ? 'Creating…' : 'Create account' }}
              </button>

              <div style="font-size:12.5px; color:#94A3B8; line-height:1.6;">
                Your workspace administrator decides which company and role the account gets — those are set on the
                Frappe user record after the address is verified.
              </div>
            </div>
          </form>

          <!-- ══ FORGOT PASSWORD ══ -->
          <div v-else>
            <form v-if="!resetSentTo" @submit.prevent="sendReset">
              <button type="button" @click="go('login')" :style="backButton">
                <LucideIcon name="arrow-left" /> Back to sign in
              </button>
              <div
                style="width:46px; height:46px; border-radius:13px; background:#FFF7ED; color:#EA580C; display:flex; align-items:center; justify-content:center; font-size:22px; margin-bottom:16px;"
              >
                <LucideIcon name="key-round" />
              </div>
              <h2 style="margin:0 0 7px; font-size:27px; font-weight:800; letter-spacing:-.03em;">Reset your password</h2>
              <p style="margin:0 0 24px; font-size:14.5px; color:#64748B; line-height:1.6;">
                Enter the email on your account and we'll send a link to set a new password.
              </p>
              <div style="display:flex; flex-direction:column; gap:16px;">
                <div>
                  <label for="reset-email" :style="labelStyle">Work email</label>
                  <input
                    id="reset-email"
                    v-model="resetEmail"
                    type="email"
                    autocomplete="email"
                    placeholder="you@company.com"
                    :disabled="!live"
                    :style="fieldStyle"
                  />
                </div>
                <button type="submit" :disabled="!canReset" :style="primaryStyle(canReset)">
                  {{ resetBusy ? 'Sending…' : 'Send reset link' }}
                </button>
              </div>
            </form>

            <div v-else style="text-align:center;">
              <div
                style="width:54px; height:54px; border-radius:16px; background:#DCFCE7; color:#15803D; display:flex; align-items:center; justify-content:center; font-size:26px; margin:0 auto 18px;"
              >
                <LucideIcon name="mail-check" />
              </div>
              <h2 style="margin:0 0 8px; font-size:26px; font-weight:800; letter-spacing:-.03em;">Check your inbox</h2>
              <p style="margin:0 0 6px; font-size:14.5px; color:#64748B; line-height:1.65;">We sent a reset link to</p>
              <div style="font-size:15px; font-weight:700; color:#0F172A; margin-bottom:22px; word-break:break-all;">
                {{ resetSentTo }}
              </div>
              <!-- Frappe answers identically whether or not the address exists,
                   so it cannot be used to find out who has an account. Say so
                   rather than implying the mail definitely went out. -->
              <div
                style="padding:16px 18px; border:1px solid #EAEEF3; background:#FCFDFE; border-radius:13px; font-size:13.5px; color:#64748B; line-height:1.65; text-align:left; margin-bottom:20px;"
              >
                {{ resetMessage || 'If that address is registered, the reset instructions are on their way.' }}
                Nothing after a minute or two? Check spam, or confirm your administrator has invited that address to the
                workspace.
              </div>
              <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
                <button
                  type="button"
                  @click="resetSentTo = ''"
                  style="background:#fff; border:1px solid #E2E8F0; color:#0F172A; padding:12px 20px; border-radius:11px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit;"
                  class="hv2"
                >
                  Try another address
                </button>
                <button
                  type="button"
                  @click="go('login')"
                  style="background:#0F172A; border:none; color:#fff; padding:12px 22px; border-radius:11px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit;"
                >
                  Back to sign in
                </button>
              </div>
            </div>
          </div>

          <div
            style="margin-top:34px; padding-top:18px; border-top:1px solid #F1F5F9; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:12.5px; color:#94A3B8;"
          >
            <span>© {{ year }} {{ companyName }}</span>
            <span style="display:inline-flex; align-items:center; gap:6px;">
              <LucideIcon name="shield-check" /> Session security is managed by your Frappe site
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
a {
  text-decoration: none;
}
input:disabled {
  background: #f8fafc;
  color: #94a3b8;
}
input:focus,
select:focus {
  outline: none;
  border-color: #f97316;
  box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.12);
}

.auth-shell {
  display: flex;
  min-height: 100vh;
  width: 100%;
  background: #fff;
}

.auth-art {
  flex: 1 1 48%;
  min-width: 300px;
  position: relative;
  overflow: hidden;
  background: #0f172a;
}

/* The brand panel is decoration; below this width it would squeeze the form
   that people actually came here for. Drop it rather than stack it. */
@media (max-width: 900px) {
  .auth-art {
    display: none;
  }
}
</style>
