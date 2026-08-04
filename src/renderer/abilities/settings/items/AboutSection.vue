<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-about' })
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">关于</v-card-title>
    <v-card-text class="text-body-2">
      Linux System Cockpit · Electron + Vue 3 + Vuetify 3 (Material 3)
      <br />
      <span class="text-caption on-surface-variant">
        能力由 config/abilities.yaml 驱动，可在 src/renderer/abilities 下动态增删。
      </span>
    </v-card-text>
  </v-card>
</template>
