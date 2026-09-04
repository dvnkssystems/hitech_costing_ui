<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { db } from '@/lib/frappeDb'
import { formRouteFor, listRouteFor } from '@/lib/frappeRouting'
import { seedPendingDoc } from '@/lib/mappedDoc'
import LucideIcon from '@/components/LucideIcon.vue'

/**
 * The desk's "Connections" strip: the DocTypes that point back at this
 * document, each with a count.
 *
 * The SDK renders no such thing, but the data is already on hand — Frappe ships
 * the `DocType Link` rows inside the `getdoctype` payload as `links`, and
 * `metaFetcher` caches that whole payload into `globalThis.locals.DocType`. So
 * this reads the links from there and asks for one count per link.
 */
const props = defineProps({
  doctype: { type: String, required: true },
  docname: { type: String, default: '' }
})

const router = useRouter()
const links = ref([])
const loading = ref(false)

async function load() {
  links.value = []
  if (!props.docname) return

  const defs = (globalThis.locals?.DocType?.[props.doctype]?.links ?? []).filter(
    (l) => l.link_doctype && l.link_fieldname && !l.hidden
  )
  if (!defs.length) return

  loading.value = true
  try {
    links.value = await Promise.all(
      defs.map(async (l) => ({
        doctype: l.link_doctype,
        fieldname: l.link_fieldname,
        group: l.group || '',
        count: Number(
          await db.count(l.link_doctype, { [l.link_fieldname]: props.docname }).catch(() => 0)
        )
      }))
    )
  } finally {
    loading.value = false
  }
}

/**
 * Open the linked record, or start a new one already pointed back at this
 * document — the same two behaviours the desk's connection tiles have.
 *
 * With several links the first is opened; there is no list screen for arbitrary
 * DocTypes to hand off to.
 */
async function open(link) {
  if (link.count) {
    // Straight to the record when there's only one; otherwise the list,
    // filtered to this document.
    if (link.count === 1) {
      const rows = await db
        .get_list(link.doctype, {
          fields: ['name'],
          filters: { [link.fieldname]: props.docname },
          limit_page_length: 1
        })
        .catch(() => [])
      const first = rows?.[0]?.name
      if (first) {
        router.push(formRouteFor(link.doctype, first))
        return
      }
    }
    router.push({
      path: listRouteFor(link.doctype),
      query: { [link.fieldname]: props.docname }
    })
    return
  }

  // Nothing linked yet: seed a new document with the back-reference filled in.
  seedPendingDoc(link.doctype, {
    doctype: link.doctype,
    [link.fieldname]: props.docname
  })
  router.push(formRouteFor(link.doctype))
}

onMounted(load)
watch(() => [props.doctype, props.docname], load)
</script>

<template>
  <div
    v-if="links.length || loading"
    style="background:#fff; border:1px solid #EAEEF3; border-radius:8px; padding:18px 20px; margin-bottom:18px; box-shadow:0 1px 2px rgba(15,23,42,.04);"
  >
    <div
      style="font-size:11px; font-weight:700; letter-spacing:.08em; color:#94A3B8; text-transform:uppercase; margin-bottom:12px;"
    >
      Connections
    </div>

    <div v-if="loading" style="font-size:13.5px; color:#94A3B8; font-weight:600;">Loading…</div>

    <div v-else style="display:flex; flex-wrap:wrap; gap:10px;">
      <button
        v-for="link in links"
        :key="link.doctype"
        :title="link.count ? `Open ${link.doctype}` : `Create a ${link.doctype} for this document`"
        @click="open(link)"
        :style="{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '9px',
          height: '38px',
          padding: '0 14px',
          borderRadius: '10px',
          border: `1px solid ${link.count ? '#E2E8F0' : '#EEF2F6'}`,
          background: '#fff',
          color: link.count ? '#0F172A' : '#94A3B8',
          fontSize: '13.5px',
          fontWeight: '600',
          fontFamily: 'inherit',
          cursor: 'pointer'
        }"
        class="hv6"
      >
        {{ link.doctype }}
        <span
          :style="{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: '20px',
            height: '20px',
            padding: '0 6px',
            borderRadius: '999px',
            fontSize: '11.5px',
            fontWeight: '700',
            background: link.count ? '#E9EFF7' : '#F1F5F9',
            color: link.count ? '#0B3465' : '#94A0AE'
          }"
          >{{ link.count }}</span
        >
        <span style="font-size:14px; color:#CBD5E1;"><LucideIcon :name="link.count ? 'chevron-right' : 'plus'" /></span>
      </button>
    </div>
  </div>
</template>
