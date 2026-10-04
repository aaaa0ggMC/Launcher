<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ProviderConfig, YayaConfig } from '../types'
import AssistantSection from './settings/AssistantSection.vue'
import ModelSection from './settings/ModelSection.vue'
import PolicySection from './settings/PolicySection.vue'
import ProviderDetail from './settings/ProviderDetail.vue'
import ProvidersSection from './settings/ProvidersSection.vue'
import ToolsSection from './settings/ToolsSection.vue'
import type { ProviderDraft } from './settings/shared'

defineOptions({ name: 'cockpit-yaya-settings' })

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

type SectionId = 'assistant' | 'model' | 'providers' | 'tools' | 'policy'

interface SectionDef {
  id: SectionId
  icon: string
  titleKey: string
  titleFallback: string
  subKey: string
  subFallback: string
}

/** 分区固定顺序 */
const sections: SectionDef[] = [
  {
    id: 'assistant',
    icon: 'mdi-account-circle-outline',
    titleKey: 'yaya.settings.title_assistant',
    titleFallback: '助手',
    subKey: 'yaya.settings.sub_assistant',
    subFallback: '名称与提示词'
  },
  {
    id: 'model',
    icon: 'mdi-brain',
    titleKey: 'yaya.settings.title_model',
    titleFallback: '默认模型',
    subKey: 'yaya.settings.sub_model',
    subFallback: '服务商与工作流'
  },
  {
    id: 'providers',
    icon: 'mdi-server-network',
    titleKey: 'yaya.settings.title_providers',
    titleFallback: '服务商',
    subKey: 'yaya.settings.sub_providers',
    subFallback: '端点与密钥'
  },
  {
    id: 'tools',
    icon: 'mdi-wrench-outline',
    titleKey: 'yaya.settings.title_tools',
    titleFallback: '工具',
    subKey: 'yaya.settings.sub_tools',
    subFallback: '开关与搜索'
  },
  {
    id: 'policy',
    icon: 'mdi-shield-check-outline',
    titleKey: 'yaya.settings.title_policy',
    titleFallback: '执行策略',
    subKey: 'yaya.settings.sub_policy',
    subFallback: '确认与步数'
  }
]

const config = ref<YayaConfig | null>(null)
const saving = ref(false)
const saveSuccess = ref(false)
const saveError = ref<string | null>(null)

// 行内操作反馈（拉取模型 / 增删服务商等）
const actionNotice = ref<{ text: string; color: string } | null>(null)

// 上次加载 / 保存时的配置快照，用于判断「有未保存的更改」
let configSnapshot = ''

const dirty = computed(
  () => config.value !== null && JSON.stringify(config.value) !== configSnapshot
)

// 拉取模型
const refreshingProviderId = ref<string | null>(null)

// 密钥「清除」待生效：保存时以 clearApiKey 下发
const pendingClearKey = ref<Record<string, boolean>>({})

// ---- 分层导航状态（分区 + 窄屏层级） ----

const STORAGE_KEY = 'yaya-settings-section'

const activeSection = ref<SectionId>('assistant')
/** 窄屏层级：0 = 分区列表，1 = 分区页，2 = 服务商详情 */
const layer = ref(0)
/** 过渡方向：1 = 向前进入，-1 = 返回 */
const slideDir = ref(1)
/** 正在查看详情的服务商 id（宽屏内嵌在服务商分区里） */
const selectedProviderId = ref<string | null>(null)

function persistNavState(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ section: activeSection.value, provider: selectedProviderId.value })
    )
  } catch {
    // 隐私模式 / 存储不可用：忽略
  }
}

function restoreNavState(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { section?: unknown; provider?: unknown }
    if (typeof parsed.section === 'string' && sections.some((s) => s.id === parsed.section)) {
      activeSection.value = parsed.section as SectionId
    }
    if (typeof parsed.provider === 'string') selectedProviderId.value = parsed.provider
  } catch {
    // 读取失败：保持默认分区
  }
}

restoreNavState()

watch([activeSection, selectedProviderId], persistNavState)

function openSection(id: SectionId): void {
  activeSection.value = id
  slideDir.value = 1
  layer.value = 1
}

function backToSections(): void {
  slideDir.value = -1
  layer.value = 0
}

/** 窄屏层级头部的返回 */
function backLayer(): void {
  if (layer.value === 2) {
    slideDir.value = -1
    layer.value = 1
  } else if (layer.value === 1) {
    backToSections()
  }
}

function selectProvider(id: string): void {
  selectedProviderId.value = id
  slideDir.value = 1
  layer.value = 2
}

function backToProviderList(): void {
  selectedProviderId.value = null
  slideDir.value = -1
  layer.value = 1
}

const activeSectionDef = computed(
  () => sections.find((s) => s.id === activeSection.value) ?? sections[0]
)

/** 窄屏第二层正在查看的服务商（已被删除时回到列表） */
const narrowProvider = computed(
  () => config.value?.providers.find((p) => p.id === selectedProviderId.value) ?? null
)

const layerTitle = computed(() => {
  if (layer.value === 2) return narrowProvider.value?.name ?? ''
  return t(activeSectionDef.value.titleKey, activeSectionDef.value.titleFallback)
})

// ---- 宽 / 窄屏：量外壳自身宽度，不用窗口断点 ----

const rootEl = ref<HTMLElement | null>(null)
const wide = ref(true)
let resizeObserver: ResizeObserver | null = null

function measureWidth(): void {
  const w = rootEl.value?.clientWidth ?? 640
  wide.value = w >= 640
}

onMounted(() => {
  measureWidth()
  if (rootEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measureWidth)
    resizeObserver.observe(rootEl.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

const layerKey = computed(() => (wide.value ? 'wide' : `layer-${layer.value}`))
const layerTransition = computed(() => (slideDir.value > 0 ? 'layer-push' : 'layer-pop'))

function notice(text: string, color = 'primary'): void {
  actionNotice.value = { text, color }
  setTimeout(() => {
    actionNotice.value = null
  }, 4000)
}

async function loadConfig(): Promise<void> {
  try {
    const res = (await window.cockpit.command('yaya.config-get')) as YayaConfig
    config.value = res
    configSnapshot = JSON.stringify(res)
  } catch (err) {
    console.error('Failed to load Yaya config', err)
  }
}

async function save(): Promise<void> {
  if (!config.value) return
  saveError.value = null
  saving.value = true
  try {
    // 思考步数夹取到 1–100
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
      notice(
        te(
          'yaya.settings.fetch_models_ok',
          { name: provider.name, n: String(res.models.length) },
          '成功从 {name} 获取 {n} 个模型'
        ),
        'success'
      )
      await save()
    } else {
      notice(
        res.error ||
          t('yaya.settings.fetch_models_failed', '获取模型列表失败，请检查 Base URL 与密钥'),
        'error'
      )
    }
  } catch (e) {
    notice(String(e), 'error')
  } finally {
    refreshingProviderId.value = null
  }
}

async function addProvider(draft: ProviderDraft): Promise<void> {
  if (!config.value) return
  const created: ProviderConfig = {
    id: 'prov-' + crypto.randomUUID().slice(0, 8),
    name: draft.name,
    type: draft.type,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey || '',
    models: draft.models.length > 0 ? draft.models : ['default'],
    enabled: true
  }
  config.value.providers.push(created)
  await save()
  notice(
    te('yaya.settings.provider_added', { name: created.name }, '已添加服务商 {name}'),
    'success'
  )
  // 直接打开新服务商的详情
  selectedProviderId.value = created.id
  slideDir.value = 1
  layer.value = wide.value ? 1 : 2
}

async function doDeleteProvider(id: string): Promise<void> {
  if (!config.value) return
  const idx = config.value.providers.findIndex((p) => p.id === id)
  if (idx === -1) return
  const name = config.value.providers[idx].name
  config.value.providers.splice(idx, 1)
  if (config.value.activeProviderId === id && config.value.providers.length > 0) {
    config.value.activeProviderId = config.value.providers[0].id
  }
  delete pendingClearKey.value[id]
  if (selectedProviderId.value === id) {
    selectedProviderId.value = null
    layer.value = 1
    slideDir.value = -1
  }
  await save()
  notice(te('yaya.settings.provider_removed', { name }, '已移除服务商 {name}'), 'info')
}

function clearApiKey(id: string): void {
  pendingClearKey.value[id] = true
}

function undoClearApiKey(id: string): void {
  delete pendingClearKey.value[id]
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div ref="rootEl" class="yaya-settings pa-4" :class="{ 'yaya-settings--narrow': !wide }">
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

    <div v-if="config" class="settings-body">
      <!-- 宽屏：左侧竖向导航 + 右侧内容区 -->
      <nav v-if="wide" class="settings-nav d-flex flex-column ga-1">
        <div
          v-for="s in sections"
          :key="s.id"
          class="nav-item d-flex align-center ga-3 pa-3 rounded-lg"
          :class="{ 'nav-item--active': activeSection === s.id }"
          role="button"
          :aria-current="activeSection === s.id ? 'page' : undefined"
          tabindex="0"
          @click="openSection(s.id)"
          @keydown.enter.prevent="openSection(s.id)"
          @keydown.space.prevent="openSection(s.id)"
        >
          <v-icon
            :icon="s.icon"
            size="20"
            :color="activeSection === s.id ? 'primary' : undefined"
            class="flex-shrink-0"
          />
          <div class="min-w-0">
            <div class="text-body-2 font-weight-medium nav-title">
              {{ t(s.titleKey, s.titleFallback) }}
            </div>
            <div class="text-caption text-medium-emphasis nav-sub">
              {{ t(s.subKey, s.subFallback) }}
            </div>
          </div>
        </div>
      </nav>

      <div class="settings-content">
        <Transition :name="layerTransition" mode="out-in">
          <div :key="layerKey" class="layer-wrap">
            <!-- 窄屏：分区页 / 详情页头部 -->
            <div v-if="!wide && layer > 0" class="layer-header d-flex align-center ga-2 py-2">
              <v-btn variant="text" prepend-icon="mdi-chevron-left" @click="backLayer">
                {{ t('yaya.settings.back', '返回') }}
              </v-btn>
              <span class="text-subtitle-1 font-weight-bold text-truncate">{{ layerTitle }}</span>
            </div>

            <!-- 窄屏第一层：分区列表 -->
            <div v-if="!wide && layer === 0" class="section-list d-flex flex-column ga-2 pt-1">
              <div
                v-for="s in sections"
                :key="s.id"
                class="section-row d-flex align-center ga-3 pa-3 rounded-lg border"
                role="button"
                tabindex="0"
                @click="openSection(s.id)"
                @keydown.enter.prevent="openSection(s.id)"
                @keydown.space.prevent="openSection(s.id)"
              >
                <v-icon :icon="s.icon" size="24" color="primary" class="flex-shrink-0" />
                <div class="min-w-0 flex-grow-1">
                  <div class="text-body-1 font-weight-medium">
                    {{ t(s.titleKey, s.titleFallback) }}
                  </div>
                  <div class="text-caption text-medium-emphasis">
                    {{ t(s.subKey, s.subFallback) }}
                  </div>
                </div>
                <v-icon icon="mdi-chevron-right" class="flex-shrink-0" />
              </div>
            </div>

            <!-- 窄屏第三层：服务商详情 -->
            <ProviderDetail
              v-else-if="!wide && layer === 2 && narrowProvider"
              :provider="narrowProvider"
              :pending-clear-key="!!pendingClearKey[narrowProvider.id]"
              :show-back="false"
              :refreshing="refreshingProviderId === narrowProvider.id"
              @back="backToProviderList"
              @refresh="refreshModelsForProvider"
              @delete="doDeleteProvider"
              @clear-key="clearApiKey"
              @undo-clear-key="undoClearApiKey"
            />

            <!-- 分区内容（宽屏右侧 / 窄屏第二层） -->
            <AssistantSection v-else-if="activeSection === 'assistant'" :config="config" />
            <ModelSection v-else-if="activeSection === 'model'" :config="config" />
            <ProvidersSection
              v-else-if="activeSection === 'providers'"
              :config="config"
              :selected-provider-id="selectedProviderId"
              :inline-detail="wide"
              :narrow="!wide"
              :refreshing-provider-id="refreshingProviderId"
              :pending-clear-key="pendingClearKey"
              @select-provider="selectProvider"
              @back-to-list="backToProviderList"
              @refresh="refreshModelsForProvider"
              @delete="doDeleteProvider"
              @clear-key="clearApiKey"
              @undo-clear-key="undoClearApiKey"
              @add-provider="addProvider"
            />
            <ToolsSection v-else-if="activeSection === 'tools'" :config="config" />
            <PolicySection v-else-if="activeSection === 'policy'" :config="config" />
          </div>
        </Transition>
      </div>
    </div>

    <div v-else class="py-6 text-center text-medium-emphasis">
      <span class="text-body-2">{{ t('yaya.settings.loading', '正在加载配置…') }}</span>
    </div>

    <!-- 底部保存栏 -->
    <div class="save-bar d-flex flex-wrap align-center ga-3 py-3">
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
      <span v-if="dirty" class="text-caption text-warning d-flex align-center ga-1">
        <v-icon icon="mdi-content-save-alert" size="small" />
        {{ t('yaya.settings.dirty', '有未保存的更改') }}
      </span>
      <span v-if="saveSuccess" class="text-caption text-success d-flex align-center ga-1">
        <v-icon icon="mdi-check" size="small" />
        {{ t('yaya.settings.save_success', '配置已保存') }}
      </span>
      <span v-if="saveError" class="text-caption text-error">{{ saveError }}</span>
    </div>
  </div>
</template>

<style scoped>
.yaya-settings {
  width: 100%;
}

.settings-body {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

/* 宽屏左侧竖向导航 */
.settings-nav {
  width: 200px;
  flex: 0 0 200px;
}

.nav-item {
  cursor: pointer;
  background: rgba(var(--v-theme-surface-variant), 0.08);
}

.nav-item--active {
  background: rgba(var(--v-theme-primary), 0.14);
}

.nav-title,
.nav-sub {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-content {
  flex: 1;
  min-width: 0;
}

.layer-wrap {
  width: 100%;
}

.section-row {
  min-height: 56px;
  cursor: pointer;
  background: rgba(var(--v-theme-surface-variant), 0.08);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
}

/* 底部保存栏：窄屏吸底 */
.save-bar {
  border-radius: 0;
}

.yaya-settings--narrow .save-bar {
  position: sticky;
  bottom: 0;
  z-index: 1;
  margin-top: 8px;
  padding-inline: 4px;
  background: rgb(var(--v-theme-surface));
}

/* 分层切换的轻微横向滑动 */
.layer-push-enter-active,
.layer-push-leave-active,
.layer-pop-enter-active,
.layer-pop-leave-active {
  transition:
    transform 0.18s ease,
    opacity 0.18s ease;
}

.layer-push-enter-from {
  transform: translateX(16px);
  opacity: 0;
}

.layer-push-leave-to {
  transform: translateX(-16px);
  opacity: 0;
}

.layer-pop-enter-from {
  transform: translateX(-16px);
  opacity: 0;
}

.layer-pop-leave-to {
  transform: translateX(16px);
  opacity: 0;
}

/* 窄屏（手机，≤720px）：容器内边距收窄 */
@media (max-width: 720px) {
  .yaya-settings {
    padding: 12px !important;
  }

  .settings-body {
    gap: 8px;
  }
}
</style>
