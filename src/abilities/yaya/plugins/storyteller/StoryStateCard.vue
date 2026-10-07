<script setup lang="ts">
/**
 * 「故事状态」数据卡片（故事模式每轮开头）：章节 / 地点 / 张力 / 命运骰 / 出场角色 / 推进的线索。
 * 数据来自工作流的 ctx.addCard（StoryCardData），只做显示。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { StoryCardData } from './index'

const props = defineProps<{ type: string; title?: string; data?: unknown }>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

const d = computed(() => (props.data ?? {}) as Partial<StoryCardData>)
const tension = computed(() => Math.min(100, Math.max(0, Number(d.value.tension) || 0)))

const EVENT: Record<string, { icon: string; color?: string; key: string; fallback: string }> = {
  complication: {
    icon: 'mdi-lightning-bolt',
    color: 'error',
    key: 'yaya.story.event.complication',
    fallback: '意外'
  },
  twist: {
    icon: 'mdi-sync',
    color: 'warning',
    key: 'yaya.story.event.twist',
    fallback: '转折'
  },
  boon: { icon: 'mdi-clover', color: 'success', key: 'yaya.story.event.boon', fallback: '好运' },
  steady: { icon: 'mdi-minus', key: 'yaya.story.event.steady', fallback: '顺势' }
}
const event = computed(() => (d.value.event ? EVENT[d.value.event] : null))

/** 名字的首字做头像，按名字算一个稳定的色相 */
function hue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}
</script>

<template>
  <div class="story-card" role="group" :aria-label="t('yaya.story.card.title', '故事状态')">
    <div class="sc-head">
      <v-icon icon="mdi-book-open-page-variant-outline" size="18" class="sc-head-icon" />
      <span class="sc-title text-truncate">{{
        title || t('yaya.story.card.title', '故事状态')
      }}</span>
      <span class="sc-sub">
        {{
          te(
            'yaya.story.card.position',
            { chapter: String(d.chapter ?? 1), turn: String(d.turn ?? 1) },
            '第 {chapter} 章 · 第 {turn} 轮'
          )
        }}
      </span>
      <span v-if="d.newChapter" class="sc-badge">{{
        t('yaya.story.card.new_chapter', '新章节')
      }}</span>
    </div>

    <div class="sc-grid">
      <div v-if="d.location" class="sc-row">
        <v-icon icon="mdi-map-marker-outline" size="16" />
        <span class="sc-text">{{ d.location }}</span>
      </div>

      <div class="sc-row" :title="`${t('yaya.story.card.tension', '张力')} ${tension}/100`">
        <v-icon icon="mdi-chart-bell-curve-cumulative" size="16" />
        <span class="sc-label">{{ t('yaya.story.card.tension', '张力') }}</span>
        <div
          class="sc-meter"
          role="meter"
          :aria-valuenow="tension"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="t('yaya.story.card.tension', '张力')"
        >
          <div class="sc-meter-fill" :style="{ width: `${tension}%` }" />
        </div>
        <span class="sc-num">{{ tension }}</span>
      </div>

      <div v-if="d.roll && event" class="sc-row">
        <v-icon icon="mdi-dice-d20-outline" size="16" />
        <span class="sc-label">{{ t('yaya.story.card.fate', '命运骰') }}</span>
        <span class="sc-num">{{ d.roll }}</span>
        <v-chip :color="event.color" variant="tonal" size="small" :prepend-icon="event.icon">
          {{ t(event.key, event.fallback) }}
        </v-chip>
      </div>

      <div v-if="d.focus" class="sc-row">
        <v-icon icon="mdi-target" size="16" />
        <span class="sc-text">{{ d.focus }}</span>
      </div>
    </div>

    <div v-if="d.cast?.length" class="sc-cast">
      <span
        v-for="c in d.cast"
        :key="c.name"
        class="sc-person"
        :title="[c.role, c.status].filter(Boolean).join(' · ') || c.name"
      >
        <span class="sc-avatar" :style="{ '--h': hue(c.name) }">{{ [...c.name][0] }}</span>
        <span class="sc-name">{{ c.name }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.story-card {
  border-radius: 14px;
  padding: 12px 14px;
  border: 1px solid rgba(var(--v-theme-primary), 0.25);
  background:
    linear-gradient(135deg, rgba(var(--v-theme-primary), 0.08), transparent 60%),
    rgba(var(--v-theme-on-surface), 0.02);
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.sc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.sc-head-icon {
  color: rgb(var(--v-theme-primary));
}
.sc-title {
  font-weight: 600;
  font-size: 0.9375rem;
  min-width: 0;
}
.sc-sub {
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.sc-badge {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 0.6875rem;
  font-weight: 600;
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
}
.sc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 6px 16px;
}
.sc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.8125rem;
  min-height: 28px;
}
.sc-row > .v-icon {
  opacity: 0.7;
  flex-shrink: 0;
}
.sc-label {
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  flex-shrink: 0;
}
.sc-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.sc-num {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  flex-shrink: 0;
}
.sc-meter {
  flex: 1 1 auto;
  min-width: 60px;
  height: 6px;
  border-radius: 3px;
  background: rgba(var(--v-theme-on-surface), 0.1);
  overflow: hidden;
}
.sc-meter-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, rgb(var(--v-theme-primary)), rgb(var(--v-theme-error)));
  transition: width 0.4s ease;
}
.sc-cast {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.sc-person {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 2px;
  border-radius: 16px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  font-size: 0.8125rem;
  max-width: 100%;
}
.sc-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 700;
  color: #fff;
  background: hsl(var(--h) 45% 45%);
}
.sc-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
