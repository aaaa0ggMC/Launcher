<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ProviderConfig, ToolInfo, YayaConfig } from '../types'

defineOptions({ name: 'cockpit-yaya-settings' })

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const config = ref<YayaConfig | null>(null)
const saving = ref(false)
const saveSuccess = ref(false)
const saveError = ref<string | null>(null)

// 行内操作反馈（拉取模型 / 增删服务商等）
const actionNotice = ref<{ text: string; color: string } | null>(null)

// 拉取模型 / 添加服务商
const refreshingProviderId = ref<string | null>(null)
const showAddDialog = ref(false)
const newProvider = ref<Partial<ProviderConfig>>({
  name: '',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  enabled: true,
  models: []
})
const addingLoading = ref(false)
const addTestNotice = ref<string | null>(null)

// 删除服务商：行内二次确认（不用原生 confirm）
const confirmDeleteId = ref<string | null>(null)

// 密钥「清除」待生效：保存时以 clearApiKey 下发
const pendingClearKey = ref<Record<string, boolean>>({})

// 工具清单（yaya.tools-list）
const tools = ref<ToolInfo[]>([])
const toolsLoading = ref(false)
const toolsError = ref<string | null>(null)

// 窄屏（≤720px）：添加弹窗全屏
const narrowMql = window.matchMedia('(max-width: 720px)')
const isNarrow = ref(narrowMql.matches)
function onNarrowChange(e: MediaQueryListEvent): void {
  isNarrow.value = e.matches
}
narrowMql.addEventListener('change', onNarrowChange)
onBeforeUnmount(() => {
  narrowMql.removeEventListener('change', onNarrowChange)
})

const providerTypes = computed(() => [
  {
    title: t('yaya.settings.type_openai', 'OpenAI 兼容协议（OpenAI / DeepSeek / SiliconFlow 等）'),
    value: 'openai' as const
  },
  { title: t('yaya.settings.type_ollama', 'Ollama（本地部署）'), value: 'ollama' as const },
  {
    title: t('yaya.settings.type_codex_proxy', 'Codex Proxy（本地代理）'),
    value: 'codex-proxy' as const
  }
])

/** 默认服务商下拉只列启用中的服务商 */
const enabledProviders = computed(() =>
  (config.value?.providers ?? [])
    .filter((p) => p.enabled)
    .map((p) => ({ title: p.name, value: p.id }))
)

/** 默认模型下拉：当前默认服务商的模型列表 */
const activeProviderModels = computed(() => {
  const cfg = config.value
  if (!cfg) return []
  return cfg.providers.find((p) => p.id === cfg.activeProviderId)?.models ?? []
})

function setNotice(text: string, color = 'primary'): void {
  actionNotice.value = { text, color }
  setTimeout(() => {
    actionNotice.value = null
  }, 4000)
}

async function loadConfig(): Promise<void> {
  try {
    const res = (await window.cockpit.command('yaya.config-get')) as YayaConfig
    config.value = res
  } catch (err) {
    console.error('Failed to load Yaya config', err)
  }
}

async function loadTools(): Promise<void> {
  toolsLoading.value = true
  toolsError.value = null
  try {
    const res = (await window.cockpit.command('yaya.tools-list')) as
      ToolInfo[] | { tools?: ToolInfo[] }
    tools.value = Array.isArray(res) ? res : (res.tools ?? [])
  } catch (err) {
    tools.value = []
    toolsError.value = String(err)
  } finally {
    toolsLoading.value = false
  }
}

function setToolEnabled(tool: ToolInfo, on: boolean): void {
  tool.enabled = on
  if (!config.value) return
  const disabled = new Set(config.value.disabledTools ?? [])
  if (on) disabled.delete(tool.name)
  else disabled.add(tool.name)
  config.value.disabledTools = [...disabled]
}

async function save(): Promise<void> {
  if (!config.value) return
  saveError.value = null
  saving.value = true
  try {
    // 思考步数夹紧到 1–100
    const steps = Number(config.value.maxLoopSteps)
    config.value.maxLoopSteps = Number.isFinite(steps)
      ? Math.min(100, Math.max(1, Math.round(steps)))
      : 10
    const payload = JSON.parse(JSON.stringify(config.value)) as YayaConfig
    // 密钥只写不回显：空 = 保留原值，点了「清除」才显式清空
    for (const p of payload.providers) {
      if (pendingClearKey.value[p.id]) p.clearApiKey = true
    }
    await window.cockpit.command('yaya.config-save', { config: payload })
    pendingClearKey.value = {}
    saveSuccess.value = true
    setTimeout(() => {
      saveSuccess.value = false
    }, 2500)
    // 重新拉取配置，刷新各服务商的 apiKeySet 状态
    await loadConfig()
  } catch (err) {
    console.error('Failed to save Yaya config', err)
    saveError.value = te('yaya.settings.save_failed', { msg: String(err) }, '保存失败：{msg}')
  } finally {
    saving.value = false
  }
}

async function refreshModelsForProvider(provider: ProviderConfig): Promise<void> {
  refreshingProviderId.value = provider.id
  try {
    const res = (await window.cockpit.command('yaya.provider-fetch-models', {
      providerId: provider.id
    })) as { ok: boolean; models?: string[]; error?: string }

    if (res.ok && res.models) {
      provider.models = res.models
      setNotice(
        te(
          'yaya.settings.fetch_models_ok',
          { name: provider.name, n: String(res.models.length) },
          '成功从 {name} 获取 {n} 个模型'
        ),
        'success'
      )
      await save()
    } else {
      setNotice(
        res.error ||
          t('yaya.settings.fetch_models_failed', '获取模型列表失败，请检查 Base URL 与密钥'),
        'error'
      )
    }
  } catch (e) {
    setNotice(String(e), 'error')
  } finally {
    refreshingProviderId.value = null
  }
}

function openAddProviderDialog(): void {
  newProvider.value = {
    name: '',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    enabled: true,
    models: []
  }
  addTestNotice.value = null
  showAddDialog.value = true
}

async function testAndFetchNewProvider(): Promise<void> {
  const p = newProvider.value
  if (!p.baseUrl) {
    addTestNotice.value = t('yaya.settings.probe_need_url', '请先输入 Base URL')
    return
  }
  addingLoading.value = true
  addTestNotice.value = null
  try {
    const res = (await window.cockpit.command('yaya.provider-fetch-models', {
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      type: p.type
    })) as { ok: boolean; models?: string[]; error?: string }

    if (res.ok && res.models && res.models.length > 0) {
      p.models = res.models
      addTestNotice.value = te(
        'yaya.settings.probe_ok',
        { n: String(res.models.length) },
        '探测成功，发现 {n} 个模型'
      )
    } else {
      addTestNotice.value =
        res.error || t('yaya.settings.probe_failed', '探测失败，请检查 Base URL 与密钥')
    }
  } catch (e) {
    addTestNotice.value = String(e)
  } finally {
    addingLoading.value = false
  }
}

async function confirmAddProvider(): Promise<void> {
  if (!config.value) return
  const p = newProvider.value
  if (!p.name?.trim()) {
    addTestNotice.value = t('yaya.settings.probe_need_name', '请输入服务商显示名称')
    return
  }
  if (!p.baseUrl?.trim()) {
    addTestNotice.value = t('yaya.settings.probe_need_url', '请先输入 Base URL')
    return
  }

  const created: ProviderConfig = {
    id: 'prov-' + crypto.randomUUID().slice(0, 8),
    name: p.name.trim(),
    type: p.type || 'openai',
    baseUrl: p.baseUrl.trim(),
    apiKey: p.apiKey || '',
    models: p.models && p.models.length > 0 ? p.models : ['default'],
    enabled: p.enabled !== false
  }

  config.value.providers.push(created)
  showAddDialog.value = false
  await save()
  setNotice(
    te('yaya.settings.provider_added', { name: created.name }, '已添加服务商 {name}'),
    'success'
  )
}

async function doDeleteProvider(id: string): Promise<void> {
  if (!config.value) return
  const idx = config.value.providers.findIndex((p) => p.id === id)
  if (idx !== -1) {
    const name = config.value.providers[idx].name
    config.value.providers.splice(idx, 1)
    if (config.value.activeProviderId === id && config.value.providers.length > 0) {
      config.value.activeProviderId = config.value.providers[0].id
    }
    confirmDeleteId.value = null
    await save()
    setNotice(te('yaya.settings.provider_removed', { name }, '已移除服务商 {name}'), 'info')
  }
}

function clearApiKey(id: string): void {
  pendingClearKey.value[id] = true
}

function undoClearApiKey(id: string): void {
  delete pendingClearKey.value[id]
}

onMounted(() => {
  loadConfig()
  loadTools()
})
</script>

<template>
  <div v-if="config" class="yaya-settings pa-4">
    <!-- 行内操作反馈 -->
    <v-alert
      v-if="actionNotice"
      :color="actionNotice.color"
      variant="tonal"
      class="mb-4"
      closable
      @click:close="actionNotice = null"
    >
      {{ actionNotice.text }}
    </v-alert>

    <!-- 1. 助手：显示名称与系统提示词 -->
    <v-card variant="outlined" class="settings-card pa-4 mb-4 rounded-lg">
      <div class="text-subtitle-1 font-weight-bold mb-1 d-flex align-center ga-2">
        <v-icon icon="mdi-robot-outline" color="primary" size="20" />
        <span>{{ t('yaya.settings.title_assistant', '助手') }}</span>
      </div>
      <div class="text-caption text-medium-emphasis mb-3">
        {{ t('yaya.settings.assistant_desc', '配置助手的显示名称与默认系统提示词') }}
      </div>

      <v-text-field
        v-model="config.assistantName"
        :label="t('yaya.settings.assistant_name', '助手名称')"
        :placeholder="t('yaya.settings.assistant_name_placeholder', 'YAYA')"
        :hint="
          t(
            'yaya.settings.assistant_name_hint',
            '显示在聊天页顶部与消息署名，最长 32 字符，留空恢复默认'
          )
        "
        :counter="32"
        maxlength="32"
        variant="outlined"
        persistent-hint
      />

      <v-textarea
        v-model="config.systemPrompt"
        :label="t('yaya.settings.system_prompt', '系统提示词')"
        :hint="
          t(
            'yaya.settings.system_prompt_hint',
            '所有新会话的默认提示词，可用 {name} 占位符代表助手名称'
          )
        "
        variant="outlined"
        rows="3"
        persistent-hint
        class="mt-3"
      />
    </v-card>

    <!-- 2. 默认模型 -->
    <v-card variant="outlined" class="settings-card pa-4 mb-4 rounded-lg">
      <div class="text-subtitle-1 font-weight-bold mb-1 d-flex align-center ga-2">
        <v-icon icon="mdi-chip" color="primary" size="20" />
        <span>{{ t('yaya.settings.title_model', '默认模型') }}</span>
      </div>
      <div class="text-caption text-medium-emphasis mb-3">
        {{ t('yaya.settings.model_desc', '新会话默认使用的服务商与模型') }}
      </div>

      <v-row dense>
        <v-col cols="12" sm="6">
          <v-select
            v-model="config.activeProviderId"
            :items="enabledProviders"
            :label="t('yaya.settings.default_provider', '默认服务商')"
            :hint="
              enabledProviders.length === 0
                ? t(
                    'yaya.settings.no_enabled_provider',
                    '暂无已启用的服务商，请先到下方「服务商」分区添加'
                  )
                : undefined
            "
            persistent-hint
            variant="outlined"
          />
        </v-col>
        <v-col cols="12" sm="6">
          <v-combobox
            v-model="config.activeModel"
            :items="activeProviderModels"
            :label="t('yaya.settings.default_model', '默认模型')"
            :placeholder="t('yaya.settings.model_placeholder', '选择或输入模型 ID')"
            variant="outlined"
          />
        </v-col>
      </v-row>
    </v-card>

    <!-- 3. 执行策略 -->
    <v-card variant="outlined" class="settings-card pa-4 mb-4 rounded-lg">
      <div class="text-subtitle-1 font-weight-bold mb-1 d-flex align-center ga-2">
        <v-icon icon="mdi-shield-lock-outline" color="primary" size="20" />
        <span>{{ t('yaya.settings.title_policy', '执行策略') }}</span>
      </div>
      <div class="text-caption text-medium-emphasis mb-3">
        {{ t('yaya.settings.policy_desc', '控制工具调用的确认方式与单次任务的思考步数') }}
      </div>

      <div class="switch-row d-flex align-center ga-3 py-2">
        <div class="min-w-0 flex-grow-1">
          <div class="text-body-2 font-weight-medium">
            {{ t('yaya.settings.auto_approve', '自动允许工具调用') }}
          </div>
          <div class="text-caption text-medium-emphasis switch-desc">
            {{ t('yaya.settings.auto_approve_desc', '打开后调用工具不再逐次弹窗确认') }}
          </div>
        </div>
        <v-switch
          v-model="config.autoApproveTools"
          v-agent-forbidden
          color="primary"
          hide-details
          density="compact"
          class="flex-shrink-0"
        />
      </div>

      <div
        v-if="config.autoApproveTools"
        class="warn-hint d-flex align-center ga-2 mt-2 pa-3 rounded-lg"
      >
        <v-icon icon="mdi-alert-outline" color="warning" size="small" />
        <span class="text-caption">
          {{
            t(
              'yaya.settings.auto_approve_warning',
              '开启后将不经确认直接执行 shell 命令、读写文件等操作，请谨慎评估风险'
            )
          }}
        </span>
      </div>

      <v-text-field
        v-model.number="config.maxLoopSteps"
        :label="t('yaya.settings.max_loop_steps', '最大循环步数')"
        :hint="t('yaya.settings.max_loop_steps_hint', '单次任务中最多连续执行的步数（1–100）')"
        persistent-hint
        type="number"
        min="1"
        max="100"
        step="1"
        variant="outlined"
        class="max-w-field mt-4"
      />
    </v-card>

    <!-- 4. 工具 -->
    <v-card variant="outlined" class="settings-card pa-4 mb-4 rounded-lg">
      <div class="text-subtitle-1 font-weight-bold mb-1 d-flex align-center ga-2">
        <v-icon icon="mdi-tools" color="primary" size="20" />
        <span>{{ t('yaya.settings.title_tools', '工具') }}</span>
      </div>
      <div class="text-caption text-medium-emphasis mb-3">
        {{ t('yaya.settings.tools_desc', '关闭后该工具不再提供给助手调用') }}
      </div>

      <div v-if="toolsLoading" class="text-body-2 text-medium-emphasis py-4">
        {{ t('yaya.settings.tools_loading', '正在加载工具列表…') }}
      </div>
      <div
        v-else-if="tools.length === 0"
        class="d-flex flex-column align-center justify-center ga-2 py-6 text-medium-emphasis"
      >
        <v-icon icon="mdi-tools" size="32" />
        <span class="text-body-2">
          {{
            toolsError
              ? t('yaya.settings.tools_load_failed', '工具列表加载失败')
              : t('yaya.settings.tools_empty', '暂无可用的工具')
          }}
        </span>
      </div>
      <div v-else class="tools-stack d-flex flex-column ga-2">
        <div
          v-for="tool in tools"
          :key="tool.name"
          class="tool-row d-flex align-center ga-3 py-2 px-3 rounded-lg border"
        >
          <div class="min-w-0 flex-grow-1">
            <div class="d-flex align-center flex-wrap ga-2">
              <span class="font-family-mono text-body-2 font-weight-medium">{{ tool.name }}</span>
              <v-chip
                v-if="tool.requiresApproval"
                size="small"
                variant="tonal"
                color="warning"
                class="chip-pad flex-shrink-0"
              >
                {{ t('yaya.settings.tool_needs_approval', '需确认') }}
              </v-chip>
            </div>
            <div class="text-caption text-medium-emphasis tool-desc">
              {{ tool.description }}
            </div>
          </div>
          <v-switch
            :model-value="tool.enabled"
            color="primary"
            hide-details
            density="compact"
            class="flex-shrink-0"
            @update:model-value="setToolEnabled(tool, $event === true)"
          />
        </div>
      </div>
    </v-card>

    <!-- 5. 服务商 -->
    <v-card variant="outlined" class="settings-card pa-4 mb-4 rounded-lg">
      <div class="d-flex flex-wrap align-center justify-space-between ga-2 mb-3">
        <div>
          <div class="text-subtitle-1 font-weight-bold d-flex align-center ga-2">
            <v-icon icon="mdi-server-network" color="primary" size="20" />
            <span>{{ t('yaya.settings.title_providers', '服务商') }}</span>
          </div>
          <div class="text-caption text-medium-emphasis">
            {{
              t(
                'yaya.settings.providers_desc',
                '配置 OpenAI 兼容、Ollama 或 Codex Proxy 端点与密钥'
              )
            }}
          </div>
        </div>
        <v-btn
          color="primary"
          variant="tonal"
          prepend-icon="mdi-plus"
          @click="openAddProviderDialog"
        >
          {{ t('yaya.settings.add_provider', '添加服务商') }}
        </v-btn>
      </div>

      <div v-if="config.providers.length === 0" class="py-6 text-center text-medium-emphasis">
        <span class="text-body-2">{{
          t('yaya.settings.providers_empty', '尚未添加任何服务商')
        }}</span>
      </div>

      <div v-else class="providers-stack d-flex flex-column ga-3">
        <v-card
          v-for="provider in config.providers"
          :key="provider.id"
          variant="outlined"
          class="provider-card pa-3 rounded-lg"
        >
          <!-- 卡片头部：启用开关 + 名称 + chips + 操作 -->
          <div class="provider-head d-flex flex-wrap align-center ga-2 pb-3 mb-3 border-b">
            <v-switch
              v-model="provider.enabled"
              color="primary"
              hide-details
              density="compact"
              class="flex-shrink-0"
            />
            <div class="provider-title min-w-0 flex-grow-1">
              <span class="font-weight-bold text-subtitle-2">{{ provider.name }}</span>
              <div class="d-flex flex-wrap align-center ga-1 mt-1">
                <v-chip size="small" variant="tonal" class="chip-pad flex-shrink-0">
                  {{ provider.type }}
                </v-chip>
                <v-chip size="small" variant="tonal" color="primary" class="chip-pad flex-shrink-0">
                  {{
                    te(
                      'yaya.settings.provider_models',
                      { n: String(provider.models.length) },
                      '{n} 个模型'
                    )
                  }}
                </v-chip>
              </div>
            </div>

            <div class="provider-actions d-flex align-center ga-2 flex-shrink-0">
              <template v-if="confirmDeleteId === provider.id">
                <span class="text-body-2 text-error font-weight-medium">
                  {{ t('yaya.settings.delete_confirm', '确认删除？') }}
                </span>
                <v-btn variant="text" color="error" @click="doDeleteProvider(provider.id)">
                  {{ t('yaya.settings.delete', '删除') }}
                </v-btn>
                <v-btn variant="text" @click="confirmDeleteId = null">
                  {{ t('yaya.settings.cancel', '取消') }}
                </v-btn>
              </template>
              <template v-else>
                <v-btn
                  variant="tonal"
                  prepend-icon="mdi-cloud-download-outline"
                  :loading="refreshingProviderId === provider.id"
                  :title="t('yaya.settings.fetch_models_title', '从端点拉取模型列表')"
                  @click="refreshModelsForProvider(provider)"
                >
                  {{ t('yaya.settings.fetch_models', '拉取模型') }}
                </v-btn>
                <v-btn
                  icon="mdi-delete-outline"
                  variant="text"
                  size="small"
                  color="error"
                  :title="t('yaya.settings.delete_provider_title', '删除服务商')"
                  :aria-label="t('yaya.settings.delete_provider_title', '删除服务商')"
                  @click="confirmDeleteId = provider.id"
                />
              </template>
            </div>
          </div>

          <!-- Base URL + 密钥（只写不回显） -->
          <v-row dense>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="provider.baseUrl"
                :label="t('yaya.settings.base_url', 'API Base URL')"
                placeholder="https://api.openai.com/v1"
                variant="outlined"
                class="mb-3 mb-md-0"
              />
            </v-col>
            <v-col cols="12" md="6">
              <div class="d-flex align-start ga-2">
                <v-text-field
                  v-model="provider.apiKey"
                  v-agent-forbidden
                  :label="t('yaya.settings.api_key', 'API Key')"
                  type="password"
                  :placeholder="
                    pendingClearKey[provider.id]
                      ? t('yaya.settings.api_key_will_clear', '将在保存后清除')
                      : provider.apiKeySet
                        ? t('yaya.settings.api_key_set_placeholder', '已设置（留空则不修改）')
                        : t('yaya.settings.api_key_placeholder', '输入 API Key（sk-...）')
                  "
                  variant="outlined"
                  class="flex-grow-1"
                />
                <v-btn
                  v-if="provider.apiKeySet || pendingClearKey[provider.id]"
                  variant="text"
                  color="error"
                  class="key-clear-btn flex-shrink-0 mt-1"
                  @click="
                    pendingClearKey[provider.id]
                      ? undoClearApiKey(provider.id)
                      : clearApiKey(provider.id)
                  "
                >
                  {{
                    pendingClearKey[provider.id]
                      ? t('yaya.settings.api_key_undo_clear', '撤销')
                      : t('yaya.settings.api_key_clear', '清除')
                  }}
                </v-btn>
              </div>
            </v-col>
          </v-row>

          <!-- 模型标签预览（最多 8 个 + N） -->
          <div v-if="provider.models.length > 0" class="d-flex flex-wrap align-center ga-1 mt-2">
            <v-chip
              v-for="m in provider.models.slice(0, 8)"
              :key="m"
              size="small"
              variant="outlined"
              class="chip-pad model-chip"
            >
              {{ m }}
            </v-chip>
            <span v-if="provider.models.length > 8" class="text-caption text-medium-emphasis">
              {{
                te('yaya.settings.models_more', { n: String(provider.models.length - 8) }, '+{n}')
              }}
            </span>
          </div>
        </v-card>
      </div>
    </v-card>

    <!-- 底部保存栏 -->
    <div class="d-flex flex-wrap align-center ga-3 mb-2">
      <v-btn
        color="primary"
        variant="elevated"
        prepend-icon="mdi-content-save"
        :loading="saving"
        @click="save"
      >
        {{
          saving ? t('yaya.settings.saving', '保存中…') : t('yaya.settings.save', '保存全部配置')
        }}
      </v-btn>
      <span v-if="saveSuccess" class="text-caption text-success d-flex align-center ga-1">
        <v-icon icon="mdi-check" size="small" />
        {{ t('yaya.settings.save_success', '配置已保存') }}
      </span>
      <span v-if="saveError" class="text-caption text-error">
        {{ saveError }}
      </span>
    </div>

    <!-- 添加服务商弹窗 -->
    <v-dialog
      v-model="showAddDialog"
      max-width="580"
      :fullscreen="isNarrow"
      transition="dialog-bottom-transition"
    >
      <v-card class="add-dialog-card pa-4 rounded-lg">
        <v-card-title class="px-0 pt-0 text-h6 font-weight-bold d-flex align-center ga-2">
          <v-icon icon="mdi-plus-box-outline" color="primary" />
          <span>{{ t('yaya.settings.add_dialog_title', '添加服务商') }}</span>
        </v-card-title>
        <v-card-subtitle class="px-0 text-caption text-medium-emphasis">
          {{ t('yaya.settings.add_dialog_desc', '填写服务商信息，可先探测端点并拉取模型列表') }}
        </v-card-subtitle>

        <div class="add-dialog-body d-flex flex-column ga-3 mt-4">
          <v-text-field
            v-model="newProvider.name"
            :label="t('yaya.settings.provider_name', '服务商显示名称')"
            :placeholder="
              t(
                'yaya.settings.provider_name_placeholder',
                '如 SiliconFlow 硅基流动、LM Studio 本地'
              )
            "
            variant="outlined"
          />

          <v-select
            v-model="newProvider.type"
            :items="providerTypes"
            :label="t('yaya.settings.provider_type', '协议类型')"
            variant="outlined"
          />

          <v-text-field
            v-model="newProvider.baseUrl"
            :label="t('yaya.settings.base_url', 'API Base URL')"
            placeholder="https://api.siliconflow.cn/v1 或 http://127.0.0.1:11434"
            variant="outlined"
          />

          <v-text-field
            v-model="newProvider.apiKey"
            v-agent-forbidden
            :label="t('yaya.settings.api_key', 'API Key')"
            :placeholder="t('yaya.settings.api_key_optional_placeholder', '可选，本地端点可留空')"
            type="password"
            variant="outlined"
          />

          <div class="d-flex flex-wrap align-center ga-2">
            <v-btn
              variant="tonal"
              prepend-icon="mdi-cloud-search-outline"
              :loading="addingLoading"
              @click="testAndFetchNewProvider"
            >
              {{ t('yaya.settings.probe', '探测端点并拉取模型') }}
            </v-btn>
            <span v-if="addTestNotice" class="text-caption text-primary add-test-notice">
              {{ addTestNotice }}
            </span>
          </div>
        </div>

        <v-card-actions class="px-0 pb-0 pt-4 mt-2">
          <v-spacer />
          <v-btn variant="text" @click="showAddDialog = false">
            {{ t('yaya.settings.cancel', '取消') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="elevated"
            prepend-icon="mdi-check"
            @click="confirmAddProvider"
          >
            {{ t('yaya.settings.confirm_add', '确认添加') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.settings-card {
  background: rgba(var(--v-theme-surface), 0.7);
  border-color: rgba(var(--v-theme-surface-bright), 0.25) !important;
}

.tool-row {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.provider-card {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.warn-hint {
  background: rgba(var(--v-theme-warning), 0.12);
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

.model-chip {
  opacity: 0.85;
}

/* 开关行 / 工具行说明允许换行，不截断 */
.switch-desc,
.tool-desc {
  white-space: normal;
  overflow-wrap: anywhere;
}

.max-w-field {
  max-width: 320px;
}

.add-dialog-card {
  background: rgba(var(--v-theme-surface), 0.98);
}

/* 窄屏（手机 ≤720px）：表单单列、卡片头换行、操作按钮整行右对齐 */
@media (max-width: 720px) {
  .yaya-settings {
    padding: 12px !important;
  }

  .max-w-field {
    max-width: 100%;
  }

  .provider-actions {
    width: 100%;
    justify-content: flex-end;
  }

  /* 全屏弹窗：标题/操作固定，表单区滚动 */
  .add-dialog-card {
    display: flex;
    flex-direction: column;
    max-height: 100%;
  }

  .add-dialog-body {
    flex-grow: 1;
    min-height: 0;
    overflow-y: auto;
  }
}
</style>
