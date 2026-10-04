<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ToolViewProps } from '../../components/plugin-ui'

defineOptions({ name: 'cockpit-yaya-tool-snapshot' })

const props = defineProps<ToolViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

/** 默认只显示前 40 行，避免一次快照把卡片撑爆 */
const MAX_LINES = 40
const REF_RE = /\[ref=[^\]\s]+\]/g

const text = computed<string>(() => {
  const r = props.call.result
  if (typeof r === 'string') return r
  const snapshot = (r as { snapshot?: unknown } | undefined)?.snapshot
  return typeof snapshot === 'string' ? snapshot : ''
})
const lines = computed<string[]>(() => text.value.split('\n'))
const expanded = ref(false)

/** 折叠时只保留前 MAX_LINES 行 */
const visible = computed<string>(() => {
  if (expanded.value || lines.value.length <= MAX_LINES) return text.value
  return lines.value.slice(0, MAX_LINES).join('\n')
})

type Segment = { text: string } | { ref: string }
const segments = computed<Segment[]>(() => {
  const src = visible.value
  const out: Segment[] = []
  let last = 0
  for (const m of src.matchAll(REF_RE)) {
    if (m.index === undefined) continue
    if (m.index > last) out.push({ text: src.slice(last, m.index) })
    out.push({ ref: m[0] })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ text: src.slice(last) })
  return out
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 无障碍树文本：原样保留缩进，只把 [ref=eN] 包成小 chip */
const html = computed<string>(() =>
  segments.value
    .map((s) =>
      'ref' in s ? `<span class="snap-ref">${escapeHtml(s.ref)}</span>` : escapeHtml(s.text)
    )
    .join('')
)

const copied = ref(false)
async function copy(): Promise<void> {
  if (!text.value) return
  try {
    await window.cockpit.copyText(text.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* 复制失败不打扰 */
  }
}
</script>

<template>
  <div class="snap">
    <div class="snap-bar">
      <v-icon icon="mdi-file-tree-outline" size="16" class="text-medium-emphasis" />
      <span class="text-caption text-medium-emphasis">
        {{ te('yaya.plugin.cockpit.snap_lines', { n: String(lines.length) }, '共 {n} 行') }}
      </span>
      <v-spacer />
      <v-btn
        icon
        size="small"
        variant="text"
        density="comfortable"
        :title="copied ? t('yaya.copied', '已复制') : t('yaya.copy', '复制')"
        :aria-label="copied ? t('yaya.copied', '已复制') : t('yaya.copy', '复制')"
        @click="copy"
      >
        <v-icon :icon="copied ? 'mdi-check' : 'mdi-content-copy-outline'" size="18" />
      </v-btn>
      <v-btn v-if="lines.length > MAX_LINES" variant="text" @click="expanded = !expanded">
        {{
          expanded
            ? t('yaya.input.collapse', '收起')
            : te(
                'yaya.plugin.cockpit.snap_expand',
                { n: String(lines.length) },
                '展开全部（{n} 行）'
              )
        }}
      </v-btn>
    </div>

    <!-- eslint-disable-next-line vue/no-v-html -- escapeHtml 已转义，只多包了一层 span -->
    <pre v-if="html" class="snap-text" v-html="html" />
    <div v-else class="snap-empty text-body-2 text-medium-emphasis">
      {{ t('yaya.plugin.cockpit.snap_empty', '没有快照内容') }}
    </div>
  </div>
</template>

<style scoped>
.snap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.snap-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.snap-text {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.05);
  font-family: ui-monospace, monospace;
  font-size: 0.78rem;
  line-height: 1.6;
  white-space: pre;
  overflow-x: auto;
  max-height: 420px;
  overflow-y: auto;
}
/* 交互元素的 ref：小 chip，和正文区分又不抢眼 */
.snap-ref {
  display: inline-block;
  padding: 0 5px;
  margin-inline: 1px;
  border-radius: 6px;
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.snap-empty {
  padding-block: 4px;
}
/* 窄屏（手机）：快照本身不出横向滚动条，让长行换行 */
@media (max-width: 720px) {
  .snap-text {
    white-space: pre-wrap;
    overflow-x: hidden;
    word-break: break-word;
    max-height: 60vh;
  }
}
</style>
