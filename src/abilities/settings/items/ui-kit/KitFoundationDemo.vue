<script setup lang="ts">
/**
 * 画廊 · 网格 / 圆形 stat / 占位 —— P0-4「80% 内容率」与 P0-5「网格式计算」的落地演示。
 */
import { inject, ref } from 'vue'
import type { Ref } from 'vue'
import {
  GRID,
  grid,
  KitCaption,
  KitCircleStat,
  KitGrid,
  KitPlaceholder,
  KitProse,
  KitTitle
} from '@ui/kit'
import { translate } from '@ui/i18n'
import KitDemoCard from './KitDemoCard.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const stats = [
  { value: '42%', label: 'CPU' },
  { value: '7.2', label: '内存 GB' },
  { value: '128', label: '进程', progress: 0.62 },
  { value: '99+', label: '未读消息' }
]
</script>

<template>
  <KitDemoCard
    :title="t('kit.gallery.foundation.title', '网格 · 圆形 stat · 占位')"
    import-path="@ui/kit"
    :import-names="['KitGrid', 'KitCircleStat', 'KitPlaceholder']"
    :use="
      t(
        'kit.gallery.foundation.use',
        'KitGrid 管多列等高与统一栏距；KitCircleStat 是「内容占 80%」的样板（直径 = 文本 × 1.25）；KitPlaceholder 代表一块全幅内容区。'
      )
    "
    :avoid="
      t(
        'kit.gallery.foundation.avoid',
        '不要手写 grid-template-columns 与斜纹背景——栏距、圆角、触控热区都从网格令牌算。'
      )
    "
  >
    <!-- 80% 规则：同一批数据在不同直径下都不裁切、不塞满 -->
    <div class="kit-demo-block">
      <KitTitle level="sub">{{
        t('kit.gallery.foundation.circles', '圆形 stat（内容占直径 80%）')
      }}</KitTitle>
      <div class="kit-demo-circles">
        <KitCircleStat
          v-for="s in stats"
          :key="s.label"
          :value="s.value"
          :label="s.label"
          :progress="s.progress"
          :min="44"
          :max="132"
        />
      </div>
      <KitCaption class="kit-demo-note">{{
        t(
          'kit.gallery.foundation.circlesNote',
          '直径由文字推算：文本宽高 × 1.25（即文字占 80%），再夹在 44–132px。改字号不用改直径。'
        )
      }}</KitCaption>
    </div>

    <!-- 网格：等宽栏 + 等高 + 统一栏距 -->
    <div class="kit-demo-block">
      <KitTitle level="sub">{{
        t('kit.gallery.foundation.grid', '网格（等宽栏 / 等高 / 统一栏距）')
      }}</KitTitle>
      <KitGrid :min-col="150" :gap="GRID.gutter">
        <div v-for="n in 6" :key="n" class="kit-demo-cell">
          <KitCaption>{{ grid(n) }}px</KitCaption>
          <KitProse
            >t('kit.gallery.foundation.cell', '格子 {n}').replace('{n}', String(n))</KitProse
          >
        </div>
      </KitGrid>
      <KitCaption class="kit-demo-note">{{
        t(
          'kit.gallery.foundation.gridNote',
          '格子里的数字是该格高度（从 4px 基础单位算）；栏距 8px、圆角 12px、触控热区 40px 都是令牌的整数倍。'
        )
      }}</KitCaption>
    </div>

    <!-- 占位：三种 pattern -->
    <div class="kit-demo-block">
      <KitTitle level="sub">{{
        t('kit.gallery.foundation.placeholder', '占位（代表一块全幅内容区）')
      }}</KitTitle>
      <div class="kit-demo-placeholders">
        <KitPlaceholder
          pattern="stripe"
          :height="72"
          icon="mdi-vector-square"
          :caption="t('kit.gallery.foundation.stripe', 'stripe：画布 / 地图 / 图表区')"
        />
        <KitPlaceholder
          pattern="dots"
          :height="72"
          icon="mdi-format-list-bulleted"
          :caption="t('kit.gallery.foundation.dots', 'dots：列表 / 日志区')"
        />
        <KitPlaceholder
          pattern="plain"
          :height="72"
          icon="mdi-text-box-outline"
          :caption="t('kit.gallery.foundation.plain', 'plain：纯文本说明区')"
        />
      </div>
    </div>
  </KitDemoCard>
</template>

<style scoped>
.kit-demo-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.kit-demo-block__head {
  opacity: 0.85;
}

.kit-demo-circles {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 16px;
}

.kit-demo-note {
  line-height: 1.6;
}

.kit-demo-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 56px;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  background: rgba(var(--v-theme-on-surface), 0.04);
}

.kit-demo-placeholders {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}
</style>
