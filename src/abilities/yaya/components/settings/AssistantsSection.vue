<script setup lang="ts">
/**
 * 设置 → 助手：助手列表 → 某个助手的详情（基本 / 提示词 / 插件 / MCP / 上下文 / 执行策略）。
 * 详情里的各页复用现有设置分区，传入 scopedConfig() 包出来的「助手视图」：
 * 读写插件开关等字段时落到这个助手上，服务商 / MCP 服务器列表等仍是全局的。
 */
import { useI18n } from '@ui/i18n'
import { computed, inject, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ReasoningEffort, WorkflowInfo, YayaAssistant, YayaConfig } from '../../types'
import { assistantFromDefaults } from '../../assistants'
import { modelMonogram } from '../../profile'
import AvatarBadge from '../AvatarBadge.vue'
import AssistantSection from './AssistantSection.vue'
import ContextSection from './ContextSection.vue'
import PluginsSection from './PluginsSection.vue'
import PolicySection from './PolicySection.vue'
import ProfileSection from './ProfileSection.vue'
import { scopedConfig } from './assistant-scope'

defineOptions({ name: 'cockpit-yaya-settings-assistants' })
/* eslint-disable vue/no-mutating-props -- 与其他设置分区一样直接改外壳持有的配置对象 */

const props = defineProps<{ config: YayaConfig }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

type Page = 'basic' | 'prompt' | 'plugins' | 'mcp' | 'context' | 'policy'

const assistants = computed<YayaAssistant[]>(() => props.config.assistants ?? [])
const search = ref('')
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q
    ? assistants.value.filter((a) => a.assistantName.toLowerCase().includes(q))
    : assistants.value
})

/** 正在看的助手 / 详情里的哪一页（null = 详情首页） */
const selectedId = ref<string | null>(null)
const page = ref<Page | null>(null)
const selected = computed(() => assistants.value.find((a) => a.id === selectedId.value) ?? null)
/** 被删掉了（别处删的 / 撤销）：回到列表 */
watch(selected, (a) => {
  if (!a) {
    selectedId.value = null
    page.value = null
  }
})
const scoped = computed(() => (selected.value ? scopedConfig(props.config, selected.value) : null))

function open(a: YayaAssistant): void {
  selectedId.value = a.id
  page.value = null
}

function back(): void {
  if (page.value) page.value = null
  else selectedId.value = null
}

// ---- 列表操作 ----

function newId(): string {
  return 'a-' + crypto.randomUUID().slice(0, 8)
}

function create(): void {
  const a = assistantFromDefaults(props.config, newId(), {
    name: t('yaya.assistants.new_name', '新助手')
  })
  props.config.assistants = [...assistants.value, a]
  open(a)
  page.value = 'basic'
}

function duplicate(a: YayaAssistant): void {
  const copy = JSON.parse(JSON.stringify(a)) as YayaAssistant
  copy.id = newId()
  copy.createdAt = Date.now()
  copy.assistantName = te('yaya.assistants.copy_name', { name: a.assistantName }, '{name} 副本')
    .trim()
    .slice(0, 32)
  props.config.assistants = [...assistants.value, copy]
}

function makeDefault(a: YayaAssistant): void {
  props.config.activeAssistantId = a.id
}

const deleteTarget = ref<YayaAssistant | null>(null)
function doDelete(): void {
  const a = deleteTarget.value
  deleteTarget.value = null
  if (!a || assistants.value.length <= 1) return
  props.config.assistants = assistants.value.filter((x) => x.id !== a.id)
  if (props.config.activeAssistantId === a.id)
    props.config.activeAssistantId = props.config.assistants[0].id
}

// ---- 头像 ----

function avatarOf(a: YayaAssistant): {
  image: string
  monogram: { text: string; hue: number } | null
} {
  const mode = a.profile?.assistantAvatarMode
  return {
    image: mode === 'custom' ? a.profile?.assistantAvatar || '' : '',
    monogram:
      mode === 'model' ? modelMonogram(a.activeModel || props.config.activeModel || 'model') : null
  }
}

function promptPreview(a: YayaAssistant): string {
  return a.systemPrompt.trim().split('\n').slice(0, 2).join(' ').slice(0, 140)
}

// ---- 详情首页的入口 ----

const pages = computed<{ id: Page; icon: string; title: string; sub: string }[]>(() => [
  {
    id: 'basic',
    icon: 'mdi-cog-outline',
    title: t('yaya.assistants.page_basic', '基本设置'),
    sub: t('yaya.assistants.page_basic_sub', '名字、头像、模型与思考强度')
  },
  {
    id: 'prompt',
    icon: 'mdi-message-text-outline',
    title: t('yaya.assistants.page_prompt', '提示词'),
    sub: t('yaya.assistants.page_prompt_sub', '系统提示词与变量')
  },
  {
    id: 'plugins',
    icon: 'mdi-puzzle-outline',
    title: t('yaya.assistants.page_plugins', '插件'),
    sub: t('yaya.assistants.page_plugins_sub', '这个助手能用哪些插件、工具与 Skill')
  },
  {
    id: 'mcp',
    icon: 'mdi-connection',
    title: t('yaya.assistants.page_mcp', 'MCP'),
    sub: t('yaya.assistants.page_mcp_sub', '这个助手能用哪些 MCP 服务器')
  },
  {
    id: 'context',
    icon: 'mdi-archive-arrow-down-outline',
    title: t('yaya.assistants.page_context', '上下文'),
    sub: t('yaya.assistants.page_context_sub', '对话太长时丢弃或压缩较早的消息')
  },
  {
    id: 'policy',
    icon: 'mdi-shield-check-outline',
    title: t('yaya.assistants.page_policy', '执行策略'),
    sub: t('yaya.assistants.page_policy_sub', '工具确认与最大步数')
  }
])
const pageTitle = computed(() => pages.value.find((p) => p.id === page.value)?.title ?? '')

// ---- 基本设置：模型 / 思考强度 / 工作流 ----

const FOLLOW = ''
const modelItems = computed(() => {
  const items: { title: string; subtitle?: string; value: string }[] = [
    {
      title: te(
        'yaya.assistants.model_follow',
        { model: props.config.activeModel || '?' },
        '跟随默认模型（{model}）'
      ),
      value: FOLLOW
    }
  ]
  for (const p of props.config.providers ?? []) {
    if (!p.enabled) continue
    for (const m of p.models) items.push({ title: m, subtitle: p.name, value: `${p.id}\n${m}` })
  }
  return items
})
const modelValue = computed({
  get: () =>
    selected.value?.activeModel
      ? `${selected.value.activeProviderId || props.config.activeProviderId}\n${selected.value.activeModel}`
      : FOLLOW,
  set: (v: string) => {
    const a = selected.value
    if (!a) return
    if (!v) {
      a.activeModel = ''
      a.activeProviderId = ''
      return
    }
    const [pid, ...rest] = v.split('\n')
    a.activeProviderId = pid
    a.activeModel = rest.join('\n')
  }
})

const reasoningItems = computed<{ title: string; value: ReasoningEffort }[]>(() =>
  (['default', 'off', 'low', 'medium', 'high'] as const).map((v) => ({
    value: v,
    title: t(`yaya.reasoning.${v}`, v)
  }))
)

const workflows = ref<WorkflowInfo[]>([])
onMounted(async () => {
  try {
    const res = (await window.cockpit.command('yaya.workflows-list')) as
      WorkflowInfo[] | { workflows?: WorkflowInfo[] }
    workflows.value = Array.isArray(res) ? res : (res.workflows ?? [])
  } catch {
    workflows.value = []
  }
})
const workflowItems = computed(() => workflows.value.map((w) => ({ title: w.label, value: w.id })))
</script>

<template>
  <div class="assistants-section d-flex flex-column ga-4">
    <!-- 列表 -->
    <template v-if="!selected">
      <div class="text-caption text-medium-emphasis">
        {{
          t(
            'yaya.assistants.desc',
            '每个助手有自己的名字、提示词、模型、插件与 MCP。新对话用标星的那个，聊天页顶部可以切换。'
          )
        }}
      </div>
      <div class="d-flex align-center ga-2">
        <v-text-field
          v-model="search"
          class="flex-grow-1"
          prepend-inner-icon="mdi-magnify"
          :placeholder="t('yaya.assistants.search', '搜索助手')"
          variant="outlined"
          density="compact"
          hide-details
          clearable
        />
        <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="create">
          {{ t('yaya.assistants.create', '新建') }}
        </v-btn>
      </div>

      <div class="d-flex flex-column ga-2">
        <div
          v-for="a in filtered"
          :key="a.id"
          class="assistant-card d-flex align-center ga-3 rounded-lg"
          role="button"
          tabindex="0"
          :aria-label="a.assistantName"
          @click="open(a)"
          @keydown.enter.prevent="open(a)"
        >
          <AvatarBadge v-bind="avatarOf(a)" :size="44" />
          <div class="min-w-0 flex-grow-1">
            <div class="d-flex align-center ga-2">
              <span class="text-body-1 font-weight-medium text-truncate">{{
                a.assistantName
              }}</span>
              <v-icon
                v-if="config.activeAssistantId === a.id"
                icon="mdi-star"
                color="primary"
                size="16"
                :title="t('yaya.assistants.is_default', '新对话默认用这个助手')"
                :aria-label="t('yaya.assistants.is_default', '新对话默认用这个助手')"
              />
            </div>
            <div class="text-caption text-medium-emphasis text-truncate">
              {{ a.activeModel || t('yaya.assistants.follow_short', '默认模型') }}
            </div>
          </div>
          <v-menu location="bottom end">
            <template #activator="{ props: menuProps }">
              <v-btn
                v-bind="menuProps"
                icon="mdi-dots-vertical"
                variant="text"
                size="small"
                :title="t('yaya.assistants.menu', '助手操作')"
                :aria-label="t('yaya.assistants.menu', '助手操作')"
                @click.stop
              />
            </template>
            <v-list density="compact" min-width="200" class="py-1 yaya-pop">
              <v-list-item
                v-if="config.activeAssistantId !== a.id"
                prepend-icon="mdi-star-outline"
                :title="t('yaya.assistants.make_default', '设为新对话默认')"
                @click="makeDefault(a)"
              />
              <v-list-item
                prepend-icon="mdi-content-copy"
                :title="t('yaya.assistants.duplicate', '复制')"
                @click="duplicate(a)"
              />
              <v-list-item
                v-if="assistants.length > 1"
                prepend-icon="mdi-delete-outline"
                base-color="error"
                :title="t('yaya.assistants.delete', '删除')"
                @click="deleteTarget = a"
              />
            </v-list>
          </v-menu>
        </div>
        <div v-if="filtered.length === 0" class="text-body-2 text-medium-emphasis text-center py-6">
          {{ t('yaya.assistants.empty_search', '没有匹配的助手') }}
        </div>
      </div>
    </template>

    <!-- 详情 -->
    <template v-else-if="scoped">
      <div class="d-flex align-center ga-2">
        <v-btn variant="text" class="text-none" prepend-icon="mdi-chevron-left" @click="back">
          {{ page ? selected.assistantName : t('yaya.assistants.back_list', '助手列表') }}
        </v-btn>
        <span v-if="page" class="text-subtitle-1 font-weight-bold text-truncate">{{
          pageTitle
        }}</span>
      </div>

      <!-- 详情首页：头像 + 名字 + 提示词预览 + 各页入口 -->
      <template v-if="!page">
        <div class="detail-head d-flex flex-column align-center ga-2 text-center">
          <AvatarBadge v-bind="avatarOf(selected)" :size="80" />
          <div class="text-h6">{{ selected.assistantName }}</div>
          <div
            v-if="promptPreview(selected)"
            class="text-body-2 text-medium-emphasis prompt-preview"
          >
            {{ promptPreview(selected) }}
          </div>
          <v-btn
            v-if="config.activeAssistantId !== selected.id"
            variant="tonal"
            prepend-icon="mdi-star-outline"
            @click="makeDefault(selected)"
          >
            {{ t('yaya.assistants.make_default', '设为新对话默认') }}
          </v-btn>
          <v-chip v-else variant="tonal" color="primary" prepend-icon="mdi-star" class="chip-pad">
            {{ t('yaya.assistants.is_default', '新对话默认用这个助手') }}
          </v-chip>
        </div>
        <div class="d-flex flex-column ga-2">
          <div
            v-for="p in pages"
            :key="p.id"
            class="page-row d-flex align-center ga-3 rounded-lg"
            role="button"
            tabindex="0"
            @click="page = p.id"
            @keydown.enter.prevent="page = p.id"
          >
            <v-icon :icon="p.icon" size="24" color="primary" class="flex-shrink-0" />
            <div class="min-w-0 flex-grow-1">
              <div class="text-body-1 font-weight-medium">{{ p.title }}</div>
              <div class="text-caption text-medium-emphasis">{{ p.sub }}</div>
            </div>
            <v-icon icon="mdi-chevron-right" class="flex-shrink-0" />
          </div>
        </div>
      </template>

      <!-- 基本设置 -->
      <div v-else-if="page === 'basic'" class="d-flex flex-column ga-4">
        <v-text-field
          v-model="selected.assistantName"
          :label="t('yaya.settings.assistant_name', '助手名称')"
          :counter="32"
          maxlength="32"
          variant="outlined"
        />
        <ProfileSection :config="scoped" part="assistant" />
        <v-divider />
        <v-select
          v-model="modelValue"
          :items="modelItems"
          :label="t('yaya.assistants.model', '模型')"
          :hint="
            t(
              'yaya.assistants.model_hint',
              '这个助手的新对话用这个模型；聊天页里换模型也会记到这里'
            )
          "
          persistent-hint
          variant="outlined"
        >
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps" :subtitle="item.raw.subtitle" />
          </template>
        </v-select>
        <v-select
          :model-value="selected.reasoningEffort ?? 'default'"
          :items="reasoningItems"
          :label="t('yaya.reasoning.title', '思考强度')"
          variant="outlined"
          hide-details
          @update:model-value="(v: ReasoningEffort) => (selected!.reasoningEffort = v)"
        />
        <v-select
          v-if="workflowItems.length"
          :model-value="selected.defaultWorkflow ?? 'agent'"
          :items="workflowItems"
          :label="t('yaya.settings.default_workflow', '默认工作流')"
          variant="outlined"
          hide-details
          @update:model-value="(v: string) => (selected!.defaultWorkflow = v)"
        />
      </div>

      <AssistantSection v-else-if="page === 'prompt'" :config="scoped" prompt-only />
      <PluginsSection
        v-else-if="page === 'plugins'"
        :key="`plugins-${selected.id}`"
        :config="scoped"
        :assistant-id="selected.id"
        :only="['plugins', 'skills']"
      />
      <PluginsSection
        v-else-if="page === 'mcp'"
        :key="`mcp-${selected.id}`"
        :config="scoped"
        :assistant-id="selected.id"
        :only="['mcp']"
      />
      <ContextSection v-else-if="page === 'context'" :config="scoped" />
      <PolicySection v-else-if="page === 'policy'" :config="scoped" assistant-scope />
    </template>

    <v-dialog
      :model-value="!!deleteTarget"
      max-width="400"
      @update:model-value="deleteTarget = null"
    >
      <v-card class="pa-4 yaya-pop">
        <v-card-title class="px-0 pt-0 text-h6">
          {{ t('yaya.assistants.delete_title', '删除助手') }}
        </v-card-title>
        <v-card-text class="px-0 py-3 text-body-2 text-medium-emphasis">
          {{
            te(
              'yaya.assistants.delete_body',
              { name: deleteTarget?.assistantName ?? '' },
              '删除「{name}」？用它的旧对话会改用第一个助手的设置，对话记录不会删除。'
            )
          }}
        </v-card-text>
        <v-card-actions class="px-0 pb-0 ga-2 justify-end">
          <v-btn variant="text" @click="deleteTarget = null">
            {{ t('yaya.sessions.cancel', '取消') }}
          </v-btn>
          <v-btn color="error" variant="elevated" @click="doDelete">
            {{ t('yaya.assistants.delete', '删除') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.assistants-section {
  width: 100%;
  min-width: 0;
}
.assistant-card,
.page-row {
  min-height: 64px;
  padding: 12px 8px 12px 16px;
  cursor: pointer;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant), 0.08);
}
.page-row {
  padding-right: 16px;
}
.assistant-card:hover,
.page-row:hover {
  background: rgba(var(--v-theme-primary), 0.08);
}
.detail-head {
  padding: 8px 16px 4px;
}
.prompt-preview {
  max-width: 520px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.chip-pad {
  padding-block: 4px;
  min-height: 28px;
}
</style>
