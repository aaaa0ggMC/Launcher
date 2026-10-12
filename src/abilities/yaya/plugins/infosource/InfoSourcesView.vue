<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { PluginSettingsViewProps } from '../../components/plugin-ui'
import {
  instancesOf,
  sourceType,
  SOURCE_TYPES,
  type InfoInstance
} from '../../services/info-sources'

/**
 * 信息源实例编辑器（插件 SDK `settingsView` 的第二个消费）：
 * 一条 = 一个渠道（类型 + 可选的 URL 模板 / 参数 + 说明 + 启停），保存走 `yaya.plugin-config-set`。
 */
const props = defineProps<PluginSettingsViewProps>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

interface EditInst {
  _key: number
  name: string
  type: string
  template: string
  params: string
  note: string
  enabled: boolean
}

let seq = 0
function toEdit(i: InfoInstance): EditInst {
  return {
    _key: ++seq,
    name: i.name,
    type: i.type,
    template: i.template ?? '',
    params: i.params ?? '',
    note: i.note ?? '',
    enabled: i.enabled !== false
  }
}
function toInst(i: EditInst): InfoInstance {
  const out: InfoInstance = { name: i.name.trim(), type: i.type, enabled: i.enabled }
  if (i.template.trim()) out.template = i.template.trim()
  if (i.params.trim()) out.params = i.params.trim()
  if (i.note.trim()) out.note = i.note.trim()
  return out
}

const rows = ref<EditInst[]>(
  instancesOf(String(props.info.config?.values?.instances ?? '')).map(toEdit)
)
const status = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const error = ref('')

const typeItems = computed(() => SOURCE_TYPES.map((t) => ({ value: t.id, title: t.label })))
function typeLabel(type: string): string {
  const found = sourceType(type)
  if (!found) return t('yaya.info.bad_type', '未知类型（该实例不可用）')
  return found.labelKey ? t(found.labelKey, found.label) : found.label
}
function typeHint(type: string): string {
  return sourceType(type)?.hint ?? ''
}
function defaultTemplate(type: string): string {
  return sourceType(type)?.template ?? ''
}

function add(): void {
  rows.value.push({
    _key: ++seq,
    name: '',
    type: 'wikipedia',
    template: '',
    params: '',
    note: '',
    enabled: true
  })
}
function remove(key: number): void {
  rows.value = rows.value.filter((r) => r._key !== key)
}

const rowError = (r: EditInst): string =>
  !r.name.trim() ? t('yaya.info.err_name', '名字不能为空（AI 按它点名）') : ''

async function save(): Promise<void> {
  const bad = rows.value.map(rowError).find(Boolean)
  if (bad) {
    status.value = 'error'
    error.value = String(bad)
    return
  }
  const dup = rows.value.find(
    (r, i) => rows.value.findIndex((x) => x.name.trim() === r.name.trim()) !== i
  )
  if (dup) {
    status.value = 'error'
    error.value = te('yaya.info.err_dup', { name: dup.name.trim() }, `名字重复：${dup.name.trim()}`)
    return
  }
  status.value = 'saving'
  error.value = ''
  try {
    await window.cockpit.command('yaya.plugin-config-set', {
      id: props.pluginId,
      values: JSON.stringify({ instances: JSON.stringify(rows.value.map(toInst), null, 2) })
    })
    status.value = 'saved'
    setTimeout(() => {
      if (status.value === 'saved') status.value = 'idle'
    }, 2500)
  } catch (e) {
    status.value = 'error'
    error.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <div class="info-instances">
    <div class="hint text-medium-emphasis">
      {{
        t(
          'yaya.info.hint',
          '一条 = 一个渠道；模板留空就用类型自带的（把 {query} 换成你的查询词）。AI 在 fetch_info 里按「名字」或「类型 id」点名，一条命令可以点多个。'
        )
      }}
    </div>

    <div v-if="!rows.length" class="empty text-medium-emphasis">
      {{ t('yaya.info.empty', '还没有渠道——点下面「添加渠道」开始') }}
    </div>

    <div v-for="r in rows" :key="r._key" class="inst-card">
      <div class="inst-head">
        <v-switch
          v-model="r.enabled"
          color="primary"
          density="compact"
          hide-details
          :label="t('yaya.info.enabled', '启用')"
        />
        <span class="type-chip text-medium-emphasis">{{ typeLabel(r.type) }}</span>
        <v-spacer />
        <v-btn
          icon
          size="small"
          variant="text"
          :title="t('yaya.info.delete', '删除这个渠道')"
          :aria-label="t('yaya.info.delete', '删除这个渠道')"
          @click="remove(r._key)"
        >
          <v-icon icon="mdi-delete-outline" size="18" />
        </v-btn>
      </div>

      <div class="inst-row">
        <v-text-field
          v-model="r.name"
          :label="t('yaya.info.name', '名字（AI 点名用）')"
          variant="outlined"
          density="compact"
          hide-details="auto"
          :error-messages="rowError(r) ? [rowError(r)] : []"
        />
        <v-select
          v-model="r.type"
          :items="typeItems"
          :label="t('yaya.info.type', '类型')"
          variant="outlined"
          density="compact"
          hide-details
        />
      </div>

      <v-text-field
        v-model="r.template"
        :label="t('yaya.info.template', 'URL 模板（留空用类型默认）')"
        :placeholder="defaultTemplate(r.type)"
        variant="outlined"
        density="compact"
        hide-details
      />

      <div class="inst-row">
        <v-text-field
          v-model="r.params"
          :label="t('yaya.info.params', '附加参数')"
          placeholder="language=zh&limit=3"
          variant="outlined"
          density="compact"
          hide-details
        />
        <v-text-field
          v-model="r.note"
          :label="t('yaya.info.note', '说明（可选，给 AI 看）')"
          variant="outlined"
          density="compact"
          hide-details
        />
      </div>

      <div v-if="typeHint(r.type)" class="type-hint text-medium-emphasis">
        {{ typeHint(r.type) }}
      </div>
    </div>

    <div class="inst-actions">
      <v-btn variant="text" prepend-icon="mdi-plus" @click="add">
        {{ t('yaya.info.add', '添加渠道') }}
      </v-btn>
      <v-spacer />
      <v-btn
        color="primary"
        variant="flat"
        :loading="status === 'saving'"
        :disabled="status === 'saving'"
        @click="save"
      >
        {{ t('yaya.info.save', '保存') }}
      </v-btn>
    </div>

    <div v-if="status === 'saved'" class="save-ok">
      {{ t('yaya.info.saved', '已保存，AI 下一次 fetch_info 就用新配置') }}
    </div>
    <div v-else-if="status === 'error'" class="save-err">{{ error }}</div>
  </div>
</template>

<style scoped>
.info-instances {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.hint {
  font-size: 0.8125rem;
  line-height: 1.6;
}
.empty {
  font-size: 0.875rem;
  padding: 16px 0;
}
.inst-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.4));
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.78));
}
.inst-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  flex-wrap: wrap;
}
.type-chip {
  font-size: 0.78rem;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.2));
}
.inst-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.inst-row > * {
  flex: 1 1 180px;
  min-width: 0;
}
.type-hint {
  font-size: 0.78rem;
  line-height: 1.5;
}
.inst-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.save-ok {
  font-size: 0.85rem;
  color: rgb(var(--v-theme-success));
}
.save-err {
  font-size: 0.85rem;
  color: rgb(var(--v-theme-error));
  word-break: break-word;
}
@media (max-width: 640px) {
  .inst-row > * {
    flex: 1 1 100%;
  }
}
</style>
