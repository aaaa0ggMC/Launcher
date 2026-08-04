<script setup lang="ts">
defineOptions({ name: 'cockpit-apps-search-roots' })

import { ref, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../i18n'

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

/** Pick a directory via the native dialog and fill the input with it. */
async function pickDirectory(): Promise<void> {
  const path = await window.cockpit.pickFile({ title: '选择应用目录', directory: true })
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
      <div class="mb-3">
        <template v-for="r in roots" :key="r.path">
          <v-chip
            size="small"
            variant="outlined"
            closable
            class="mr-2 mb-1"
            @click:close="removeRoot(r.path)"
          >
            {{ r.path }}
          </v-chip>
        </template>
        <span v-if="roots.length === 0" class="text-caption on-surface-variant">{{
          translate(uiLang, 'apps.unconfigured')
        }}</span>
      </div>
      <div class="d-flex align-center ga-2">
        <v-text-field
          v-model="searching"
          placeholder="/home/aaaa0ggmc/Apps"
          variant="outlined"
          density="compact"
          hide-details
          class="flex-grow-1"
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
