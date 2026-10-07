<script setup lang="ts">
/**
 * 朗读播放器（悬浮窗 `yaya.tts-player`；悬浮窗被禁用时由 YAYA 页面内嵌）。
 * 手机：一颗胶囊（播放 / 暂停带进度环、倍速、展开、关闭），展开后才有上一段 / 下一段与标题；
 * 电脑：同一颗胶囊默认就展开，带标题、段落进度与跳段。
 */
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import { setRate, skip, stop, toggle, tts } from './player'

defineProps<{ inline?: boolean }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 720px)') : null
const narrow = ref(mq?.matches ?? false)
const onMq = (e: MediaQueryListEvent): void => {
  narrow.value = e.matches
}
mq?.addEventListener('change', onMq)
onBeforeUnmount(() => mq?.removeEventListener('change', onMq))

const expandedByUser = ref<boolean | null>(null)
const expanded = computed(() => expandedByUser.value ?? !narrow.value)

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

/** 进度环：当前段内进度 + 已念完的段 */
const overall = computed(() => {
  const total = tts.total || 1
  return Math.min(100, ((tts.index + tts.progress) / total) * 100)
})
const RING = 2 * Math.PI * 19

const stateText = computed(() => {
  if (tts.status === 'loading')
    return tts.engine === 'api'
      ? t('yaya.speech.player.synth', '合成中…')
      : t('yaya.speech.player.preparing', '准备中…')
  if (tts.status === 'paused') return t('yaya.speech.player.paused', '已暂停')
  return ''
})
const partText = computed(() =>
  tts.total > 1
    ? te(
        'yaya.speech.player.part',
        { i: String(tts.index + 1), n: String(tts.total) },
        '第 {i}/{n} 段'
      )
    : ''
)
const errorText = computed(() => (tts.errorKey ? t(tts.errorKey, tts.error) : tts.error))
const playLabel = computed(() =>
  tts.status === 'playing'
    ? t('yaya.speech.player.pause', '暂停')
    : t('yaya.speech.player.play', '播放')
)
</script>

<template>
  <div
    class="tts-pill"
    :class="{ 'is-inline': inline, 'is-expanded': expanded, 'is-error': tts.status === 'error' }"
    role="region"
    :aria-label="t('yaya.speech.player.title', '朗读')"
  >
    <template v-if="tts.status === 'error'">
      <v-icon icon="mdi-alert-circle-outline" color="error" class="ml-2 flex-shrink-0" />
      <span class="tts-error" :title="errorText">{{ errorText }}</span>
    </template>
    <template v-else>
      <button
        type="button"
        class="tts-play"
        :title="playLabel"
        :aria-label="playLabel"
        :disabled="tts.status === 'loading'"
        @click="toggle"
      >
        <svg class="tts-ring" viewBox="0 0 44 44" aria-hidden="true">
          <circle cx="22" cy="22" r="19" class="tts-ring-track" />
          <circle
            cx="22"
            cy="22"
            r="19"
            class="tts-ring-bar"
            :stroke-dasharray="RING"
            :stroke-dashoffset="RING * (1 - overall / 100)"
          />
        </svg>
        <v-progress-circular
          v-if="tts.status === 'loading'"
          indeterminate
          size="20"
          width="2"
          class="tts-play-icon"
        />
        <v-icon
          v-else
          :icon="tts.status === 'playing' ? 'mdi-pause' : 'mdi-play'"
          size="22"
          class="tts-play-icon"
        />
      </button>

      <div v-if="expanded" class="tts-meta">
        <div class="tts-title" :title="tts.title">{{ tts.title }}</div>
        <div class="tts-sub text-medium-emphasis">
          <span v-if="partText">{{ partText }}</span>
          <span v-if="partText && stateText"> · </span>
          <span v-if="stateText">{{ stateText }}</span>
          <span v-if="!partText && !stateText">{{
            tts.engine === 'api'
              ? t('yaya.speech.engine.api', 'OpenAI 兼容接口')
              : t('yaya.speech.engine.browser', '系统语音（浏览器）')
          }}</span>
        </div>
      </div>

      <template v-if="expanded && tts.total > 1">
        <v-btn
          icon="mdi-skip-previous"
          variant="text"
          size="small"
          :disabled="tts.index === 0"
          :title="t('yaya.speech.player.prev', '上一段')"
          :aria-label="t('yaya.speech.player.prev', '上一段')"
          @click="skip(-1)"
        />
        <v-btn
          icon="mdi-skip-next"
          variant="text"
          size="small"
          :disabled="tts.index >= tts.total - 1"
          :title="t('yaya.speech.player.next', '下一段')"
          :aria-label="t('yaya.speech.player.next', '下一段')"
          @click="skip(1)"
        />
      </template>

      <v-menu location="top" :close-on-content-click="true">
        <template #activator="{ props: menuProps }">
          <button
            v-bind="menuProps"
            type="button"
            class="tts-rate"
            :title="t('yaya.speech.player.rate', '语速')"
            :aria-label="`${t('yaya.speech.player.rate', '语速')}: ${tts.rate}×`"
          >
            {{ tts.rate }}×
          </button>
        </template>
        <v-list density="compact" class="yaya-pop">
          <v-list-item
            v-for="r in RATES"
            :key="r"
            :active="Math.abs(r - tts.rate) < 0.01"
            color="primary"
            :title="`${r}×`"
            @click="setRate(r)"
          />
        </v-list>
      </v-menu>

      <v-btn
        v-if="narrow"
        :icon="expanded ? 'mdi-chevron-left' : 'mdi-chevron-right'"
        variant="text"
        size="small"
        :title="
          expanded ? t('yaya.speech.player.less', '收起') : t('yaya.speech.player.more', '展开')
        "
        :aria-label="
          expanded ? t('yaya.speech.player.less', '收起') : t('yaya.speech.player.more', '展开')
        "
        @click="expandedByUser = !expanded"
      />
    </template>

    <v-btn
      icon="mdi-close"
      variant="text"
      size="small"
      :title="t('yaya.speech.player.stop', '停止朗读')"
      :aria-label="t('yaya.speech.player.stop', '停止朗读')"
      @click="stop"
    />
  </div>
</template>

<style scoped>
.tts-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 56px;
  padding: 6px 6px 6px 6px;
  border-radius: 28px;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.92));
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.5));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  color: rgb(var(--v-theme-on-surface));
  max-width: min(440px, calc(var(--app-vw, 100vw) - 32px));
}
.tts-pill.is-inline {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  margin: 0 auto 8px;
  width: fit-content;
}
.tts-play {
  position: relative;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(var(--v-theme-primary), 0.14);
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
}
.tts-play:disabled {
  cursor: default;
}
.tts-ring {
  position: absolute;
  inset: 0;
  transform: rotate(-90deg);
}
.tts-ring-track {
  fill: none;
  stroke: rgba(var(--v-theme-primary), 0.18);
  stroke-width: 2.5;
}
.tts-ring-bar {
  fill: none;
  stroke: rgb(var(--v-theme-primary));
  stroke-width: 2.5;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.25s linear;
}
.tts-play-icon {
  position: relative;
}
.tts-meta {
  min-width: 0;
  flex: 1 1 auto;
  padding: 0 6px;
  max-width: 220px;
}
.tts-title {
  font-size: 0.875rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tts-sub {
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tts-rate {
  flex-shrink: 0;
  min-width: 44px;
  height: 32px;
  padding: 0 8px;
  border-radius: 16px;
  font-size: 0.8125rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: rgba(var(--v-theme-on-surface), 0.06);
  cursor: pointer;
}
.tts-rate:hover {
  background: rgba(var(--v-theme-on-surface), 0.1);
}
.tts-error {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0 8px;
  font-size: 0.8125rem;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
</style>
