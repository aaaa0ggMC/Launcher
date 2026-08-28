<script setup lang="ts">
import { ref, computed, onMounted, inject, type Ref } from 'vue'
import type { BalanceConfig, BalanceProfile, BalanceProviderType, PlatformConfig } from '../types'
import AbilityIcon from '../../../main/ui/components/AbilityIcon.vue'
import { translate, translateTemplate } from '../../../main/ui/i18n'

defineOptions({ name: 'ProfileManagerView' })

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated'): void
}>()

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
const profiles = ref<BalanceProfile[]>([])
const platforms = ref<PlatformConfig[]>([])
const checkingProfile = ref<Record<string, boolean>>({})
const loggingIn = ref<Record<string, BalanceProviderType | null>>({})

const showEditDialog = ref(false)
const isNewProfile = ref(false)
const editingProfile = ref<{ id?: string; name: string }>({ id: '', name: '' })
const savingProfile = ref(false)

const toast = ref({ show: false, text: '', color: 'success' })
function showToast(text: string, color = 'success'): void {
  toast.value = { show: true, text, color }
}

const PROVIDERS: Array<{
  key: BalanceProviderType
  name: string
  icon: string
  consoleUrl: string
  color: string
}> = [
  {
    key: 'openai',
    name: 'OpenAI',
    icon: 'gi:settings',
    consoleUrl: 'https://platform.openai.com/home',
    color: 'teal'
  },
  {
    key: 'mimo',
    name: '小米 MiMo',
    icon: 'gi:settings',
    consoleUrl: 'https://platform.xiaomimimo.com/console/balance',
    color: 'orange'
  },
  {
    key: 'bigmodel',
    name: '智谱 BigModel',
    icon: 'gi:settings',
    consoleUrl: 'https://bigmodel.cn/finance-center/finance/overview',
    color: 'indigo'
  },
  {
    key: 'google',
    name: 'Google AI Studio',
    icon: 'gi:settings',
    consoleUrl: 'https://aistudio.google.com/billing',
    color: 'blue'
  }
]

async function loadData(): Promise<void> {
  loading.value = true
  try {
    const [profRes, cfgRes] = await Promise.all([
      window.cockpit.command('balance.profiles.list') as Promise<BalanceProfile[]>,
      window.cockpit.command('balance.config.get', { reveal: false }) as Promise<BalanceConfig>
    ])

    if (Array.isArray(profRes)) {
      profiles.value = profRes
    }
    if (cfgRes?.platforms) {
      platforms.value = cfgRes.platforms
    }
  } catch (err) {
    console.error('Failed to load profiles:', err)
    showToast(String(err), 'error')
  } finally {
    loading.value = false
  }
}

function getBoundPlatforms(profileId: string): PlatformConfig[] {
  return platforms.value.filter((p) => p.profileId === profileId)
}

function openAddDialog(): void {
  isNewProfile.value = true
  editingProfile.value = {
    id: `profile_${Date.now().toString(36)}`,
    name: ''
  }
  showEditDialog.value = true
}

function openEditDialog(prof: BalanceProfile): void {
  isNewProfile.value = false
  editingProfile.value = {
    id: prof.id,
    name: prof.name
  }
  showEditDialog.value = true
}

async function saveProfile(): Promise<void> {
  if (!editingProfile.value.name.trim()) {
    showToast(t('balance.profiles.name_placeholder', '请输入 Profile 名称'), 'warning')
    return
  }

  savingProfile.value = true
  try {
    await window.cockpit.command('balance.profiles.upsert', {
      id: editingProfile.value.id,
      name: editingProfile.value.name.trim()
    })
    showEditDialog.value = false
    showToast(t('balance.dialog.save', '保存成功'))
    await loadData()
    emit('updated')
  } catch (err) {
    showToast(`保存失败: ${String(err)}`, 'error')
  } finally {
    savingProfile.value = false
  }
}

async function deleteProfile(prof: BalanceProfile): Promise<void> {
  const msg = tt(
    'balance.profiles.delete_confirm',
    { name: prof.name },
    `确定要删除 Profile「${prof.name}」吗？此操作将解绑相关平台卡片并清除该容器的登录数据。`
  )
  if (!confirm(msg)) return

  try {
    const res = (await window.cockpit.command('balance.profiles.remove', {
      id: prof.id,
      clearStorage: true
    })) as { ok: boolean; error?: string }

    if (res && res.ok) {
      showToast('删除成功')
      await loadData()
      emit('updated')
    } else {
      showToast(`删除失败: ${res?.error || '未知错误'}`, 'error')
    }
  } catch (err) {
    showToast(`删除失败: ${String(err)}`, 'error')
  }
}

async function checkSingleProfile(profileId: string): Promise<void> {
  checkingProfile.value[profileId] = true
  try {
    const res = (await window.cockpit.command('balance.profiles.check', {
      id: profileId
    })) as { ok: boolean; profile?: BalanceProfile }

    if (res && res.ok && res.profile) {
      const idx = profiles.value.findIndex((p) => p.id === profileId)
      if (idx >= 0) {
        profiles.value[idx] = res.profile
      }
      showToast('检测完成')
    }
  } catch (err) {
    showToast(`检测失败: ${String(err)}`, 'error')
  } finally {
    checkingProfile.value[profileId] = false
  }
}

async function checkAllProfiles(): Promise<void> {
  loading.value = true
  try {
    const res = (await window.cockpit.command('balance.profiles.list')) as BalanceProfile[]
    if (Array.isArray(res)) {
      profiles.value = res
      showToast('全部 Profile 状态已更新')
    }
  } catch (err) {
    showToast(`检测失败: ${String(err)}`, 'error')
  } finally {
    loading.value = false
  }
}

async function handleLogin(profileId: string, provider: BalanceProviderType): Promise<void> {
  loggingIn.value[profileId] = provider
  try {
    const res = (await window.cockpit.command('balance.profiles.login', {
      id: profileId,
      provider
    })) as { ok: boolean; loggedIn: boolean }

    if (res && res.loggedIn) {
      showToast(`登录成功！`)
      await checkSingleProfile(profileId)
      emit('updated')
    } else {
      showToast('登录窗口已关闭', 'info')
    }
  } catch (err) {
    showToast(`登录失败: ${String(err)}`, 'error')
  } finally {
    loggingIn.value[profileId] = null
  }
}

async function handleLogoutProvider(
  profileId: string,
  provider?: BalanceProviderType
): Promise<void> {
  try {
    await window.cockpit.command('balance.profiles.logout', {
      id: profileId,
      provider
    })
    showToast(provider ? `已清除 ${provider} 凭据` : '已清空该 Profile 全部会话数据')
    await checkSingleProfile(profileId)
    emit('updated')
  } catch (err) {
    showToast(`注销失败: ${String(err)}`, 'error')
  }
}

async function openConsoleWindow(
  profileId: string,
  provider: BalanceProviderType,
  name: string
): Promise<void> {
  try {
    await window.cockpit.command('balance.profiles.open_window', {
      id: profileId,
      provider,
      title: `${name} - 控制台`
    })
  } catch (err) {
    showToast(`打开窗口失败: ${String(err)}`, 'error')
  }
}

const stats = computed(() => {
  let loggedInCount = 0
  let totalVendors = profiles.value.length * PROVIDERS.length
  for (const prof of profiles.value) {
    if (prof.providers) {
      for (const p of PROVIDERS) {
        if (prof.providers[p.key]?.isLoggedIn) loggedInCount++
      }
    }
  }
  return {
    profileCount: profiles.value.length,
    loggedInCount,
    totalVendors,
    boundPlatformCount: platforms.value.length
  }
})

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="profile-manager-container d-flex flex-column ga-4 pb-6">
    <!-- Header Toolbar -->
    <div class="d-flex align-center justify-space-between flex-wrap ga-3 pt-1">
      <div class="d-flex align-center ga-3">
        <v-btn
          icon="mdi-arrow-left"
          size="small"
          variant="tonal"
          color="primary"
          :title="t('balance.profiles.back_to_dashboard', '返回看板')"
          @click="emit('close')"
        />
        <div class="profile-title-icon rounded-lg d-flex align-center justify-center elevation-2">
          <v-icon icon="mdi-account-group-outline" size="28" color="primary" />
        </div>
        <div>
          <h1 class="text-h5 font-weight-bold mb-0">
            {{ t('balance.profiles.title', 'Profile 账户管理') }}
          </h1>
          <p class="text-caption text-medium-emphasis mb-0">
            {{
              t(
                'balance.profiles.subtitle',
                '统一管理 Browser Profile 隔离容器，一个 Profile 内可登录多家平台'
              )
            }}
          </p>
        </div>
      </div>

      <!-- Actions -->
      <div class="d-flex align-center flex-wrap ga-2">
        <v-btn
          color="primary"
          variant="flat"
          class="text-none"
          prepend-icon="mdi-plus"
          @click="openAddDialog"
        >
          {{ t('balance.profiles.add_profile', '新建 Profile') }}
        </v-btn>

        <v-btn
          variant="tonal"
          class="text-none"
          prepend-icon="mdi-refresh"
          :loading="loading"
          @click="checkAllProfiles"
        >
          {{ t('balance.profiles.check_all', '全部检测') }}
        </v-btn>

        <v-btn
          variant="tonal"
          class="text-none"
          prepend-icon="mdi-view-dashboard-outline"
          @click="emit('close')"
        >
          {{ t('balance.profiles.back_to_dashboard', '返回看板') }}
        </v-btn>
      </div>
    </div>

    <!-- Stats Summary Row -->
    <v-row class="ma-0 ga-3 ga-md-0" dense>
      <v-col cols="12" sm="4">
        <v-card variant="tonal" class="rounded-xl stat-card pa-4" color="primary">
          <div class="d-flex align-center justify-space-between mb-1">
            <span class="text-caption text-uppercase font-weight-bold">Profile 容器总数</span>
            <v-icon icon="mdi-account-box-multiple-outline" size="small" />
          </div>
          <div class="text-h5 font-weight-bold">{{ stats.profileCount }} 个</div>
        </v-card>
      </v-col>

      <v-col cols="12" sm="4">
        <v-card variant="tonal" class="rounded-xl stat-card pa-4" color="success">
          <div class="d-flex align-center justify-space-between mb-1">
            <span class="text-caption text-uppercase font-weight-bold">已登录厂商凭据</span>
            <v-icon icon="mdi-shield-check-outline" size="small" />
          </div>
          <div class="text-h5 font-weight-bold">
            {{ stats.loggedInCount }}
            <span class="text-caption font-weight-regular text-medium-emphasis">
              / {{ stats.totalVendors }} 项
            </span>
          </div>
        </v-card>
      </v-col>

      <v-col cols="12" sm="4">
        <v-card variant="tonal" class="rounded-xl stat-card pa-4" color="info">
          <div class="d-flex align-center justify-space-between mb-1">
            <span class="text-caption text-uppercase font-weight-bold">关联平台卡片</span>
            <v-icon icon="mdi-link-variant" size="small" />
          </div>
          <div class="text-h5 font-weight-bold">{{ stats.boundPlatformCount }} 张</div>
        </v-card>
      </v-col>
    </v-row>

    <!-- Profiles List -->
    <div class="d-flex flex-column ga-4">
      <v-card
        v-for="prof in profiles"
        :key="prof.id"
        variant="outlined"
        class="profile-card rounded-2xl pa-4 d-flex flex-column ga-3"
      >
        <!-- Profile Header -->
        <div class="d-flex align-center justify-space-between flex-wrap ga-2">
          <div class="d-flex align-center ga-3">
            <div class="profile-avatar rounded-xl d-flex align-center justify-center">
              <v-icon icon="mdi-folder-account-outline" size="24" color="primary" />
            </div>
            <div>
              <div class="d-flex align-center ga-2 flex-wrap">
                <span class="text-subtitle-1 font-weight-bold">{{ prof.name }}</span>
                <v-chip size="small" variant="tonal" color="primary" class="balance-chip font-mono">
                  ID: {{ prof.id }}
                </v-chip>
                <v-chip
                  v-if="prof.id === 'default'"
                  size="small"
                  color="teal"
                  variant="flat"
                  class="balance-chip"
                >
                  系统默认
                </v-chip>
              </div>
              <div class="text-caption text-medium-emphasis font-mono">
                {{ prof.partition }}
              </div>
            </div>
          </div>

          <!-- Top Action Buttons for Profile -->
          <div class="d-flex align-center ga-1">
            <v-btn
              icon="mdi-refresh"
              size="small"
              variant="text"
              :loading="checkingProfile[prof.id]"
              :title="t('balance.profiles.check_status', '检测状态')"
              @click="checkSingleProfile(prof.id)"
            />
            <v-btn
              icon="mdi-pencil"
              size="small"
              variant="text"
              :title="t('balance.profiles.edit_profile', '编辑名称')"
              @click="openEditDialog(prof)"
            />
            <v-btn
              v-if="prof.id !== 'default' || profiles.length > 1"
              icon="mdi-delete-outline"
              size="small"
              variant="text"
              color="error"
              title="删除 Profile"
              @click="deleteProfile(prof)"
            />
          </div>
        </div>

        <!-- Bound Platforms Tags -->
        <div class="d-flex align-center flex-wrap ga-1">
          <span class="text-caption text-medium-emphasis mr-1">关联卡片:</span>
          <template v-if="getBoundPlatforms(prof.id).length">
            <v-chip
              v-for="p in getBoundPlatforms(prof.id)"
              :key="p.id"
              size="small"
              variant="outlined"
              class="balance-chip"
            >
              <AbilityIcon :icon="p.icon || 'gi:settings'" :size="14" class="mr-1" />
              {{ p.name }}
            </v-chip>
          </template>
          <span v-else class="text-caption text-disabled">（暂无关联卡片）</span>
        </div>

        <v-divider />

        <!-- Providers Grid for this Profile -->
        <div class="providers-grid">
          <div
            v-for="prov in PROVIDERS"
            :key="prov.key"
            class="provider-item rounded-xl pa-3 d-flex flex-column justify-space-between ga-2"
            :class="{
              'is-logged-in': prof.providers?.[prov.key]?.isLoggedIn
            }"
          >
            <!-- Provider Title & Status -->
            <div class="d-flex align-center justify-space-between ga-2">
              <div class="d-flex align-center ga-2">
                <v-icon
                  :icon="
                    prov.key === 'openai'
                      ? 'mdi-creation'
                      : prov.key === 'mimo'
                        ? 'mdi-cellphone-cog'
                        : prov.key === 'bigmodel'
                          ? 'mdi-brain'
                          : 'mdi-google'
                  "
                  size="20"
                  :color="prov.color"
                />
                <span class="text-body-2 font-weight-bold">{{ prov.name }}</span>
              </div>

              <!-- Status Chip -->
              <v-chip
                v-if="prof.providers?.[prov.key]?.isLoggedIn"
                size="small"
                color="success"
                variant="flat"
                class="balance-chip font-weight-medium"
              >
                <v-icon icon="mdi-check" size="12" class="mr-1" />
                已登录
              </v-chip>
              <v-chip
                v-else
                size="small"
                variant="tonal"
                color="warning"
                class="balance-chip font-weight-medium"
              >
                未登录
              </v-chip>
            </div>

            <!-- Provider Action Buttons -->
            <div class="d-flex align-center flex-wrap ga-2 pt-1">
              <v-btn
                color="primary"
                :variant="prof.providers?.[prov.key]?.isLoggedIn ? 'tonal' : 'flat'"
                class="text-none"
                prepend-icon="mdi-login"
                :loading="loggingIn[prof.id] === prov.key"
                @click="handleLogin(prof.id, prov.key)"
              >
                {{ prof.providers?.[prov.key]?.isLoggedIn ? '重新登录' : '登录授权' }}
              </v-btn>

              <v-btn
                variant="outlined"
                class="text-none"
                prepend-icon="mdi-open-in-new"
                @click="openConsoleWindow(prof.id, prov.key, prov.name)"
              >
                控制台
              </v-btn>

              <v-btn
                v-if="prof.providers?.[prov.key]?.isLoggedIn"
                variant="text"
                color="error"
                class="text-none"
                prepend-icon="mdi-logout"
                title="注销此厂商"
                @click="handleLogoutProvider(prof.id, prov.key)"
              >
                注销
              </v-btn>
            </div>
          </div>
        </div>
      </v-card>
    </div>

    <!-- Add/Edit Profile Dialog -->
    <v-dialog v-model="showEditDialog" max-width="480px">
      <v-card class="rounded-2xl">
        <v-card-title
          class="px-6 pt-5 pb-3 font-weight-bold d-flex align-center justify-space-between"
        >
          <span>{{
            isNewProfile
              ? t('balance.profiles.add_profile', '新建 Profile')
              : t('balance.profiles.edit_profile', '编辑 Profile')
          }}</span>
          <v-btn icon="mdi-close" size="small" variant="text" @click="showEditDialog = false" />
        </v-card-title>

        <v-divider />

        <v-card-text class="px-6 py-4 d-flex flex-column ga-4">
          <v-text-field
            v-model="editingProfile.name"
            density="comfortable"
            variant="outlined"
            :label="t('balance.profiles.name', 'Profile 名称')"
            :placeholder="t('balance.profiles.name_placeholder', '如：个人主账号 / 公司工作账号')"
            hide-details
            autofocus
            @keyup.enter="saveProfile"
          />

          <v-alert
            type="info"
            variant="tonal"
            density="comfortable"
            class="rounded-lg text-caption"
          >
            {{
              t(
                'balance.profiles.select_hint',
                '同一个 Profile 下的会话与 Cookie 在各厂商间互不冲突、自由共享'
              )
            }}
          </v-alert>
        </v-card-text>

        <v-divider />

        <v-card-actions class="px-6 py-4 ga-2">
          <v-spacer />
          <v-btn variant="text" class="text-none" @click="showEditDialog = false">
            {{ t('balance.dialog.cancel', '取消') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            class="text-none"
            :loading="savingProfile"
            @click="saveProfile"
          >
            {{ t('balance.dialog.save', '保存') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Global Toast -->
    <v-snackbar v-model="toast.show" :color="toast.color" timeout="2500" location="top right">
      {{ toast.text }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.profile-manager-container {
  min-height: calc(100vh - 96px);
}

.profile-title-icon {
  width: 48px;
  height: 48px;
  background: rgba(var(--v-theme-primary), 0.12);
  border: 1px solid rgba(var(--v-theme-primary), 0.2);
}

.stat-card {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.profile-card {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));
  transition: border-color 0.2s ease;
}

.profile-card:hover {
  border-color: rgba(var(--v-theme-primary), 0.4);
}

.profile-avatar {
  width: 44px;
  height: 44px;
  background: rgba(var(--v-theme-primary), 0.1);
  border: 1px solid rgba(var(--v-theme-primary), 0.2);
}

.balance-chip {
  padding-block: 4px !important;
  min-height: 24px !important;
}

.providers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.provider-item {
  background: rgba(var(--v-theme-surface-variant), 0.2);
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  transition: all 0.2s ease;
}

.provider-item.is-logged-in {
  background: rgba(var(--v-theme-success), 0.04);
  border-color: rgba(var(--v-theme-success), 0.3);
}
</style>
