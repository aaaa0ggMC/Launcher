<script setup lang="ts">
/**
 * 画廊 · KitSettingRow —— 设置行 `[名字][控件][数值]`，三档宽度并排。
 * 三条同一份数据、三个固定宽度：宽屏滑块 + 数值、中屏步进器 + 数值、窄屏步进器（数值收起）。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { KitGrid, KitSelect, KitSettingRow } from '@ui/kit'
import { translate } from '@ui/i18n'
import KitDemoCard from './KitDemoCard.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const volume = ref(42)
const scale = ref(110)
const scheme = ref('dark')
const schemes = ['dark', 'light', 'pureblack', 'moonlight', 'forest', 'aurora']

/** 三档并排：宽 / 中 / 窄。列宽按 480:320:232 的比例（fr），容器变窄时同比收缩，
 *  等高 + 底部留白一致由 KitGrid 的 align-stretch 与栏距令牌保证 */
const stages = computed(() => [
  { width: 480, narrow: false, label: t('kit.gallery.wide', '宽') },
  { width: 320, narrow: false, label: t('kit.gallery.mid', '中') },
  { width: 232, narrow: true, label: t('kit.gallery.tight', '窄') }
])
</script>

<template>
  <KitDemoCard
    :title="t('kit.gallery.settingRow.title', 'KitSettingRow · 设置行')"
    import-path="@ui/kit"
    :import-names="['KitSettingRow', 'KitNumberStepper']"
    :use="
      t(
        'kit.gallery.settingRow.use',
        '设置项的标准形态：名字 + 控件 + 数值。内置「禁通栏 slider、移动端默认步进器」两条硬禁令，直接挂进设置页的 v-row/v-col 网格。'
      )
    "
    :avoid="
      t(
        'kit.gallery.settingRow.avoid',
        '不要在设置页手写 justify-space-between + v-slider 三件套——那是仓里 140 处的重复来源。'
      )
    "
  >
    <KitGrid cols="minmax(0, 1.55fr) minmax(0, 1.03fr) minmax(0, 0.75fr)" :gap="12">
      <div v-for="s in stages" :key="s.width" class="kit-demo-stagecol">
        <div class="kit-demo-stagecol__head">{{ s.label }} · {{ s.width }}px</div>
        <div class="kit-demo-stagecol__box" :style="{ maxWidth: `${s.width}px` }">
          <KitSettingRow
            v-model="volume"
            :label="t('kit.gallery.masterVolume', '主音量')"
            :min="0"
            :max="100"
            unit="%"
            slider
            :narrow="s.narrow"
            :hint="t('kit.gallery.settingRow.hint', '拖动或点 ± 都能改')"
          />
          <KitSettingRow
            v-model="scale"
            :label="t('kit.gallery.uiScale', '界面缩放')"
            :min="80"
            :max="180"
            :step="10"
            unit="%"
          />
          <KitSettingRow :label="t('kit.gallery.theme', '配色方案')" :narrow="s.narrow">
            <KitSelect
              v-model="scheme"
              :items="schemes"
              :aria-label="t('kit.gallery.theme', '配色方案')"
            />
          </KitSettingRow>
          <KitSettingRow
            :label="t('kit.gallery.optionalRow', '可整行隐藏的次要设置')"
            secondary
            :narrow="s.narrow"
            value="1.4 GB"
          >
            <v-btn variant="text" prepend-icon="mdi-folder-open-outline" size="default">
              {{ t('kit.gallery.pickDir', '选择目录') }}
            </v-btn>
          </KitSettingRow>
        </div>
      </div>
    </KitGrid>
  </KitDemoCard>
</template>

<style scoped>
.kit-demo-stagecol {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  /* 等高：KitGrid 的 align-stretch 已经把列拉成一样高，这里把内容往下推 */
  height: 100%;
}

.kit-demo-stagecol__box {
  flex: 1 1 auto;
  max-width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 底部留白 = 一个栏距（2 个网格单位）：三列一致，最后一项不贴底边 */
  padding: 8px 8px 8px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  background: rgba(var(--kit-surface), var(--kit-glass-alpha));
  backdrop-filter: blur(var(--kit-glass-blur));
}
</style>
