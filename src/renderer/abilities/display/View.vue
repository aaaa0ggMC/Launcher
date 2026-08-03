<script setup lang="ts">
import { ref, shallowRef, computed, inject, onMounted } from 'vue'
import type { DisplayOutput, WallpaperFile } from '@shared/types'
import LoadingBar from '../../components/LoadingBar.vue'

const { configs } = inject<{ configs: Record<string, Record<string, unknown>> }>('cockpit:abilities', {
  configs: {}
})

const wallpaperDir = computed(() => {
  const cfg = configs.value.display as Record<string, unknown> | undefined
  return (cfg?.wallpaperDir as string) ?? ''
})
const wallpapers = shallowRef<WallpaperFile[]>([])
const outputs = shallowRef<DisplayOutput[]>([])
const applying = ref<string | null>(null)
const loading = ref(false)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    const [w, o] = await Promise.all([
      window.cockpit.wallpapers(wallpaperDir.value),
      window.cockpit.outputs()
    ])
    wallpapers.value = w
    outputs.value = o
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function apply(w: WallpaperFile): Promise<void> {
  applying.value = w.path
  try {
    const ok = await window.cockpit.applyWallpaper(w.path)
    if (!ok) error.value = `应用壁纸失败: ${w.name}`
  } finally {
    applying.value = null
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="text-h6 font-weight-medium mb-1">显示与壁纸</div>
    <div class="text-caption on-surface-variant mb-4">
      壁纸目录: {{ wallpaperDir || '未配置 (config → display.wallpaperDir)' }}
    </div>

    <LoadingBar :loading="loading" :error="error" />

    <div class="text-subtitle-2 mb-2">输出设备</div>
    <v-row dense class="mb-4">
      <v-col v-for="o in outputs" :key="o.name" cols="auto">
        <v-chip :color="o.enabled ? 'success' : ''" variant="tonal">
          <v-icon start :color="o.enabled ? 'success' : ''">
            {{ o.enabled ? 'mdi-monitor' : 'mdi-monitor-off' }}
          </v-icon>
          {{ o.name }}
          <span v-if="!o.enabled" class="text-caption">(断开)</span>
        </v-chip>
      </v-col>
      <v-col v-if="outputs.length === 0" cols="12">
        <span class="text-caption on-surface-variant">kscreen-doctor 不可用</span>
      </v-col>
    </v-row>

    <div class="text-subtitle-2 mb-2">壁纸</div>
    <v-row dense>
      <v-col
        v-for="w in wallpapers"
        :key="w.path"
        cols="6"
        sm="4"
        md="3"
        lg="2"
      >
        <v-card rounded="lg" variant="tonal" class="wallpaper-card" @click="apply(w)">
          <v-img
            :src="`cockpit-icon://${encodeURIComponent(w.path)}`"
            :lazy-src="`cockpit-icon://${encodeURIComponent(w.path)}`"
            height="120"
            cover
            class="rounded-t"
          />
          <v-card-text class="d-flex align-center justify-space-between py-1">
            <span class="text-caption text-truncate">{{ w.name }}</span>
            <v-progress-circular
              v-if="applying === w.path"
              size="16"
              width="2"
              indeterminate
              color="primary"
            />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-empty-state
      v-if="!loading && wallpapers.length === 0"
      icon="mdi-image-outline"
      title="没有找到壁纸"
      :text="`目录为空或不存在: ${wallpaperDir}`"
      class="mt-4"
    />
  </div>
</template>
