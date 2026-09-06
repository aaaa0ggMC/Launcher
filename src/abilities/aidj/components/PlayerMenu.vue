<script setup lang="ts">
import { ref, inject, watch, onUnmounted, type Ref } from 'vue'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import type { EqProfile } from '../types'
import EqCurveCanvas from './EqCurveCanvas.vue'

const props = defineProps<{
  modelValue: boolean
  mode: string
  queueTracks: string[]
  queueIndex: number
  queueTotal: number
  playbackRate: number
  sleepRemainMs: number | null
  eqProfiles: EqProfile[]
  eqActiveId: string
  eqRange: number
  spectrumOn: boolean
  webRemoteRunning: boolean
  webRemotePort: number
}>()

const emit = defineEmits<{
  'update:modelValue': [val: boolean]
  'update:spectrumOn': [val: boolean]
  clearQueue: []
  setRate: [rate: number]
  setSleep: [minutes: number]
  applyEq: [id: string]
  openEqEditor: [profile: EqProfile | null]
  deleteEqProfile: [id: string]
  toggleWebRemote: []
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string | number>, fallback?: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])) as Record<
      string,
      string
    >,
    fallback
  )

type MenuStep = 'main' | 'queue' | 'speed' | 'sleep' | 'eq' | 'remote'
const menuStep = ref<MenuStep>('main')
const pageMenuRef = ref<HTMLElement | null>(null)
const customRate = ref('')
const rateItems = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
const sleepItems = [15, 30, 45, 60, 90, 120]

let menuCleanup: (() => void) | null = null

function toggleMenu(): void {
  const next = !props.modelValue
  emit('update:modelValue', next)
  menuStep.value = 'main'
}

function menuClose(): void {
  emit('update:modelValue', false)
  menuStep.value = 'main'
}

function onMenuDocClick(e: MouseEvent): void {
  const el = pageMenuRef.value
  const target = e.target as Node | null
  if (!el || !target || !target.isConnected) return
  if (el.contains(target)) return
  menuClose()
}

function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuClose()
}

watch(menuStep, (step) => {
  if (step === 'speed') customRate.value = String(props.playbackRate)
})

watch(
  () => props.modelValue,
  (open) => {
    menuCleanup?.()
    menuCleanup = null
    if (open) {
      document.addEventListener('click', onMenuDocClick)
      document.addEventListener('contextmenu', onMenuDocClick)
      document.addEventListener('keydown', onMenuKey)
      menuCleanup = (): void => {
        document.removeEventListener('click', onMenuDocClick)
        document.removeEventListener('contextmenu', onMenuDocClick)
        document.removeEventListener('keydown', onMenuKey)
      }
    }
  }
)

onUnmounted(() => {
  menuCleanup?.()
  menuCleanup = null
})

function formatSleep(ms: number | null | undefined): string {
  if (ms == null) return ''
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function submenuTitle(step: string): string {
  const keys: Record<string, string> = {
    queue: 'aidj.player.queue',
    speed: 'aidj.player.speed',
    sleep: 'aidj.player.sleep_timer',
    eq: 'aidj.player.eq',
    remote: 'aidj.player.web_remote'
  }
  return t(keys[step] ?? keys.queue, keys[step] ?? '')
}

function applyCustomRate(): void {
  const n = Number(customRate.value)
  if (!isNaN(n) && n > 0) emit('setRate', n)
}
</script>

<template>
  <div ref="pageMenuRef" class="page-menu" :class="{ 'is-open': modelValue }" @click.stop>
    <button class="page-menu-handle" @click="toggleMenu">
      <v-icon size="16">{{ modelValue ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
    </button>

    <Transition name="menu-pop">
      <div v-if="modelValue" class="page-menu-pop">
        <template v-if="menuStep === 'main'">
          <div class="menu-item" @click="menuStep = 'queue'">
            <v-icon size="18">mdi-format-list-bulleted</v-icon>
            <span>{{ t('aidj.player.queue', '播放队列') }}</span>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'speed'">
            <v-icon size="18">mdi-speedometer</v-icon>
            <span>{{ t('aidj.player.speed', '倍速') }}</span>
            <span class="ml-auto text-caption text-medium-emphasis">{{
              `${playbackRate.toFixed(2)}x`
            }}</span>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'sleep'">
            <v-icon size="18">mdi-bed-clock</v-icon>
            <span>{{ t('aidj.player.sleep_timer', '睡眠定时') }}</span>
            <span
              v-if="sleepRemainMs != null"
              class="ml-auto text-caption text-primary tabular-nums"
              >{{ formatSleep(sleepRemainMs) }}</span
            >
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item" @click="menuStep = 'eq'">
            <v-icon size="18">mdi-chart-bell-curve-cumulative</v-icon>
            <span>{{ t('aidj.player.eq', '均衡器') }}</span>
            <span class="ml-auto text-caption text-medium-emphasis">
              {{ eqProfiles.find((p) => p.id === eqActiveId)?.name ?? eqActiveId }}
            </span>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item">
            <v-icon size="18">mdi-chart-bar</v-icon>
            <span>{{ t('aidj.player.spectrum', '频谱') }}</span>
            <v-switch
              :model-value="spectrumOn"
              :disabled="mode !== 'web'"
              size="x-small"
              density="compact"
              color="primary"
              hide-details
              class="ml-auto"
              @update:model-value="emit('update:spectrumOn', Boolean($event))"
            />
          </div>
          <div class="menu-item" @click="menuStep = 'remote'">
            <v-icon size="18">mdi-access-point-network</v-icon>
            <span>{{ t('aidj.player.web_remote', '局域网遥控') }}</span>
            <v-chip
              v-if="webRemoteRunning"
              variant="flat"
              color="success"
              class="ml-auto menu-chip"
            >
              {{ webRemotePort || '' }}
            </v-chip>
            <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
          </div>
          <div class="menu-item is-static">
            <v-icon size="18">mdi-playback-speed</v-icon>
            <span>{{ t('aidj.player.backend', '播放后端') }}</span>
            <v-chip variant="flat" class="ml-auto menu-chip">
              {{
                mode === 'web'
                  ? t('aidj.player_mode.web', '内置播放器')
                  : t('aidj.player_mode.dbus', '外部播放器 (MPRIS)')
              }}
            </v-chip>
          </div>
        </template>

        <template v-else-if="menuStep === 'queue'">
          <div class="menu-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('aidj.sessions.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{
              t('aidj.player.queue', '播放队列')
            }}</span>
            <v-spacer />
            <span v-if="queueTotal > 0" class="text-caption text-medium-emphasis">{{
              tt('aidj.player.count', { n: queueTotal }, '{n} 首')
            }}</span>
            <v-btn
              v-if="mode === 'web' && queueTracks.length > 0"
              icon
              size="small"
              variant="text"
              color="error"
              :title="t('aidj.player.clear_queue', '清空队列')"
              @click="emit('clearQueue')"
            >
              <v-icon size="16">mdi-trash-can-outline</v-icon>
            </v-btn>
          </div>
          <div v-if="queueTracks.length === 0" class="menu-empty text-body-2">
            {{ t('aidj.player.queue_empty', '队列为空') }}
          </div>
          <div v-else class="menu-scroll">
            <div
              v-for="(name, i) in queueTracks"
              :key="`${i}-${name}`"
              class="queue-item d-flex align-center ga-2"
              :class="{ 'is-current': i === queueIndex }"
            >
              <v-icon
                size="14"
                :icon="i === queueIndex ? 'mdi-play-circle' : 'mdi-music-note'"
                :color="i === queueIndex ? 'primary' : undefined"
              />
              <span class="text-body-2 text-truncate" :title="name">{{ name }}</span>
            </div>
          </div>
        </template>

        <template v-else-if="menuStep === 'speed'">
          <div class="menu-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('aidj.sessions.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{ submenuTitle('speed') }}</span>
          </div>
          <div class="menu-grid">
            <v-btn
              v-for="rate in rateItems"
              :key="rate"
              variant="tonal"
              class="menu-grid-item"
              :color="Math.abs(playbackRate - rate) < 0.001 ? 'primary' : undefined"
              @click="emit('setRate', rate)"
            >
              {{ `${rate}x` }}
            </v-btn>
          </div>
          <div class="menu-scroll pa-2 d-flex flex-column ga-2">
            <div class="d-flex align-center ga-2">
              <v-text-field
                v-model="customRate"
                type="number"
                step="0.1"
                min="0.1"
                density="compact"
                variant="outlined"
                hide-details
                class="custom-rate-field"
                :placeholder="t('aidj.player.custom_rate', '自定义倍速')"
                @keyup.enter="applyCustomRate"
              />
              <v-btn
                variant="tonal"
                :title="t('aidj.player.custom_rate_hint', '任意正数，>16 为静音快进')"
                @click="applyCustomRate"
              >
                {{ t('aidj.player.apply', '应用') }}
              </v-btn>
            </div>
            <div class="text-caption text-medium-emphasis">
              {{ t('aidj.player.custom_rate_hint', '任意正数，>16 为静音快进') }}
            </div>
          </div>
        </template>

        <template v-else-if="menuStep === 'sleep'">
          <div class="menu-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('aidj.sessions.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{ submenuTitle('sleep') }}</span>
          </div>
          <div class="menu-scroll pa-2 d-flex flex-column ga-2">
            <div v-if="sleepRemainMs != null" class="text-caption text-primary text-center">
              {{ tt('aidj.player.sleep_remaining', { t: formatSleep(sleepRemainMs) }, '剩余 {t}') }}
            </div>
            <div class="menu-grid">
              <v-btn
                v-for="m in sleepItems"
                :key="m"
                variant="tonal"
                class="menu-grid-item"
                @click="emit('setSleep', m)"
              >
                {{ m }}
              </v-btn>
            </div>
            <v-btn
              variant="text"
              color="error"
              :disabled="sleepRemainMs == null"
              @click="emit('setSleep', 0)"
            >
              {{ t('aidj.player.sleep_off', '取消定时') }}
            </v-btn>
          </div>
        </template>

        <template v-else-if="menuStep === 'eq'">
          <div class="menu-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('aidj.sessions.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{ submenuTitle('eq') }}</span>
            <v-spacer />
            <v-btn
              icon
              size="small"
              variant="text"
              color="primary"
              :title="t('aidj.player.eq_new', '新建 EQ')"
              @click="emit('openEqEditor', null)"
            >
              <v-icon size="18">mdi-plus</v-icon>
            </v-btn>
          </div>
          <div class="menu-scroll">
            <div
              v-for="p in eqProfiles"
              :key="p.id"
              class="eq-item d-flex align-center ga-2"
              :class="{ 'is-active': p.id === eqActiveId }"
              @click="emit('applyEq', p.id)"
            >
              <EqCurveCanvas :gains="p.gains" :height="30" :range="eqRange" class="eq-thumb" />
              <span class="text-body-2 text-truncate flex-grow-1">{{
                p.builtin ? t(`aidj.player.eq_${p.id}`, p.name) : p.name
              }}</span>
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('aidj.player.eq_edit', '编辑')"
                @click.stop="emit('openEqEditor', p)"
              >
                <v-icon size="16">mdi-pencil</v-icon>
              </v-btn>
              <v-btn
                v-if="!p.builtin"
                icon
                size="small"
                variant="text"
                color="error"
                :title="t('aidj.player.eq_delete', '删除')"
                @click.stop="emit('deleteEqProfile', p.id)"
              >
                <v-icon size="16">mdi-trash-can-outline</v-icon>
              </v-btn>
            </div>
            <div v-if="eqProfiles.length === 0" class="menu-empty text-body-2">
              {{ t('aidj.player.eq_empty', '暂无 EQ，点击 + 新建') }}
            </div>
          </div>
        </template>

        <template v-else-if="menuStep === 'remote'">
          <div class="menu-head d-flex align-center ga-2">
            <v-btn
              icon
              size="small"
              variant="text"
              :title="t('aidj.sessions.back', '返回')"
              @click="menuStep = 'main'"
            >
              <v-icon size="18">mdi-arrow-left</v-icon>
            </v-btn>
            <span class="text-body-2 font-weight-medium">{{ submenuTitle('remote') }}</span>
          </div>
          <div class="menu-scroll pa-2 d-flex flex-column ga-2">
            <div class="text-caption text-medium-emphasis">
              {{
                t(
                  'aidj.player.web_remote_hint',
                  '在手机或同局域网设备的浏览器打开服务器地址，即可查看歌曲/封面并控制播放。'
                )
              }}
            </div>
            <v-btn
              variant="tonal"
              :color="webRemoteRunning ? 'error' : 'primary'"
              :prepend-icon="
                webRemoteRunning ? 'mdi-stop-circle-outline' : 'mdi-play-circle-outline'
              "
              @click="emit('toggleWebRemote')"
            >
              {{
                webRemoteRunning
                  ? t('aidj.player.web_remote_stop', '停止遥控服务器')
                  : t('aidj.player.web_remote_start', '启动遥控服务器')
              }}
            </v-btn>
            <div v-if="webRemoteRunning" class="text-body-2">
              <a
                :href="`http://localhost:${webRemotePort}`"
                target="_blank"
                rel="noopener"
                class="link"
              >
                http://localhost:{{ webRemotePort }}
              </a>
            </div>
          </div>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.page-menu {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.page-menu-handle {
  width: 36px;
  height: 20px;
  border: none;
  background: rgba(var(--v-theme-surface-bright), 0.18);
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.page-menu-handle:hover,
.page-menu.is-open .page-menu-handle {
  background: rgba(var(--v-theme-primary), 0.28);
  color: rgb(var(--v-theme-primary));
}
.page-menu-pop {
  margin-top: 6px;
  width: 300px;
  background: rgba(var(--v-theme-surface), 0.88);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 8px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.menu-item:hover:not(.is-static) {
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.menu-item.is-static {
  cursor: default;
}
.menu-head {
  padding: 2px 4px 6px;
}
.menu-scroll {
  max-height: 40vh;
  overflow-y: auto;
  padding: 2px;
}
.menu-empty {
  padding: 18px 12px;
  color: rgb(var(--v-theme-on-surface-variant));
}
.queue-item {
  padding: 7px 10px;
  border-radius: 8px;
  margin-block: 1px;
}
.queue-item.is-current {
  background: rgba(var(--v-theme-primary), 0.12);
}
.menu-pop-enter-active,
.menu-pop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.menu-chip {
  min-height: 24px;
  padding-block: 4px;
}
.menu-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 4px;
}
.menu-grid-item {
  text-transform: none;
}
.eq-item {
  padding: 4px 8px;
  border-radius: 8px;
  margin-block: 1px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.eq-item:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}
.eq-item.is-active {
  background: rgba(var(--v-theme-primary), 0.16);
}
.eq-thumb {
  flex: 0 0 84px;
  min-width: 84px;
}
.custom-rate-field {
  flex: 0 1 auto;
  width: 96px;
  min-width: 96px;
}
.custom-rate-field :deep(.v-field) {
  --v-field-control-height: 32px;
  min-height: 32px;
  border-radius: 8px;
}
.custom-rate-field :deep(.v-field__input) {
  min-height: 32px;
  padding-block: 0;
  font-size: 0.85rem;
}
.custom-rate-field :deep(.v-field__outline) {
  --v-field-border-width: 1px;
}
.link {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
  word-break: break-all;
}
</style>
