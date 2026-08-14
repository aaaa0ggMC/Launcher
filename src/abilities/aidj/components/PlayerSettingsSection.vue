<script setup lang="ts">
import { ref, watch, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'

defineOptions({ name: 'cockpit-aidj-player-settings' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// -- player preferences (lives under `preferences.*` in the aidj config file) --
const crossfadeEnabled = ref(false)
const crossfadeSeconds = ref(2.5)
const eqPreset = ref('flat')
const playbackRate = ref(1.0)
const defaultVolume = ref(80)
const spectrumEnabled = ref(false)
const webRemotePort = ref(17320)

const eqItems = ['flat', 'pop', 'rock', 'classical', 'vocal'].map((p) => ({
  title: t(`aidj.player.eq_${p}`, p),
  value: p
}))
const rateItems = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((r) => ({
  title: `${r}x`,
  value: r
}))

let loaded = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  const r = (await window.cockpit.command('aidj.get-config').catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (r?.ok && r.config) {
    const prefs = (r.config as Record<string, unknown>).preferences as Record<string, unknown>
    const cf = (prefs.crossfade as { enabled?: boolean; seconds?: number } | undefined) ?? {}
    crossfadeEnabled.value = cf.enabled ?? false
    crossfadeSeconds.value = cf.seconds ?? 2.5
    eqPreset.value = (prefs.eq_preset as string) || 'flat'
    playbackRate.value = (prefs.playback_rate as number) ?? 1.0
    defaultVolume.value = Math.round(((prefs.default_volume as number) ?? 0.8) * 100)
    spectrumEnabled.value = (prefs.spectrum_enabled as boolean) ?? false
    webRemotePort.value = (prefs.web_remote_port as number) ?? 17320
  }
  loaded = true
})

/** Persist a preference then push it live into the running engine (best-effort). */
function apply(path: string, value: unknown, live?: () => Promise<unknown>): void {
  if (!loaded) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      await window.cockpit.command('aidj.update-config', { path, value })
      await window.cockpit.command('aidj.save-config')
    } catch {
      /* keep last saved state */
    }
    if (live) await live().catch(() => {})
  }, 300)
}

watch(crossfadeEnabled, (v) =>
  apply('preferences.crossfade', { enabled: v, seconds: crossfadeSeconds.value }, () =>
    window.cockpit.command('aidj.player-crossfade', { enabled: v })
  )
)
watch(crossfadeSeconds, (v) =>
  apply('preferences.crossfade', { enabled: crossfadeEnabled.value, seconds: v }, () =>
    window.cockpit.command('aidj.player-crossfade', { enabled: crossfadeEnabled.value, seconds: v })
  )
)
watch(eqPreset, (v) =>
  apply('preferences.eq_preset', v, () => window.cockpit.command('aidj.player-eq', { preset: v }))
)
watch(playbackRate, (v) =>
  apply('preferences.playback_rate', v, () =>
    window.cockpit.command('aidj.player-rate', { set: v })
  )
)
watch(defaultVolume, (v) => {
  const vol = Math.max(0, Math.min(100, v)) / 100
  apply('preferences.default_volume', vol, () =>
    window.cockpit.command('aidj.volume', { set: vol })
  )
})
watch(spectrumEnabled, (v) => apply('preferences.spectrum_enabled', v))
watch(webRemotePort, (v) => {
  const n = Math.floor(Number(v))
  if (Number.isFinite(n) && n >= 0 && n <= 65535) apply('preferences.web_remote_port', n)
})

function resetAll(): void {
  crossfadeEnabled.value = false
  crossfadeSeconds.value = 2.5
  eqPreset.value = 'flat'
  playbackRate.value = 1.0
  defaultVolume.value = 80
  spectrumEnabled.value = false
  webRemotePort.value = 17320
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="d-flex align-center ga-2">
      <v-icon start>mdi-play-speed</v-icon>
      {{ t('aidj.player_settings.title', '内置播放器') }}
      <v-spacer />
      <v-btn variant="text" color="primary" prepend-icon="mdi-backup-restore" @click="resetAll">
        {{ t('aidj.player_settings.reset', '恢复默认') }}
      </v-btn>
    </v-card-title>

    <v-divider />

    <v-card-text class="d-flex flex-column ga-4 py-4">
      <div>
        <div class="text-subtitle-2 mb-2">
          {{ t('aidj.player_settings.transitions', '曲间过渡') }}
        </div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-switch
              v-model="crossfadeEnabled"
              color="primary"
              :label="t('aidj.player_settings.crossfade', '淡入淡出')"
              :hint="t('aidj.player_settings.crossfade_hint', '切歌时淡出再淡入，情绪变化时更长')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-slider
              v-model="crossfadeSeconds"
              :label="t('aidj.player_settings.crossfade_seconds', '淡入淡出时长')"
              :min="0.5"
              :max="8"
              :step="0.5"
              :disabled="!crossfadeEnabled"
              thumb-label
              hide-details
              class="mt-1"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.player_settings.audio', '音频处理') }}</div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-select
              v-model="eqPreset"
              :items="eqItems"
              :label="t('aidj.player_settings.eq', '均衡器预设')"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-select
              v-model="playbackRate"
              :items="rateItems"
              :label="t('aidj.player_settings.rate', '默认倍速')"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-slider
              v-model="defaultVolume"
              :label="t('aidj.player_settings.default_volume', '默认音量')"
              :min="0"
              :max="100"
              :step="5"
              thumb-label
              hide-details
              class="mt-1"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">
          {{ t('aidj.player_settings.display', '显示与遥控') }}
        </div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-switch
              v-model="spectrumEnabled"
              color="primary"
              :label="t('aidj.player_settings.spectrum', '频谱条默认显示')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="webRemotePort"
              :label="t('aidj.player_settings.web_remote_port', '局域网遥控端口')"
              type="number"
              min="0"
              max="65535"
              :hint="t('aidj.player_settings.web_remote_port_hint', '0 = 禁用')"
              persistent-hint
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
