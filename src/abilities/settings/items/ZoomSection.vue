<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-zoom' })

import { ref, inject, onMounted } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { KitCaption, KitRowItem, KitSection, KitSlider, KitSmartRow } from '@ui/kit'

const uiScale = ref(1.1)
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const scale = Number(cfg?.uiScale)
  uiScale.value = Number.isFinite(scale) && scale > 0 ? scale : 1.1
})

async function commitUiScale(): Promise<void> {
  window.cockpit.setZoom(uiScale.value)
  await window.cockpit.setConfig({ uiScale: uiScale.value })
}

/** Deep export: current UI scale. */
defineExpose({
  toMarkdown: (): string => `${translate(uiLang.value, 'zoom.title')}: ${uiScale.value}x`
})
</script>

<template>
  <KitSection :title="translate(uiLang, 'zoom.title')" icon="mdi-magnify-plus-outline">
    <KitSmartRow :gap="8">
      <!-- 不传 slot：走 KitRowItem 的内置 KitTruncated（text 即全文，截断可揭示）。
           原来的 slot 是没接原语的裸 span，slot 优先后会把揭示顶掉（A-2 回归口径）。 -->
      <KitRowItem kind="label" :text="translate(uiLang, 'zoom.label')" truncate grow />
      <KitRowItem kind="number" priority="secondary" :min-width="56">
        <span class="kit-num">{{ Math.round(uiScale * 100) }}%</span>
      </KitRowItem>
    </KitSmartRow>
    <KitSlider
      v-model="uiScale"
      :min="0.8"
      :max="1.8"
      :step="0.05"
      thumb-label
      show-ticks
      @end="commitUiScale"
    />
    <div class="d-flex justify-space-between">
      <KitCaption>{{ translate(uiLang, 'zoom.small') }}</KitCaption>
      <KitCaption>{{ translate(uiLang, 'zoom.default') }}</KitCaption>
      <KitCaption>{{ translate(uiLang, 'zoom.large') }}</KitCaption>
    </div>
  </KitSection>
</template>
