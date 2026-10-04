<script setup lang="ts">
import { useI18n } from '@ui/i18n'
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import type { ProviderConfig } from '../../types'
import { YAYA_SAVE_API_KEY, type YayaSettingsSaveApi } from './shared'
import { providerTypeItems } from './shared'

defineOptions({ name: 'cockpit-yaya-settings-provider-detail' })

// provider 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、
// 外壳统一保存，故关闭「不要修改 props」检查。
/* eslint-disable vue/no-mutating-props */

const props = defineProps<{
  provider: ProviderConfig
  /** 该服务商的密钥是否处于「保存后清除」待生效状态 */
  pendingClearKey: boolean
  /** 是否显示顶部「返回服务商列表」（窄屏由外壳的层级头部负责返回） */
  showBack: boolean
  /** 正在拉取模型列表（来自外壳的 shell 级状态） */
  refreshing: boolean
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'refresh', provider: ProviderConfig): void
  (e: 'delete', id: string): void
  (e: 'clearKey', id: string): void
  (e: 'undoClearKey', id: string): void
}>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

/** 外壳注入的保存接口：密钥失焦即存，不走防抖 */
const saveApi = inject<YayaSettingsSaveApi | null>(YAYA_SAVE_API_KEY, null)

const providerTypes = computed(() => providerTypeItems(t))

// 删除：行内二次确认（不用原生 confirm）
const confirmDelete = ref(false)

// 清除密钥：行内二次确认（没有保存按钮可以反悔）
const confirmClearKey = ref(false)

// 模板里不要写多语句处理器：prettier（无分号）会把 `a; b` 拆成两行，Vue 编译器解析失败
function doClearKey(): void {
  confirmClearKey.value = false
  emit('clearKey', props.provider.id)
}

// 密钥草稿：只留在本地，失焦 / 回车才写回 provider.apiKey 并立刻保存
const keyDraft = ref('')

function commitKeyDraft(): void {
  const value = keyDraft.value.trim()
  keyDraft.value = ''
  if (!value) return
  props.provider.apiKey = value
  saveApi?.saveNow()
}

// 模型列表搜索
const modelQuery = ref('')

const filteredModels = computed(() => {
  const q = modelQuery.value.trim().toLowerCase()
  if (!q) return props.provider.models
  return props.provider.models.filter((m) => m.toLowerCase().includes(q))
})
</script>

<template>
  <div class="section-page d-flex flex-column ga-4">
    <v-btn
      v-if="showBack"
      variant="text"
      prepend-icon="mdi-chevron-left"
      class="align-self-start"
      @click="emit('back')"
    >
      {{ t('yaya.settings.back_providers', '返回服务商列表') }}
    </v-btn>

    <!-- 启用开关 -->
    <div class="switch-row d-flex align-center ga-3">
      <div class="min-w-0 flex-grow-1">
        <div class="text-body-2 font-weight-medium">
          {{ t('yaya.settings.provider_enabled', '启用该服务商') }}
        </div>
        <div class="text-caption text-medium-emphasis switch-desc">
          {{ t('yaya.settings.provider_enabled_desc', '关闭后不再出现在默认服务商下拉里') }}
        </div>
      </div>
      <v-switch
        v-model="provider.enabled"
        color="primary"
        hide-details
        density="compact"
        class="flex-shrink-0"
      />
    </div>

    <v-text-field
      v-model="provider.name"
      :label="t('yaya.settings.provider_name', '服务商显示名称')"
      :placeholder="
        t('yaya.settings.provider_name_placeholder', '如 SiliconFlow 硅基流动、LM Studio 本地')
      "
      variant="outlined"
    />

    <v-select
      v-model="provider.type"
      :items="providerTypes"
      :label="t('yaya.settings.provider_type', '协议类型')"
      variant="outlined"
    />

    <v-text-field
      v-model="provider.baseUrl"
      :label="t('yaya.settings.base_url', 'API Base URL')"
      placeholder="https://api.openai.com/v1"
      variant="outlined"
    />

    <!-- 密钥：本地草稿，失焦 / 回车才写回并立刻保存（不随打字保存） -->
    <div class="key-row d-flex align-start ga-2 flex-wrap">
      <v-text-field
        v-model="keyDraft"
        v-agent-forbidden
        :label="t('yaya.settings.api_key', 'API Key')"
        type="password"
        :placeholder="
          pendingClearKey
            ? t('yaya.settings.api_key_will_clear', '将在保存后清除')
            : provider.apiKeySet
              ? t('yaya.settings.api_key_draft_placeholder', '已设置（输入新值才会替换）')
              : t('yaya.settings.api_key_placeholder', '输入 API Key（sk-...）')
        "
        variant="outlined"
        class="key-field flex-grow-1"
        @blur="commitKeyDraft"
        @keydown.enter.prevent="commitKeyDraft"
      />

      <div v-if="pendingClearKey" class="d-flex align-center ga-1 flex-shrink-0 key-side">
        <v-btn variant="text" @click="emit('undoClearKey', provider.id)">
          {{ t('yaya.settings.api_key_undo_clear', '撤销') }}
        </v-btn>
      </div>
      <div v-else-if="confirmClearKey" class="d-flex align-center ga-1 flex-shrink-0 key-side">
        <v-btn
          variant="text"
          color="error"
          @click="doClearKey"
        >
          {{ t('yaya.settings.api_key_clear_confirm', '确定清除？') }}
        </v-btn>
        <v-btn variant="text" @click="confirmClearKey = false">
          {{ t('yaya.settings.cancel', '取消') }}
        </v-btn>
      </div>
      <div v-else-if="provider.apiKeySet" class="flex-shrink-0 key-side">
        <v-btn variant="text" color="error" @click="confirmClearKey = true">
          {{ t('yaya.settings.api_key_clear', '清除') }}
        </v-btn>
      </div>
    </div>

    <v-divider />

    <!-- 模型列表：拉取 + 搜索 -->
    <div>
      <div class="d-flex flex-wrap align-center ga-2 mb-3">
        <span class="text-body-2 font-weight-medium">
          {{
            te('yaya.settings.provider_models', { n: String(provider.models.length) }, '{n} 个模型')
          }}
        </span>
        <v-btn
          variant="tonal"
          prepend-icon="mdi-cloud-download-outline"
          :loading="refreshing"
          :title="t('yaya.settings.fetch_models_title', '从端点拉取模型列表')"
          @click="emit('refresh', provider)"
        >
          {{ t('yaya.settings.fetch_models', '拉取模型') }}
        </v-btn>
      </div>

      <v-text-field
        v-if="provider.models.length > 0"
        v-model="modelQuery"
        :label="t('yaya.settings.models_search', '搜索模型')"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        clearable
        hide-details
        class="mb-3"
        @update:model-value="modelQuery = $event ?? ''"
      />

      <div v-if="provider.models.length === 0" class="text-body-2 text-medium-emphasis py-2">
        {{ t('yaya.settings.models_empty', '尚未获取模型列表，可点上方「拉取模型」') }}
      </div>
      <div v-else-if="filteredModels.length === 0" class="text-body-2 text-medium-emphasis py-2">
        {{ t('yaya.settings.models_filter_empty', '没有匹配的模型') }}
      </div>
      <div v-else class="d-flex flex-wrap align-center ga-1">
        <v-chip
          v-for="m in filteredModels.slice(0, 40)"
          :key="m"
          size="small"
          variant="outlined"
          class="chip-pad model-chip"
        >
          {{ m }}
        </v-chip>
        <span v-if="filteredModels.length > 40" class="text-caption text-medium-emphasis">
          {{ te('yaya.settings.models_more', { n: String(filteredModels.length - 40) }, '+{n}') }}
        </span>
      </div>
    </div>

    <v-divider />

    <!-- 删除（二次确认） -->
    <div class="d-flex flex-wrap align-center ga-2 pb-2">
      <template v-if="confirmDelete">
        <span class="text-body-2 text-error font-weight-medium">
          {{ t('yaya.settings.delete_confirm', '确认删除？') }}
        </span>
        <v-btn variant="text" color="error" @click="emit('delete', provider.id)">
          {{ t('yaya.settings.delete', '删除') }}
        </v-btn>
        <v-btn variant="text" @click="confirmDelete = false">
          {{ t('yaya.settings.cancel', '取消') }}
        </v-btn>
      </template>
      <v-btn
        v-else
        variant="text"
        color="error"
        prepend-icon="mdi-delete-outline"
        @click="confirmDelete = true"
      >
        {{ t('yaya.settings.delete_provider', '删除该服务商') }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.section-page {
  width: 100%;
}

/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}

.model-chip {
  opacity: 0.85;
}

/* 开关行说明允许换行，不截断 */
.switch-desc {
  white-space: normal;
  overflow-wrap: anywhere;
}

.key-field {
  min-width: 0;
}

.key-side {
  margin-top: 8px;
}

/* 窄屏（手机 ≤720px）：密钥输入框独占一行，操作按钮跟在下一行 */
@media (max-width: 720px) {
  .key-row {
    flex-direction: column;
    align-items: stretch !important;
  }

  .key-side {
    margin-top: 0;
    justify-content: flex-start;
  }
}
</style>
