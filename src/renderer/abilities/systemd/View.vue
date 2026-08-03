<script setup lang="ts">
import { ref, shallowRef, computed, onMounted } from 'vue'
import type { SystemdUnit } from '@shared/types'
import LoadingBar from '../../components/LoadingBar.vue'

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
  const q = filter.value.trim().toLowerCase()
  return units.value.filter((u) => {
    if (!showAll.value && u.active !== 'active') return false
    if (!q) return true
    return u.name.toLowerCase().includes(q) || u.description.toLowerCase().includes(q)
  })
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
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-3">
      <div>
        <div class="text-h6 font-weight-medium">Systemd 服务</div>
        <div class="text-caption on-surface-variant">用户服务 (systemctl --user)</div>
      </div>
      <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" :loading="loading" @click="load">
        刷新
      </v-btn>
    </div>

    <v-row class="mb-2" dense>
      <v-col cols="12" sm="5">
        <v-text-field
          v-model="filter"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索服务"
          density="compact"
          variant="solo-filled"
          hide-details
          clearable
        />
      </v-col>
      <v-col cols="12" sm="7" class="d-flex align-center">
        <v-checkbox v-model="showAll" label="显示全部 (含未激活)" density="compact" hide-details />
      </v-col>
    </v-row>

    <LoadingBar :loading="loading" :error="error" />

    <v-card rounded="lg" variant="tonal" flat>
      <v-list-item
        v-for="u in filtered"
        :key="u.name"
        density="compact"
        class="border-b"
      >
        <template #prepend>
          <v-icon :color="colorFor(u)">
            {{ u.active === 'active' ? 'mdi-play-circle' : u.active === 'failed' ? 'mdi-alert-circle' : 'mdi-stop-circle' }}
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
          <div class="d-flex ga-1">
            <v-btn
              size="small"
              icon="mdi-restart"
              variant="tonal"
              :loading="busy === `${u.name}:restart`"
              :disabled="u.active !== 'active'"
              title="重启"
              @click="act(u, 'restart')"
            />
            <v-btn
              v-if="u.active === 'active'"
              size="small"
              color="error"
              variant="tonal"
              :loading="busy === `${u.name}:stop`"
              title="停止"
              @click="act(u, 'stop')"
            >
              <v-icon>mdi-stop</v-icon>
            </v-btn>
            <v-btn
              v-else
              size="small"
              color="success"
              variant="tonal"
              :loading="busy === `${u.name}:start`"
              title="启动"
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
      title="没有匹配的服务"
      class="mt-6"
    />
  </div>
</template>
