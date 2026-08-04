<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-theme' })

import { ref, onMounted } from 'vue'

const theme = ref('dark')

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  theme.value = (cfg?.theme as string) ?? 'dark'
})

async function setTheme(t: string): Promise<void> {
  theme.value = t
  await window.cockpit.setConfig({ theme: t })
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">主题</v-card-title>
    <v-card-text>
      <v-radio-group
        v-model="theme"
        density="compact"
        hide-details
        @update:model-value="(v: string | null) => setTheme(v ?? 'dark')"
      >
        <v-radio label="深色 (Material 3)" value="dark" />
        <v-radio label="纯黑" value="pureblack" />
        <v-radio label="跟随系统" value="system" />
      </v-radio-group>
    </v-card-text>
  </v-card>
</template>
