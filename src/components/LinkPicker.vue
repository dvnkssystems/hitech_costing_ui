<script setup>
/**
 * A Frappe-style Link control.
 *
 * The desk's link field is a text box that searches the server as you type and
 * offers what it finds. A native `<datalist>` looks similar and is not the same
 * thing: it only filters a list the page already downloaded, so it cannot work
 * against 1,400 jobs, and it gives no keyboard model, no loading state and no
 * "nothing matches" feedback.
 *
 * This searches on every keystroke (debounced), so the list is never stale and
 * nothing is preloaded. Free text is still allowed — the caller decides whether
 * a value has to exist, because the reports behind these filters match with
 * LIKE and a partial is a legitimate thing to type.
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { db } from '@/lib/frappeDb'
import LucideIcon from '@/components/LucideIcon.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  doctype: { type: String, required: true },
  placeholder: { type: String, default: '' },
  /** Extra filters, in Frappe list form, e.g. [['Operations','is_trashed','!=',1]]. */
  filters: { type: Array, default: () => [] },
  orderBy: { type: String, default: 'modified desc' },
  disabled: { type: Boolean, default: false },
  /** Shown under the box when nothing is typed. */
  hint: { type: String, default: '' },
  /** Compact sizing, to sit in a dense filter row rather than a form column. */
  dense: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])

const text = ref(props.modelValue)
const open = ref(false)
const loading = ref(false)
const results = ref([])
const highlighted = ref(-1)
const rootEl = ref(null)

// The parent can reset filters; follow it without clobbering what is being typed.
watch(
  () => props.modelValue,
  (v) => {
    if (v !== text.value) text.value = v ?? ''
  }
)

let timer = null
let sequence = 0

async function search(txt) {
  // Every request carries a ticket. A slow early response landing after a fast
  // later one would otherwise repopulate the list with stale matches.
  const ticket = ++sequence
  loading.value = true
  try {
    const filters = [...props.filters]
    if (txt) filters.push([props.doctype, 'name', 'like', `%${txt}%`])

    const rows = await db.get_list(props.doctype, {
      fields: ['name'],
      filters,
      order_by: props.orderBy,
      limit_page_length: 20
    })
    if (ticket !== sequence) return
    results.value = (rows ?? []).map((r) => r.name).filter(Boolean)
  } catch {
    if (ticket === sequence) results.value = []
  } finally {
    if (ticket === sequence) loading.value = false
  }
}

function onInput() {
  emit('update:modelValue', text.value)
  open.value = true
  highlighted.value = -1
  clearTimeout(timer)
  timer = setTimeout(() => search(text.value.trim()), 200)
}

function onFocus() {
  open.value = true
  if (!results.value.length) search(text.value.trim())
}

function choose(name) {
  text.value = name
  emit('update:modelValue', name)
  open.value = false
  highlighted.value = -1
}

function clear() {
  text.value = ''
  emit('update:modelValue', '')
  results.value = []
  open.value = false
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    open.value = false
    return
  }
  if (!open.value && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    open.value = true
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlighted.value = Math.min(highlighted.value + 1, results.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlighted.value = Math.max(highlighted.value - 1, -1)
  } else if (e.key === 'Enter' && highlighted.value >= 0) {
    e.preventDefault()
    choose(results.value[highlighted.value])
  }
}

/* Clicking away closes the list. Bound only while it is open, and only in the
   browser — the render smoke test has no document. */
function onDocumentClick(e) {
  if (rootEl.value && !rootEl.value.contains(e.target)) open.value = false
}

watch(open, (isOpen) => {
  if (typeof document === 'undefined') return
  if (isOpen) document.addEventListener('mousedown', onDocumentClick)
  else document.removeEventListener('mousedown', onDocumentClick)
})

onBeforeUnmount(() => {
  clearTimeout(timer)
  if (typeof document !== 'undefined') document.removeEventListener('mousedown', onDocumentClick)
})

const showList = computed(() => open.value && !props.disabled)

const inputStyle = computed(() =>
  props.dense
    ? 'width:100%; height:34px; box-sizing:border-box; border:1px solid #DFE3E8; border-radius:7px; padding:0 52px 0 10px; font-size:12.5px; font-family:inherit; background:#fff; color:#0F172A;'
    : 'width:100%; height:44px; border:1px solid #E6EBF1; border-radius:10px; padding:0 62px 0 12px; font-size:14px; font-family:inherit; background:#fff;'
)

const optionStyle = (i) => ({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '9px 12px',
  border: 'none',
  background: highlighted.value === i ? '#FFF7ED' : 'transparent',
  color: highlighted.value === i ? '#9A3412' : '#334155',
  fontSize: '13.5px',
  fontWeight: highlighted.value === i ? '600' : '500',
  fontFamily: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis'
})
</script>

<template>
  <div ref="rootEl" style="position:relative;">
    <input
      v-model="text"
      :placeholder="placeholder"
      :disabled="disabled"
      autocomplete="off"
      :style="inputStyle"
      @input="onInput"
      @focus="onFocus"
      @keydown="onKeydown"
    />

    <div
      :style="`position:absolute; right:${dense ? 6 : 8}px; top:50%; transform:translateY(-50%); display:flex; align-items:center; gap:2px;`"
    >
      <span v-if="loading" style="color:#CBD5E1; font-size:14px; display:flex;" title="Searching…">
        <LucideIcon name="loader" />
      </span>
      <button
        v-if="text && !disabled"
        type="button"
        aria-label="Clear"
        @click="clear"
        :style="`width:${dense ? 20 : 26}px; height:${dense ? 20 : 26}px; border:none; background:none; color:#94A3B8; display:flex; align-items:center; justify-content:center; cursor:pointer; border-radius:6px; font-size:${dense ? 12 : 14}px;`"
        class="hv2"
      >
        <LucideIcon name="x" />
      </button>
      <span :style="`color:#CBD5E1; font-size:${dense ? 12 : 15}px; display:flex; pointer-events:none;`">
        <LucideIcon name="chevron-right" style="transform:rotate(90deg);" />
      </span>
    </div>

    <div
      v-if="showList"
      style="position:absolute; z-index:40; left:0; right:0; top:calc(100% + 4px); background:#fff; border:1px solid #E6EBF1; border-radius:11px; box-shadow:0 12px 28px rgba(15,23,42,.12); overflow:hidden; max-height:264px; overflow-y:auto;"
    >
      <button
        v-for="(name, i) in results"
        :key="name"
        type="button"
        :style="optionStyle(i)"
        @mouseenter="highlighted = i"
        @click="choose(name)"
      >
        {{ name }}
      </button>

      <div
        v-if="!results.length"
        style="padding:12px; font-size:13px; color:#94A3B8; font-weight:600;"
      >
        {{ loading ? 'Searching…' : `No ${doctype} matches “${text}”` }}
      </div>

      <div
        v-if="results.length >= 20"
        style="padding:8px 12px; border-top:1px solid #F1F5F9; font-size:11.5px; color:#94A3B8; font-weight:600;"
      >
        First 20 shown — keep typing to narrow.
      </div>
    </div>

    <div v-if="hint && !showList" style="font-size:10.5px; color:#94A3B8; margin-top:6px; line-height:1.35;">
      {{ hint }}
    </div>
  </div>
</template>
