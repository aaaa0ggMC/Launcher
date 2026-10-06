<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ProviderConfig, YayaConfig } from '../types'

defineOptions({ name: 'ModelSelectDialog' })

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    currentModel: string
    currentProviderId?: string
    config: YayaConfig | null
  }>(),
  { currentProviderId: '' }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'select', payload: { model: string; providerId: string }): void
  (e: 'add-custom-model', payload: { model: string; providerId: string }): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

// 窄屏（手机）弹窗全屏化；与全站断点一致，用 matchMedia 而非 useDisplay
const narrow = ref(false)
let narrowMql: MediaQueryList | null = null
function onNarrowChange(e: MediaQueryListEvent): void {
  narrow.value = e.matches
}
onMounted(() => {
  narrowMql = window.matchMedia('(max-width: 720px)')
  narrow.value = narrowMql.matches
  narrowMql.addEventListener('change', onNarrowChange)
})
onBeforeUnmount(() => {
  narrowMql?.removeEventListener('change', onNarrowChange)
})

// 只展示已启用的服务商
const enabledProviders = computed<ProviderConfig[]>(() =>
  (props.config?.providers ?? []).filter((p) => p.enabled)
)

// Provider 过滤 Tab：'all' 或具体 provider.id
const selectedProviderTab = ref('all')

// 全局搜索（同时过滤所有 Provider 的模型名）
const globalSearch = ref('')

// 拉取结果只做本地覆盖显示，不直接改写 props 里的 config；
// 命令本身已在主进程落盘，父组件下次拉取配置时自然同步
const fetchedModels = ref<Record<string, string[]>>({})
watch(
  () => props.config,
  () => {
    fetchedModels.value = {}
  }
)
watch(
  () => enabledProviders.value.map((p) => p.id).join('|'),
  () => {
    if (
      selectedProviderTab.value !== 'all' &&
      !enabledProviders.value.some((p) => p.id === selectedProviderTab.value)
    ) {
      selectedProviderTab.value = 'all'
    }
  }
)

// 插件给模型加的小标签（插件 SDK hooks.modelHint，如价格 / 上下文长度）
const hints = ref<Record<string, { badges?: string[]; title?: string }>>({})
async function loadHints(): Promise<void> {
  const pairs = enabledProviders.value.flatMap((p) =>
    modelsOf(p).map((model) => ({ providerId: p.id, model }))
  )
  if (!pairs.length) return
  try {
    const r = (await window.cockpit.command('yaya.model-hints', {
      pairs: JSON.stringify(pairs)
    })) as { hints?: typeof hints.value }
    hints.value = r.hints ?? {}
  } catch {
    /* 没有标签也能选模型 */
  }
}
function hintOf(provider: ProviderConfig, model: string): { badges?: string[]; title?: string } {
  return hints.value[`${provider.id}/${model}`] ?? {}
}
watch(
  () => [isOpen.value, fetchedModels.value] as const,
  ([open]) => {
    if (open) void loadHints()
  }
)
let offHints: (() => void) | undefined
onMounted(() => {
  offHints = window.cockpit.on('cockpit:yaya-model-hints-changed', () => {
    if (isOpen.value) void loadHints()
  })
})
onBeforeUnmount(() => offHints?.())

// 轻量操作提示条（拉取成功 / 失败）
const toast = ref<{ text: string; ok: boolean } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string, ok: boolean): void {
  toast.value = { text, ok }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 4000)
}

const refreshingProviderId = ref<string | null>(null)
async function refreshModels(provider: ProviderConfig): Promise<void> {
  refreshingProviderId.value = provider.id
  try {
    const res = (await window.cockpit.command('yaya.provider-fetch-models', {
      providerId: provider.id
    })) as { ok: boolean; models?: string[]; error?: string }
    if (res.ok && res.models && res.models.length > 0) {
      fetchedModels.value = { ...fetchedModels.value, [provider.id]: res.models }
      showToast(
        te(
          'yaya.models.refreshOk',
          { name: provider.name, n: String(res.models.length) },
          '已从 {name} 拉取 {n} 个模型'
        ),
        true
      )
    } else {
      showToast(
        te(
          'yaya.models.refreshFail',
          { error: res.error || t('yaya.models.unknownError', '未知错误') },
          '拉取失败：{error}'
        ),
        false
      )
    }
  } catch (e) {
    showToast(te('yaya.models.refreshFail', { error: String(e) }, '拉取失败：{error}'), false)
  } finally {
    refreshingProviderId.value = null
  }
}

function modelsOf(provider: ProviderConfig): string[] {
  return fetchedModels.value[provider.id] ?? provider.models
}

function filteredModelsOf(provider: ProviderConfig): string[] {
  const q = globalSearch.value.trim().toLowerCase()
  if (!q) return modelsOf(provider)
  return modelsOf(provider).filter((m) => m.toLowerCase().includes(q))
}

/** 分组标题上的模型计数：有搜索词时显示「命中 / 总数」 */
function countLabel(provider: ProviderConfig): string {
  const total = modelsOf(provider).length
  if (globalSearch.value.trim()) {
    return te(
      'yaya.models.countSearch',
      { m: String(filteredModelsOf(provider).length), n: String(total) },
      '{m} / {n} 个模型'
    )
  }
  return te('yaya.models.count', { n: String(total) }, '{n} 个模型')
}

const totalModels = computed(() =>
  enabledProviders.value.reduce((acc, p) => acc + modelsOf(p).length, 0)
)

const displayedProviders = computed<ProviderConfig[]>(() => {
  if (selectedProviderTab.value === 'all') return enabledProviders.value
  return enabledProviders.value.filter((p) => p.id === selectedProviderTab.value)
})

function isCurrentModel(provider: ProviderConfig, model: string): boolean {
  if (model !== props.currentModel) return false
  return !props.currentProviderId || props.currentProviderId === provider.id
}

function handleSelect(model: string, providerId: string): void {
  emit('select', { model, providerId })
  isOpen.value = false
}

// 自定义模型
const customModelName = ref('')
const customProviderId = ref('')
const showCustomInput = ref(false)

function handleAddCustomModel(): void {
  const name = customModelName.value.trim()
  if (!name) return
  const provider =
    enabledProviders.value.find((p) => p.id === customProviderId.value) ?? enabledProviders.value[0]
  if (!provider) return
  emit('add-custom-model', { model: name, providerId: provider.id })
  handleSelect(name, provider.id)
  customModelName.value = ''
  showCustomInput.value = false
}

// 关闭时清掉筛选态，下次打开是干净界面
watch(isOpen, (v) => {
  if (v) return
  globalSearch.value = ''
  selectedProviderTab.value = 'all'
  showCustomInput.value = false
  toast.value = null
})
</script>

<template>
  <v-dialog
    v-model="isOpen"
    :fullscreen="narrow"
    max-width="640"
    scrollable
    transition="dialog-bottom-transition"
    class="model-select-dialog"
  >
    <v-card class="model-select-card yaya-pop d-flex flex-column">
      <!-- 头部：标题 + 关闭 -->
      <v-card-title class="d-flex align-center ga-2 px-5 pt-4 pb-2 flex-shrink-0">
        <v-icon icon="mdi-robot-outline" color="primary" size="24" />
        <div class="min-w-0">
          <div class="text-h6 font-weight-bold">{{ t('yaya.models.title', '选择大模型') }}</div>
          <div class="text-caption text-medium-emphasis">
            {{ t('yaya.models.subtitle', '切换推理模型与服务商') }}
          </div>
        </div>
        <v-spacer />
        <v-btn
          icon="mdi-close"
          variant="text"
          size="small"
          :title="t('yaya.models.close', '关闭')"
          :aria-label="t('yaya.models.close', '关闭')"
          @click="isOpen = false"
        />
      </v-card-title>

      <v-divider />

      <!-- 工具栏：Provider 过滤 tab + 全局搜索 -->
      <template v-if="enabledProviders.length > 0">
        <div class="px-5 pt-3 pb-2 flex-shrink-0">
          <v-slide-group v-model="selectedProviderTab" mandatory class="provider-tabs mb-3">
            <v-slide-group-item v-slot="{ isSelected, toggle }" value="all">
              <v-chip
                :color="isSelected ? 'primary' : undefined"
                :variant="isSelected ? 'flat' : 'outlined'"
                class="provider-tab-chip mr-2 cursor-pointer"
                prepend-icon="mdi-view-grid-outline"
                @click="toggle"
              >
                {{ t('yaya.models.tabAll', '全部') }} ({{ totalModels }})
              </v-chip>
            </v-slide-group-item>

            <v-slide-group-item
              v-for="p in enabledProviders"
              :key="p.id"
              v-slot="{ isSelected, toggle }"
              :value="p.id"
            >
              <v-chip
                :color="isSelected ? 'primary' : undefined"
                :variant="isSelected ? 'flat' : 'outlined'"
                class="provider-tab-chip mr-2 cursor-pointer"
                :prepend-icon="p.type === 'ollama' ? 'mdi-server' : 'mdi-cloud-outline'"
                @click="toggle"
              >
                {{ p.name }} ({{ modelsOf(p).length }})
              </v-chip>
            </v-slide-group-item>
          </v-slide-group>

          <v-text-field
            v-model="globalSearch"
            class="global-search"
            prepend-inner-icon="mdi-magnify"
            :placeholder="t('yaya.models.search', '搜索模型名称...')"
            density="compact"
            variant="outlined"
            hide-details
            clearable
          />
        </div>

        <v-divider />
      </template>

      <!-- 模型列表 -->
      <v-card-text class="model-scroll flex-grow-1 overflow-y-auto min-h-0 px-5 py-3">
        <!-- 操作提示条（轻量，不是大红块） -->
        <div
          v-if="toast"
          class="model-toast text-caption d-flex align-center ga-2 px-3 py-2 mb-3 rounded-lg"
          :class="toast.ok ? 'is-ok' : 'is-error'"
          role="status"
        >
          <v-icon
            :icon="toast.ok ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline'"
            size="16"
          />
          <span class="flex-grow-1">{{ toast.text }}</span>
        </div>

        <!-- 空状态：没有启用的服务商 -->
        <div
          v-if="enabledProviders.length === 0"
          class="model-empty text-center py-8 text-medium-emphasis"
        >
          <v-icon icon="mdi-server-off" size="30" class="mb-2" />
          <div class="text-body-2 font-weight-medium mb-1">
            {{ t('yaya.models.emptyTitle', '暂无可用服务商') }}
          </div>
          <div class="text-caption">
            {{ t('yaya.models.emptyBody', '请先在设置里启用至少一个模型服务商') }}
          </div>
        </div>

        <div v-for="provider in displayedProviders" :key="provider.id" class="provider-group mb-4">
          <!-- 服务商头部：名称 + 计数 + 拉取 -->
          <div class="d-flex flex-wrap align-center ga-2 pb-2">
            <v-icon
              :icon="provider.type === 'ollama' ? 'mdi-server' : 'mdi-server-network'"
              size="18"
              color="primary"
            />
            <span class="text-subtitle-2 font-weight-bold text-truncate">{{ provider.name }}</span>
            <v-chip variant="tonal" class="info-chip">{{ provider.type }}</v-chip>
            <v-chip variant="tonal" color="primary" class="info-chip">
              {{ countLabel(provider) }}
            </v-chip>
            <v-spacer />
            <v-btn
              icon="mdi-cloud-download-outline"
              size="small"
              variant="text"
              density="comfortable"
              :loading="refreshingProviderId === provider.id"
              :title="t('yaya.models.refresh', '从端点拉取模型列表')"
              :aria-label="t('yaya.models.refresh', '从端点拉取模型列表')"
              @click.stop="refreshModels(provider)"
            />
          </div>

          <v-list nav density="comfortable" class="pa-0 bg-transparent">
            <v-list-item
              v-for="model in filteredModelsOf(provider)"
              :key="model"
              :active="isCurrentModel(provider, model)"
              color="primary"
              rounded="lg"
              class="model-row"
              @click="handleSelect(model, provider.id)"
            >
              <template #prepend>
                <v-icon
                  :icon="isCurrentModel(provider, model) ? 'mdi-check-circle' : 'mdi-cube-outline'"
                  :color="isCurrentModel(provider, model) ? 'primary' : 'medium-emphasis'"
                  size="18"
                  class="mr-3"
                />
              </template>

              <v-list-item-title class="text-body-2 font-weight-medium text-truncate">
                {{ model }}
              </v-list-item-title>
              <v-list-item-subtitle
                v-if="hintOf(provider, model).badges?.length"
                class="model-hint"
                :title="hintOf(provider, model).title"
              >
                {{ hintOf(provider, model).badges!.join(' · ') }}
              </v-list-item-subtitle>

              <template #append>
                <v-chip
                  v-if="isCurrentModel(provider, model)"
                  color="primary"
                  variant="flat"
                  size="small"
                  class="active-tag-chip"
                >
                  {{ t('yaya.models.current', '当前使用') }}
                </v-chip>
              </template>
            </v-list-item>
          </v-list>

          <div
            v-if="filteredModelsOf(provider).length === 0"
            class="model-none text-caption text-medium-emphasis text-center py-4 border rounded border-dashed"
          >
            {{ t('yaya.models.noMatch', '未找到匹配的模型') }}
          </div>
        </div>

        <!-- 自定义模型 -->
        <v-card
          v-if="enabledProviders.length > 0"
          variant="outlined"
          class="custom-model-card pa-3 rounded-lg border-dashed"
        >
          <div
            class="d-flex align-center justify-space-between cursor-pointer"
            @click="showCustomInput = !showCustomInput"
          >
            <div class="d-flex align-center ga-2">
              <v-icon icon="mdi-plus-circle-outline" size="18" color="primary" />
              <span class="text-body-2 font-weight-medium">
                {{ t('yaya.models.customTitle', '输入自定义模型名称') }}
              </span>
            </div>
            <v-icon :icon="showCustomInput ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" />
          </div>

          <v-expand-transition>
            <div v-if="showCustomInput" class="pt-3">
              <v-row dense>
                <v-col cols="12" sm="5">
                  <v-select
                    v-model="customProviderId"
                    :items="enabledProviders.map((p) => ({ title: p.name, value: p.id }))"
                    :label="t('yaya.models.customProvider', '所属服务商')"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="7">
                  <v-text-field
                    v-model="customModelName"
                    :label="t('yaya.models.customName', '模型标识')"
                    :placeholder="
                      t('yaya.models.customPlaceholder', '如 claude-sonnet-4、qwen-max')
                    "
                    density="compact"
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
                  prepend-icon="mdi-check"
                  :disabled="!customModelName.trim()"
                  @click="handleAddCustomModel"
                >
                  {{ t('yaya.models.customApply', '应用并加入列表') }}
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
          v-if="globalSearch.trim()"
          variant="text"
          prepend-icon="mdi-refresh"
          @click="globalSearch = ''"
        >
          {{ t('yaya.models.resetSearch', '重置搜索') }}
        </v-btn>
        <v-spacer />
        <v-btn variant="tonal" @click="isOpen = false">
          {{ t('yaya.models.close', '关闭') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.model-select-card {
  border-radius: 14px;
  max-height: 82vh;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.2);
}

/* chip 默认密度 + 显式 padding-block，label 不贴边 */
.provider-tab-chip,
.info-chip,
.active-tag-chip {
  padding-block: 4px;
  min-height: 24px;
}

/* tab 横向滑动列表本身滚，不会把滚动条甩到页面 */
.provider-tabs {
  max-width: 100%;
}

.global-search :deep(.v-field) {
  border-radius: 8px;
}

.model-scroll {
  min-height: 0;
}

.model-row {
  min-height: 44px;
}

.model-row:hover {
  background: rgba(var(--v-theme-primary), 0.08);
}

/* 轻量提示条：细边框 + 淡淡的语义色，不是大红块 */
.model-toast {
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.25);
  background: rgba(var(--v-theme-surface-variant), 0.18);
}

.model-toast.is-ok {
  color: rgb(var(--v-theme-primary));
}

.model-toast.is-error {
  color: rgb(var(--v-theme-error));
}

.custom-model-card {
  background: rgba(var(--v-theme-surface-variant), 0.08);
  border-color: rgba(var(--v-theme-surface-bright), 0.3) !important;
}

/* 手机：弹窗全屏，卡片撑满，行高保触摸下限 */
@media (max-width: 720px) {
  .model-select-card {
    max-height: 100%;
    height: 100%;
  }

  .model-row {
    min-height: 48px;
  }
}
.model-hint {
  font-variant-numeric: tabular-nums;
}
</style>
