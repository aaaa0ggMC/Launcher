<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-window' })

import { ref, inject, onMounted } from 'vue'
import { backgrounds } from '../../../backgrounds'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })

const frameless = ref(true)
const rounded = ref(true)
const background = ref('transparent')
const backgroundImage = ref('')
const backgroundOpacity = ref(1)
const fuseAlpha = ref(0.85)
const fuseBlur = ref(28)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  const win = (cfg?.window as Record<string, unknown> | undefined) ?? {}
  frameless.value = win.frameless !== false
  rounded.value = win.rounded !== false
  background.value = (win.background as string) ?? 'transparent'
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

function saveWindow(patch: Record<string, unknown>): Promise<unknown> {
  return window.cockpit.setConfig({
    window: { ...(config.value.window as Record<string, unknown> | undefined), ...patch }
  })
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
    title: '选择背景图片',
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg', 'gif', 'avif'] }
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
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">窗口</v-card-title>
    <v-card-text class="d-flex flex-column">
      <v-switch
        :model-value="frameless"
        label="无边框窗口"
        density="compact"
        hide-details
        @update:model-value="setFrameless"
      />
      <v-switch
        :model-value="rounded"
        label="圆角窗口"
        density="compact"
        hide-details
        class="mt-1"
        @update:model-value="setRounded"
      />

      <v-divider class="my-3" />

      <div class="text-body-2 mb-1">背景</div>
      <v-select
        v-model="background"
        :items="backgrounds"
        item-title="name"
        item-value="id"
        label="背景"
        variant="outlined"
        density="compact"
        hide-details
        @update:model-value="setBackground"
      />
      <div class="text-caption on-surface-variant mt-1">
        {{ backgrounds.find((b) => b.id === background)?.description }}
      </div>
      <div v-if="background === 'image'" class="mt-2">
        <v-text-field
          v-model="backgroundImage"
          label="图片路径"
          placeholder="/home/user/Pictures/wall.jpg"
          variant="outlined"
          density="compact"
          hide-details
          @change="setBackgroundImage"
        >
          <template #append-inner>
            <v-btn icon variant="text" size="small" title="选择图片" @click="browseBackgroundImage">
              <v-icon>mdi-folder-image</v-icon>
            </v-btn>
          </template>
        </v-text-field>
      </div>

      <div class="d-flex align-center justify-space-between mt-3 mb-1">
        <span class="text-body-2">Fuse 蒙层不透明度</span>
        <span class="text-caption on-surface-variant font-family-mono">
          {{ Math.round(fuseAlpha * 100) }}%
        </span>
      </div>
      <v-slider
        v-model="fuseAlpha"
        :min="0"
        :max="1"
        :step="0.01"
        color="primary"
        thumb-label
        hide-details
        @update:model-value="commitFuseAlpha"
      />

      <template v-if="background !== 'transparent'">
        <div class="d-flex align-center justify-space-between mt-3 mb-1">
          <span class="text-body-2">背景图片不透明度</span>
          <span class="text-caption on-surface-variant font-family-mono">
            {{ Math.round(backgroundOpacity * 100) }}%
          </span>
        </div>
        <v-slider
          v-model="backgroundOpacity"
          :min="0"
          :max="1"
          :step="0.01"
          color="primary"
          thumb-label
          hide-details
          @update:model-value="commitBackgroundOpacity"
        />
      </template>

      <div class="d-flex align-center justify-space-between mt-3 mb-1">
        <span class="text-body-2">背景模糊</span>
        <span class="text-caption on-surface-variant font-family-mono"> {{ fuseBlur }}px </span>
      </div>
      <v-slider
        v-model="fuseBlur"
        :min="0"
        :max="60"
        :step="1"
        color="primary"
        thumb-label
        hide-details
        @end="commitFuseBlur"
      />

      <div class="text-caption on-surface-variant mt-2">
        frameless/rounded 下次启动生效；背景/fuse 即时生效。图层: Background(底) → Fuse(中) →
        Data(顶)。Fuse 100% 时完全盖住背景；调低 Fuse 透出背景，图片可见度 = 背景图片不透明度 × (1 −
        Fuse 蒙层不透明度)。
      </div>
    </v-card-text>
  </v-card>
</template>
