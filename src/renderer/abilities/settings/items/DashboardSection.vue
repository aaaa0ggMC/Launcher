<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-dashboard' })

import { ref, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../i18n'

const uiLang = (inject('cockpit:lang', ref('zh')) as Ref<string>)

async function resetDashboardLayout(): Promise<void> {
  await window.cockpit.command('dashboard.reset-layout')
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'dashboardReset.title') }}</v-card-title>
    <v-card-text>
      <div class="text-body-2 mb-2">在总览页把卡片拖乱了吗？一键恢复默认排版。</div>
      <v-btn color="error" variant="tonal" prepend-icon="mdi-restore" @click="resetDashboardLayout">
        重置排版
      </v-btn>
    </v-card-text>
  </v-card>
</template>
