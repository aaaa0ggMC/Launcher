<script setup lang="ts">
defineOptions({ name: 'cockpit-settings-about' })

import { ref, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../i18n'

const uiLang = (inject('cockpit:lang', ref('zh')) as Ref<string>)
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'about.title') }}</v-card-title>
    <v-card-text class="text-body-2">
      Linux System Cockpit · Electron + Vue 3 + Vuetify 3 (Material 3)
      <br />
      <span class="text-caption on-surface-variant">
        {{ translate(uiLang, 'about.text') }}
      </span>
    </v-card-text>
  </v-card>
</template>
