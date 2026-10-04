<script setup lang="ts">
import { ref, computed } from 'vue'
import type { YayaConfig, ProviderConfig } from '../types'

defineOptions({ name: 'ModelSelectDialog' })

const props = defineProps<{
  modelValue: boolean
  currentModel: string
  currentProviderId?: string
  config: YayaConfig | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'select', payload: { model: string; providerId: string }): void
  (e: 'add-custom-model', payload: { model: string; providerId: string }): void
}>()

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

// Provider 筛选 Tab: 'all' 或具体 provider.id
const selectedProviderTab = ref('all')

// 全局搜索框
const globalSearch = ref('')

// 每个 Provider 独立的搜索过滤词 (满足"多个provider下每个provider也可以进行搜索")
const providerSearch = ref<Record<string, string>>({})

// 自定义模型输入
const customModelName = ref('')
const customProviderId = ref('')
const showCustomInput = ref(false)

const refreshingProviderId = ref<string | null>(null)
const refreshToast = ref<string | null>(null)

async function refreshModels(provider: ProviderConfig): Promise<void> {
  refreshingProviderId.value = provider.id
  try {
    const res = (await window.cockpit.command('yaya.provider-fetch-models', {
      providerId: provider.id
    })) as { ok: boolean; models?: string[]; error?: string }
    if (res.ok && res.models) {
      provider.models = res.models
      refreshToast.value = `成功从 ${provider.name} 动态拉取到 ${res.models.length} 个模型`
      setTimeout(() => {
        refreshToast.value = null
      }, 3500)
    } else {
      refreshToast.value = res.error || '拉取失败，请检查服务地址与网络'
      setTimeout(() => {
        refreshToast.value = null
      }, 4000)
    }
  } catch (e) {
    refreshToast.value = String(e)
    setTimeout(() => {
      refreshToast.value = null
    }, 4000)
  } finally {
    refreshingProviderId.value = null
  }
}

const allProviders = computed<ProviderConfig[]>(() => {
  return props.config?.providers || []
})

// 计算每个 Provider 匹配后的模型列表
function getFilteredModels(provider: ProviderConfig): string[] {
  const gQuery = globalSearch.value.trim().toLowerCase()
  const pQuery = (providerSearch.value[provider.id] || '').trim().toLowerCase()

  return provider.models.filter((m) => {
    const matchesGlobal = !gQuery || m.toLowerCase().includes(gQuery)
    const matchesProvider = !pQuery || m.toLowerCase().includes(pQuery)
    return matchesGlobal && matchesProvider
  })
}

// 统计特定 provider 匹配到的模型数量
function getMatchedCount(provider: ProviderConfig): number {
  return getFilteredModels(provider).length
}

// 显示的 Provider 列表 (受 tab 过滤)
const displayedProviders = computed(() => {
  if (selectedProviderTab.value === 'all') {
    return allProviders.value
  }
  return allProviders.value.filter((p) => p.id === selectedProviderTab.value)
})

function handleSelect(model: string, providerId: string): void {
  emit('select', { model, providerId })
  isOpen.value = false
}

function handleAddCustomModel(): void {
  const name = customModelName.value.trim()
  const pId = customProviderId.value || displayedProviders.value[0]?.id || 'codex-proxy'
  if (!name) return

  emit('add-custom-model', { model: name, providerId: pId })
  handleSelect(name, pId)
  customModelName.value = ''
  showCustomInput.value = false
}

function clearSearch(): void {
  globalSearch.value = ''
  providerSearch.value = {}
}
</script>

<template>
  <v-dialog
    v-model="isOpen"
    max-width="720"
    scrollable
    transition="dialog-bottom-transition"
    class="model-select-dialog"
  >
    <v-card class="model-select-card d-flex flex-column">
      <!-- 头部：标题 + 描述 + 关闭按钮 -->
      <v-card-title class="px-5 pt-4 pb-2 d-flex align-center justify-space-between flex-shrink-0">
        <div class="d-flex align-center ga-2">
          <v-icon icon="mdi-robot-outline" color="primary" size="24" />
          <div>
            <div class="text-h6 font-weight-bold">选择大模型</div>
            <div class="text-caption text-medium-emphasis">
              为当前对话或全局切换所使用的推理大模型与服务提供商
            </div>
          </div>
        </div>
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          aria-label="关闭"
          @click="isOpen = false"
        />
      </v-card-title>

      <v-divider />

      <!-- 工具栏：Provider 标签切换 + 全局搜索 -->
      <div class="px-5 pt-3 pb-2 flex-shrink-0">
        <!-- Provider 快捷切换 Tab -->
        <v-slide-group v-model="selectedProviderTab" mandatory class="mb-3">
          <v-slide-group-item v-slot="{ isSelected, toggle }" value="all">
            <v-chip
              :color="isSelected ? 'primary' : undefined"
              :variant="isSelected ? 'flat' : 'outlined'"
              class="mr-2 provider-tab-chip cursor-pointer"
              prepend-icon="mdi-view-grid-outline"
              @click="toggle"
            >
              全部 ({{ allProviders.reduce((acc, p) => acc + p.models.length, 0) }})
            </v-chip>
          </v-slide-group-item>

          <v-slide-group-item
            v-for="p in allProviders"
            :key="p.id"
            v-slot="{ isSelected, toggle }"
            :value="p.id"
          >
            <v-chip
              :color="isSelected ? 'primary' : undefined"
              :variant="isSelected ? 'flat' : 'outlined'"
              class="mr-2 provider-tab-chip cursor-pointer"
              :prepend-icon="p.type === 'ollama' ? 'mdi-server' : 'mdi-cloud-outline'"
              @click="toggle"
            >
              {{ p.name }} ({{ p.models.length }})
            </v-chip>
          </v-slide-group-item>
        </v-slide-group>

        <!-- 全局搜索栏 -->
        <v-text-field
          v-model="globalSearch"
          placeholder="全局搜索所有 Provider 的模型名称..."
          density="comfortable"
          variant="outlined"
          prepend-inner-icon="mdi-magnify"
          clearable
          hide-details
          class="global-search-field"
        />
      </div>

      <v-divider />

      <!-- 中间可滚动区域：按 Provider 分组展示模型与独立搜索 -->
      <v-card-text class="px-5 py-4 flex-grow-1 overflow-y-auto">
        <!-- 操作状态提示条 -->
        <v-alert
          v-if="refreshToast"
          density="compact"
          color="primary"
          variant="tonal"
          class="mb-3 text-caption"
          closable
          @click:close="refreshToast = null"
        >
          {{ refreshToast }}
        </v-alert>

        <div v-if="displayedProviders.length === 0" class="text-center py-8 text-medium-emphasis">
          暂无可用模型提供商
        </div>

        <div
          v-for="provider in displayedProviders"
          :key="provider.id"
          class="provider-group-card mb-4 pa-4 rounded-lg border"
        >
          <!-- Provider 头部栏：信息 + 专属搜索框 + 动态拉取按钮 -->
          <div class="d-flex flex-wrap align-center justify-space-between ga-2 mb-3">
            <div class="d-flex align-center ga-2 min-w-0">
              <v-icon
                :icon="provider.type === 'ollama' ? 'mdi-server' : 'mdi-server-network'"
                size="18"
                color="primary"
              />
              <span class="font-weight-bold text-subtitle-2 text-truncate">{{
                provider.name
              }}</span>
              <v-chip size="x-small" variant="tonal" class="info-chip">
                {{ provider.type }}
              </v-chip>
              <v-chip
                size="x-small"
                :color="provider.enabled ? 'success' : 'default'"
                variant="tonal"
                class="info-chip"
              >
                {{ provider.enabled ? '已启用' : '备用' }}
              </v-chip>
              <v-chip size="x-small" variant="tonal" color="primary" class="info-chip">
                {{ getMatchedCount(provider) }} / {{ provider.models.length }} 个模型
              </v-chip>
            </div>

            <!-- Provider 专属操作：拉取模型 + 独立过滤输入框 -->
            <div class="d-flex align-center ga-1">
              <v-btn
                icon="mdi-cloud-download-outline"
                variant="text"
                size="small"
                :loading="refreshingProviderId === provider.id"
                :title="'从端点刷新模型列表 (GET /v1/models)'"
                aria-label="从端点刷新模型列表"
                @click.stop="refreshModels(provider)"
              />
              <div class="provider-search-box">
                <v-text-field
                  v-model="providerSearch[provider.id]"
                  density="compact"
                  variant="outlined"
                  :placeholder="'在 ' + provider.name + ' 搜索...'"
                  prepend-inner-icon="mdi-filter-outline"
                  hide-details
                  clearable
                  class="provider-search-input"
                />
              </div>
            </div>
          </div>

          <!-- 模型卡片栅格 (响应式两列) -->
          <v-row v-if="getFilteredModels(provider).length > 0" dense>
            <v-col v-for="model in getFilteredModels(provider)" :key="model" cols="12" sm="6">
              <v-card
                variant="outlined"
                :class="[
                  'model-item-card pa-3 cursor-pointer d-flex align-center justify-space-between',
                  { 'is-active-model': model === currentModel }
                ]"
                @click="handleSelect(model, provider.id)"
              >
                <div class="d-flex align-center ga-2 min-w-0 mr-2">
                  <v-icon
                    :icon="model === currentModel ? 'mdi-check-circle' : 'mdi-cube-outline'"
                    :color="model === currentModel ? 'primary' : 'medium-emphasis'"
                    size="18"
                    class="flex-shrink-0"
                  />
                  <span class="text-body-2 font-weight-medium text-truncate" :title="model">
                    {{ model }}
                  </span>
                </div>

                <v-chip
                  v-if="model === currentModel"
                  color="primary"
                  variant="flat"
                  size="small"
                  class="active-tag-chip flex-shrink-0"
                >
                  当前使用
                </v-chip>
              </v-card>
            </v-col>
          </v-row>

          <!-- 搜索未匹配提示 -->
          <div
            v-else
            class="text-center py-4 text-caption text-medium-emphasis border rounded border-dashed"
          >
            未在此 Provider 下找到匹配的模型
          </div>
        </div>

        <!-- 自定义模型添加折叠区 -->
        <v-card variant="outlined" class="custom-model-card pa-3 rounded-lg border-dashed">
          <div
            class="d-flex align-center justify-space-between cursor-pointer"
            @click="showCustomInput = !showCustomInput"
          >
            <div class="d-flex align-center ga-2">
              <v-icon icon="mdi-plus-circle-outline" size="18" color="primary" />
              <span class="text-body-2 font-weight-medium">输入自定义模型名称</span>
            </div>
            <v-icon :icon="showCustomInput ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" />
          </div>

          <v-expand-transition>
            <div v-if="showCustomInput" class="pt-3">
              <v-row dense>
                <v-col cols="12" sm="5">
                  <v-select
                    v-model="customProviderId"
                    :items="allProviders.map((p) => ({ title: p.name, value: p.id }))"
                    label="所属 Provider"
                    density="comfortable"
                    variant="outlined"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="7">
                  <v-text-field
                    v-model="customModelName"
                    placeholder="如: claude-3-7-sonnet, qwen-max"
                    label="模型标识 (Model Identifier)"
                    density="comfortable"
                    variant="outlined"
                    hide-details
                    @keyup.enter="handleAddCustomModel"
                  />
                </v-col>
              </v-row>
              <div class="d-flex justify-end mt-3">
                <v-btn
                  color="primary"
                  variant="tonal"
                  density="default"
                  prepend-icon="mdi-check"
                  :disabled="!customModelName.trim()"
                  @click="handleAddCustomModel"
                >
                  应用并加入列表
                </v-btn>
              </div>
            </div>
          </v-expand-transition>
        </v-card>
      </v-card-text>

      <v-divider />

      <!-- 底部操作栏 -->
      <v-card-actions class="px-5 py-3 flex-shrink-0">
        <v-btn
          v-if="globalSearch || Object.values(providerSearch).some(Boolean)"
          variant="text"
          density="default"
          prepend-icon="mdi-refresh"
          @click="clearSearch"
        >
          重置搜索
        </v-btn>
        <v-spacer />
        <v-btn variant="tonal" density="default" @click="isOpen = false"> 关闭 </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.model-select-dialog {
  backdrop-filter: blur(8px);
}

.model-select-card {
  border-radius: 14px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
  max-height: 82vh;
}

.provider-tab-chip {
  padding-block: 4px;
  min-height: 24px;
}

.info-chip {
  padding-block: 2px;
  min-height: 20px;
}

.active-tag-chip {
  padding-block: 4px;
  min-height: 24px;
}

.provider-group-card {
  background: rgba(var(--v-theme-surface-variant), 0.15);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.provider-search-box {
  width: 210px;
  min-width: 170px;
}

.model-item-card {
  border-radius: 8px;
  border-color: rgba(var(--v-theme-surface-bright), 0.25) !important;
  background: rgba(var(--v-theme-surface), 0.6);
  transition: all 0.15s ease-in-out;
}

.model-item-card:hover {
  border-color: rgb(var(--v-theme-primary)) !important;
  background: rgba(var(--v-theme-primary), 0.08);
  transform: translateY(-1px);
}

.is-active-model {
  border-color: rgb(var(--v-theme-primary)) !important;
  background: rgba(var(--v-theme-primary), 0.14) !important;
}

.custom-model-card {
  background: rgba(var(--v-theme-surface-variant), 0.08);
  border-color: rgba(var(--v-theme-surface-bright), 0.3) !important;
}

.min-w-0 {
  min-width: 0;
}

@media (max-width: 600px) {
  .provider-search-box {
    width: 100%;
  }
}
</style>
