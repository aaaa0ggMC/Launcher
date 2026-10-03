<script setup lang="ts">
/**
 * 模型细则 — the default model, one model per agent (LoopAgent / LibAgent /
 * DreamAgent / RankAgent; empty = follow the default) and the metadata model.
 * Used by the settings page and the AIDJ page-menu; every change is saved
 * immediately (aidj.update-config + aidj.save-config).
 */
import { ref, computed, onMounted, onBeforeUnmount, inject } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '../../../main/ui/i18n'

defineOptions({ name: 'AidjAgentModelsPanel' })

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

interface Row {
  key: string
  path: string
  icon: string
  label: string
  hint: string
  /** Agent rows may be empty (= follow the default model). */
  followsDefault: boolean
}

const rows = computed<Row[]>(() => [
  {
    key: 'default',
    path: 'preferences.model',
    icon: 'mdi-robot-outline',
    label: t('aidj.models.default', '默认模型'),
    hint: t('aidj.models.default_hint', '文本模式、标题生成，以及未单独设置的 Agent'),
    followsDefault: false
  },
  {
    key: 'loop',
    path: 'preferences.agent_models.loop',
    icon: 'mdi-sync',
    label: 'LoopAgent',
    hint: t('aidj.models.loop_hint', '理解请求、调用工具、组织整个 workflow'),
    followsDefault: true
  },
  {
    key: 'lib',
    path: 'preferences.agent_models.lib',
    icon: 'mdi-bookshelf',
    label: 'LibAgent',
    hint: t('aidj.models.lib_hint', '读候选曲库片段，按描述挑歌（输入较长）'),
    followsDefault: true
  },
  {
    key: 'dream',
    path: 'preferences.agent_models.dream',
    icon: 'mdi-weather-night',
    label: 'DreamAgent',
    hint: t('aidj.models.dream_hint', '从起点歌曲出发联想、扩展'),
    followsDefault: true
  },
  {
    key: 'rank',
    path: 'preferences.agent_models.rank',
    icon: 'mdi-sort-variant',
    label: 'RankAgent',
    hint: t('aidj.models.rank_hint', '排序、剔除并写 DJ 词'),
    followsDefault: true
  },
  {
    key: 'vocab',
    path: 'preferences.agent_models.vocab',
    icon: 'mdi-tag-multiple-outline',
    label: 'VocabAgent',
    hint: t('aidj.models.vocab_hint', '标签整理：把词云合并成规范词表'),
    followsDefault: true
  },
  {
    key: 'sanitize',
    path: 'preferences.agent_models.sanitize',
    icon: 'mdi-broom',
    label: 'SanitizeAgent',
    hint: t('aidj.models.sanitize_hint', '标签整理：逐首清洗不规范的歌曲（调用次数多）'),
    followsDefault: true
  },
  {
    key: 'metadata',
    path: 'ai_settings.metadata_model',
    icon: 'mdi-database-sync-outline',
    label: t('aidj.models.metadata', '元数据模型'),
    hint: t('aidj.models.metadata_hint', '同步新歌时提取情绪 / 风格 / 语言 / 评语'),
    followsDefault: false
  }
])

const values = ref<Record<string, string>>({})
const models = ref<string[]>([])
const modelsLoading = ref(true)
const modelsError = ref(false)
const loaded = ref(false)

onMounted(async () => {
  try {
    const r = (await window.cockpit.command('aidj.get-config')) as {
      ok?: boolean
      config?: {
        preferences?: { model?: string; agent_models?: Record<string, string> }
        ai_settings?: { metadata_model?: string }
      }
    } | null
    const prefs = r?.config?.preferences ?? {}
    const agents = prefs.agent_models ?? {}
    values.value = {
      default: prefs.model ?? '',
      loop: agents.loop ?? '',
      lib: agents.lib ?? '',
      dream: agents.dream ?? '',
      rank: agents.rank ?? '',
      vocab: agents.vocab ?? '',
      sanitize: agents.sanitize ?? '',
      metadata: r?.config?.ai_settings?.metadata_model ?? ''
    }
  } catch {
    /* leave empty */
  } finally {
    loaded.value = true
  }
  try {
    const r = (await window.cockpit.command('aidj.get-models')) as {
      ok?: boolean
      models?: string[]
    } | null
    if (r?.ok && Array.isArray(r.models)) models.value = r.models
    else modelsError.value = true
  } catch {
    modelsError.value = true
  } finally {
    modelsLoading.value = false
  }
})

// The combobox emits on every keystroke — persist once typing pauses.
const timers = new Map<string, ReturnType<typeof setTimeout>>()
function save(row: Row, v: string | null): void {
  const value = (v ?? '').trim()
  values.value = { ...values.value, [row.key]: value }
  clearTimeout(timers.get(row.key))
  timers.set(
    row.key,
    setTimeout(() => {
      timers.delete(row.key)
      void window.cockpit
        .command('aidj.update-config', { path: row.path, value })
        .then(() => window.cockpit.command('aidj.save-config'))
        .catch(() => {})
    }, 400)
  )
}
onBeforeUnmount(() => {
  // Flush pending edits instead of dropping them.
  for (const [key, timer] of timers) {
    clearTimeout(timer)
    const row = rows.value.find((r) => r.key === key)
    if (row) {
      void window.cockpit
        .command('aidj.update-config', { path: row.path, value: values.value[key] ?? '' })
        .then(() => window.cockpit.command('aidj.save-config'))
        .catch(() => {})
    }
  }
})

/** Sentinel item for "follow the default model" (saved as an empty string). */
const FOLLOW = '__follow_default__'

const followLabel = computed(() =>
  translateTemplate(
    uiLang.value,
    'aidj.models.follow',
    { model: values.value.default || '—' },
    '跟随默认（{model}）'
  )
)

/** Agent rows get "follow default" as the first, explicit option. */
function itemsFor(row: Row): { title: string; value: string }[] {
  const list = models.value.map((m) => ({ title: m, value: m }))
  return row.followsDefault ? [{ title: followLabel.value, value: FOLLOW }, ...list] : list
}

function valueFor(row: Row): string | null {
  const v = values.value[row.key]
  if (v) return v
  return row.followsDefault ? FOLLOW : null
}

function onPick(row: Row, v: unknown): void {
  // Item objects (or a typed string) → the stored model name; FOLLOW / cleared → ''.
  const raw = v && typeof v === 'object' ? (v as { value?: unknown }).value : v
  const name = typeof raw === 'string' && raw !== FOLLOW ? raw : ''
  save(row, name)
}
</script>

<template>
  <div class="d-flex flex-column ga-3" :class="{ 'models-compact': props.compact }">
    <div v-for="row in rows" :key="row.key" class="model-row">
      <div class="d-flex align-center ga-2 mb-1">
        <v-icon size="16" class="text-medium-emphasis">{{ row.icon }}</v-icon>
        <span class="text-body-2 font-weight-medium">{{ row.label }}</span>
        <span class="text-caption text-medium-emphasis model-hint">{{ row.hint }}</span>
      </div>
      <v-combobox
        :model-value="valueFor(row)"
        :items="itemsFor(row)"
        item-title="title"
        item-value="value"
        :return-object="false"
        :loading="modelsLoading"
        :disabled="!loaded"
        :no-data-text="
          modelsError
            ? t('aidj.settings.models_unavailable', 'API 未提供模型列表')
            : t('aidj.settings.no_data', '无数据')
        "
        :aria-label="row.label"
        hide-details
        density="compact"
        variant="outlined"
        clearable
        @update:model-value="(v: unknown) => onPick(row, v)"
      />
    </div>
  </div>
</template>

<style scoped>
.model-row {
  min-width: 0;
}
.model-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.models-compact .model-hint {
  white-space: normal;
}
</style>
