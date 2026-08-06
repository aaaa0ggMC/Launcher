<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import type { SystemdUnit } from './types'
import { translate } from '@ui/i18n'
import { filterByQuery, fields } from '@ui/composables/search'
import LoadingBar from '@ui/components/LoadingBar.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

const units = shallowRef<SystemdUnit[]>([])
const loading = ref(false)
const busy = ref<string | null>(null)
const error = ref('')
const filter = ref('')
const showAll = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    units.value = await window.cockpit.listSystemd()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  let list = units.value
  if (!showAll.value) list = list.filter((u) => u.active === 'active')
  if (!filter.value.trim()) return list
  // shared weighted AND search: name > description
  return filterByQuery(list, filter.value, (u) => fields(u.name, '', u.description))
})

async function act(u: SystemdUnit, action: 'start' | 'stop' | 'restart'): Promise<void> {
  busy.value = `${u.name}:${action}`
  try {
    units.value = await window.cockpit.systemdAction(u.name, action)
  } finally {
    busy.value = null
  }
}

function colorFor(u: SystemdUnit): string {
  if (u.active === 'active') return 'success'
  if (u.active === 'failed') return 'error'
  return ''
}

onMounted(load)

/** Export the (filtered) systemd unit list as markdown. */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'systemd.mdHeading')]
  if (filtered.value.length === 0) {
    lines.push(`- ${translate(uiLang.value, 'systemd.empty')}`)
    return lines.join('\n')
  }
  for (const u of filtered.value) {
    lines.push(
      `- **\`${u.name}\`** — \`${u.active} / ${u.sub}\`${u.description ? ` — ${u.description}` : ''}`
    )
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-3">
      <div>
        <div class="text-h6 font-weight-medium">{{ translate(uiLang, 'systemd.heading') }}</div>
        <div class="text-caption on-surface-variant">
          {{ translate(uiLang, 'systemd.subtitle') }}
        </div>
      </div>
      <v-btn variant="tonal" prepend-icon="mdi-refresh" :loading="loading" @click="load">
        {{ translate(uiLang, 'systemd.refresh') }}
      </v-btn>
    </div>

    <v-row class="mb-2" dense>
      <v-col cols="12" sm="5">
        <v-text-field
          v-model="filter"
          prepend-inner-icon="mdi-magnify"
          :placeholder="translate(uiLang, 'systemd.search')"
          density="compact"
          variant="solo-filled"
          hide-details
          clearable
          @click:clear="filter = ''"
        />
      </v-col>
      <v-col cols="12" sm="7" class="d-flex align-center">
        <v-checkbox
          v-model="showAll"
          :label="translate(uiLang, 'systemd.showAll')"
          density="compact"
          hide-details
        />
      </v-col>
    </v-row>

    <LoadingBar :loading="loading" :error="error" />

    <v-card rounded="lg" variant="tonal" flat>
      <v-list-item v-for="u in filtered" :key="u.name" density="compact" class="border-b">
        <template #prepend>
          <v-icon :color="colorFor(u)">
            {{
              u.active === 'active'
                ? 'mdi-play-circle'
                : u.active === 'failed'
                  ? 'mdi-alert-circle'
                  : 'mdi-stop-circle'
            }}
          </v-icon>
        </template>
        <v-list-item-title class="d-flex align-center ga-2">
          <span class="font-family-mono">{{ u.name }}</span>
          <v-chip size="x-small" variant="tonal" :color="colorFor(u)">
            {{ u.active }} / {{ u.sub }}
          </v-chip>
        </v-list-item-title>
        <v-list-item-subtitle class="text-truncate">{{ u.description }}</v-list-item-subtitle>
        <template #append>
          <div class="d-flex ga-2">
            <v-btn
              size="small"
              icon
              variant="tonal"
              :loading="busy === `${u.name}:restart`"
              :disabled="u.active !== 'active'"
              :title="translate(uiLang, 'systemd.restart')"
              @click="act(u, 'restart')"
            >
              <v-icon>mdi-restart</v-icon>
            </v-btn>
            <v-btn
              v-if="u.active === 'active'"
              size="small"
              icon
              color="error"
              variant="tonal"
              :loading="busy === `${u.name}:stop`"
              :title="translate(uiLang, 'systemd.stop')"
              @click="act(u, 'stop')"
            >
              <v-icon>mdi-stop</v-icon>
            </v-btn>
            <v-btn
              v-else
              size="small"
              icon
              color="success"
              variant="tonal"
              :loading="busy === `${u.name}:start`"
              :title="translate(uiLang, 'systemd.start')"
              @click="act(u, 'start')"
            >
              <v-icon>mdi-play</v-icon>
            </v-btn>
          </div>
        </template>
      </v-list-item>
    </v-card>

    <v-empty-state
      v-if="!loading && filtered.length === 0"
      icon="mdi-server-off"
      :title="translate(uiLang, 'systemd.empty')"
      class="mt-6"
    />
  </div>
</template>
