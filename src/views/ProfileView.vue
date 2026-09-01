<script setup>
import { ref, shallowRef, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { FormView, useFrmRemote } from '@frappe-vue-sdk/vue'
import { call, uploadFile, metaFetcher, hasBackend } from '@/lib/frappe'
import { installRouting, renderTextEditorsAsHtml } from '@/lib/frappeRouting'
import { installDeskApis } from '@/lib/mappedDoc'
import { nativeClientScripts } from '@/lib/clientScripts'
import { coerceTableFields, hideEmptyReadOnlyFields } from '@/lib/frmCompat'
import { useSessionStore } from '@/stores/session'
import LucideIcon from '@/components/LucideIcon.vue'

const router = useRouter()
const session = useSessionStore()
const { user, userImage } = storeToRefs(session)

const frm = shallowRef(null)
const loading = ref(true)
const error = ref('')
const loggingOut = ref(false)

const live = computed(() => hasBackend)
const displayName = computed(() => session.displayName)
const initials = computed(() => session.initials)

async function load() {
  loading.value = true
  error.value = ''

  if (!live.value) {
    loading.value = false
    return
  }

  try {
    await session.resolve()
    if (!session.isLoggedIn) {
      router.replace({ name: 'login', query: { redirect: '/profile' } })
      return
    }
    // The signed-in user's own User record — the same form Frappe's desk shows
    // under My Settings.
    const result = await useFrmRemote({
      transport: call,
      metaFetcher,
      doctype: 'User',
      name: session.user,
      upload_file: uploadFile,
      autoBoot: true,
      scripts: [
        nativeClientScripts('User'),
        renderTextEditorsAsHtml('User'),
        hideEmptyReadOnlyFields('User')
      ]
    })
    // Makes the Link fields' open-document arrow navigate instead of no-op.
    installRouting(router, result.frappe)
    installDeskApis(result.frappe, router)
    frm.value = coerceTableFields(result.frm)
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

async function onLogout() {
  loggingOut.value = true
  await session.logout()
  loggingOut.value = false
  router.replace({ name: 'login' })
}

// SDK is browser-only — see the note in DocFormView.vue.
onMounted(load)
</script>

<template>
  <div style="padding:30px 36px 80px; margin:0 auto;">
    <div
      style="font-size:13px; color:#94A3B8; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:14px;"
    >
      <RouterLink to="/" style="color:#64748B;">Dashboard</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <span style="color:#16A34A;">Profile</span>
    </div>

    <!-- identity header -->
    <div
      style="display:flex; align-items:center; gap:16px; flex-wrap:wrap; background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:20px 22px; margin-bottom:18px; box-shadow:0 1px 2px rgba(15,23,42,.04);"
    >
      <img
        v-if="userImage"
        :src="userImage"
        alt=""
        style="width:56px; height:56px; border-radius:50%; object-fit:cover; flex:none;"
      />
      <div
        v-else
        style="width:56px; height:56px; border-radius:50%; background:#0F172A; color:#fff; display:flex; align-items:center; justify-content:center; font-size:19px; font-weight:700; flex:none;"
      >
        {{ initials }}
      </div>

      <div style="flex:1; min-width:180px;">
        <h1 style="margin:0; font-size:22px; font-weight:800; letter-spacing:-.025em;">{{ displayName }}</h1>
        <div style="font-size:13.5px; color:#64748B; margin-top:4px;">
          {{ live && user ? user : 'Signed-out preview' }}
        </div>
      </div>

      <button
        :disabled="loggingOut || !live"
        @click="onLogout"
        style="display:flex; align-items:center; gap:8px; background:#fff; color:#DC2626; border:1px solid #FECACA; padding:11px 18px; border-radius:11px; font-size:14.5px; font-weight:600; cursor:pointer; font-family:inherit;"
        class="hv9"
      >
        <span style="font-size:16px;"><LucideIcon name="lock" /></span>
        {{ loggingOut ? 'Signing out…' : 'Log out' }}
      </button>
    </div>

    <div
      v-if="!live"
      style="display:flex; align-items:center; gap:14px; background:#EFF6FF; border:1px solid #BFDBFE; border-radius:13px; padding:15px 18px; margin-bottom:18px; flex-wrap:wrap;"
    >
      <span
        style="width:34px; height:34px; border-radius:9px; background:#fff; color:#2563EB; display:flex; align-items:center; justify-content:center; font-size:17px; flex:none;"
        ><LucideIcon name="info" /></span
      >
      <div style="flex:1; min-width:200px;">
        <div style="font-size:14.5px; font-weight:700; color:#1E40AF;">No backend configured</div>
        <div style="font-size:13px; color:#2563EB; margin-top:2px;">
          Profile details come from the Frappe <code>User</code> record. Set <code>VITE_FRAPPE_URL</code>
          in <code>.env</code> to sign in and load them.
        </div>
      </div>
    </div>

    <div
      v-if="error"
      style="display:flex; align-items:flex-start; gap:12px; background:#FEF2F2; border:1px solid #FECACA; border-radius:13px; padding:15px 18px; margin-bottom:18px;"
    >
      <span style="color:#DC2626; font-size:17px; flex:none;"><LucideIcon name="x" /></span>
      <div style="min-width:0;">
        <div style="font-size:14.5px; font-weight:700; color:#991B1B;">Could not load your profile</div>
        <div style="font-size:13px; color:#B91C1C; margin-top:3px; word-break:break-word;">{{ error }}</div>
      </div>
    </div>

    <div
      v-if="loading"
      style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:48px; text-align:center; color:#94A3B8; font-size:14px; font-weight:600;"
    >
      Loading profile…
    </div>

    <div
      v-else-if="frm"
      style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:8px 20px 20px; box-shadow:0 1px 2px rgba(15,23,42,.04);"
    >
      <FormView :frm="frm" @error="error = $event" />
    </div>
  </div>
</template>

<style scoped>
a {
  text-decoration: none;
}
</style>
