<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onUnmounted, inject, type Ref } from 'vue'
import type {
  BalanceConfig,
  BalanceProfile,
  BalanceProviderType,
  BalanceResult,
  PlatformConfig
} from './types'
import AbilityIcon from '../../main/ui/components/AbilityIcon.vue'
import LoadingBar from '../../main/ui/components/LoadingBar.vue'
import ProfileManagerView from './components/ProfileManagerView.vue'
import { translate, translateTemplate } from '../../main/ui/i18n'
import { SUPPORTED_PLATFORM_TYPES, formatBalanceDisplay } from './shared'

defineOptions({ name: 'cockpit-balance' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string | number>, fallback?: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])),
    fallback
  )

// View mode: 'dashboard' | 'profiles'
const viewMode = ref<'dashboard' | 'profiles'>('dashboard')

const loadingAll = ref(false)
const loadingCards = ref<Record<string, boolean>>({})
const expandedCards = ref<Record<string, boolean>>({})
const balances = ref<BalanceResult[]>([])
const config = ref<BalanceConfig | null>(null)
const searchQuery = ref('')
const activeFilter = ref<'all' | 'normal' | 'error'>('all')

// Edit / Add platform modal state
const showEditModal = ref(false)
const isNewPlatform = ref(false)
const editingPlatform = ref<PlatformConfig>({
  id: '',
  name: '',
  type: 'deepseek',
  apiKey: '',
  profileId: 'default',
  enabled: true,
  baseUrl: '',
  icon: 'gi:settings'
})
const showPassword = ref(false)
const testingConnection = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const savingPlatform = ref(false)
const snackbar = ref({ show: false, text: '', color: 'success' })

// Quick add profile dialog from inside edit platform modal
const showQuickProfileDialog = ref(false)
const quickProfileName = ref('')
const creatingQuickProfile = ref(false)

let autoRefreshTimer: ReturnType<typeof setInterval> | null = null
const supportedTypes = SUPPORTED_PLATFORM_TYPES

function showToast(text: string, color = 'success'): void {
  snackbar.value = { show: true, text, color }
}

async function loadData(): Promise<void> {
  try {
    const [cfgRes, listRes] = await Promise.all([
      window.cockpit.command('balance.config.get', { reveal: false }) as Promise<BalanceConfig>,
      window.cockpit.command('balance.list', { refresh: false }) as Promise<BalanceResult[]>
    ])

    if (cfgRes) config.value = cfgRes
    if (Array.isArray(listRes)) {
      balances.value = listRes
    }
  } catch (err) {
    console.error('Failed to load balance data:', err)
    showToast(String(err), 'error')
  }
}

async function refreshSingle(id: string): Promise<void> {
  loadingCards.value[id] = true
  try {
    const res = (await window.cockpit.command('balance.check', { id })) as BalanceResult
    if (res && res.id) {
      const idx = balances.value.findIndex((b) => b.id === id)
      if (idx >= 0) {
        balances.value[idx] = res
      } else {
        balances.value.push(res)
      }
    }
  } catch (err) {
    console.error(`Failed to refresh balance for ${id}:`, err)
    showToast(String(err), 'error')
  } finally {
    loadingCards.value[id] = false
  }
}

async function refreshAll(): Promise<void> {
  if (loadingAll.value) return
  loadingAll.value = true
  try {
    const enabledPlatforms = config.value?.platforms?.filter((p) => p.enabled) || []
    const targetIds = enabledPlatforms.length
      ? enabledPlatforms.map((p) => p.id)
      : balances.value.map((b) => b.id)

    await Promise.all(
      targetIds.map(async (id) => {
        await refreshSingle(id)
      })
    )
  } finally {
    loadingAll.value = false
  }
}

function openAddModal(): void {
  isNewPlatform.value = true
  showPassword.value = false
  testResult.value = null
  editingPlatform.value = {
    id: `custom_${Date.now().toString(36)}`,
    name: '',
    type: 'deepseek',
    apiKey: '',
    profileId: config.value?.profiles?.[0]?.id || 'default',
    enabled: true,
    baseUrl: '',
    icon: 'gi:settings'
  }
  showEditModal.value = true
}

async function openEditModal(platformId: string): Promise<void> {
  isNewPlatform.value = false
  showPassword.value = false
  testResult.value = null

  try {
    const fullCfg = (await window.cockpit.command('balance.config.get', {
      reveal: true
    })) as BalanceConfig
    const found = fullCfg.platforms.find((p) => p.id === platformId)
    if (found) {
      editingPlatform.value = JSON.parse(JSON.stringify(found)) as PlatformConfig
      if (!editingPlatform.value.icon) {
        editingPlatform.value.icon = 'gi:settings'
      }
      if (!editingPlatform.value.profileId) {
        editingPlatform.value.profileId = fullCfg.profiles?.[0]?.id || 'default'
      }
      showEditModal.value = true
    }
  } catch (err) {
    console.error('Failed to get platform config:', err)
  }
}

function onTypeChange(type: string): void {
  const found = supportedTypes.find((t) => t.type === type)
  if (found) {
    if (!editingPlatform.value.name || isNewPlatform.value) {
      editingPlatform.value.name = found.name
    }
    if (!editingPlatform.value.icon || isNewPlatform.value) {
      editingPlatform.value.icon = found.defaultIcon || 'gi:settings'
    }
  }
}

async function handleCreateQuickProfile(): Promise<void> {
  if (!quickProfileName.value.trim()) return
  creatingQuickProfile.value = true
  try {
    const res = (await window.cockpit.command('balance.profiles.upsert', {
      name: quickProfileName.value.trim()
    })) as { ok: boolean; profile?: BalanceProfile }

    if (res && res.ok && res.profile) {
      showToast('新建 Profile 成功')
      await loadData()
      editingPlatform.value.profileId = res.profile.id
      showQuickProfileDialog.value = false
      quickProfileName.value = ''
    }
  } catch (err) {
    showToast(`创建失败: ${String(err)}`, 'error')
  } finally {
    creatingQuickProfile.value = false
  }
}

async function testConnection(): Promise<void> {
  testingConnection.value = true
  testResult.value = null
  try {
    await window.cockpit.command('balance.config.upsert', {
      platform: JSON.parse(JSON.stringify(editingPlatform.value))
    })
    const res = (await window.cockpit.command('balance.check', {
      id: editingPlatform.value.id
    })) as BalanceResult

    if (res && !res.error) {
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

  savingPlatform.value = true
  try {
    await window.cockpit.command('balance.config.upsert', {
      platform: JSON.parse(JSON.stringify(p))
    })
    showEditModal.value = false
    showToast(t('balance.dialog.save', '保存成功'))
    await loadData()
    await refreshSingle(p.id)
  } catch (err) {
    console.error('Failed to save platform:', err)
    showToast(String(err), 'error')
  } finally {
    savingPlatform.value = false
  }
}

async function deletePlatform(id: string, name: string): Promise<void> {
  const msg = tt('balance.delete_confirm', { name }, `确定要删除平台「${name}」吗？`)
  if (!confirm(msg)) return

  try {
    await window.cockpit.command('balance.config.remove', { id })
    balances.value = balances.value.filter((b) => b.id !== id)
    showToast('删除成功')
  } catch (err) {
    console.error('Failed to delete platform:', err)
  }
}

async function importLegacy(): Promise<void> {
  try {
    const res = (await window.cockpit.command('balance.import', {})) as {
      ok: boolean
      count?: number
      error?: string
    }
    if (res.ok) {
      showToast(`成功导入 ${res.count ?? 0} 个平台配置！`)
      await loadData()
      refreshAll()
    } else {
      showToast(`导入失败: ${res.error || '未找到配置'}`, 'error')
    }
  } catch (err) {
    showToast(`导入失败: ${String(err)}`, 'error')
  }
}

const loggingInCards = ref<Record<string, boolean>>({})

function getPlatformUrl(b: BalanceResult): string {
  if (b.type === 'google_ai_studio') {
    const rawTarget = typeof b.raw?.targetUrl === 'string' ? b.raw.targetUrl : ''
    return rawTarget || 'https://aistudio.google.com/billing'
  }
  if (b.type === 'openai_web') return 'https://platform.openai.com/home'
  if (b.type === 'mimo_web') return 'https://platform.xiaomimimo.com/console/balance'
  if (b.type === 'bigmodel' || b.type === 'bigmodel_web')
    return 'https://bigmodel.cn/finance-center/finance/overview'
  if (b.type === 'openai') return 'https://platform.openai.com/usage'
  if (b.type === 'deepseek') return 'https://platform.deepseek.com/top_up'
  if (b.type === 'openrouter') return 'https://openrouter.ai/credits'
  if (b.type === 'ppio') return 'https://ppinfra.com/user/balance'
  if (b.type === 'tavily') return 'https://app.tavily.com/home'
  return typeof b.raw?.url === 'string' ? b.raw.url : ''
}

async function openPlatformWebsite(b: BalanceResult): Promise<void> {
  const url = getPlatformUrl(b)
  if (!url) return

  try {
    await window.cockpit.command('balance.open_window', {
      id: b.id,
      type: b.type,
      url,
      title: b.name || '控制台'
    })
  } catch (err) {
    console.error('Failed to open Electron window:', err)
    window.open(url, '_blank')
  }
}

async function handleCardLogin(b: BalanceResult): Promise<void> {
  loggingInCards.value[b.id] = true
  try {
    let provider: BalanceProviderType = 'google'
    if (b.type.includes('openai')) provider = 'openai'
    else if (b.type.includes('mimo')) provider = 'mimo'
    else if (b.type.includes('bigmodel')) provider = 'bigmodel'
    else if (b.type.includes('google')) provider = 'google'

    const profileId = b.profileId || 'default'
    const res = (await window.cockpit.command('balance.profiles.login', {
      id: profileId,
      provider
    })) as { ok: boolean; loggedIn: boolean }

    if (res && res.loggedIn) {
      showToast('登录授权成功！')
      await refreshSingle(b.id)
    } else {
      showToast('登录窗口已关闭', 'info')
    }
  } catch (err) {
    showToast(`登录失败: ${String(err)}`, 'error')
  } finally {
    loggingInCards.value[b.id] = false
  }
}

function copyText(text: string): void {
  navigator.clipboard.writeText(text)
  showToast('已复制到剪贴板')
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return t('balance.card.not_queried', '未查询')
  const date = new Date(timestamp)
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`
}

function toggleRaw(id: string): void {
  expandedCards.value[id] = !expandedCards.value[id]
}

// Summary statistics
const summaryStats = computed(() => {
  let cny = 0
  let usd = 0
  let credits = 0
  let errorCount = 0
  let normalCount = 0

  for (const b of balances.value) {
    if (b.error) {
      errorCount++
    } else {
      normalCount++
      if (b.currency === 'CNY') cny += b.amount + (b.voucher || 0)
      else if (b.currency === 'USD') usd += b.amount + (b.voucher || 0)
      else if (b.currency === 'Credits') credits += b.amount
    }
  }

  return {
    cny,
    usd,
    credits,
    errorCount,
    normalCount,
    totalCount: balances.value.length
  }
})

// Filtered cards
const filteredBalances = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return balances.value.filter((b) => {
    if (activeFilter.value === 'normal' && b.error) return false
    if (activeFilter.value === 'error' && !b.error) return false

    if (!q) return true
    const nameMatch = b.name.toLowerCase().includes(q)
    const typeMatch = b.type.toLowerCase().includes(q)
    const currMatch = (b.currency || '').toLowerCase().includes(q)
    const profMatch = (b.profileName || '').toLowerCase().includes(q)
    return nameMatch || typeMatch || currMatch || profMatch
  })
})

function startAutoRefresh(): void {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  const intervalSec = config.value?.settings?.refreshIntervalSec || 900
  if (config.value?.settings?.autoRefresh !== false && intervalSec > 0) {
    autoRefreshTimer = setInterval(() => {
      refreshAll()
    }, intervalSec * 1000)
  }
}

onMounted(async () => {
  await loadData()
  refreshAll()
  startAutoRefresh()
})

onActivated(async () => {
  if (balances.value.length === 0) {
    await loadData()
    refreshAll()
  }
  if (!autoRefreshTimer) {
    startAutoRefresh()
  }
})

onUnmounted(() => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
})
</script>

<template>
  <div class="balance-shell">
    <!-- PROFILE MANAGEMENT SUBPAGE -->
    <ProfileManagerView
      v-if="viewMode === 'profiles'"
      @close="viewMode = 'dashboard'"
      @updated="loadData"
    />

    <!-- BALANCE DASHBOARD SUBPAGE -->
    <div v-else class="balance-container d-flex flex-column ga-4 pb-6">
      <LoadingBar :loading="loadingAll" />

      <!-- Header Toolbar -->
      <div class="d-flex align-center justify-space-between flex-wrap ga-3 pt-1">
        <div class="d-flex align-center ga-3">
          <div class="balance-title-icon rounded-lg d-flex align-center justify-center elevation-2">
            <AbilityIcon icon="default/bitcoin/padding" :size="32" />
          </div>
          <div>
            <h1 class="text-h5 font-weight-bold mb-0">
              {{ t('balance.title', '余额中心') }}
            </h1>
            <p class="text-caption text-medium-emphasis mb-0">
              {{ t('balance.subtitle', '各 AI 平台账户余额与用量监控') }}
            </p>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="d-flex align-center flex-wrap ga-2">
          <v-btn
            color="primary"
            variant="flat"
            class="text-none"
            prepend-icon="mdi-refresh"
            :loading="loadingAll"
            @click="refreshAll"
          >
            {{ t('balance.refresh_all', '全部刷新') }}
          </v-btn>

          <v-btn
            variant="tonal"
            class="text-none"
            prepend-icon="mdi-account-group-outline"
            @click="viewMode = 'profiles'"
          >
            {{ t('balance.menu.profiles', 'Profile 账户管理') }}
          </v-btn>

          <v-btn variant="tonal" class="text-none" prepend-icon="mdi-plus" @click="openAddModal">
            {{ t('balance.add_platform', '添加平台') }}
          </v-btn>

          <v-btn variant="tonal" class="text-none" prepend-icon="mdi-import" @click="importLegacy">
            {{ t('balance.menu.import_legacy', '导入旧配置') }}
          </v-btn>
        </div>
      </div>

      <!-- Summary Stats Row -->
      <v-row class="ma-0 ga-3 ga-md-0" dense>
        <!-- Total CNY -->
        <v-col cols="12" sm="6" md="3">
          <v-card variant="tonal" class="rounded-xl stat-card pa-4" color="primary">
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption text-uppercase font-weight-bold">
                {{ t('balance.stat_cny', '人民币总额') }}
              </span>
              <v-icon icon="mdi-currency-cny" size="small" />
            </div>
            <div class="text-h5 font-weight-bold">¥ {{ summaryStats.cny.toFixed(2) }}</div>
          </v-card>
        </v-col>

        <!-- Total USD -->
        <v-col cols="12" sm="6" md="3">
          <v-card variant="tonal" class="rounded-xl stat-card pa-4" color="success">
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption text-uppercase font-weight-bold">
                {{ t('balance.stat_usd', '美元总额') }}
              </span>
              <v-icon icon="mdi-currency-usd" size="small" />
            </div>
            <div class="text-h5 font-weight-bold">$ {{ summaryStats.usd.toFixed(2) }}</div>
          </v-card>
        </v-col>

        <!-- Total Credits -->
        <v-col cols="12" sm="6" md="3">
          <v-card variant="tonal" class="rounded-xl stat-card pa-4" color="info">
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption text-uppercase font-weight-bold">
                {{ t('balance.stat_credits', 'Credits 积分') }}
              </span>
              <v-icon icon="mdi-star-circle-outline" size="small" />
            </div>
            <div class="text-h5 font-weight-bold">
              {{ Math.round(summaryStats.credits).toLocaleString() }}
              <span class="text-caption font-weight-regular">Cr</span>
            </div>
          </v-card>
        </v-col>

        <!-- Health Status -->
        <v-col cols="12" sm="6" md="3">
          <v-card
            variant="tonal"
            class="rounded-xl stat-card pa-4"
            :color="summaryStats.errorCount > 0 ? 'warning' : 'teal'"
          >
            <div class="d-flex align-center justify-space-between mb-1">
              <span class="text-caption text-uppercase font-weight-bold">
                {{ t('balance.stat_health', '平台状态') }}
              </span>
              <v-icon
                :icon="
                  summaryStats.errorCount > 0
                    ? 'mdi-alert-circle-outline'
                    : 'mdi-check-circle-outline'
                "
                size="small"
              />
            </div>
            <div
              class="text-h5 font-weight-bold d-flex align-center justify-space-between flex-wrap ga-2"
            >
              <span class="font-weight-black"
                >{{ summaryStats.normalCount }} / {{ summaryStats.totalCount }}</span
              >
              <v-chip
                v-if="summaryStats.errorCount > 0"
                size="small"
                color="error"
                variant="flat"
                class="balance-chip"
              >
                {{ summaryStats.errorCount }} 异常
              </v-chip>
              <v-chip
                v-else
                size="small"
                color="teal"
                variant="tonal"
                class="balance-chip font-weight-bold"
              >
                全部正常
              </v-chip>
            </div>
          </v-card>
        </v-col>
      </v-row>

      <!-- Search and Filter Bar -->
      <div class="d-flex align-center justify-space-between flex-wrap ga-3">
        <div class="d-flex align-center flex-grow-1" style="max-width: 480px">
          <v-text-field
            v-model="searchQuery"
            density="comfortable"
            variant="outlined"
            prepend-inner-icon="mdi-magnify"
            clearable
            hide-details
            class="rounded-lg"
            :placeholder="t('balance.search_placeholder', '搜索平台名称、Profile 或币种...')"
          />
        </div>

        <div class="d-flex align-center ga-2">
          <v-btn-toggle
            v-model="activeFilter"
            mandatory
            density="comfortable"
            variant="outlined"
            color="primary"
            class="rounded-lg"
          >
            <v-btn value="all" class="text-none">{{ t('balance.filter_all', '全部') }}</v-btn>
            <v-btn value="normal" class="text-none">{{ t('balance.filter_normal', '正常') }}</v-btn>
            <v-btn value="error" class="text-none">{{ t('balance.filter_error', '异常') }}</v-btn>
          </v-btn-toggle>
        </div>
      </div>

      <!-- Empty State -->
      <div
        v-if="filteredBalances.length === 0 && !loadingAll"
        class="d-flex flex-column align-center justify-center py-12 text-center"
      >
        <v-icon icon="mdi-wallet-bifold-outline" size="64" color="medium-emphasis" class="mb-3" />
        <h3 class="text-subtitle-1 font-weight-bold mb-1">
          {{ t('balance.empty_title', '暂无匹配的平台数据') }}
        </h3>
        <p class="text-caption text-medium-emphasis mb-4">
          {{ t('balance.empty_desc', '点击上方「添加平台」或「导入旧配置」开始使用') }}
        </p>
        <v-btn
          color="primary"
          variant="flat"
          class="text-none"
          prepend-icon="mdi-plus"
          @click="openAddModal"
        >
          {{ t('balance.add_platform', '添加平台') }}
        </v-btn>
      </div>

      <!-- Platform Cards Grid -->
      <v-row class="ma-0" dense>
        <v-col v-for="b in filteredBalances" :key="b.id" cols="12" md="6" lg="4" class="pa-2">
          <v-card
            variant="outlined"
            class="balance-card rounded-xl d-flex flex-column h-100 transition-swing"
            :class="{ 'border-error': !!b.error }"
          >
            <!-- Card Header -->
            <div class="px-4 pt-4 pb-2 d-flex align-center justify-space-between ga-2">
              <div class="d-flex align-center ga-3 overflow-hidden">
                <div
                  class="platform-icon-box rounded-lg d-flex align-center justify-center flex-shrink-0"
                >
                  <AbilityIcon :icon="b.icon || 'default/bitcoin/padding'" :size="24" />
                </div>
                <div class="overflow-hidden">
                  <div class="text-subtitle-1 font-weight-bold text-truncate" :title="b.name">
                    {{ b.name }}
                  </div>
                  <div
                    class="d-flex align-center ga-1 text-caption text-medium-emphasis text-truncate"
                  >
                    <span>{{ b.type }}</span>
                    <span v-if="b.profileName" class="text-primary font-weight-medium">
                      · {{ b.profileName }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Status & Latency Chip -->
              <div class="d-flex align-center ga-1 flex-shrink-0">
                <v-chip
                  v-if="b.type === 'google_ai_studio'"
                  size="small"
                  color="primary"
                  variant="tonal"
                  class="balance-chip font-weight-medium"
                >
                  控制台直达
                </v-chip>
                <v-chip
                  v-else-if="loadingCards[b.id]"
                  size="small"
                  color="primary"
                  variant="tonal"
                  class="balance-chip font-weight-medium"
                >
                  <v-progress-circular indeterminate size="12" width="2" class="mr-1" />
                  查询中
                </v-chip>
                <v-chip
                  v-else-if="b.error"
                  size="small"
                  color="error"
                  variant="tonal"
                  class="balance-chip font-weight-medium"
                >
                  异常
                </v-chip>
                <v-chip
                  v-else-if="b.updatedAt"
                  size="small"
                  color="success"
                  variant="tonal"
                  class="balance-chip font-weight-medium"
                >
                  正常
                </v-chip>
                <v-chip v-else size="small" variant="tonal" class="balance-chip font-weight-medium">
                  未查询
                </v-chip>

                <v-chip
                  v-if="b.latencyMs && !loadingCards[b.id] && b.type !== 'google_ai_studio'"
                  size="small"
                  variant="outlined"
                  class="balance-chip text-caption font-mono"
                >
                  {{ b.latencyMs }}ms
                </v-chip>
              </div>
            </div>

            <!-- Card Body: Balance Display -->
            <div
              class="px-4 py-2 flex-grow-1 d-flex flex-column justify-center"
              style="min-height: 72px"
            >
              <!-- Google AI Studio Direct Portal View -->
              <div v-if="b.type === 'google_ai_studio'" class="d-flex flex-column ga-2 py-1">
                <div class="text-caption text-medium-emphasis">Google 计费控制台快捷通道：</div>
                <v-btn
                  color="primary"
                  variant="tonal"
                  prepend-icon="mdi-open-in-new"
                  class="font-weight-bold rounded-lg text-none"
                  @click.stop="openPlatformWebsite(b)"
                >
                  打开 Google 计费页面
                </v-btn>
              </div>

              <!-- Error Box with Quick Login / Console Buttons -->
              <div
                v-else-if="b.error"
                class="error-box rounded-lg pa-3 text-caption text-error bg-error-lighten"
              >
                <div class="d-flex align-center ga-1 mb-1 font-weight-bold">
                  <v-icon icon="mdi-alert-circle" size="small" />
                  <span>查询失败</span>
                </div>
                <div class="text-truncate-2 font-mono mb-2">{{ b.error }}</div>
                <div class="d-flex align-center ga-2 flex-wrap mt-1">
                  <v-btn
                    variant="tonal"
                    color="primary"
                    class="text-none"
                    prepend-icon="mdi-open-in-new"
                    @click.stop="openPlatformWebsite(b)"
                  >
                    {{ t('balance.card.open_console', '打开控制台') }}
                  </v-btn>
                  <v-btn
                    v-if="
                      b.type.includes('web') ||
                      b.type === 'openai' ||
                      b.type === 'mimo' ||
                      b.type === 'bigmodel'
                    "
                    variant="flat"
                    color="primary"
                    class="text-none"
                    prepend-icon="mdi-login"
                    :loading="!!loggingInCards[b.id]"
                    @click.stop="handleCardLogin(b)"
                  >
                    登录授权
                  </v-btn>
                </div>
              </div>

              <!-- Normal Balance Display -->
              <div v-else class="d-flex flex-column">
                <!-- Big Balance Text -->
                <div class="d-flex align-baseline ga-2 flex-wrap">
                  <span class="balance-amount font-weight-bold">
                    {{ formatBalanceDisplay(b) }}
                  </span>
                  <span
                    v-if="b.currency && b.currency !== 'Credits'"
                    class="text-caption text-medium-emphasis font-weight-medium"
                  >
                    {{ b.currency }}
                  </span>
                </div>

                <!-- Breakdown info: Voucher / Usage -->
                <div v-if="b.voucher" class="text-caption text-primary font-weight-medium mt-1">
                  {{
                    tt(
                      'balance.card.voucher',
                      {
                        voucher: formatBalanceDisplay({ currency: b.currency, amount: b.voucher })
                      },
                      `含赠送券: ${b.voucher}`
                    )
                  }}
                </div>

                <div
                  v-if="b.used !== undefined && b.total !== undefined"
                  class="text-caption text-medium-emphasis mt-1"
                >
                  {{
                    tt(
                      'balance.card.used',
                      { used: b.used.toLocaleString(), total: b.total.toLocaleString() },
                      `已消耗: ${b.used} / ${b.total}`
                    )
                  }}
                </div>
              </div>
            </div>

            <!-- Card Footer: Pinned to bottom via mt-auto -->
            <div class="mt-auto px-4 pb-3 pt-1">
              <v-divider class="mb-2" />
              <div
                class="d-flex align-center justify-space-between text-caption text-medium-emphasis"
              >
                <span>{{ formatTime(b.updatedAt) }}</span>
                <div class="d-flex align-center ga-1">
                  <v-btn
                    icon="mdi-open-in-new"
                    size="small"
                    variant="text"
                    :title="t('balance.card.open_console', '打开控制台')"
                    @click.stop="openPlatformWebsite(b)"
                  />
                  <v-btn
                    icon="mdi-code-json"
                    size="small"
                    variant="text"
                    :title="t('balance.card.toggle_raw', '查看原始数据')"
                    @click="toggleRaw(b.id)"
                  />
                  <v-btn
                    icon="mdi-pencil"
                    size="small"
                    variant="text"
                    :title="t('balance.card.edit', '编辑平台')"
                    @click="openEditModal(b.id)"
                  />
                  <v-btn
                    icon="mdi-delete-outline"
                    size="small"
                    variant="text"
                    color="error"
                    :title="t('balance.card.delete', '删除平台')"
                    @click="deletePlatform(b.id, b.name)"
                  />
                  <v-btn
                    icon="mdi-refresh"
                    size="small"
                    variant="tonal"
                    color="primary"
                    :loading="loadingCards[b.id]"
                    :title="t('balance.card.refresh', '刷新此卡片')"
                    @click="refreshSingle(b.id)"
                  />
                </div>
              </div>

              <!-- Collapsible Raw JSON Data View -->
              <v-expand-transition>
                <div v-if="expandedCards[b.id]" class="mt-2">
                  <v-divider class="mb-2" />
                  <div class="d-flex align-center justify-space-between mb-1">
                    <span class="text-caption font-weight-bold text-medium-emphasis">RAW DATA</span>
                    <v-btn
                      icon="mdi-content-copy"
                      size="small"
                      variant="text"
                      @click="copyText(JSON.stringify(b.raw || b, null, 2))"
                    />
                  </div>
                  <pre class="raw-json-box rounded-lg pa-3 font-mono text-caption overflow-auto">{{
                    JSON.stringify(b.raw || b, null, 2)
                  }}</pre>
                </div>
              </v-expand-transition>
            </div>
          </v-card>
        </v-col>
      </v-row>
    </div>

    <!-- Add/Edit Platform Dialog Modal -->
    <v-dialog v-model="showEditModal" max-width="580px">
      <v-card class="rounded-2xl">
        <v-card-title
          class="px-6 pt-5 pb-3 font-weight-bold d-flex align-center justify-space-between"
        >
          <span>{{
            isNewPlatform
              ? t('balance.add_platform', '添加平台')
              : t('balance.edit_platform', '编辑平台')
          }}</span>
          <v-btn icon="mdi-close" size="small" variant="text" @click="showEditModal = false" />
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

          <!-- Profile Selection -->
          <div class="d-flex align-center ga-2">
            <v-select
              v-model="editingPlatform.profileId"
              :items="config?.profiles || []"
              item-title="name"
              item-value="id"
              density="comfortable"
              variant="outlined"
              :label="t('balance.profiles.select_profile', '使用 Profile 容器')"
              hide-details
              class="flex-grow-1"
            />
            <v-btn
              variant="tonal"
              height="48"
              class="text-none"
              prepend-icon="mdi-plus"
              @click="showQuickProfileDialog = true"
            >
              {{ t('balance.profiles.create_quick', '新建 Profile') }}
            </v-btn>
          </div>

          <v-text-field
            v-model="editingPlatform.name"
            density="comfortable"
            variant="outlined"
            :label="t('balance.dialog.name', '显示名称')"
            hide-details
          />

          <!-- Icon configuration -->
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
                  { label: '云端', icon: 'default/cloud/padding' }
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

          <!-- Web Platform Instructions -->
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
              该平台使用 Profile 隔离容器授权。可以在上方切换或新建 Profile，同一个 Profile
              内各厂商登录态互不冲突。
            </v-alert>
          </div>

          <!-- API Key for token-based platforms -->
          <v-text-field
            v-else
            v-model="editingPlatform.apiKey"
            :type="showPassword ? 'text' : 'password'"
            density="comfortable"
            variant="outlined"
            :label="
              editingPlatform.type === 'bigmodel'
                ? 'Authorization Token (选填，留空则使用 Profile 授权)'
                : editingPlatform.type === 'mimo'
                  ? 'Cookie / api-platform_serviceToken (选填，留空则使用 Profile 授权)'
                  : editingPlatform.type === 'openai'
                    ? 'API Key (sk-...) 或 Session Token'
                    : t('balance.dialog.api_key', 'API 密钥 (硬件绑定加密存储)')
            "
            hide-details
            :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
            @click:append-inner="showPassword = !showPassword"
          >
            <template #append>
              <v-btn
                v-if="editingPlatform.apiKey"
                icon="mdi-content-copy"
                size="small"
                variant="text"
                :title="t('balance.card.copy_key', '复制密钥')"
                @click="copyText(editingPlatform.apiKey)"
              />
            </template>
          </v-text-field>

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
            class="text-none"
            prepend-icon="mdi-lan-connect"
            :loading="testingConnection"
            @click="testConnection"
          >
            {{ t('balance.dialog.test', '测试连通性') }}
          </v-btn>
          <v-spacer />
          <v-btn variant="text" class="text-none" @click="showEditModal = false">
            {{ t('balance.dialog.cancel', '取消') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            class="text-none"
            :loading="savingPlatform"
            @click="savePlatform"
          >
            {{ t('balance.dialog.save', '保存') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Quick Add Profile Dialog -->
    <v-dialog v-model="showQuickProfileDialog" max-width="420px">
      <v-card class="rounded-2xl">
        <v-card-title
          class="px-6 pt-5 pb-3 font-weight-bold d-flex align-center justify-space-between"
        >
          <span>{{ t('balance.profiles.add_profile', '新建 Profile') }}</span>
          <v-btn
            icon="mdi-close"
            size="small"
            variant="text"
            @click="showQuickProfileDialog = false"
          />
        </v-card-title>
        <v-divider />
        <v-card-text class="px-6 py-4">
          <v-text-field
            v-model="quickProfileName"
            density="comfortable"
            variant="outlined"
            :label="t('balance.profiles.name', 'Profile 名称')"
            placeholder="如：个人主账号 / 公司工作账号"
            hide-details
            autofocus
            @keyup.enter="handleCreateQuickProfile"
          />
        </v-card-text>
        <v-divider />
        <v-card-actions class="px-6 py-4 ga-2">
          <v-spacer />
          <v-btn variant="text" class="text-none" @click="showQuickProfileDialog = false">
            {{ t('balance.dialog.cancel', '取消') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            class="text-none"
            :loading="creatingQuickProfile"
            @click="handleCreateQuickProfile"
          >
            {{ t('balance.dialog.save', '创建') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Global Toast Notification -->
    <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="2500" location="top right">
      {{ snackbar.text }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.balance-shell {
  position: relative;
  min-height: calc(100vh - 96px);
}

.balance-container {
  min-height: calc(100vh - 96px);
}

.balance-title-icon {
  width: 48px;
  height: 48px;
  background: rgba(var(--v-theme-primary), 0.12);
  border: 1px solid rgba(var(--v-theme-primary), 0.2);
}

.stat-card {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.balance-card {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}

.balance-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  border-color: rgba(var(--v-theme-primary), 0.4);
}

.border-error {
  border-color: rgba(var(--v-theme-error), 0.5) !important;
}

.platform-icon-box {
  width: 40px;
  height: 40px;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  border: 1px solid rgba(var(--v-border-color), 0.1);
}

.balance-amount {
  font-size: 1.65rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.balance-chip {
  padding-block: 4px !important;
  min-height: 24px !important;
}

.raw-json-box {
  font-size: 11px;
  max-height: 160px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.2);
}

.bg-error-lighten {
  background: rgba(var(--v-theme-error), 0.08);
}
</style>
