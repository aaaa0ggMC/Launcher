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
 *  等高 + 底部留白一致由 KitGrid 的 align-stretch 与栏距令牌保证。
 *  每档都自述当前状态（state）：拆两行是引擎设计好的退化，不是坏了——
 *   宽/中：一行 `[标签][控件][数值]`；窄：标签独占一行、控件落第二行，数值（secondary）
 *   装不下先收进行尾「更多」。 */
const stages = computed(() => [
  {
    width: 480,
    narrow: false,
    label: t('kit.gallery.wide', '宽'),
    state: t('kit.gallery.settingRow.stateWide', '一行：标签 + 控件 + 数值')
  },
  {
    width: 320,
    narrow: false,
    label: t('kit.gallery.mid', '中'),
    state: t('kit.gallery.settingRow.stateMid', '一行：标签 + 步进器 + 数值（滑块换步进器）')
  },
  {
    width: 232,
    narrow: true,
    label: t('kit.gallery.tight', '窄'),
    state: t(
      'kit.gallery.settingRow.stateTight',
      '窄屏退化：标签独占一行，控件落第二行（刻意设计）'
    )
  }
])

/** 每行的对齐档标记（SPEC「行内对齐」：下拉/输入=左，数值=右） */
const alignTags = computed(() => ({
  slider: t('kit.gallery.alignLeft', '值·左'),
  num: t('kit.gallery.alignRight', '值·右'),
  select: t('kit.gallery.alignLeft', '值·左'),
  btn: t('kit.gallery.alignLeft', '值·左')
}))
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
        <div class="kit-demo-stagecol__head">
          <span>{{ s.label }} · {{ s.width }}px</span>
          <span class="kit-demo-stagecol__state">{{ s.state }}</span>
        </div>
        <div class="kit-demo-stagecol__box" :style="{ maxWidth: `${s.width}px` }">
          <div class="kit-demo-tagged">
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
            <span class="kit-demo-tagged__tag">{{ alignTags.slider }}</span>
          </div>
          <div class="kit-demo-tagged">
            <KitSettingRow
              v-model="scale"
              :label="t('kit.gallery.uiScale', '界面缩放')"
              :min="80"
              :max="180"
              :step="10"
              unit="%"
              :narrow="s.narrow"
            />
            <span class="kit-demo-tagged__tag">{{ alignTags.num }}</span>
          </div>
          <div class="kit-demo-tagged">
            <KitSettingRow :label="t('kit.gallery.theme', '配色方案')" :narrow="s.narrow">
              <KitSelect
                v-model="scheme"
                :items="schemes"
                :aria-label="t('kit.gallery.theme', '配色方案')"
              />
            </KitSettingRow>
            <span class="kit-demo-tagged__tag">{{ alignTags.select }}</span>
          </div>
          <div class="kit-demo-tagged">
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
            <span class="kit-demo-tagged__tag">{{ alignTags.btn }}</span>
          </div>
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

/* 每档自述状态：拆两行是刻意退化，不是坏了 */
.kit-demo-stagecol__head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kit-demo-stagecol__state {
  font-size: 0.6875rem;
  line-height: 1.4;
  opacity: 0.7;
}

/* 行尾对齐档小标记：绝对定位浮在行尾，不占行宽（列宽宣称值不变） */
.kit-demo-tagged {
  position: relative;
}

.kit-demo-tagged__tag {
  position: absolute;
  right: 0;
  bottom: -1px;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 0.625rem;
  line-height: 1.5;
  opacity: 0.75;
  background: rgba(var(--v-theme-on-surface), 0.1);
  pointer-events: none;
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
