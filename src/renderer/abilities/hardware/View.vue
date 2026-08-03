<script setup lang="ts">
import { ref, shallowRef, computed, onMounted } from 'vue'
import type { GpuInfo, SystemStats } from '@shared/types'

const gpus = shallowRef<GpuInfo[]>([])
const stats = shallowRef<SystemStats | null>(null)
const pm = ref<0 | 1 | null>(null)
const pmBusy = ref(false)
const pmConfirm = ref(false)
const error = ref('')

async function load(): Promise<void> {
  const [g, s, p] = await Promise.all([
    window.cockpit.gpu(),
    window.cockpit.stats().catch(() => null),
    window.cockpit.readPm()
  ])
  gpus.value = g
  stats.value = s
  pm.value = p
}

async function doTogglePm(): Promise<void> {
  pmConfirm.value = false
  pmBusy.value = true
  try {
    const v = await window.cockpit.togglePm()
    if (v !== null) pm.value = v
    else error.value = '切换失败'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pmBusy.value = false
  }
}

const disks = computed(() => stats.value?.disk ?? [])

onMounted(load)
</script>

<template>
  <div>
    <div class="text-h6 font-weight-medium mb-1">硬件信息</div>
    <div class="text-caption on-surface-variant mb-4">GPU / 磁盘 / 电源管理</div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-3" density="compact">{{ error }}</v-alert>

    <v-row dense>
      <v-col v-for="g in gpus" :key="g.name" cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="d-flex align-center ga-2 text-subtitle-2">
            <v-icon color="primary">mdi-video-card</v-icon>
            {{ g.name }}
          </v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item title="驱动版本" :subtitle="g.driver" />
              <v-list-item title="显存" :subtitle="g.vram" />
              <v-list-item title="利用率" :subtitle="g.usage" />
              <v-list-item title="温度" :subtitle="g.temp" />
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col v-if="gpus.length === 0" cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-text class="text-caption on-surface-variant">未检测到 NVIDIA GPU (nvidia-smi 不可用)</v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-title class="d-flex align-center ga-2 text-subtitle-2">
            <v-icon color="primary">mdi-power-plug</v-icon>
            NVIDIA 电源管理
          </v-card-title>
          <v-card-text>
            <div class="d-flex align-center justify-space-between">
              <div>
                <div class="text-body-2">NVreg_PreserveVideoMemoryAllocations</div>
                <div class="text-caption on-surface-variant">
                  当前: <code>{{ pm ?? '—' }}</code> · 修改后需重启生效
                </div>
              </div>
              <v-btn
                :color="pm === 1 ? 'success' : ''"
                variant="tonal"
                :loading="pmBusy"
                @click="pmConfirm = true"
              >
                {{ pm === 1 ? '已启用 (1)' : '已禁用 (0)' }}
              </v-btn>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <div class="text-subtitle-2 mt-4 mb-2">磁盘</div>
    <v-row dense>
      <v-col v-for="d in disks" :key="d.path" cols="12" md="6">
        <v-card rounded="lg" variant="tonal">
          <v-card-text>
            <div class="d-flex justify-space-between text-caption">
              <span>{{ d.path }}</span>
              <span class="on-surface-variant">{{ d.percent }}%</span>
            </div>
            <v-progress-linear
              :model-value="d.percent"
              :color="d.percent > 85 ? 'error' : d.percent > 70 ? 'warning' : 'primary'"
              height="8"
              rounded
              class="mt-2"
            />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-dialog v-model="pmConfirm" width="440">
      <v-card>
        <v-card-title>切换 NVIDIA 电源管理？</v-card-title>
        <v-card-text class="text-body-2">
          将修改 <code>/etc/modprobe.d/nvidia-pm-override.conf</code>（自动备份），
          需要管理员密码，且需重启才能生效。
        </v-card-text>
        <v-card-actions class="pa-4 pt-0">
          <v-spacer />
          <v-btn variant="text" @click="pmConfirm = false">取消</v-btn>
          <v-btn color="primary" @click="doTogglePm">确认</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
