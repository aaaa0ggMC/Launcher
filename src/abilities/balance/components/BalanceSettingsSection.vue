<script setup lang="ts">
import { ref, onMounted, inject, type Ref } from 'vue'
import type { BalanceConfig, PlatformConfig, BalanceResult } from '../types'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import AbilityIcon from '../../../main/ui/components/AbilityIcon.vue'
import { SUPPORTED_PLATFORM_TYPES, formatBalanceDisplay } from '../shared'

defineOptions({ name: 'BalanceSettingsSection' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string | number>, fallback?: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])),
    fallback
  )

const loading = ref(false)
const saving = ref(false)
const revealKeys = ref(false)
const showEditDialog = ref(false)
const testingConnection = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

const config = ref<BalanceConfig>({
  version: 1,
  settings: {
    autoRefresh: false,
    refreshIntervalSec: 300,
    timeoutSec: 10,
    concurrency: 5
  },
  profiles: [],
  platforms: []
})

const editingPlatform = ref<PlatformConfig>({
  id: '',
  name: '',
  type: 'deepseek',
  apiKey: '',
  profileId: 'default',
  enabled: true,
  baseUrl: '',
  icon: ''
})

const isNew = ref(false)
const supportedTypes = SUPPORTED_PLATFORM_TYPES

async function loadConfig(): Promise<void> {
  loading.value = true
  try {
    const res = (await window.cockpit.command('balance.config.get', {
      reveal: revealKeys.value
    })) as BalanceConfig
    if (res && res.platforms) {
      config.value = res
    }
  } catch (err) {
    console.error('Failed to load balance config:', err)
  } finally {
    loading.value = false
  }
}

async function toggleRevealKeys(): Promise<void> {
  revealKeys.value = !revealKeys.value
  await loadConfig()
}

async function saveGeneralSettings(): Promise<void> {
  saving.value = true
  try {
    await window.cockpit.command('balance.config.set', {
      config: JSON.parse(JSON.stringify(config.value))
    })
  } catch (err) {
    console.error('Failed to save balance settings:', err)
  } finally {
    saving.value = false
  }
}

function openAddDialog(): void {
  isNew.value = true
  editingPlatform.value = {
    id: `custom_${Date.now().toString(36)}`,
    name: '',
    type: 'deepseek',
    apiKey: '',
    profileId: 'default',
    enabled: true,
    baseUrl: '',
    icon: 'gi:settings'
  }
  testResult.value = null
  showEditDialog.value = true
}

function openEditDialog(platform: PlatformConfig): void {
  isNew.value = false
  editingPlatform.value = JSON.parse(JSON.stringify(platform)) as PlatformConfig
  if (!editingPlatform.value.icon) {
    editingPlatform.value.icon = 'gi:settings'
  }
  testResult.value = null
  showEditDialog.value = true
}

async function savePlatform(): Promise<void> {
  const p = editingPlatform.value
  if (!p.name) {
    const found = supportedTypes.find((t) => t.type === p.type)
    p.name = found?.name || p.type
  }
  if (!p.icon) {
    const found = supportedTypes.find((t) => t.type === p.type)
    p.icon = found?.defaultIcon || 'gi:settings'
  }

  saving.value = true
  try {
    await window.cockpit.command('balance.config.upsert', {
      platform: JSON.parse(JSON.stringify(p))
    })
    showEditDialog.value = false
    await loadConfig()
  } catch (err) {
    console.error('Failed to upsert platform:', err)
  } finally {
    saving.value = false
  }
}

async function removePlatform(id: string): Promise<void> {
  try {
    await window.cockpit.command('balance.config.remove', { id })
    await loadConfig()
  } catch (err) {
    console.error('Failed to remove platform:', err)
  }
}

async function testCurrentPlatform(): Promise<void> {
  testingConnection.value = true
  testResult.value = null
  try {
    // Temporarily upsert to test or check directly
    await window.cockpit.command('balance.config.upsert', {
      platform: JSON.parse(JSON.stringify(editingPlatform.value))
    })
    const res = (await window.cockpit.command('balance.check', {
      id: editingPlatform.value.id
    })) as BalanceResult
    if (res && typeof res === 'object' && !res.error) {
      testResult.value = {
        ok: true,
        message: tt(
          'balance.dialog.test_success',
          { balance: formatBalanceDisplay(res) },
          `连接成功: ${formatBalanceDisplay(res)}`
        )
      }
    } else {
      testResult.value = {
        ok: false,
        message: tt(
          'balance.dialog.test_failed',
          { error: res?.error || '未知错误' },
          `连接失败: ${res?.error || '未知错误'}`
        )
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    testResult.value = {
      ok: false,
      message: tt('balance.dialog.test_failed', { error: msg }, `连接失败: ${msg}`)
    }
  } finally {
    testingConnection.value = false
  }
}

function onTypeChange(type: string): void {
  const found = supportedTypes.find((t) => t.type === type)
  if (found) {
    if (!editingPlatform.value.name || isNew.value) {
      editingPlatform.value.name = found.name
    }
    if (!editingPlatform.value.icon || isNew.value) {
      editingPlatform.value.icon = found.defaultIcon || 'gi:settings'
    }
  }
}

onMounted(() => {
  loadConfig()
})
</script>

<template>
  <div class="d-flex flex-column ga-4">
    <!-- General Settings Card -->
    <v-card variant="outlined" class="rounded-lg">
      <v-card-item class="px-4 py-3">
        <v-card-title class="text-subtitle-1 font-weight-bold">
          {{ t('balance.settings', '余额通用设置') }}
        </v-card-title>
        <v-card-subtitle class="text-caption">
          {{ t('balance.settings.auto_refresh_desc', '轮询刷新与请求超时参数') }}
        </v-card-subtitle>
      </v-card-item>

      <v-divider />

      <v-card-text class="px-4 py-4 d-flex flex-column ga-4">
        <v-switch
          v-model="config.settings.autoRefresh"
          color="primary"
          density="comfortable"
          hide-details
          :label="t('balance.settings.auto_refresh', '开启自动定时轮询')"
          @update:model-value="saveGeneralSettings"
        />

        <div class="d-flex flex-wrap ga-4">
          <v-text-field
            v-model.number="config.settings.refreshIntervalSec"
            type="number"
            min="30"
            max="3600"
            density="comfortable"
            variant="outlined"
            style="max-width: 200px"
            :label="t('balance.settings.interval', '刷新间隔 (秒)')"
            hide-details
            @blur="saveGeneralSettings"
          />

          <v-text-field
            v-model.number="config.settings.timeoutSec"
            type="number"
            min="3"
            max="60"
            density="comfortable"
            variant="outlined"
            style="max-width: 200px"
            :label="t('balance.settings.timeout', '请求超时 (秒)')"
            hide-details
            @blur="saveGeneralSettings"
          />

          <v-text-field
            v-model.number="config.settings.concurrency"
            type="number"
            min="1"
            max="20"
            density="comfortable"
            variant="outlined"
            style="max-width: 200px"
            :label="t('balance.settings.concurrency', '最大并发数')"
            hide-details
            @blur="saveGeneralSettings"
          />
        </div>
      </v-card-text>
    </v-card>

    <!-- Platform Credentials Card -->
    <v-card variant="outlined" class="rounded-lg">
      <v-card-item class="px-4 py-3">
        <div class="d-flex align-center justify-space-between flex-wrap ga-2">
          <div>
            <v-card-title class="text-subtitle-1 font-weight-bold">
              {{ t('balance.settings.keys_title', '平台密钥与凭据管理') }}
            </v-card-title>
            <v-card-subtitle class="text-caption">
              {{
                t(
                  'balance.settings.keys_desc',
                  '密钥均在本地以本机硬件 ID AES-256-GCM 密文加密保存'
                )
              }}
            </v-card-subtitle>
          </div>

          <div class="d-flex align-center ga-2">
            <v-btn
              variant="tonal"
              :prepend-icon="revealKeys ? 'mdi-eye-off' : 'mdi-eye'"
              @click="toggleRevealKeys"
            >
              {{
                revealKeys
                  ? t('balance.settings.hide_keys', '隐藏明文密钥')
                  : t('balance.settings.reveal_keys', '显示明文密钥')
              }}
            </v-btn>

            <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="openAddDialog">
              {{ t('balance.add_platform', '添加平台') }}
            </v-btn>
          </div>
        </div>
      </v-card-item>

      <v-divider />

      <v-card-text class="pa-0">
        <v-list lines="two" class="py-0">
          <template v-for="(p, idx) in config.platforms" :key="p.id">
            <v-list-item class="px-4 py-2">
              <template #prepend>
                <div
                  class="mr-3 d-flex align-center justify-center"
                  style="width: 32px; height: 32px"
                >
                  <AbilityIcon :icon="p.icon || 'gi:settings'" :size="24" />
                </div>
              </template>

              <v-list-item-title class="font-weight-medium d-flex align-center ga-2">
                {{ p.name }}
                <v-chip
                  v-if="!p.enabled"
                  size="small"
                  color="warning"
                  variant="tonal"
                  class="balance-chip"
                >
                  已禁用
                </v-chip>
                <v-chip size="small" variant="outlined" class="balance-chip">
                  {{ p.type }}
                </v-chip>
              </v-list-item-title>

              <v-list-item-subtitle class="text-caption font-mono mt-1">
                {{ p.apiKey ? (revealKeys ? p.apiKey : '••••••••••••••••') : '（未设置 API Key）' }}
              </v-list-item-subtitle>

              <template #append>
                <div class="d-flex align-center ga-1">
                  <v-btn icon="mdi-pencil" size="small" variant="text" @click="openEditDialog(p)" />
                  <v-btn
                    icon="mdi-delete-outline"
                    size="small"
                    variant="text"
                    color="error"
                    @click="removePlatform(p.id)"
                  />
                </div>
              </template>
            </v-list-item>
            <v-divider v-if="idx < config.platforms.length - 1" />
          </template>
        </v-list>
      </v-card-text>
    </v-card>

    <!-- Add/Edit Platform Dialog -->
    <v-dialog v-model="showEditDialog" max-width="560px">
      <v-card class="rounded-xl">
        <v-card-title class="px-6 pt-5 pb-3 font-weight-bold">
          {{
            isNew ? t('balance.add_platform', '添加平台') : t('balance.edit_platform', '编辑平台')
          }}
        </v-card-title>
        <v-divider />

        <v-card-text class="px-6 py-4 d-flex flex-column ga-4">
          <v-select
            v-model="editingPlatform.type"
            :items="supportedTypes"
            item-title="name"
            item-value="type"
            density="comfortable"
            variant="outlined"
            :label="t('balance.dialog.platform_type', '平台类型')"
            hide-details
            @update:model-value="onTypeChange"
          />

          <v-text-field
            v-model="editingPlatform.name"
            density="comfortable"
            variant="outlined"
            :label="t('balance.dialog.name', '显示名称')"
            hide-details
          />

          <!-- Icon configuration with preview and presets -->
          <div class="d-flex flex-column ga-1">
            <div class="d-flex align-center ga-3">
              <div
                class="platform-icon-box rounded-lg d-flex align-center justify-center flex-shrink-0"
                style="width: 44px; height: 44px"
              >
                <AbilityIcon :icon="editingPlatform.icon || 'gi:settings'" :size="24" />
              </div>
              <v-text-field
                v-model="editingPlatform.icon"
                density="comfortable"
                variant="outlined"
                :label="t('balance.dialog.icon', '卡片图标')"
                placeholder="gi:settings"
                hide-details
                class="flex-grow-1"
              />
            </div>
            <div class="text-caption text-medium-emphasis px-1">
              {{
                t(
                  'balance.dialog.icon_hint',
                  '支持 gi:settings (扁平齿轮)、default/<名称>[/padding]、emoji/<表情> 或 file/<本地路径>'
                )
              }}
            </div>
            <!-- Quick preset icons -->
            <div class="d-flex align-center flex-wrap ga-1 mt-1">
              <v-chip
                v-for="preset in [
                  { label: '齿轮', icon: 'gi:settings' },
                  { label: '星光', icon: 'default/sparkles/padding' },
                  { label: '芯片', icon: 'default/microchip/padding' },
                  { label: '代币', icon: 'default/bitcoin/padding' },
                  { label: '闪电', icon: 'default/lightning/padding' },
                  { label: '罗盘', icon: 'default/compass/padding' },
                  { label: '搜索', icon: 'default/search/padding' },
                  { label: '云端', icon: 'default/cloud/padding' },
                  { label: '🤖', icon: 'emoji/🤖' },
                  { label: '🧠', icon: 'emoji/🧠' }
                ]"
                :key="preset.icon"
                size="small"
                variant="tonal"
                :color="editingPlatform.icon === preset.icon ? 'primary' : undefined"
                class="cursor-pointer"
                @click="editingPlatform.icon = preset.icon"
              >
                <AbilityIcon :icon="preset.icon" :size="14" class="mr-1" />
                {{ preset.label }}
              </v-chip>
            </div>
          </div>

          <!-- Instructions for Web/Portal based platforms -->
          <div
            v-if="
              editingPlatform.type === 'openai_web' ||
              editingPlatform.type === 'mimo_web' ||
              editingPlatform.type === 'bigmodel_web' ||
              editingPlatform.type === 'google_ai_studio'
            "
            class="d-flex flex-column ga-2"
          >
            <v-alert
              type="info"
              variant="tonal"
              density="comfortable"
              class="rounded-lg text-caption"
            >
              {{
                editingPlatform.type === 'openai_web'
                  ? '网页版 OpenAI 平台采用原生 Chromium 独立隔离会话授权，无需配置 API Key。'
                  : editingPlatform.type === 'mimo_web'
                    ? '小米 MiMo 平台采用原生 Chromium 独立隔离会话授权，无需配置 API Key。'
                    : editingPlatform.type === 'bigmodel_web'
                      ? '智谱 BigModel 平台采用原生 Chromium 独立隔离会话授权，无需配置 API Key。'
                      : 'Google AI Studio 计费控制台快捷卡片。无需配置 API Key，保存后点击卡片即可直达控制台查看。'
              }}
            </v-alert>
          </div>

          <v-text-field
            v-else
            v-model="editingPlatform.apiKey"
            type="text"
            density="comfortable"
            variant="outlined"
            :label="
              editingPlatform.type === 'bigmodel'
                ? 'Authorization Token (抓包或请求头中的 Token)'
                : editingPlatform.type === 'mimo'
                  ? 'Cookie / api-platform_serviceToken'
                  : editingPlatform.type === 'openai'
                    ? 'API Key (sk-...) 或 Session Token (sess-...)'
                    : t('balance.dialog.api_key', 'API 密钥 (硬件绑定加密存储)')
            "
            hide-details
            :placeholder="
              editingPlatform.type === 'bigmodel'
                ? 'eyJhbGciOi...'
                : editingPlatform.type === 'mimo'
                  ? 'api-platform_serviceToken=...; userId=...'
                  : editingPlatform.type === 'openai'
                    ? 'sk-... 或 sess-...'
                    : 'sk-...'
            "
          />

          <v-text-field
            v-model="editingPlatform.baseUrl"
            density="comfortable"
            variant="outlined"
            :label="
              editingPlatform.type === 'google_ai_studio'
                ? '自定义计费页面 URL (选填，如指定 ?billing=xxx)'
                : t('balance.dialog.base_url', '接口地址 / Base URL (选填)')
            "
            hide-details
            :placeholder="
              editingPlatform.type === 'google_ai_studio'
                ? 'https://aistudio.google.com/billing?billing=0124AE-19360F-4521C8'
                : 'https://api.deepseek.com/user/balance'
            "
          />

          <v-switch
            v-model="editingPlatform.enabled"
            color="primary"
            density="comfortable"
            hide-details
            :label="t('balance.dialog.enabled', '启用此平台')"
          />

          <!-- Test Result Alert -->
          <v-alert
            v-if="testResult"
            :type="testResult.ok ? 'success' : 'error'"
            variant="tonal"
            density="compact"
            class="rounded-lg text-caption"
          >
            {{ testResult.message }}
          </v-alert>
        </v-card-text>

        <v-divider />

        <v-card-actions class="px-6 py-4 ga-2">
          <v-btn
            variant="tonal"
            prepend-icon="mdi-lan-connect"
            :loading="testingConnection"
            @click="testCurrentPlatform"
          >
            {{ t('balance.dialog.test', '测试连通性') }}
          </v-btn>
          <v-spacer />
          <v-btn variant="text" @click="showEditDialog = false">
            {{ t('balance.dialog.cancel', '取消') }}
          </v-btn>
          <v-btn color="primary" variant="flat" :loading="saving" @click="savePlatform">
            {{ t('balance.dialog.save', '保存') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.balance-chip {
  padding-block: 4px !important;
  min-height: 24px !important;
}
</style>
