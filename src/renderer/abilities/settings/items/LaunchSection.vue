<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-launch' })

import { ref, inject, onMounted } from 'vue'

const config = inject<{ value: Record<string, unknown> }>('cockpit:config', { value: {} })
const confirmBeforeLaunch = ref(false)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  confirmBeforeLaunch.value = !!(cfg?.runtime as Record<string, unknown> | undefined)
    ?.confirmBeforeLaunch
})

async function setConfirm(v: boolean | null): Promise<void> {
  const val = !!v
  confirmBeforeLaunch.value = val
  await window.cockpit.setConfig({
    runtime: {
      ...(config.value.runtime as Record<string, unknown> | undefined),
      confirmBeforeLaunch: val
    }
  })
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">启动</v-card-title>
    <v-card-text>
      <v-switch
        :model-value="confirmBeforeLaunch"
        label="所有启动前都需确认"
        density="compact"
        hide-details
        @update:model-value="setConfirm"
      />
    </v-card-text>
  </v-card>
</template>
