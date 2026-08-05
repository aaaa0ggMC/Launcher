<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'

defineOptions({ name: 'cockpit-aidj-settings' })

const model = ref('')
const metadataModel = ref('')
const baseUrl = ref('')
const apiKey = ref('')
const ncmBaseUrl = ref('')
const dbusTarget = ref('vlc')
const autoPlay = ref(true)
const dynamicBalance = ref(true)
const adjMethod = ref<'lufs' | 'linear'>('lufs')
const volumeCurve = ref(3.0)
const verbose = ref(false)
const recordFreq = ref(true)
const metadataConcurrency = ref(8)
const availableModels = ref<string[]>([])
const modelsLoading = ref(false)
const modelsError = ref(false)
const libraryInjects = ref<Record<string, boolean>>({})
const statusBar = ref<Record<string, number>>({ tokens: 1, tracks: 2, volbal: 3, record_freq: 4 })

onMounted(async () => {
  const r = (await window.cockpit.command('aidj.get-config')) as Record<string, unknown>
  if (!r?.ok || !r.config) return
  const cfg = r.config as Record<string, unknown>
  const prefs = cfg.preferences as Record<string, unknown>
  const ai = cfg.ai_settings as Record<string, unknown>
  const sec = cfg.secrets as Record<string, unknown>
  model.value = (prefs.model as string) || ''
  metadataModel.value = (ai.metadata_model as string) || ''
  baseUrl.value = (ai.base_url as string) || ''
  apiKey.value = (sec.api_key as string) || ''
  ncmBaseUrl.value = (cfg.ncm_base_url as string) || ''
  dbusTarget.value = (prefs.dbus_target as string) || 'vlc'
  autoPlay.value = (prefs.auto_play as boolean) ?? true
  dynamicBalance.value = (prefs.dynamic_balance_volume as boolean) ?? true
  adjMethod.value = (prefs.sound_adjust_method as 'lufs' | 'linear') || 'lufs'
  volumeCurve.value = (prefs.volume_curve as number) ?? 3.0
  verbose.value = (prefs.verbose as boolean) ?? false
  recordFreq.value = (prefs.record_freq as boolean) ?? true
  metadataConcurrency.value = (prefs.metadata_concurrency as number) ?? 8
  libraryInjects.value = { ...((prefs.library_injects as Record<string, boolean>) || {}) }
  statusBar.value = { ...((prefs.status_bar as Record<string, number>) || {}) }
  fetchModels()
})

async function fetchModels(): Promise<void> {
  modelsLoading.value = true
  modelsError.value = false
  try {
    const r = (await window.cockpit.command('aidj.get-models')) as Record<string, unknown>
    if (r?.ok && Array.isArray(r.models)) {
      availableModels.value = r.models as string[]
    } else {
      modelsError.value = true
    }
  } catch {
    modelsError.value = true
  } finally {
    modelsLoading.value = false
  }
}

function update(path: string, value: unknown): void {
  window.cockpit
    .command('aidj.update-config', { path, value })
    .then(() => window.cockpit.command('aidj.save-config'))
    .catch(() => {})
}

watch(model, (v) => update('preferences.model', v))
watch(metadataModel, (v) => update('ai_settings.metadata_model', v))
watch(baseUrl, (v) => update('ai_settings.base_url', v))
watch(apiKey, (v) => update('secrets.api_key', v))
watch(ncmBaseUrl, (v) => update('ncm_base_url', v))
watch(dbusTarget, (v) => update('preferences.dbus_target', v))
watch(autoPlay, (v) => update('preferences.auto_play', v))
watch(dynamicBalance, (v) => update('preferences.dynamic_balance_volume', v))
watch(adjMethod, (v) => update('preferences.sound_adjust_method', v))
watch(volumeCurve, (v) => update('preferences.volume_curve', v))
watch(verbose, (v) => update('preferences.verbose', v))
watch(recordFreq, (v) => update('preferences.record_freq', v))
watch(metadataConcurrency, (v) => update('preferences.metadata_concurrency', v))
watch(libraryInjects, (v) => update('preferences.library_injects', { ...v }), { deep: true })
watch(statusBar, (v) => update('preferences.status_bar', { ...v }), { deep: true })
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title>
      <v-icon start>mdi-radio-tower</v-icon>
      AI DJ
    </v-card-title>

    <v-divider />

    <v-card-text class="d-flex flex-column ga-4 py-4">
      <div>
        <div class="text-subtitle-2 mb-2">API 配置</div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="baseUrl"
              label="API 地址"
              placeholder="http://localhost:1145/v1"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="apiKey"
              label="API 密钥"
              type="password"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">AI 模型</div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-combobox
              v-model="model"
              :items="availableModels"
              :loading="modelsLoading"
              :no-data-text="modelsError ? 'API 未提供模型列表' : '无数据'"
              label="对话模型"
              hide-details
              density="compact"
              variant="outlined"
              clearable
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-combobox
              v-model="metadataModel"
              :items="availableModels"
              :loading="modelsLoading"
              :no-data-text="modelsError ? 'API 未提供模型列表' : '无数据'"
              label="元数据提取模型"
              hide-details
              density="compact"
              variant="outlined"
              clearable
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">音乐库与播放器</div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="ncmBaseUrl"
              label="NCM API 地址"
              placeholder="http://localhost:3000"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="dbusTarget"
              label="DBus 播放器目标"
              placeholder="vlc"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">播放偏好</div>
        <v-row dense>
          <v-col cols="6" md="3">
            <v-switch
              v-model="autoPlay"
              color="primary"
              label="自动播放"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="dynamicBalance"
              color="primary"
              label="动态响度平衡"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="verbose"
              color="primary"
              label="详细日志"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="recordFreq"
              color="primary"
              label="记录播放频率"
              hide-details
              density="compact"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">响度调整</div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-select
              v-model="adjMethod"
              :items="[
                { title: 'LUFS', value: 'lufs' },
                { title: 'RMS (Linear)', value: 'linear' }
              ]"
              label="调整方法"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-slider
              v-model="volumeCurve"
              color="primary"
              label="音量曲线"
              min="1"
              max="5"
              step="0.1"
              hide-details
              density="compact"
              thumb-label
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="metadataConcurrency"
              label="同步并发数"
              type="number"
              min="1"
              max="16"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">元数据字段注入</div>
        <v-row dense>
          <v-col v-for="(_v, k) in libraryInjects" :key="k" cols="6" md="2">
            <v-switch
              v-model="libraryInjects[k]"
              color="primary"
              :label="String(k)"
              hide-details
              density="compact"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">状态栏指示器</div>
        <div class="text-caption text-medium-emphasis mb-2">
          数值为显示顺序，0 = 隐藏；相同数值按字母排序
        </div>
        <v-row dense>
          <v-col v-for="(_v, k) in statusBar" :key="k" cols="6" md="3">
            <v-text-field
              v-model.number="statusBar[k]"
              :label="String(k)"
              type="number"
              min="0"
              step="1"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>
    </v-card-text>
  </v-card>
</template>
