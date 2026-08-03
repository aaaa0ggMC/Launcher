<script setup lang="ts">
import { ref, shallowRef, onMounted } from 'vue'
import type { AutostartEntry } from '@shared/types'

const entries = shallowRef<AutostartEntry[]>([])
const loading = ref(false)
const toggling = ref<string | null>(null)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    entries.value = await window.cockpit.listAutostart()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function toggle(e: AutostartEntry): Promise<void> {
  toggling.value = e.file
  try {
    const next = e.hidden
    entries.value = await window.cockpit.toggleAutostart(e.file, !next)
  } finally {
    toggling.value = null
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="text-h6 font-weight-medium mb-1">启动项</div>
    <div class="text-caption on-surface-variant mb-4">管理 ~/.config/autostart 中的自启动项</div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-3" density="compact">{{ error }}</v-alert>

    <v-progress-linear v-if="loading" indeterminate class="mb-2" />

    <v-row dense>
      <v-col v-for="e in entries" :key="e.file" cols="12" sm="6" md="4">
        <v-card rounded="lg" variant="tonal" :class="e.hidden ? 'opacity-60' : ''">
          <v-card-text class="d-flex align-center ga-3">
            <v-icon :color="e.hidden ? 'on-surface-variant' : 'success'" size="28">
              {{ e.hidden ? 'mdi-weather-night' : 'mdi-rocket-launch' }}
            </v-icon>
            <div class="flex-grow-1 min-width-0">
              <div class="d-flex align-center ga-2">
                <span class="text-body-1 font-weight-medium text-truncate">{{ e.name }}</span>
                <v-chip size="x-small" variant="tonal" :color="e.hidden ? '' : 'success'">
                  {{ e.hidden ? '已禁用' : '已启用' }}
                </v-chip>
              </div>
              <div class="text-caption on-surface-variant text-truncate mt-1">{{ e.exec }}</div>
              <div class="text-caption on-surface-variant">{{ e.file }}</div>
            </div>
            <v-switch
              :model-value="!e.hidden"
              color="success"
              density="compact"
              hide-details
              :loading="toggling === e.file"
              @update:model-value="toggle(e)"
            />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-empty-state
      v-if="!loading && entries.length === 0"
      icon="mdi-rocket-launch-outline"
      title="没有自启动项"
      text="~/.config/autostart 中没有 .desktop 文件。"
      class="mt-6"
    />
  </div>
</template>

<style scoped>
.opacity-60 {
  opacity: 0.6;
}
.min-width-0 {
  min-width: 0;
}
</style>
