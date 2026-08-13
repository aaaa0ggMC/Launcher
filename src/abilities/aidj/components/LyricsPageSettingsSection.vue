<script setup lang="ts">
import { ref, watch, onMounted, inject } from 'vue'
import type { Ref } from 'vue'
import { DEFAULT_LYRICS_PAGE_CFG } from '../types'
import type { AidjLyricsPageConfig } from '../types'
import { translate } from '../../../main/ui/i18n'

defineOptions({ name: 'cockpit-aidj-lyrics-settings' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const cfg = ref<AidjLyricsPageConfig>({ ...DEFAULT_LYRICS_PAGE_CFG })
const saving = ref(false)
let loaded = false

onMounted(async () => {
  const r = (await window.cockpit.command('aidj.lyrics-page-config').catch(() => null)) as {
    ok?: boolean
    config?: Partial<AidjLyricsPageConfig>
  } | null
  if (r?.ok && r.config) cfg.value = { ...DEFAULT_LYRICS_PAGE_CFG, ...r.config }
  loaded = true
})

let saveTimer: ReturnType<typeof setTimeout> | null = null
watch(
  cfg,
  (v) => {
    if (!loaded) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      saving.value = true
      try {
        // structured clone: strip Vue reactivity before crossing IPC
        await window.cockpit.command('aidj.lyrics-page-save', {
          config: JSON.parse(JSON.stringify(v))
        })
      } catch {
        /* keep last saved state */
      } finally {
        saving.value = false
      }
    }, 300)
  },
  { deep: true }
)

function resetAll(): void {
  cfg.value = { ...DEFAULT_LYRICS_PAGE_CFG }
}
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title class="d-flex align-center ga-2">
      <v-icon start>mdi-music-note-outline</v-icon>
      AIDJ Lyrics
      <v-spacer />
      <v-btn variant="text" color="primary" prepend-icon="mdi-backup-restore" @click="resetAll">
        {{ t('aidj.lyrics_settings.reset', '恢复默认') }}
      </v-btn>
      <v-chip v-if="saving" size="small" variant="tonal">{{
        t('aidj.lyrics_settings.saving', '保存中…')
      }}</v-chip>
    </v-card-title>

    <v-divider />

    <v-card-text class="d-flex flex-column ga-4 py-4">
      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.lyrics_settings.mode', '显示模式') }}</div>
        <div class="text-caption text-medium-emphasis mb-2">
          {{
            t(
              'aidj.lyrics_settings.mode_hint',
              '颜色始终跟随应用主题，不可单独配置；这里只控制呈现方式与排版'
            )
          }}
        </div>
        <v-row dense>
          <v-col cols="6" md="3">
            <v-switch
              v-model="cfg.scroll_follow"
              color="primary"
              :label="t('aidj.lyrics_settings.scroll_follow', '歌词滚动跟随')"
              :hint="
                t(
                  'aidj.lyrics_settings.scroll_follow_hint',
                  '显示全部歌词并自动把当前行滚到居中；关闭则用固定窗口'
                )
              "
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="cfg.karaoke"
              color="primary"
              :label="t('aidj.lyrics_settings.karaoke', '卡拉OK 逐字高亮')"
              :hint="t('aidj.lyrics_settings.karaoke_hint', '当前行按 LRC 内联时间戳逐字填充高亮')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="cfg.dim_candidates"
              color="primary"
              :label="t('aidj.lyrics_settings.dim_candidates', '淡化非当前行')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="cfg.show_header"
              color="primary"
              :label="t('aidj.lyrics_settings.show_header', '显示头部')"
              :hint="t('aidj.lyrics_settings.show_header_hint', '歌曲信息 / 播放控制 / 进度条')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="cfg.immerse_mode"
              color="primary"
              :label="t('aidj.lyrics_settings.immerse', '沉浸模式')"
              :hint="
                t(
                  'aidj.lyrics_settings.immerse_hint',
                  '有封面时用模糊暗化的封面叠加背景，替代用户设置的背景'
                )
              "
              hide-details
              density="compact"
            />
          </v-col>
        </v-row>
        <v-row dense class="mt-2">
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.lines_before"
              :label="t('aidj.lyrics_settings.lines_before', '当前行上方行数')"
              type="number"
              min="0"
              max="8"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.lines_after"
              :label="t('aidj.lyrics_settings.lines_after', '当前行下方行数')"
              type="number"
              min="0"
              max="8"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.lyrics_settings.typography', '排版') }}</div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="cfg.font_family"
              :label="t('aidj.settings.lyrics_font', '字体')"
              placeholder="Iansui Regular"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.font_size"
              :label="t('aidj.lyrics_settings.font_size', '当前行字号 (px)')"
              type="number"
              min="18"
              max="46"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.candidate_size"
              :label="t('aidj.lyrics_settings.candidate_size', '候选行字号 (px)')"
              type="number"
              min="13"
              max="28"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.current_weight"
              :label="t('aidj.settings.lyrics_weight', '当前行字重')"
              type="number"
              min="500"
              max="900"
              step="100"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.candidate_weight"
              :label="t('aidj.settings.lyrics_candidate_weight', '候选行字重')"
              type="number"
              min="400"
              max="700"
              step="100"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.line_height"
              :label="t('aidj.settings.lyrics_line_height', '行高 (1.0–2.0)')"
              type="number"
              min="1"
              max="2"
              step="0.05"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.line_gap"
              :label="t('aidj.settings.lyrics_line_gap', '行间距 (px)')"
              type="number"
              min="4"
              max="24"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.letter_spacing"
              :label="t('aidj.settings.lyrics_letter_spacing', '字间距 (px)')"
              type="number"
              min="-2"
              max="8"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-text-field
              v-model.number="cfg.position_offset_ms"
              :label="t('aidj.settings.lyrics_offset', '位置偏移 (ms)')"
              type="number"
              min="-1000"
              max="1000"
              step="50"
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
