<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { PluginSettingsViewProps } from '../../components/plugin-ui'
import { checkTextRule, parseTextRules, type TextRule } from '../../services/text-rules'

/**
 * Regex 规则编辑器（插件 SDK `settingsView` 的首个消费）：
 * 逐条编辑 pattern / flags / replacement / 替换对象 / 模式 / 格式，保存走
 * `yaya.plugin-config-set`（schema 校验 + 落盘 + 广播），界面立即按新规则变换。
 */
const props = defineProps<PluginSettingsViewProps>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

/** 编辑器内的行：把可选字段补成必填，避免 v-model 绑 undefined */
interface EditRule {
  _id: number
  enabled: boolean
  pattern: string
  flags: string
  replacement: string
  target: 'user' | 'ai' | 'both'
  mode: 'visual' | 'raw'
  format: 'regex' | 'html'
}

let seq = 0
function toEdit(r: TextRule): EditRule {
  return {
    _id: ++seq,
    enabled: r.enabled !== false,
    pattern: r.pattern,
    flags: r.flags ?? '',
    replacement: r.replacement ?? '',
    target: r.target ?? 'ai',
    mode: r.mode ?? 'visual',
    format: r.format ?? 'regex'
  }
}
function toRule(r: EditRule): TextRule {
  const { _id, ...rest } = r
  void _id
  return rest
}

const rules = ref<EditRule[]>(
  parseTextRules(String(props.info.config?.values?.rules ?? '')).map(toEdit)
)
const status = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const error = ref('')

const targetItems = computed(() => [
  { value: 'user' as const, title: t('yaya.regex.t_user', '只替换用户输入') },
  { value: 'ai' as const, title: t('yaya.regex.t_ai', '只替换 AI 输出') },
  { value: 'both' as const, title: t('yaya.regex.t_both', '两边都替换') }
])
const modeItems = computed(() => [
  { value: 'visual' as const, title: t('yaya.regex.m_visual', '只改显示（原文不动）') },
  { value: 'raw' as const, title: t('yaya.regex.m_raw', '改原文（入库 / 落库前）') }
])
const formatItems = computed(() => [
  { value: 'regex' as const, title: t('yaya.regex.f_regex', '普通正则') },
  { value: 'html' as const, title: t('yaya.regex.f_html', 'HTML 片段（仅 AI 输出）') }
])

function ruleError(r: EditRule): string {
  return checkTextRule(toRule(r)) ?? ''
}

function add(): void {
  rules.value.push({
    _id: ++seq,
    enabled: true,
    pattern: '',
    flags: 'g',
    replacement: '',
    target: 'ai',
    mode: 'visual',
    format: 'regex'
  })
}
function remove(id: number): void {
  rules.value = rules.value.filter((r) => r._id !== id)
}

async function save(): Promise<void> {
  const list = rules.value.map(toRule)
  const bad = list.map((r) => checkTextRule(r)).find(Boolean)
  if (bad) {
    status.value = 'error'
    error.value = String(bad)
    return
  }
  status.value = 'saving'
  error.value = ''
  try {
    await window.cockpit.command('yaya.plugin-config-set', {
      id: props.pluginId,
      values: JSON.stringify({ rules: JSON.stringify(list) })
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
  <div class="regex-rules">
    <div class="hint text-medium-emphasis">
      {{
        t(
          'yaya.regex.hint',
          '规则按顺序生效；$1 引用捕获组，$& 是整个匹配。HTML 片段只作用于 AI 输出，其中夹带的匹配文本会自动转义。'
        )
      }}
    </div>

    <div v-if="!rules.length" class="empty text-medium-emphasis">
      {{ t('yaya.regex.empty', '还没有规则——点下面「添加规则」开始') }}
    </div>

    <div v-for="r in rules" :key="r._id" class="rule-card">
      <div class="rule-head">
        <v-switch
          v-model="r.enabled"
          color="primary"
          density="compact"
          hide-details
          :label="t('yaya.regex.enabled', '启用')"
        />
        <v-spacer />
        <v-btn
          icon
          size="small"
          variant="text"
          :title="t('yaya.regex.delete', '删除这条规则')"
          :aria-label="t('yaya.regex.delete', '删除这条规则')"
          @click="remove(r._id)"
        >
          <v-icon icon="mdi-delete-outline" size="18" />
        </v-btn>
      </div>

      <div class="rule-row">
        <v-text-field
          v-model="r.pattern"
          :label="t('yaya.regex.pattern', '正则表达式')"
          placeholder="\\bhelo\\b"
          variant="outlined"
          density="compact"
          hide-details="auto"
          :error-messages="ruleError(r) ? [ruleError(r)] : []"
        />
        <v-text-field
          v-model="r.flags"
          label="flags"
          placeholder="gi"
          variant="outlined"
          density="compact"
          hide-details
          class="flags-field"
        />
      </div>

      <v-text-field
        v-model="r.replacement"
        :label="t('yaya.regex.replacement', '替换为（可用 $1、$&）')"
        variant="outlined"
        density="compact"
        hide-details
      />

      <div class="rule-row">
        <v-select
          v-model="r.target"
          :items="targetItems"
          :label="t('yaya.regex.target', '替换对象')"
          variant="outlined"
          density="compact"
          hide-details
        />
        <v-select
          v-model="r.mode"
          :items="modeItems"
          :label="t('yaya.regex.mode', '替换方式')"
          variant="outlined"
          density="compact"
          hide-details
        />
        <v-select
          v-model="r.format"
          :items="formatItems"
          :label="t('yaya.regex.format', '格式')"
          variant="outlined"
          density="compact"
          hide-details
        />
      </div>
    </div>

    <div class="rule-actions">
      <v-btn variant="text" prepend-icon="mdi-plus" @click="add">
        {{ t('yaya.regex.add', '添加规则') }}
      </v-btn>
      <v-spacer />
      <v-btn
        color="primary"
        variant="flat"
        :loading="status === 'saving'"
        :disabled="status === 'saving'"
        @click="save"
      >
        {{ t('yaya.regex.save', '保存') }}
      </v-btn>
    </div>

    <div v-if="status === 'saved'" class="save-ok">
      {{ t('yaya.regex.saved', '已保存，界面即时生效（原文替换从下一条消息起生效）') }}
    </div>
    <div v-else-if="status === 'error'" class="save-err">{{ error }}</div>
  </div>
</template>

<style scoped>
.regex-rules {
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
.rule-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.4));
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.78));
}
.rule-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.rule-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.rule-row > * {
  flex: 1 1 160px;
  min-width: 0;
}
.flags-field {
  flex: 0 0 88px;
}
.rule-actions {
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
  .rule-row > * {
    flex: 1 1 100%;
  }
  .flags-field {
    flex: 1 1 100%;
  }
}
</style>
