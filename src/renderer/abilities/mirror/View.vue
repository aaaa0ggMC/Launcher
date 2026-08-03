<script setup lang="ts">
import { ref, shallowRef, onMounted } from 'vue'
import type { MirrorInfo } from '@shared/types'

const info = shallowRef<MirrorInfo | null>(null)
const busy = ref<string | null>(null)
const error = ref('')
const confirmOpen = ref(false)
const pendingMirror = ref<{ name: string; url: string } | null>(null)

async function load(): Promise<void> {
  info.value = await window.cockpit.getMirror()
  error.value = info.value?.lastError ?? ''
}

function serverLine(url: string): string {
  return `Server = ${url}`
}

function requestSwitch(m: { name: string; url: string }): void {
  pendingMirror.value = m
  confirmOpen.value = true
}

async function doSwitch(): Promise<void> {
  const m = pendingMirror.value
  if (!m) return
  confirmOpen.value = false
  busy.value = m.name
  try {
    const res = await window.cockpit.switchMirror(serverLine(m.url))
    info.value = res
    error.value = res.lastError ?? ''
  } finally {
    busy.value = null
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="text-h6 font-weight-medium mb-1">软件源</div>
    <div class="text-caption on-surface-variant mb-4">切换 Arch Linux 镜像源（pkexec + 自动备份）</div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-3" density="compact">
      {{ error }}
    </v-alert>

    <v-alert
      v-if="info?.current"
      type="info"
      variant="tonal"
      class="mb-3"
      density="compact"
    >
      当前: <code class="text-body-2">{{ info.current }}</code>
    </v-alert>

    <v-row dense>
      <v-col v-for="m in info?.configured ?? []" :key="m.name" cols="12" sm="6" md="4">
        <v-card
          rounded="lg"
          variant="tonal"
          :class="info?.current === m.url ? 'current-mirror' : ''"
        >
          <v-card-text>
            <div class="d-flex align-center ga-2">
              <v-icon
                :color="info?.current === m.url ? 'success' : 'on-surface-variant'"
              >
                {{ info?.current === m.url ? 'mdi-check-circle' : 'mdi-earth' }}
              </v-icon>
              <span class="text-body-1 font-weight-medium">{{ m.name }}</span>
              <v-chip v-if="info?.current === m.url" size="x-small" color="success" variant="tonal">
                使用中
              </v-chip>
            </div>
            <div class="text-caption on-surface-variant mt-2 text-truncate">{{ m.url }}</div>
          </v-card-text>
          <v-card-actions class="px-3 pb-3 pt-0">
            <v-spacer />
            <v-btn
              size="small"
              :color="info?.current === m.url ? 'success' : 'primary'"
              variant="tonal"
              :disabled="info?.current === m.url"
              :loading="busy === m.name"
              @click="requestSwitch(m)"
            >
              {{ info?.current === m.url ? '已启用' : '切换' }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <v-dialog v-model="confirmOpen" width="460">
      <v-card>
        <v-card-title>切换到「{{ pendingMirror?.name }}」？</v-card-title>
        <v-card-text class="text-body-2">
          将写入 <code>/etc/pacman.d/mirrorlist</code>，原文件备份为
          <code>mirrorlist.cockpit.bak</code>。需要输入管理员密码。
        </v-card-text>
        <v-card-actions class="pa-4 pt-0">
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">取消</v-btn>
          <v-btn color="primary" @click="doSwitch">确认切换</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.current-mirror {
  border: 1px solid rgb(var(--v-theme-success));
}
</style>
