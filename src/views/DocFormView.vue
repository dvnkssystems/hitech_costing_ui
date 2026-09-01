<script setup>
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { FormToolbar, useFrmRemote } from '@frappe-vue-sdk/vue'
import FormSections from '@/components/FormSections.vue'
import ChildRowDrawer from '@/components/ChildRowDrawer.vue'
import ActivityDrawer from '@/components/ActivityDrawer.vue'
import { fetchLayoutMap, formLayoutFor } from '@/lib/layouts'
import { call, uploadFile, metaFetcher, hasBackend } from '@/lib/frappe'
import { openPrintView } from '@/lib/print'
import { installFormEnhancements } from '@/lib/formEnhance'
import { installRouting, renderTextEditorsAsHtml, formRouteFor, listRouteFor } from '@/lib/frappeRouting'
import { nativeClientScripts } from '@/lib/clientScripts'
import {
  coerceTableFields,
  hideEmptyReadOnlyFields,
  restoreOnloadCustomButtons,
  lockOnSubmit,
  hideNamingSeries,
  installWorkflowActions
} from '@/lib/frmCompat'
import { installDeskApis, installAmend, seedPendingDoc, takePendingDoc } from '@/lib/mappedDoc'
import DocConnections from '@/components/DocConnections.vue'
import LucideIcon from '@/components/LucideIcon.vue'

/**
 * DocTypes whose workflow transition buttons `FormToolbar` should render, and
 * the field their Workflow record calls `workflow_state_field`. Without this,
 * `frm.doc.__workflow_transitions` never gets set — see `installWorkflowActions`
 * in `lib/frmCompat.js` for why the SDK/this app don't do it automatically.
 * Add an entry here for any other workflow-driven DocType.
 */
const WORKFLOW_STATE_FIELD = {
  'Costing Worksheet': 'status'
}

const props = defineProps({
  doctype: { type: String, required: true },
  name: { type: String, default: '' }
})

const router = useRouter()

// `frm` is a plain class instance carrying its own reactivity — shallowRef
// keeps Vue from installing a second proxy over it.
const frm = shallowRef(null)
const loading = ref(true)
const error = ref('')

const live = computed(() => hasBackend)

// Saving, submitting, cancelling, amending and Duplicate all live in the SDK's
// own FormToolbar, which is rendered below. Adding an app-level Save
// button here would duplicate it and would miss the rest of the lifecycle.
const heading = computed(() => {
  const docname = frm.value?.doc?.name
  if (!docname || String(docname).startsWith('New ')) return `New ${props.doctype}`
  return docname
})

/**
 * Which form template this DocType is mapped to, from the backend.
 *
 * `cards` (FormSections, derived from meta) is the only template today. A
 * DocType earns a bespoke one by adding a component to `lib/layouts.js` and a
 * `Custom UI Doctype Layout` record naming it.
 */
const layoutMap = ref(null)
onMounted(async () => {
  layoutMap.value = await fetchLayoutMap()
})
const formLayout = computed(() => formLayoutFor(layoutMap.value, frm.value?.doctype))

/** The server-side name, or '' while the document is still unsaved. */
const savedName = computed(() => {
  const docname = frm.value?.doc?.name
  return !docname || String(docname).startsWith('New ') ? '' : String(docname)
})

// Link clear buttons and required markers — see src/lib/formEnhance.js. Bound to the wrapper
// element, which wraps the toolbar and the section cards together.
const formEl = ref(null)
let teardownEnhancements = null
watch(formEl, (el) => {
  teardownEnhancements?.()
  teardownEnhancements = el ? installFormEnhancements(el, () => frm.value) : null
})
onBeforeUnmount(() => teardownEnhancements?.())

/** Open the DocType's default print format in a new tab. */
function onPrint() {
  if (!savedName.value) return
  error.value = ''
  try {
    openPrintView(props.doctype, savedName.value)
  } catch (e) {
    error.value = e?.message ?? String(e)
  }
}

async function load() {
  loading.value = true
  error.value = ''
  frm.value = null

  if (!live.value) {
    error.value = 'No Frappe backend configured. Set VITE_FRAPPE_URL in .env to render this form.'
    loading.value = false
    return
  }

  try {
    const result = await useFrmRemote({
      transport: call,
      // Populates globalThis.locals from getdoctype so submittable state and
      // child-table metas survive — see the note in src/lib/frappe.js.
      metaFetcher,
      doctype: props.doctype,
      // Empty name means "new document" to the SDK.
      name: props.name || null,
      upload_file: uploadFile,
      // Resolve `:Company`, `__user` and user defaults on new docs.
      autoBoot: true,
      // A doc built by "Create → …" on another form arrives here to be opened.
      initialDoc: props.name ? null : takePendingDoc(props.doctype),
      scripts: [
        nativeClientScripts(props.doctype),
        renderTextEditorsAsHtml(props.doctype),
        hideEmptyReadOnlyFields(props.doctype),
        lockOnSubmit(props.doctype),
        hideNamingSeries(props.doctype),
        ...(WORKFLOW_STATE_FIELD[props.doctype]
          ? [installWorkflowActions(props.doctype, { stateField: WORKFLOW_STATE_FIELD[props.doctype] })]
          : [])
      ]
    })
    // Makes the Link fields' open-document arrow navigate instead of no-op.
    installRouting(router, result.frappe)
    // erpnext.utils.map_current_doc / frappe.model.open_mapped_doc — the
    // ERPNext desk globals the mapped-doc buttons call.
    installDeskApis(result.frappe, router)
    // Buttons registered in `onload` are cleared by the refresh that follows
    // it — put them back before the toolbar renders.
    await restoreOnloadCustomButtons(result.frm)
    // The SDK's Amend calls a server method that does not exist; replace it
    // with the client-side copy Frappe actually performs. See lib/mappedDoc.
    installAmend(result.frm, router)
    frm.value = coerceTableFields(result.frm)
  } catch (e) {
    error.value = e?.message ?? String(e)
  } finally {
    loading.value = false
  }
}

/**
 * FormToolbar's Duplicate hands the copied document to the host and stops
 * there — the SDK owns no routing, so without this the button does nothing.
 */
function onDuplicate(copy) {
  if (!copy?.doctype) return
  seedPendingDoc(copy.doctype, copy)
  router.push(formRouteFor(copy.doctype))
}

// The SDK is browser-only — useFrmRemote assigns globalThis.frappe and
// globalThis.locals, which on a server would leak across requests. onMounted
// never runs during SSR.
onMounted(load)
watch([() => props.doctype, () => props.name], load)
</script>

<template>
  <div style="padding:30px 36px 80px; margin:0 auto;">
    <div
      style="font-size:13px; color:#94A3B8; font-weight:600; display:flex; align-items:center; gap:7px; margin-bottom:8px;"
    >
      <RouterLink to="/" style="color:#64748B;">Home</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <RouterLink :to="listRouteFor(doctype)" style="color:#64748B;">{{ doctype }}</RouterLink>
      <span style="font-size:13px;"><LucideIcon name="chevron-right" /></span>
      <span style="color:#16A34A;">{{ name || 'New' }}</span>
    </div>

    <div
      style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:20px;"
    >
      <div style="min-width:0;">
        <h1 style="margin:0; font-size:26px; font-weight:800; letter-spacing:-.025em;">{{ heading }}</h1>
      </div>

      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <!-- Only for a document that exists on the server: the print view renders
             from the stored record, so there is nothing to print before insert. -->
        <button
          v-if="live && savedName"
          @click="onPrint"
          title="Open the print format in a new tab"
          style="display:flex; align-items:center; gap:8px; background:#fff; color:#475569; border:1px solid #E2E8F0; padding:10px 16px; border-radius:11px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit;"
          class="hv2"
        >
          <span style="font-size:16px;"><LucideIcon name="printer" /></span> Print
        </button>
      </div>
    </div>

    <!-- Offline banner: no bench configured. -->
    <div
      v-if="!live && !loading"
      style="display:flex; align-items:center; gap:14px; background:#EFF6FF; border:1px solid #BFDBFE; border-radius:13px; padding:15px 18px; margin-bottom:18px; flex-wrap:wrap;"
    >
      <span
        style="width:34px; height:34px; border-radius:9px; background:#fff; color:#2563EB; display:flex; align-items:center; justify-content:center; font-size:17px; flex:none;"
        ><LucideIcon name="info" /></span
      >
      <div style="flex:1; min-width:200px;">
        <div style="font-size:14.5px; font-weight:700; color:#1E40AF;">No backend configured</div>
        <div style="font-size:13px; color:#2563EB; margin-top:2px;">
          Set <code>VITE_FRAPPE_URL</code> in <code>.env</code> to render <code>{{ doctype }}</code>.
        </div>
      </div>
    </div>

    <div
      v-if="error"
      style="display:flex; align-items:flex-start; gap:12px; background:#FEF2F2; border:1px solid #FECACA; border-radius:13px; padding:15px 18px; margin-bottom:18px;"
    >
      <span style="color:#DC2626; font-size:17px; flex:none;"><LucideIcon name="x" /></span>
      <div style="min-width:0;">
        <div style="font-size:14.5px; font-weight:700; color:#991B1B;">Form error</div>
        <div style="font-size:13px; color:#B91C1C; margin-top:3px; word-break:break-word;">{{ error }}</div>
      </div>
    </div>

    <div
      v-if="loading"
      style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:48px; text-align:center; color:#94A3B8; font-size:14px; font-weight:600;"
    >
      Loading form…
    </div>

    <!-- Kept out of the loading/form v-if chain above; inserting between them
         would break the v-else-if link. -->
    <template v-if="frm">
      <DocConnections v-if="live" :doctype="doctype" :docname="name" />

      <!-- FormToolbar + FormSections in one — Save, Submit, Cancel, Amend and
           Duplicate all live in the toolbar and none is reimplemented here. -->
      <div ref="formEl">
        <form class="frappe-form" @submit.prevent>
          <div
            style="background:#fff; border:1px solid #EAEEF3; border-radius:16px; padding:8px 20px; margin-bottom:18px; box-shadow:0 1px 2px rgba(15,23,42,.04);"
          >
            <FormToolbar :frm="frm" @error="error = $event" @duplicate="onDuplicate" />
          </div>
          <FormSections :frm="frm" :layout-name="formLayout" />
        </form>

        <!-- Child table rows open here rather than inside the grid — see
             src/lib/childRowDrawer.js. -->
        <ChildRowDrawer :frm="frm" :root="formEl" />
      </div>

      <!-- Frappe's own record of what happened to this document. -->
      <ActivityDrawer :frm="frm" />
    </template>
  </div>
</template>
