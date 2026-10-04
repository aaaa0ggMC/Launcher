<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { ProviderConfig, ProviderType, YayaConfig } from '../../types'
import type { ProviderDraft } from './shared'
import ProviderDetail from './ProviderDetail.vue'
import { providerTypeItems } from './shared'

defineOptions({ name: 'cockpit-yaya-settings-providers' })

const props = defineProps<{
  config: YayaConfig
  /** 当前正在查看详情的服务商 id（外壳持有，窄屏第二层才使用） */
  selectedProviderId: string | null
  /** 宽屏：详情直接嵌在右侧内容区；窄屏：详情由外壳渲染为第三层 */
  inlineDetail: boolean
  /** 窄屏时添加弹窗全屏 */
  narrow: boolean
  /** 正在拉取模型列表的服务商 id */
  refreshingProviderId: string | null
  /** 各服务商「保存后清除密钥」的待生效状态 */
  pendingClearKey: Record<string, boolean>
}>()

const emit = defineEmits<{
  (e: 'selectProvider', id: string): void
  (e: 'backToList'): void
  (e: 'refresh', provider: ProviderConfig): void
  (e: 'delete', id: string): void
  (e: 'clearKey', id: string): void
  (e: 'undoClearKey', id: string): void
  (e: 'addProvider', draft: ProviderDraft): void
}>()

/** 添加服务商弹窗里的草稿（不含 id，由外壳落库） */
const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const providerTypes = computed(() => providerTypeItems(t))

/** 宽屏内嵌详情对应的服务商（已被删掉时回到列表） */
const inlineProvider = computed(
  () => props.config.providers.find((p) => p.id === props.selectedProviderId) ?? null
)

// 添加服务商
const showAddDialog = ref(false)
const newProvider = ref({
  name: '',
  type: 'openai' as ProviderType,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  models: [] as string[]
})
const addingLoading = ref(false)
const addTestNotice = ref<string | null>(null)

function openAddProviderDialog(): void {
  newProvider.value = {
    name: '',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
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
      newProvider.value.models = res.models
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

function confirmAddProvider(): void {
  const p = newProvider.value
  if (!p.name?.trim()) {
    addTestNotice.value = t('yaya.settings.probe_need_name', '请输入服务商显示名称')
    return
  }
  if (!p.baseUrl?.trim()) {
    addTestNotice.value = t('yaya.settings.probe_need_url', '请先输入 Base URL')
    return
  }
  // 草稿是 ref（reactive），交给外壳前先深拷贝
  const draft: ProviderDraft = JSON.parse(JSON.stringify(p))
  draft.name = draft.name.trim()
  draft.baseUrl = draft.baseUrl.trim()
  if (draft.models.length === 0) draft.models = ['default']
  emit('addProvider', draft)
}

function onRowActivate(id: string): void {
  emit('selectProvider', id)
}
</script>

<template>
  <div class="section-page d-flex flex-column ga-4">
    <div class="d-flex flex-wrap align-center justify-space-between ga-2">
      <div class="text-caption text-medium-emphasis providers-sub">
        {{
          t('yaya.settings.providers_desc', '配置 OpenAI 兼容、Ollama 或 Codex Proxy 端点与密钥')
        }}
      </div>
      <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" @click="openAddProviderDialog">
        {{ t('yaya.settings.add_provider', '添加服务商') }}
      </v-btn>
    </div>

    <div v-if="config.providers.length === 0" class="py-6 text-center text-medium-emphasis">
      <span class="text-body-2">{{
        t('yaya.settings.providers_empty', '尚未添加任何服务商')
      }}</span>
    </div>

    <!-- 宽屏：选中的服务商以详情页形式占满右侧内容区 -->
    <ProviderDetail
      v-else-if="inlineDetail && inlineProvider"
      :provider="inlineProvider"
      :pending-clear-key="!!pendingClearKey[inlineProvider.id]"
      :show-back="true"
      :refreshing="refreshingProviderId === inlineProvider.id"
      @back="emit('backToList')"
      @refresh="emit('refresh', $event)"
      @delete="emit('delete', $event)"
      @clear-key="emit('clearKey', $event)"
      @undo-clear-key="emit('undoClearKey', $event)"
    />

    <div v-else class="providers-stack d-flex flex-column ga-2">
      <div
        v-for="provider in config.providers"
        :key="provider.id"
        class="provider-row d-flex align-center ga-3 pa-3 rounded-lg border"
        role="button"
        :aria-label="provider.name"
        tabindex="0"
        @click="onRowActivate(provider.id)"
        @keydown.enter.prevent="onRowActivate(provider.id)"
        @keydown.space.prevent="onRowActivate(provider.id)"
      >
        <v-icon icon="mdi-server-network" color="primary" class="flex-shrink-0" />
        <div class="min-w-0 flex-grow-1">
          <div class="d-flex align-center flex-wrap ga-2">
            <span class="font-weight-bold text-subtitle-2">{{ provider.name }}</span>
            <v-chip size="small" variant="tonal" class="chip-pad flex-shrink-0">
              {{ provider.type }}
            </v-chip>
            <v-chip
              v-if="!provider.enabled"
              size="small"
              variant="tonal"
              color="warning"
              class="chip-pad flex-shrink-0"
            >
              {{ t('yaya.settings.provider_disabled', '已停用') }}
            </v-chip>
          </div>
          <div class="text-caption text-medium-emphasis provider-row-sub">
            {{
              te(
                'yaya.settings.provider_models',
                { n: String(provider.models.length) },
                '{n} 个模型'
              )
            }}
            <template v-if="provider.baseUrl"> · {{ provider.baseUrl }}</template>
          </div>
        </div>
        <v-icon icon="mdi-chevron-right" class="flex-shrink-0" />
      </div>
    </div>

    <!-- 添加服务商弹窗 -->
    <v-dialog
      v-model="showAddDialog"
      max-width="580"
      :fullscreen="narrow"
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
.section-page {
  width: 100%;
}

.provider-row {
  background: rgba(var(--v-theme-surface-variant), 0.12);
  border-color: rgba(var(--v-theme-surface-bright), 0.2) !important;
  cursor: pointer;
}

.providers-sub {
  min-width: 0;
}

.provider-row-sub {
  white-space: normal;
  overflow-wrap: anywhere;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

.add-dialog-card {
  background: rgba(var(--v-theme-surface), 0.98);
}

/* 窄屏（手机 ≤720px）：全屏弹窗标题/操作固定，表单区滚动 */
@media (max-width: 720px) {
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
