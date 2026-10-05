<script setup lang="ts">
/**
 * 「选择文字」：手机上消息气泡的长按被菜单占用（长按选字与长按菜单只能二选一），
 * 这里把消息原文放进一个可以正常选择的只读区域——长按拖动选任意一段，用系统菜单复制；
 * 也可以切到「完整过程」（含思考与工具调用）再选。
 */
import { computed, inject, ref, watch } from 'vue'
import { useI18n } from '../../../main/ui/i18n'

const props = defineProps<{
  /** 正文（Markdown 原文） */
  text: string
  /** 含思考与工具调用的完整过程（只有回答才有） */
  fullText?: string
}>()
const open = defineModel<boolean>({ default: false })

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const narrow = ref(false)
const showFull = ref(false)
const copied = ref(false)
const shown = computed(() => (showFull.value && props.fullText ? props.fullText : props.text))

watch(open, (o) => {
  if (!o) return
  narrow.value = window.matchMedia('(max-width: 720px)').matches
  showFull.value = false
  copied.value = false
})

async function copyAll(): Promise<void> {
  await window.cockpit.copyText(shown.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <v-dialog v-model="open" :fullscreen="narrow" :max-width="narrow ? undefined : 760" scrollable>
    <v-card class="sel-card" :rounded="narrow ? 0 : 'xl'">
      <div class="sel-head">
        <v-icon icon="mdi-format-text" />
        <div class="text-subtitle-1 font-weight-medium flex-grow-1">
          {{ t('yaya.select_text.title', '选择文字') }}
        </div>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :title="t('yaya.close', '关闭')"
          :aria-label="t('yaya.close', '关闭')"
          @click="open = false"
        />
      </div>
      <div v-if="fullText" class="sel-tabs">
        <v-btn-toggle
          :model-value="showFull ? 'full' : 'text'"
          mandatory
          divided
          variant="outlined"
          color="primary"
          density="comfortable"
          @update:model-value="(v: string) => (showFull = v === 'full')"
        >
          <v-btn value="text">{{ t('yaya.select_text.answer', '回答') }}</v-btn>
          <v-btn value="full">{{ t('yaya.select_text.full', '完整过程') }}</v-btn>
        </v-btn-toggle>
      </div>
      <p class="sel-hint text-caption text-medium-emphasis">
        {{ t('yaya.select_text.hint', '长按或拖动选择任意一段，用系统菜单复制') }}
      </p>
      <div class="sel-body">
        <pre class="sel-text">{{ shown }}</pre>
      </div>
      <div class="sel-actions">
        <v-btn variant="text" @click="open = false">{{ t('yaya.close', '关闭') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'"
          @click="copyAll"
        >
          {{ copied ? t('yaya.copied', '已复制') : t('yaya.select_text.copy_all', '全部复制') }}
        </v-btn>
      </div>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.sel-card {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-vh, 100vh) * 0.9);
}
.sel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 12px 8px 20px;
}
.sel-tabs {
  padding: 0 20px 8px;
}
.sel-hint {
  margin: 0;
  padding: 0 20px 8px;
}
.sel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 20px;
}
/* 这里要能选：覆盖外层可能继承来的 user-select:none */
.sel-text {
  margin: 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.05);
  font-family: inherit;
  font-size: 0.9rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
  -webkit-touch-callout: default;
}
.sel-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 20px 16px;
}
</style>
