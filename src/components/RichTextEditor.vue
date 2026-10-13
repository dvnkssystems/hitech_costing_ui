<script setup>
/**
 * A small WYSIWYG box for a Text Editor field (e.g. Quotation's Term Details).
 *
 * The SDK's ControlTextEditor puts the HTML source in a plain textarea while
 * editable (see `renderTextEditorsAsHtml` in `lib/frappeRouting.js`), so a
 * terms template shows up as `<p>…</p>`. This edits the formatted text
 * instead, the way the desk's Quill editor does, with the handful of
 * formatting buttons terms need. No dependency: `contenteditable` plus
 * `document.execCommand`, which every browser still supports for this.
 */
import { ref, watch, onMounted } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue'])

const el = ref(null)
let lastEmitted = null

function render(html) {
  if (el.value && el.value.innerHTML !== (html ?? '')) el.value.innerHTML = html ?? ''
}
onMounted(() => render(props.modelValue))
// Only overwrite the box for a change that came from outside (a template
// picked, a reload) — re-rendering our own edits would throw the caret away.
watch(
  () => props.modelValue,
  (v) => {
    if (v !== lastEmitted) render(v)
  }
)

function onInput() {
  const html = el.value.innerHTML
  lastEmitted = html === '<br>' ? '' : html
  emit('update:modelValue', lastEmitted)
}

function exec(command, value = null) {
  if (props.disabled) return
  el.value?.focus()
  document.execCommand(command, false, value)
  onInput()
}

const TOOLS = [
  { label: 'B', title: 'Bold', run: () => exec('bold'), style: 'font-weight:800;' },
  { label: 'I', title: 'Italic', run: () => exec('italic'), style: 'font-style:italic;' },
  { label: 'U', title: 'Underline', run: () => exec('underline'), style: 'text-decoration:underline;' },
  { label: 'H', title: 'Heading', run: () => exec('formatBlock', '<h4>'), style: 'font-weight:800;' },
  { label: '¶', title: 'Normal text', run: () => exec('formatBlock', '<p>') },
  { label: '• List', title: 'Bulleted list', run: () => exec('insertUnorderedList') },
  { label: '1. List', title: 'Numbered list', run: () => exec('insertOrderedList') },
  { label: 'Clear', title: 'Clear formatting', run: () => exec('removeFormat') }
]
</script>

<template>
  <div class="rte" :class="{ 'rte--disabled': disabled }">
    <div v-if="!disabled" class="rte__toolbar">
      <button
        v-for="t in TOOLS"
        :key="t.title"
        type="button"
        class="rte__btn"
        :title="t.title"
        :style="t.style"
        @mousedown.prevent="t.run"
      >
        {{ t.label }}
      </button>
    </div>
    <div
      ref="el"
      class="rte__body"
      :contenteditable="!disabled"
      :data-placeholder="placeholder"
      @input="onInput"
    />
  </div>
</template>

<style scoped>
.rte {
  border: 1px solid #e6ebf1;
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
}
.rte__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid #eef2f6;
  background: #f8fafc;
}
.rte__btn {
  height: 28px;
  min-width: 30px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #334155;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.rte__btn:hover {
  background: #e9eff7;
  border-color: #dbe3ec;
}
.rte__body {
  min-height: 160px;
  max-height: 420px;
  overflow-y: auto;
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.55;
  color: #0f172a;
  outline: none;
}
.rte__body:empty::before {
  content: attr(data-placeholder);
  color: #94a3b8;
}
.rte__body :deep(ol),
.rte__body :deep(ul) {
  padding-left: 22px;
  margin: 4px 0;
}
.rte__body :deep(p) {
  margin: 0 0 6px;
}
.rte--disabled {
  background: #f8fafc;
}
</style>
