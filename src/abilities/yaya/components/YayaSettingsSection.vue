<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { YayaConfig, ProviderConfig } from '../types'

const config = ref<YayaConfig | null>(null)
const loading = ref(false)
const saveSuccess = ref(false)
const saveError = ref<string | null>(null)

// 刷新状态与提示
const refreshingProviderId = ref<string | null>(null)
const actionNotice = ref<{ text: string; color: string } | null>(null)

// 添加服务商对话框
const showAddDialog = ref(false)
const newProvider = ref<Partial<ProviderConfig>>({
  name: '',
  type: 'openai',
  baseUrl: '',
  apiKey: '',
  enabled: true,
  models: []
})
const addingLoading = ref(false)
const addTestNotice = ref<string | null>(null)

// 密码显示状态
const showKeyMap = ref<Record<string, boolean>>({})

const providerTypes = [
  { title: 'OpenAI 兼容协议 (OpenAI / DeepSeek / SiliconFlow / StepFun 等)', value: 'openai' },
  { title: 'Ollama (本地部署)', value: 'ollama' },
  { title: 'Codex Proxy (本地代理)', value: 'codex-proxy' },
  { title: 'Anthropic Claude (Messages API)', value: 'anthropic' },
  { title: 'Google Gemini (Native API)', value: 'gemini' }
]

function setNotice(text: string, color = 'primary'): void {
  actionNotice.value = { text, color }
  setTimeout(() => {
    actionNotice.value = null
  }, 4000)
}

async function loadConfig(): Promise<void> {
  loading.value = true
  try {
    const res = (await window.cockpit.command('yaya.config-get')) as YayaConfig
    config.value = res
  } catch (err) {
    console.error('Failed to load Yaya config', err)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!config.value) return
  saveError.value = null
  try {
    const rawConfig = JSON.parse(JSON.stringify(config.value))
    await window.cockpit.command('yaya.config-save', { config: rawConfig })
    saveSuccess.value = true
    setTimeout(() => {
      saveSuccess.value = false
    }, 2500)
  } catch (err) {
    console.error('Failed to save Yaya config', err)
    saveError.value = String(err)
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
      setNotice(`成功从 ${provider.name} 动态获取 ${res.models.length} 个模型`, 'success')
      await save()
    } else {
      setNotice(res.error || '获取模型列表失败，请检查 Base URL 与 Key', 'error')
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
    addTestNotice.value = '请先输入 Base URL'
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
      addTestNotice.value = `探测成功！共发现 ${res.models.length} 个模型`
    } else {
      addTestNotice.value = res.error || '探测端点未返回有效模型'
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
    addTestNotice.value = '请输入服务商显示名称'
    return
  }
  if (!p.baseUrl?.trim()) {
    addTestNotice.value = '请输入 Base URL'
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
  setNotice(`已添加服务商 ${created.name}`, 'success')
}

function deleteProvider(id: string): void {
  if (!config.value) return
  const idx = config.value.providers.findIndex((p) => p.id === id)
  if (idx !== -1) {
    const name = config.value.providers[idx].name
    config.value.providers.splice(idx, 1)
    if (config.value.activeProviderId === id && config.value.providers.length > 0) {
      config.value.activeProviderId = config.value.providers[0].id
    }
    save()
    setNotice(`已移除服务商 ${name}`, 'info')
  }
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div v-if="config" class="yaya-settings-container pa-3 pa-sm-4">
    <!-- 顶部状态提示条 -->
    <v-alert
      v-if="actionNotice"
      :color="actionNotice.color"
      density="compact"
      variant="tonal"
      class="mb-3 text-caption"
      closable
      @click:close="actionNotice = null"
    >
      {{ actionNotice.text }}
    </v-alert>

    <!-- 1. 常规与推理策略卡片 (告别密集嵌套，响应式纵向分层) -->
    <v-card variant="outlined" class="settings-card pa-4 mb-4 rounded-lg">
      <div class="text-subtitle-1 font-weight-bold mb-1 d-flex align-center ga-2">
        <v-icon icon="mdi-tune" color="primary" size="20" />
        <span>常规与推理策略</span>
      </div>
      <div class="text-caption text-medium-emphasis mb-4">
        配置 YAYA 的默认大模型、系统提示词与执行策略
      </div>

      <!-- 默认服务商与默认模型 (响应式表单，手机端单列不挤压) -->
      <v-row dense class="mb-2">
        <v-col cols="12" sm="6">
          <v-select
            v-model="config.activeProviderId"
            :items="config.providers.map((p) => ({ title: p.name, value: p.id }))"
            label="当前默认服务商 (Provider)"
            variant="outlined"
            density="comfortable"
            hide-details
            class="mb-2 mb-sm-0"
          />
        </v-col>
        <v-col cols="12" sm="6">
          <v-text-field
            v-model="config.activeModel"
            label="当前默认模型 (Model Identifier)"
            placeholder="gpt-5.5, deepseek-chat, gpt-4o"
            variant="outlined"
            density="comfortable"
            hide-details
          />
        </v-col>
      </v-row>

      <!-- 系统提示词 -->
      <div class="mt-3">
        <v-textarea
          v-model="config.systemPrompt"
          label="全局系统提示词 (System Prompt)"
          variant="outlined"
          rows="3"
          density="comfortable"
          hide-details
        />
      </div>

      <!-- 开关项：独立 Setting Item 卡片结构，彻底解决手机端文本与边框重叠问题 -->
      <div
        class="setting-item d-flex align-center justify-space-between py-3 px-3 rounded-lg border mt-4"
      >
        <div class="pr-3 min-w-0">
          <div class="text-body-2 font-weight-medium">自动允许工具调用</div>
          <div class="text-caption text-medium-emphasis text-truncate">
            调用系统命令或读写文件时免去人工审批弹窗
          </div>
        </div>
        <v-switch
          v-model="config.autoApproveTools"
          color="primary"
          hide-details
          density="compact"
          class="flex-shrink-0"
        />
      </div>

      <!-- 单次任务思考循环上限 -->
      <div class="mt-3">
        <v-text-field
          v-model.number="config.maxLoopSteps"
          label="思考循环上限步数 (Max Loop Steps)"
          type="number"
          variant="outlined"
          density="comfortable"
          hide-details
          class="max-w-field"
        />
      </div>
    </v-card>

    <!-- 2. 服务商与端点大一统管理 (支持自由添加/删除/探测，参考 codex-proxy-node) -->
    <v-card variant="outlined" class="settings-card pa-4 mb-4 rounded-lg">
      <div class="d-flex flex-wrap align-center justify-space-between ga-2 mb-3">
        <div>
          <div class="text-subtitle-1 font-weight-bold d-flex align-center ga-2">
            <v-icon icon="mdi-server-network" color="primary" size="20" />
            <span>服务商与端点管理 (Providers)</span>
          </div>
          <div class="text-caption text-medium-emphasis">
            支持动态扩充任意兼容 OpenAI、Ollama、Claude 等服务商与端点
          </div>
        </div>
        <v-btn
          color="primary"
          variant="tonal"
          density="default"
          prepend-icon="mdi-plus"
          @click="openAddProviderDialog"
        >
          添加服务商
        </v-btn>
      </div>

      <!-- Provider 列表卡片组 -->
      <div class="providers-stack d-flex flex-column ga-3 mt-3">
        <v-card
          v-for="provider in config.providers"
          :key="provider.id"
          variant="outlined"
          class="provider-item-card pa-3 rounded-lg"
        >
          <!-- 卡片头部：开关 + 标题 + 类型 + 模型数 + 操作按钮 -->
          <div class="d-flex flex-wrap align-center justify-space-between ga-2 mb-2 pb-2 border-b">
            <div class="d-flex align-center ga-2 min-w-0">
              <v-switch
                v-model="provider.enabled"
                color="primary"
                hide-details
                density="compact"
                class="flex-shrink-0"
              />
              <span class="font-weight-bold text-subtitle-2 text-truncate">{{
                provider.name
              }}</span>
              <v-chip size="x-small" variant="tonal" class="type-chip flex-shrink-0">
                {{ provider.type }}
              </v-chip>
              <v-chip
                size="x-small"
                variant="tonal"
                color="primary"
                class="type-chip flex-shrink-0"
              >
                {{ provider.models.length }} 个模型
              </v-chip>
            </div>

            <!-- 卡片右侧快捷操作 -->
            <div class="d-flex align-center ga-1">
              <v-btn
                variant="tonal"
                density="default"
                prepend-icon="mdi-cloud-download-outline"
                :loading="refreshingProviderId === provider.id"
                title="拉取 /v1/models"
                class="refresh-btn"
                @click="refreshModelsForProvider(provider)"
              >
                拉取模型
              </v-btn>
              <v-btn
                icon="mdi-delete-outline"
                variant="text"
                size="small"
                color="error"
                title="删除服务商"
                aria-label="删除服务商"
                @click="deleteProvider(provider.id)"
              />
            </div>
          </div>

          <!-- 卡片内部配置表单 (BaseURL + API Key) -->
          <v-row dense class="mt-1">
            <v-col cols="12" md="6">
              <v-text-field
                v-model="provider.baseUrl"
                label="API Base URL"
                placeholder="https://api.openai.com/v1"
                variant="outlined"
                density="comfortable"
                hide-details
                class="mb-2 mb-md-0"
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="provider.apiKey"
                label="API Key (密钥保密加密存储)"
                :type="showKeyMap[provider.id] ? 'text' : 'password'"
                :append-inner-icon="showKeyMap[provider.id] ? 'mdi-eye-off' : 'mdi-eye'"
                variant="outlined"
                density="comfortable"
                hide-details
                @click:append-inner="showKeyMap[provider.id] = !showKeyMap[provider.id]"
              />
            </v-col>
          </v-row>

          <!-- 模型标签列表预览 -->
          <div v-if="provider.models.length > 0" class="d-flex flex-wrap ga-1 mt-2">
            <v-chip
              v-for="m in provider.models.slice(0, 8)"
              :key="m"
              size="x-small"
              variant="outlined"
              class="model-tag-chip"
            >
              {{ m }}
            </v-chip>
            <span
              v-if="provider.models.length > 8"
              class="text-caption text-medium-emphasis self-center ml-1"
            >
              +{{ provider.models.length - 8 }} 更多...
            </span>
          </div>
        </v-card>
      </div>
    </v-card>

    <!-- 底部固定保存栏 -->
    <div class="d-flex flex-wrap align-center ga-3 mt-4">
      <v-btn
        color="primary"
        variant="elevated"
        density="default"
        prepend-icon="mdi-content-save"
        @click="save"
      >
        保存全部配置
      </v-btn>
      <span v-if="saveSuccess" class="text-caption text-success d-flex align-center ga-1">
        <v-icon icon="mdi-check" size="small" />
        配置已安全加密保存
      </span>
      <span v-if="saveError" class="text-caption text-error">
        {{ saveError }}
      </span>
    </div>

    <!-- 添加服务商弹窗 -->
    <v-dialog v-model="showAddDialog" max-width="580" transition="dialog-bottom-transition">
      <v-card class="pa-4 rounded-lg">
        <v-card-title class="px-0 pt-0 text-h6 font-weight-bold d-flex align-center ga-2">
          <v-icon icon="mdi-plus-box-outline" color="primary" />
          <span>添加模型服务商 (Provider)</span>
        </v-card-title>
        <v-card-subtitle class="px-0 text-caption text-medium-emphasis">
          自定义配置服务商类型、端点地址并一键拉取模型
        </v-card-subtitle>

        <div class="mt-4 d-flex flex-column ga-3">
          <v-text-field
            v-model="newProvider.name"
            label="服务商显示名称"
            placeholder="如: SiliconFlow 硅基流动, LM Studio 本地"
            variant="outlined"
            density="comfortable"
            hide-details
          />

          <v-select
            v-model="newProvider.type"
            :items="providerTypes"
            label="协议类型 (Protocol Type)"
            variant="outlined"
            density="comfortable"
            hide-details
          />

          <v-text-field
            v-model="newProvider.baseUrl"
            label="API Base URL"
            placeholder="如: https://api.siliconflow.cn/v1 或 http://127.0.0.1:11434"
            variant="outlined"
            density="comfortable"
            hide-details
          />

          <v-text-field
            v-model="newProvider.apiKey"
            label="API Key (可选，无则留空)"
            placeholder="sk-..."
            type="password"
            variant="outlined"
            density="comfortable"
            hide-details
          />

          <!-- 端点连通性测试与模型嗅探按钮 -->
          <div class="d-flex align-center justify-space-between pt-1">
            <v-btn
              variant="tonal"
              density="default"
              prepend-icon="mdi-cloud-search-outline"
              :loading="addingLoading"
              @click="testAndFetchNewProvider"
            >
              探测端点并拉取模型 (/v1/models)
            </v-btn>
            <span v-if="addTestNotice" class="text-caption text-primary text-truncate ml-2">
              {{ addTestNotice }}
            </span>
          </div>
        </div>

        <v-card-actions class="px-0 pb-0 pt-4 mt-2">
          <v-spacer />
          <v-btn variant="text" density="default" @click="showAddDialog = false"> 取消 </v-btn>
          <v-btn
            color="primary"
            variant="elevated"
            density="default"
            prepend-icon="mdi-check"
            @click="confirmAddProvider"
          >
            确认添加
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

.setting-item {
  background: rgba(var(--v-theme-surface-variant), 0.15);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.provider-item-card {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.type-chip {
  padding-block: 2px;
  min-height: 20px;
}

.model-tag-chip {
  padding-block: 2px;
  min-height: 20px;
  opacity: 0.85;
}

.refresh-btn {
  border-radius: 6px;
}

.max-w-field {
  max-width: 320px;
}

.min-w-0 {
  min-width: 0;
}
</style>
