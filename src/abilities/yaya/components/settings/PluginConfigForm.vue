<script setup lang="ts">
/**
 * 插件配置表单（PLAN 6.4）：按插件声明的 `configSchema` 自动生成——
 * string → 单行输入 / text → 多行 / number → 数字输入（夹 min/max）/ boolean → 开关 /
 * select → 下拉；`secret` 字段是密码框，已设置时占位提示「已设置，留空则不修改」，旁边可清除。
 *
 * 插件可以自己在 `plugins/<id>/ui.ts` 导出 `settingsView` 组件替换整个表单
 * （PluginDetail 会优先用它）。
 */
import { useI18n } from '@ui/i18n'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { PluginConfigField, PluginInfo } from '../../services/plugins/types'
import SaveStatusText from './SaveStatusText.vue'

defineOptions({ name: 'cockpit-yaya-settings-plugin-config-form' })

const props = defineProps<{
  plugin: PluginInfo
  schema: PluginConfigField[]
  /** 非 secret 字段的当前值（默认值已填） */
  values: Record<string, unknown>
  /** 已设置的 secret 字段 key */
  secretsSet: string[]
}>()

const emit = defineEmits<{ (e: 'saved'): void }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

/** 表单里各组字段：插件级 + 各子分组 */
interface FieldSection {
  id: string
  label: string
  fields: PluginConfigField[]
}

/** secret 的值不下发：输入框一律从空串开始，空 = 不修改 */
function initDraft(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of props.schema) {
    if (field.secret) {
      out[field.key] = ''
      continue
    }
    const current = props.values[field.key]
    if (field.type === 'boolean') out[field.key] = current === true
    else if (field.type === 'number')
      out[field.key] = typeof current === 'number' ? current : Number(field.default ?? 0)
    else out[field.key] = typeof current === 'string' ? current : String(current ?? '')
  }
  return out
}

const draft = ref<Record<string, unknown>>(initDraft())
/** 用户点过「清除」的 secret 字段 */
const cleared = ref<Set<string>>(new Set())

const sections = computed<FieldSection[]>(() => {
  const groups = props.plugin.groups ?? []
  const byId = new Map<string, PluginConfigField[]>()
  const plain: PluginConfigField[] = []
  for (const field of props.schema) {
    if (field.group && groups.some((g) => g.id === field.group)) {
      const list = byId.get(field.group) ?? []
      list.push(field)
      byId.set(field.group, list)
    } else plain.push(field)
  }
  const out: FieldSection[] = []
  if (plain.length > 0)
    out.push({
      id: '',
      label: t('yaya.settings.plugins.config_plugin_group', '插件配置'),
      fields: plain
    })
  for (const group of groups) {
    const fields = byId.get(group.id) ?? []
    if (fields.length === 0) continue
    out.push({ id: group.id, label: group.label, fields })
  }
  return out
})

// 保存状态（与外壳一致：保存中 / 已保存 2s 后淡出 / 失败保留）
const saving = ref(false)
const savedShown = ref(false)
const savedFading = ref(false)
const saveError = ref<string | null>(null)
let savedTimer: number | null = null

const statusProps = computed(() => ({
  saving: saving.value,
  saved: savedShown.value,
  fading: savedFading.value,
  error: saveError.value
}))

/** 有任何改动（含 secret 的清除）才能保存 */
const dirty = ref(false)
watch(
  draft,
  () => {
    dirty.value = true
  },
  { deep: true }
)
watch(
  cleared,
  () => {
    dirty.value = true
  },
  { deep: true }
)

function clearSecret(key: string): void {
  draft.value[key] = ''
  const next = new Set(cleared.value)
  next.add(key)
  cleared.value = next
}

function isCleared(key: string): boolean {
  return cleared.value.has(key)
}

function secretPlaceholder(field: PluginConfigField): string {
  if (isCleared(field.key))
    return t('yaya.settings.plugins.config_secret_cleared', '已清除，保存后生效')
  if (props.secretsSet.includes(field.key))
    return t('yaya.settings.plugins.config_secret_set', '已设置，留空则不修改')
  return field.placeholder ?? ''
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  saveError.value = null
  try {
    const values: Record<string, unknown> = {}
    for (const field of props.schema) {
      const raw = draft.value[field.key]
      if (field.type === 'boolean') values[field.key] = raw === true
      else if (field.type === 'number') values[field.key] = Number(raw ?? 0)
      else values[field.key] = typeof raw === 'string' ? raw : String(raw ?? '')
    }
    // IPC 参数必须可克隆：来自 ref 的先深拷贝
    const payload = JSON.parse(JSON.stringify(values)) as Record<string, unknown>
    await window.cockpit.command('yaya.plugin-config-set', {
      id: props.plugin.id,
      values: payload,
      clear: [...cleared.value].join(',')
    })
    cleared.value = new Set()
    dirty.value = false
    savedShown.value = true
    savedFading.value = false
    if (savedTimer !== null) window.clearTimeout(savedTimer)
    savedTimer = window.setTimeout(() => {
      savedFading.value = true
      savedTimer = window.setTimeout(() => {
        savedShown.value = false
        savedFading.value = false
      }, 400)
    }, 2000)
    emit('saved')
  } catch (err) {
    saveError.value = String(err)
  } finally {
    saving.value = false
  }
}

onBeforeUnmount(() => {
  if (savedTimer !== null) window.clearTimeout(savedTimer)
  resizeObs?.disconnect()
  resizeObs = null
})

// 容器 < 640px（如手机 / 窄分栏）时表单调成单列、标签在上，
// 用 ResizeObserver 量容器而不是窗口断点——设置页可能嵌在别处或被缩放。
const stack = ref<HTMLElement | null>(null)
const narrow = ref(false)
let resizeObs: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  if (!stack.value) return
  narrow.value = stack.value.clientWidth < 640
  resizeObs = new ResizeObserver(() => {
    narrow.value = (stack.value?.clientWidth ?? 0) < 640
  })
  resizeObs.observe(stack.value)
})
</script>

<template>
  <div ref="stack" class="config-form d-flex flex-column ga-4">
    <div class="text-caption text-medium-emphasis">
      {{
        t(
          'yaya.settings.plugins.config_desc',
          '这些配置只影响本插件的工具；保存后从下一次工具调用起生效'
        )
      }}
    </div>

    <template v-for="section in sections" :key="section.id || 'plain'">
      <div class="d-flex flex-column ga-3">
        <span v-if="section.id" class="text-body-2 font-weight-medium">{{ section.label }}</span>
        <div
          v-for="field in section.fields"
          :key="field.key"
          class="config-row"
          :class="{ 'config-row--narrow': narrow }"
        >
          <div class="config-label">
            <span class="text-body-2">{{ field.label }}</span>
            <div v-if="field.description" class="text-caption text-medium-emphasis config-hint">
              {{ field.description }}
            </div>
          </div>

          <div class="config-control d-flex align-center ga-2 flex-wrap">
            <!-- text：多行 -->
            <v-textarea
              v-if="field.type === 'text'"
              v-model="draft[field.key] as string"
              :rows="4"
              :placeholder="field.placeholder ?? ''"
              variant="outlined"
              hide-details
              auto-grow
            />
            <!-- string：单行 -->
            <v-text-field
              v-else-if="field.type === 'string'"
              v-model="draft[field.key] as string"
              :placeholder="field.placeholder ?? ''"
              variant="outlined"
              hide-details
            />
            <!-- secret：密码框 + 占位提示 + 清除按钮；整块是 AI 禁区 -->
            <template v-else-if="field.secret">
              <div v-agent-forbidden class="d-flex align-center ga-2 flex-grow-1 min-w-0">
                <v-text-field
                  v-model="draft[field.key] as string"
                  type="password"
                  :placeholder="secretPlaceholder(field)"
                  variant="outlined"
                  hide-details
                  autocomplete="new-password"
                  class="min-w-0 flex-grow-1"
                />
                <v-btn
                  variant="text"
                  :disabled="!secretsSet.includes(field.key) || isCleared(field.key)"
                  :title="t('yaya.settings.plugins.config_secret_clear', '清除已保存的值')"
                  :aria-label="t('yaya.settings.plugins.config_secret_clear', '清除已保存的值')"
                  @click="clearSecret(field.key)"
                >
                  {{ t('yaya.settings.plugins.config_clear', '清除') }}
                </v-btn>
              </div>
            </template>
            <!-- number -->
            <v-text-field
              v-else-if="field.type === 'number'"
              v-model.number="draft[field.key] as number"
              type="number"
              :min="field.min"
              :max="field.max"
              :step="field.step ?? 1"
              :placeholder="field.placeholder ?? ''"
              variant="outlined"
              hide-details
              class="config-number"
            />
            <!-- boolean -->
            <v-switch
              v-else-if="field.type === 'boolean'"
              :model-value="draft[field.key] === true"
              color="primary"
              hide-details
              density="compact"
              @update:model-value="draft[field.key] = $event === true"
            />
            <!-- select -->
            <v-select
              v-else
              v-model="draft[field.key] as string"
              :items="(field.options ?? []).map((o) => ({ title: o.label, value: o.value }))"
              variant="outlined"
              hide-details
            />
          </div>
        </div>
      </div>
    </template>

    <div class="d-flex flex-wrap align-center ga-2 pb-2">
      <v-btn
        variant="elevated"
        color="primary"
        prepend-icon="mdi-content-save-outline"
        :disabled="!dirty || saving"
        :loading="saving"
        @click="save"
      >
        {{ t('yaya.settings.plugins.config_save', '保存配置') }}
      </v-btn>
      <SaveStatusText v-bind="statusProps" />
    </div>
  </div>
</template>

<style scoped>
.config-form {
  width: 100%;
  min-width: 0;
}

/* 一行 = 标签列 + 控件列；窄屏收成单列、标签在上 */
.config-row {
  display: grid;
  grid-template-columns: minmax(180px, 280px) minmax(0, 1fr);
  gap: 8px 16px;
  align-items: start;
  width: 100%;
}

.config-row--narrow {
  grid-template-columns: minmax(0, 1fr);
}

.config-label {
  min-width: 0;
  padding-top: 6px;
}

.config-hint {
  margin-top: 2px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.config-control {
  min-width: 0;
}

.config-number {
  max-width: 220px;
}
</style>
