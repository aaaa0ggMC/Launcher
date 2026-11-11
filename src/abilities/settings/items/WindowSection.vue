<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-window' })

import { ref, inject, onMounted, computed } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { backgrounds, isBackgroundAvailable } from '../../../background'
import {
  KitCaption,
  KitProse,
  KitSection,
  KitSelect,
  KitSettingRow,
  KitSlider,
  KitSwitch,
  KitTextField
} from '@ui/kit'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })
const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

const bgItems = computed(() =>
  backgrounds.filter(isBackgroundAvailable).map((b) => ({
    id: b.id,
    name: translate(uiLang.value, `background.${b.id}.name`),
    description: translate(uiLang.value, `background.${b.id}.desc`)
  }))
)

/** 窗口外壳（无边框 / 圆角）只在宿主有自己的窗口时才有意义；网页里浏览器就是窗口 */
const hasFrame = window.cockpit.hasCap('window.frame')
const blurMode = ref<'on' | 'off' | 'auto'>('on')
const frameless = ref(true)
const rounded = ref(true)
const radius = ref(12)
const background = ref('transparent')
const backgroundImage = ref('')
const backgroundOpacity = ref(1)
const fuseAlpha = ref(0.85)
const fuseBlur = ref(28)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const win = (cfg?.window as Record<string, unknown> | undefined) ?? {}
  blurMode.value = win.blur === 'off' || win.blur === 'auto' ? win.blur : 'on'
  frameless.value = win.frameless !== false
  rounded.value = win.rounded !== false
  const r = Number(win.radius)
  radius.value = Number.isFinite(r) && r >= 0 ? r : 12
  background.value = (win.background as string) ?? 'transparent'
  // 已存的背景在当前宿主不可用（如网页里的 wallpaper）：界面按 transparent 显示，不改动已存配置
  if (!bgItems.value.some((b) => b.id === background.value)) background.value = 'transparent'
  backgroundImage.value = (win.backgroundImage as string) ?? ''
  const bop = Number(win.backgroundOpacity)
  backgroundOpacity.value = Number.isFinite(bop) ? bop : 1
  const alpha = Number(win.fuseAlpha)
  fuseAlpha.value = Number.isFinite(alpha) ? alpha : 0.85
  const blur = Number(win.fuseBlur)
  fuseBlur.value = Number.isFinite(blur) ? blur : 28
})

async function setFrameless(v: boolean | null): Promise<void> {
  const val = !!v
  frameless.value = val
  await window.cockpit.setConfig({
    window: { ...(config.value.window as Record<string, unknown> | undefined), frameless: val }
  })
}

async function setRounded(v: boolean | null): Promise<void> {
  const val = !!v
  rounded.value = val
  await window.cockpit.setConfig({
    window: { ...(config.value.window as Record<string, unknown> | undefined), rounded: val }
  })
}

async function commitRadius(): Promise<void> {
  await saveWindow({ radius: radius.value })
}

function saveWindow(patch: Record<string, unknown>): Promise<unknown> {
  return window.cockpit.setConfig({
    window: { ...(config.value.window as Record<string, unknown> | undefined), ...patch }
  })
}

async function setBlurMode(v: string | null): Promise<void> {
  const m = v === 'off' || v === 'auto' ? v : 'on'
  blurMode.value = m
  await saveWindow({ blur: m })
}

async function setBackground(v: string | null): Promise<void> {
  background.value = v ?? 'transparent'
  await saveWindow({ background: background.value })
}

async function setBackgroundImage(): Promise<void> {
  await saveWindow({ backgroundImage: backgroundImage.value.trim() || undefined })
}

async function browseBackgroundImage(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'dialog.selectBackground'),
    filters: [
      {
        name: translate(uiLang.value, 'dialog.filterImages'),
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg', 'gif', 'avif']
      }
    ]
  })
  if (!path) return
  backgroundImage.value = path
  await saveWindow({ backgroundImage: path })
}

async function commitFuseAlpha(): Promise<void> {
  await saveWindow({ fuseAlpha: fuseAlpha.value })
}

async function commitBackgroundOpacity(): Promise<void> {
  await saveWindow({ backgroundOpacity: backgroundOpacity.value })
}

async function commitFuseBlur(): Promise<void> {
  await saveWindow({ fuseBlur: fuseBlur.value })
}

/** Deep export: window chrome + background settings. */
defineExpose({
  toMarkdown: (): string => {
    const on = translate(uiLang.value, 'settings.on', '开')
    const off = translate(uiLang.value, 'settings.off', '关')
    const bgName = bgItems.value.find((b) => b.id === background.value)?.name ?? background.value
    return [
      `${translate(uiLang.value, 'window.frameless')}: ${frameless.value ? on : off}`,
      `${translate(uiLang.value, 'window.rounded')}: ${rounded.value ? on : off}`,
      `${translate(uiLang.value, 'window.background')}: ${bgName}`,
      `${translate(uiLang.value, 'window.fuseAlpha')}: ${fuseAlpha.value.toFixed(2)}`,
      `${translate(uiLang.value, 'window.bgBlur')}: ${fuseBlur.value}px`
    ].join('\n')
  }
})
</script>

<template>
  <KitSection :title="translate(uiLang, 'window.title')" icon="mdi-window-maximize">
    <KitSettingRow v-if="hasFrame" :label="translate(uiLang, 'window.frameless')">
      <KitSwitch
        size="inline"
        :model-value="frameless"
        :aria-label="translate(uiLang, 'window.frameless')"
        @update:model-value="setFrameless"
      />
    </KitSettingRow>

    <KitSettingRow v-if="hasFrame" :label="translate(uiLang, 'window.rounded')">
      <KitSwitch
        size="inline"
        :model-value="rounded"
        :aria-label="translate(uiLang, 'window.rounded')"
        @update:model-value="setRounded"
      />
    </KitSettingRow>

    <template v-if="hasFrame && rounded">
      <KitSettingRow :label="translate(uiLang, 'window.radius')" :value="`${radius}px`">
        <KitSlider v-model="radius" :min="0" :max="40" :step="1" thumb-label @end="commitRadius" />
      </KitSettingRow>
    </template>

    <KitSettingRow :label="translate(uiLang, 'window.bgSelect')">
      <KitSelect
        size="inline"
        v-model="background"
        :items="bgItems"
        item-title="name"
        item-value="id"
        :aria-label="translate(uiLang, 'window.bgSelect')"
        @update:model-value="setBackground($event as string | null)"
      />
    </KitSettingRow>
    <KitCaption>{{ bgItems.find((b) => b.id === background)?.description }}</KitCaption>

    <KitSettingRow v-if="background === 'image'" :label="translate(uiLang, 'window.imgPath')">
      <KitTextField
        size="inline"
        v-model="backgroundImage"
        placeholder="/home/user/Pictures/wall.jpg"
        :aria-label="translate(uiLang, 'window.imgPath')"
        @change="setBackgroundImage"
      >
        <template #append-inner>
          <v-btn
            icon
            variant="text"
            size="small"
            :title="translate(uiLang, 'dialog.selectBackground')"
            :aria-label="translate(uiLang, 'dialog.selectBackground')"
            @click="browseBackgroundImage"
          >
            <v-icon>mdi-folder-image</v-icon>
          </v-btn>
        </template>
      </KitTextField>
    </KitSettingRow>

    <KitSettingRow
      :label="translate(uiLang, 'window.fuseAlpha')"
      :value="`${Math.round(fuseAlpha * 100)}%`"
    >
      <KitSlider
        size="inline"
        v-model="fuseAlpha"
        :min="0"
        :max="1"
        :step="0.01"
        thumb-label
        :aria-label="translate(uiLang, 'window.fuseAlpha')"
        @update:model-value="commitFuseAlpha"
      />
    </KitSettingRow>

    <KitSettingRow
      v-if="background !== 'transparent'"
      :label="translate(uiLang, 'window.bgOpacity')"
      :value="`${Math.round(backgroundOpacity * 100)}%`"
    >
      <KitSlider
        size="inline"
        v-model="backgroundOpacity"
        :min="0"
        :max="1"
        :step="0.01"
        thumb-label
        :aria-label="translate(uiLang, 'window.bgOpacity')"
        @update:model-value="commitBackgroundOpacity"
      />
    </KitSettingRow>

    <KitSettingRow :label="translate(uiLang, 'window.bgBlur')" :value="`${fuseBlur}px`">
      <KitSlider
        size="inline"
        v-model="fuseBlur"
        :min="0"
        :max="60"
        :step="1"
        thumb-label
        :aria-label="translate(uiLang, 'window.bgBlur')"
        @end="commitFuseBlur"
      />
    </KitSettingRow>

    <KitProse>{{ translate(uiLang, 'window.blurMode') }}</KitProse>
    <KitCaption>{{ translate(uiLang, 'window.blurModeHint') }}</KitCaption>
    <v-radio-group
      :model-value="blurMode"
      color="primary"
      density="compact"
      hide-details
      @update:model-value="setBlurMode"
    >
      <v-radio :label="translate(uiLang, 'window.blurOn')" value="on" />
      <v-radio :label="translate(uiLang, 'window.blurAuto')" value="auto" />
      <v-radio :label="translate(uiLang, 'window.blurOff')" value="off" />
    </v-radio-group>

    <KitCaption>{{ translate(uiLang, 'window.note') }}</KitCaption>
  </KitSection>
</template>
