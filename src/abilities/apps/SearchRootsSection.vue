<script setup lang="ts">
defineOptions({ name: 'cockpit-apps-search-roots' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

const roots = ref<{ path: string; watch: boolean }[]>([])
const searching = ref('')

onMounted(async () => {
  const cfg = (await window.cockpit.appsConfig()) as {
    searchRoots: { path: string; watch: boolean }[]
  }
  roots.value = cfg.searchRoots
})

async function addRoot(): Promise<void> {
  if (!searching.value.trim()) return
  const list = (await window.cockpit.addRoot(searching.value.trim())) as {
    path: string
    watch: boolean
  }[]
  roots.value = list
  searching.value = ''
}

async function removeRoot(p: string): Promise<void> {
  const list = (await window.cockpit.removeRoot(p)) as { path: string; watch: boolean }[]
  roots.value = list
}

/** Move one root up (-1) / down (+1); search order follows this list. */
async function moveRoot(p: string, dir: -1 | 1): Promise<void> {
  const list = (await window.cockpit.moveRoot(p, dir)) as { path: string; watch: boolean }[]
  roots.value = list
}

/** Pick a directory via the native dialog and fill the input with it. */
async function pickDirectory(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'dialog.selectDir'),
    directory: true
  })
  if (!path) return
  searching.value = path
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="text-subtitle-2">{{ translate(uiLang, 'apps.searchRoots') }}</v-card-title>
    <v-card-text>
      <div class="text-caption on-surface-variant mb-3">
        {{ translate(uiLang, 'apps.searchRootsDesc') }}
      </div>
      <div v-if="roots.length > 0" class="d-flex flex-column ga-2 rules-list">
        <div v-for="(r, i) in roots" :key="r.path" class="d-flex align-center ga-2 flex-wrap">
          <v-text-field
            :model-value="r.path"
            :label="translateTemplate(uiLang, 'apps.rootRow', { n: String(i + 1) })"
            readonly
            density="compact"
            variant="outlined"
            hide-details
            class="flex-grow-1 rule-input"
          />
          <div class="d-flex ga-1">
            <v-btn
              icon
              size="small"
              variant="flat"
              :disabled="i === 0"
              :title="translate(uiLang, 'apps.moveUp')"
              @click="moveRoot(r.path, -1)"
            >
              <v-icon size="small">mdi-arrow-up</v-icon>
            </v-btn>
            <v-btn
              icon
              size="small"
              variant="flat"
              :disabled="i === roots.length - 1"
              :title="translate(uiLang, 'apps.moveDown')"
              @click="moveRoot(r.path, 1)"
            >
              <v-icon size="small">mdi-arrow-down</v-icon>
            </v-btn>
            <v-btn
              icon
              size="small"
              variant="flat"
              color="error"
              :title="translate(uiLang, 'apps.removeRoot')"
              @click="removeRoot(r.path)"
            >
              <v-icon size="small">mdi-close</v-icon>
            </v-btn>
          </div>
        </div>
      </div>
      <div v-else class="text-caption on-surface-variant d-flex align-center ga-2 rules-empty">
        <span>{{ translate(uiLang, 'apps.unconfigured') }}</span>
      </div>
      <div class="d-flex align-center ga-2 mt-2 flex-wrap">
        <v-text-field
          v-model="searching"
          placeholder="/home/aaaa0ggmc/Apps"
          variant="outlined"
          density="compact"
          hide-details
          class="flex-grow-1 rule-input"
        >
          <template #append-inner>
            <v-btn
              icon
              variant="text"
              size="small"
              :title="translate(uiLang, 'apps.selectDir')"
              @click="pickDirectory"
            >
              <v-icon>mdi-folder-open</v-icon>
            </v-btn>
          </template>
        </v-text-field>
        <v-btn color="primary" variant="tonal" height="40" class="px-5" @click="addRoot">
          {{ translate(uiLang, 'apps.add') }}
        </v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.rules-list {
  overflow-y: auto;
  padding: 10px 6px 8px 2px;
}
.rules-empty {
  min-height: 44px;
}
.rule-input {
  min-width: 160px;
}
</style>
