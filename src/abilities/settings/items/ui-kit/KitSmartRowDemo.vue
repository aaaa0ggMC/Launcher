<script setup lang="ts">
/**
 * 画廊 · KitSmartRow —— 宽度模拟器 + 智能行退化全过程。
 *
 * 这是整个 UI 库的核心积木：同一个设置行 `[名字][slider][数值]`，
 * 拖宽度看它从「一行」→「隐藏数值框（收进行尾 ⋯）」→「名字单独一行」。
 * 右侧实时显示 planRow 的规划结果（行数 / 隐藏数），退到哪一步一目了然。
 */
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import {
  KitCaption,
  KitDebugOutline,
  KitProse,
  KitRowGroup,
  KitRowItem,
  KitSelect,
  KitSlider,
  KitSmartRow,
  KitSwitch
} from '@ui/kit'
import { translate } from '@ui/i18n'
import KitDemoCard from './KitDemoCard.vue'
import KitWidthStage from './KitWidthStage.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const volume = ref(42)
const quality = ref('high')
const notify = ref(true)

/** 行内探针：把 KitSmartRow 的实时规划状态报上来（demo 用，正式页面不需要） */
const rowLines = ref(0)
const rowHidden = ref(0)
const rowTight = ref(false)
function onRowState(state: { lines: number; hidden: number; tight: boolean }): void {
  rowLines.value = state.lines
  rowHidden.value = state.hidden
  rowTight.value = state.tight
}

const stateText = computed(() => {
  const parts = [
    t('kit.gallery.lines', '{n} 行').replace('{n}', String(rowLines.value)),
    t('kit.gallery.hiddenCount', '隐藏 {n} 个').replace('{n}', String(rowHidden.value))
  ]
  if (rowTight.value) parts.push(t('kit.gallery.tight', '紧凑态'))
  return parts.join(' · ')
})

const debugOn = ref(false)
const qualities = [
  { title: '流畅', value: 'low' },
  { title: '均衡', value: 'medium' },
  { title: '高', value: 'high' }
]
</script>

<template>
  <KitDemoCard
    :title="t('kit.gallery.smartRow.title', 'KitSmartRow · 智能行')"
    import-path="@ui/kit"
    :import-names="['KitSmartRow', 'KitRowItem', 'KitRowGroup']"
    :use="
      t(
        'kit.gallery.smartRow.use',
        '一行放多个控件、空间会变的场景：设置项、工具条、状态行。下限自动算，作者只标 priority。'
      )
    "
    :avoid="
      t(
        'kit.gallery.smartRow.avoid',
        '不要用它做多行列表；也不要给文字按钮套它——按钮组用 KitToolbar。'
      )
    "
  >
    <!-- 布局自检：打开后本页所有元素描边、溢出容器的元素标红（默认关，仅演示） -->
    <div class="kit-demo-debug">
      <KitSwitch v-model="debugOn" :aria-label="t('kit.gallery.debugToggle', '布局自检开关')" />
      <KitProse muted>
        {{ t('kit.gallery.debugOutline', '布局自检：打开后本页所有元素描边，溢出容器的元素标红') }}
      </KitProse>
    </div>
    <KitDebugOutline :active="debugOn" :interval="600" />

    <KitWidthStage
      :initial="720"
      :min="240"
      :max="1180"
      caption="拖动右侧手柄 / 用滑块改容器宽度，看同一行怎么退化"
    >
      <!-- 设置项：名字 + 滑块 + 数值框。数值框标 secondary，窄了自动收进 ⋯ -->
      <KitSmartRow :gap="8" @state="onRowState">
        <KitRowGroup>
          <KitRowItem kind="label" text="主音量" truncate grow priority="primary">
            <span class="kit-demo-label">{{ t('kit.gallery.masterVolume', '主音量') }}</span>
          </KitRowItem>
          <KitRowItem priority="primary" :min-width="120">
            <KitSlider
              v-model="volume"
              :min="0"
              :max="100"
              :step="1"
              :aria-label="t('kit.gallery.masterVolume', '主音量')"
            />
          </KitRowItem>
          <KitRowItem kind="number" priority="secondary" :min-width="72" :text="`${volume}%`">
            <span class="kit-num kit-demo-value">{{ volume }}%</span>
          </KitRowItem>
        </KitRowGroup>
      </KitSmartRow>

      <KitProse muted class="kit-demo-state">
        <v-icon icon="mdi-information-outline" size="14" />
        <span>{{ stateText }}</span>
      </KitProse>

      <!-- 次要元素整行隐藏 + 「更多」浮层 -->
      <KitSmartRow :gap="8" :label="t('kit.gallery.secondaryRow', '次要元素（tertiary 先藏）')">
        <KitRowItem kind="label" :text="t('kit.gallery.status', '状态')" truncate grow>
          <span class="kit-demo-label">{{ t('kit.gallery.status', '状态') }}</span>
        </KitRowItem>
        <KitRowItem kind="control" priority="primary" :min-width="120">
          <KitSelect
            v-model="quality"
            :items="qualities"
            item-title="title"
            item-value="value"
            :aria-label="t('kit.gallery.quality', '画质')"
          />
        </KitRowItem>
        <KitRowItem kind="control" priority="secondary" :min-width="88">
          <KitSwitch v-model="notify" :aria-label="t('kit.gallery.notify', '通知')" />
        </KitRowItem>
        <KitRowItem kind="label" priority="tertiary" :text="t('kit.gallery.latency', '延迟 12ms')">
          <KitCaption class="kit-demo-chip">{{ t('kit.gallery.latency', '延迟 12ms') }}</KitCaption>
        </KitRowItem>
        <KitRowItem kind="label" priority="tertiary" :text="t('kit.gallery.fps', '60 FPS')">
          <KitCaption class="kit-demo-chip">{{ t('kit.gallery.fps', '60 FPS') }}</KitCaption>
        </KitRowItem>
      </KitSmartRow>

      <!-- 换行退化：名字与控件不同 Group，窄了各占一行 -->
      <KitSmartRow :gap="8" :label="t('kit.gallery.wrapRow', '换行退化（名字与控件不同组）')">
        <KitRowItem kind="label" text="很长的设置项名称" truncate grow priority="primary">
          <span class="kit-demo-label">{{ t('kit.gallery.longName', '很长的设置项名称') }}</span>
        </KitRowItem>
        <KitRowItem kind="control" priority="primary" :min-width="160">
          <v-btn variant="text" prepend-icon="mdi-cog" size="default">
            {{ t('kit.gallery.configure', '配置') }}
          </v-btn>
        </KitRowItem>
        <KitRowItem kind="number" priority="secondary" :min-width="56">
          <span class="kit-num kit-demo-value">1.4 GB</span>
        </KitRowItem>
      </KitSmartRow>
    </KitWidthStage>
  </KitDemoCard>
</template>

<style scoped>
.kit-demo-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kit-demo-value {
  white-space: nowrap;
}

.kit-demo-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  background: rgba(var(--v-theme-on-surface), 0.08);
}

.kit-demo-debug {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kit-demo-state {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
