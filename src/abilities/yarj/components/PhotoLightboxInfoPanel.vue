<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj-photo-lightbox-info-panel' })

import { ref, computed, watch, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import type { Photo, ReverseGeocodeResult, GuessedGps } from '../types'
import { isVideoFile } from '../types'
import JsonTreeView from './JsonTreeView.vue'

const props = defineProps<{
  photo: Photo | null
  guessedGpsMap?: Map<string, GuessedGps>
}>()

const emit = defineEmits<{
  (e: 'updated'): void
  (e: 'locate', coords: [number, number]): void
  (e: 'pick-gps', photo: Photo): void
  (e: 'solidify-gps', payload: { photo: Photo; guess: GuessedGps }): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const isEditing = ref(false)
const saving = ref(false)
const geocoding = ref(false)
const geocodeResult = ref<ReverseGeocodeResult | null>(null)
const showJsonMetadata = ref(false)
const solidifying = ref(false)

// 内联编辑表单
const editTags = ref('')
const editComment = ref('')
const editLat = ref('')
const editLon = ref('')

const currentGuessedGps = computed<GuessedGps | null>(() => {
  if (!props.photo) return null
  if (props.photo.gps_lat != null && props.photo.gps_lon != null) return null
  return props.guessedGpsMap?.get(props.photo.path) ?? null
})

watch(
  () => props.photo,
  (p) => {
    isEditing.value = false
    geocodeResult.value = null
    if (!p) return
    editTags.value = Array.isArray(p.appendix?.tags) ? p.appendix.tags.join(', ') : ''
    editComment.value = typeof p.appendix?.comment === 'string' ? p.appendix.comment : ''
    editLat.value = p.gps_lat != null ? String(p.gps_lat) : ''
    editLon.value = p.gps_lon != null ? String(p.gps_lon) : ''

    if (typeof p.appendix?.formatted_address === 'string') {
      geocodeResult.value = {
        formattedAddress: p.appendix.formatted_address,
        city: typeof p.appendix.city === 'string' ? p.appendix.city : undefined,
        country: typeof p.appendix.country === 'string' ? p.appendix.country : undefined,
        provider: 'cache'
      }
    }
  },
  { immediate: true }
)

async function solidifyCurrentGps(): Promise<void> {
  const p = props.photo
  const guess = currentGuessedGps.value
  if (!p || !guess || solidifying.value) return
  solidifying.value = true
  try {
    const res = (await window.cockpit.command('yarj.update-photo', {
      path: p.path,
      lat: guess.lat,
      lon: guess.lon,
      patch: { gps_source: 'solidified_guess' }
    })) as { ok: boolean; photo?: Photo }
    if (res?.ok) {
      p.gps_lat = guess.lat
      p.gps_lon = guess.lon
      p.appendix = {
        ...p.appendix,
        gps_source: 'solidified_guess'
      }
      emit('solidify-gps', { photo: p, guess })
      emit('updated')
    }
  } catch (err) {
    console.error('Failed to solidify GPS:', err)
  } finally {
    solidifying.value = false
  }
}

function handleLocateCurrentPhoto(): void {
  if (props.photo?.gps_lon != null && props.photo?.gps_lat != null) {
    emit('locate', [props.photo.gps_lon, props.photo.gps_lat])
  }
}

async function requestReverseGeocode(): Promise<void> {
  const p = props.photo
  if (!p || p.gps_lat == null || p.gps_lon == null || geocoding.value) return
  geocoding.value = true
  try {
    const res = (await window.cockpit.command('yarj.reverse-geocode', {
      lat: p.gps_lat,
      lon: p.gps_lon,
      lang: uiLang.value
    })) as { ok?: boolean; result?: ReverseGeocodeResult } | null

    if (res?.ok && res.result) {
      geocodeResult.value = res.result
      await window.cockpit.command('yarj.update-photo', {
        path: p.path,
        patch: {
          formatted_address: res.result.formattedAddress,
          city: res.result.city,
          country: res.result.country
        }
      })
      p.appendix = {
        ...p.appendix,
        formatted_address: res.result.formattedAddress,
        city: res.result.city,
        country: res.result.country
      }
      emit('updated')
    }
  } catch (err) {
    console.error('Reverse geocode failed:', err)
  } finally {
    geocoding.value = false
  }
}

function addAddressToTags(): void {
  const p = props.photo
  const addr = geocodeResult.value
  if (!p || !addr) return
  const current = Array.isArray(p.appendix?.tags) ? [...p.appendix.tags] : []
  const candidates = [addr.city, addr.country].filter(Boolean) as string[]
  let changed = false
  for (const c of candidates) {
    if (!current.includes(c)) {
      current.push(c)
      changed = true
    }
  }
  if (changed) {
    editTags.value = current.join(', ')
    void saveLightboxEdit()
  }
}

async function saveLightboxEdit(): Promise<void> {
  const p = props.photo
  if (!p || saving.value) return
  saving.value = true
  try {
    const rawTags = editTags.value
      .split(/[,，、 ]+/)
      .map((x) => x.trim())
      .filter(Boolean)
    const patch: Record<string, unknown> = {
      tags: rawTags,
      comment: editComment.value.trim()
    }
    const newLat = editLat.value.trim() ? parseFloat(editLat.value.trim()) : null
    const newLon = editLon.value.trim() ? parseFloat(editLon.value.trim()) : null

    await window.cockpit.command('yarj.update-photo', {
      path: p.path,
      patch,
      lat: Number.isNaN(newLat) ? undefined : newLat,
      lon: Number.isNaN(newLon) ? undefined : newLon
    })

    p.appendix = {
      ...p.appendix,
      tags: rawTags,
      comment: editComment.value.trim()
    }
    if (!Number.isNaN(newLat)) p.gps_lat = newLat
    if (!Number.isNaN(newLon)) p.gps_lon = newLon

    isEditing.value = false
    emit('updated')
  } catch (err) {
    console.error('Failed to save edit:', err)
  } finally {
    saving.value = false
  }
}

async function onSaveJsonTree(updatedObj: unknown): Promise<void> {
  const p = props.photo
  if (!p || !updatedObj || typeof updatedObj !== 'object') return
  const data = updatedObj as Record<string, unknown>
  const patch = (
    data.appendix && typeof data.appendix === 'object' ? data.appendix : data
  ) as Record<string, unknown>
  saving.value = true
  try {
    const res = (await window.cockpit.command('yarj.update-photo', {
      path: p.path,
      patch
    })) as { ok: boolean; photo?: Photo }
    if (res?.ok && res.photo) {
      p.appendix = { ...res.photo.appendix }
      emit('updated')
    }
  } catch (err) {
    console.error('Failed to save appendix JSON:', err)
  } finally {
    saving.value = false
  }
}

async function openExternalVideo(filePath: string): Promise<void> {
  try {
    await window.cockpit.command('yarj.open-path', { path: filePath })
  } catch {
    /* ignore */
  }
}

async function openInFolder(filePath: string): Promise<void> {
  try {
    await window.cockpit.command('yarj.show-item-in-folder', { path: filePath })
  } catch {
    /* ignore */
  }
}

function formatCoords(lat: number | null, lon: number | null): string {
  if (lat == null || lon == null) return t('yarj.lightbox.noGps', '无 GPS 定位')
  const latStr = `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}`
  const lonStr = `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`
  return `${latStr}, ${lonStr}`
}

function formatDate(iso: string | null): string {
  if (!iso) return t('yarj.popup.unknownTime', '未知时间')
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(uiLang.value === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return iso
  }
}

function formatExposure(s?: string | null): string {
  if (!s) return '—'
  return s.includes('/') ? `${s}s` : `${s}s`
}

defineExpose({
  isEditing
})
</script>

<template>
  <div v-if="photo" class="lightbox-info-drawer">
    <div class="drawer-header d-flex align-center justify-space-between px-4 py-3">
      <span class="text-subtitle-1 font-weight-bold">{{
        t('yarj.lightbox.details', '照片详细信息')
      }}</span>
      <v-btn
        v-if="!isEditing"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-pencil"
        @click="isEditing = true"
      >
        {{ t('yarj.lightbox.editGpsTags', '编辑坐标/备注') }}
      </v-btn>
    </div>

    <v-divider />

    <div class="drawer-scroll px-4 py-4 d-flex flex-column ga-4">
      <!-- 媒体类型 -->
      <div class="info-group">
        <div class="text-caption font-weight-bold on-surface-variant mb-1">
          {{ t('yarj.lightbox.mediaType', '媒体类型') }}
        </div>
        <div class="d-flex align-center ga-2 text-body-2 font-weight-medium">
          <v-icon size="18" :color="isVideoFile(photo.path) ? 'primary' : 'secondary'">
            {{ isVideoFile(photo.path) ? 'mdi-video' : 'mdi-image' }}
          </v-icon>
          <span>{{
            isVideoFile(photo.path)
              ? t('yarj.lightbox.video', '视频短片')
              : t('yarj.lightbox.image', '照片图片')
          }}</span>
          <span
            v-if="photo.width && photo.height"
            class="text-caption on-surface-variant ml-1 font-mono"
          >
            · {{ photo.width }} × {{ photo.height }}
          </span>
        </div>
      </div>

      <!-- 拍摄设备与基本信息 -->
      <div class="info-group">
        <div class="text-caption font-weight-bold on-surface-variant mb-1">
          {{ t('yarj.lightbox.cameraInfo', '拍摄设备') }}
        </div>
        <div class="text-body-1 font-weight-medium">
          {{ [photo.camera_make, photo.camera_model].filter(Boolean).join(' ') || '—' }}
        </div>
        <div v-if="photo.lens_model" class="text-caption on-surface-variant mt-1">
          {{ photo.lens_model }}
        </div>
      </div>

      <!-- 拍摄参数 -->
      <div class="info-group">
        <div class="text-caption font-weight-bold on-surface-variant mb-2">
          {{ t('yarj.lightbox.params', '拍摄参数') }}
        </div>
        <div class="d-flex flex-wrap ga-2 text-caption">
          <v-chip variant="tonal" class="param-chip">
            {{ formatDate(photo.taken_at) }}
          </v-chip>
          <v-chip v-if="photo.exposure_time" variant="tonal" class="param-chip">
            {{ formatExposure(photo.exposure_time) }}
          </v-chip>
          <v-chip v-if="photo.f_number" variant="tonal" class="param-chip">
            f/{{ photo.f_number }}
          </v-chip>
          <v-chip v-if="photo.iso" variant="tonal" class="param-chip"> ISO {{ photo.iso }} </v-chip>
          <v-chip v-if="photo.focal_length" variant="tonal" class="param-chip">
            {{ photo.focal_length }}mm
          </v-chip>
        </div>
      </div>

      <!-- 地理位置 & 智能逆地理编码 -->
      <div class="info-group">
        <div class="d-flex align-center justify-space-between mb-2">
          <span class="text-caption font-weight-bold on-surface-variant">
            {{ t('yarj.lightbox.gpsLocation', '地理位置') }}
          </span>
          <v-btn
            v-if="photo.gps_lat != null && photo.gps_lon != null"
            variant="text"
            color="primary"
            prepend-icon="mdi-map-marker-radius"
            :loading="geocoding"
            @click="requestReverseGeocode"
          >
            {{ t('yarj.lightbox.reverseGeocode', '解析详细地址') }}
          </v-btn>
        </div>

        <!-- 智能时空速度纠正展示 -->
        <div v-if="photo.gps_corrected" class="corrected-box pa-3 rounded-lg mb-2">
          <div class="d-flex align-center justify-space-between mb-2">
            <div class="d-flex align-center ga-1">
              <v-icon size="18" color="secondary">mdi-auto-fix</v-icon>
              <span class="text-body-2 font-weight-bold text-secondary">
                {{ t('yarj.correct.badge', 'GPS 已纠正') }}
              </span>
            </div>
            <v-chip
              v-if="photo.gps_corrected.drift_distance_km"
              size="x-small"
              color="secondary"
              variant="tonal"
            >
              偏移 {{ photo.gps_corrected.drift_distance_km }} km ·
              {{ photo.gps_corrected.speed_kmh }} km/h
            </v-chip>
          </div>

          <div class="text-caption on-surface-variant mb-2">
            {{ photo.gps_corrected.reason }}
          </div>

          <div class="text-body-1 font-weight-medium mb-3">
            {{ formatCoords(photo.gps_corrected.lat, photo.gps_corrected.lon) }}
          </div>

          <div class="d-flex ga-2 flex-wrap">
            <v-btn
              color="secondary"
              variant="flat"
              prepend-icon="mdi-crosshairs-gps"
              @click="emit('locate', [photo.gps_corrected!.lon, photo.gps_corrected!.lat])"
            >
              {{ t('yarj.guess.locateGuess', '定位到此点') }}
            </v-btn>
          </div>
        </div>

        <div
          v-if="currentGuessedGps && !photo.gps_corrected"
          class="guess-box pa-3 rounded-lg mb-2"
        >
          <div class="d-flex align-center justify-space-between mb-2">
            <div class="d-flex align-center ga-1">
              <v-icon size="18" color="warning">mdi-map-marker-question-outline</v-icon>
              <span class="text-body-2 font-weight-bold text-warning">
                {{ t('yarj.guess.badge', '大致 GPS 猜测') }}
              </span>
            </div>
            <v-chip size="x-small" color="warning" variant="tonal">
              {{ (currentGuessedGps.distanceM / 1000).toFixed(1) }} km ·
              {{
                currentGuessedGps.timeDiffSeconds >= 3600
                  ? `${(currentGuessedGps.timeDiffSeconds / 3600).toFixed(1)} h`
                  : `${Math.round(currentGuessedGps.timeDiffSeconds / 60)} min`
              }}
            </v-chip>
          </div>

          <div class="text-caption on-surface-variant mb-2">
            {{
              t(
                'yarj.guess.desc',
                '该照片未记录原生 GPS，根据拍摄时间处于两张照片之间，自动计算中点推算得出（间距约 {dist}，拍摄时差约 {time}）。'
              )
                .replace(
                  '{dist}',
                  currentGuessedGps.distanceM >= 1000
                    ? `${(currentGuessedGps.distanceM / 1000).toFixed(1)}km`
                    : `${currentGuessedGps.distanceM}m`
                )
                .replace(
                  '{time}',
                  currentGuessedGps.timeDiffSeconds >= 3600
                    ? `${(currentGuessedGps.timeDiffSeconds / 3600).toFixed(1)}h`
                    : `${Math.round(currentGuessedGps.timeDiffSeconds / 60)}min`
                )
            }}
          </div>

          <div class="text-body-1 font-weight-medium mb-3">
            {{ formatCoords(currentGuessedGps.lat, currentGuessedGps.lon) }}
          </div>

          <div class="d-flex ga-2 flex-wrap">
            <v-btn
              color="warning"
              variant="flat"
              prepend-icon="mdi-check-decagram"
              :loading="solidifying"
              @click="solidifyCurrentGps"
            >
              {{ t('yarj.guess.solidify', '固化此位置') }}
            </v-btn>
            <v-btn
              variant="outlined"
              prepend-icon="mdi-map-marker-plus-outline"
              @click="emit('pick-gps', photo)"
            >
              {{ t('yarj.guess.pickCorrect', '选择正确地址') }}
            </v-btn>
            <v-btn
              variant="text"
              prepend-icon="mdi-crosshairs-gps"
              @click="emit('locate', [currentGuessedGps.lon, currentGuessedGps.lat])"
            >
              {{ t('yarj.guess.locate', '定位猜测点') }}
            </v-btn>
          </div>
        </div>

        <div v-else class="text-body-1 font-weight-medium mb-1">
          {{ formatCoords(photo.gps_lat, photo.gps_lon) }}
          <span v-if="photo.gps_alt != null" class="text-caption on-surface-variant ml-1">
            (海拔 {{ Math.round(photo.gps_alt) }}m)
          </span>
        </div>

        <!-- 智能解析出的中文/英文地名地址 -->
        <div v-if="geocodeResult?.formattedAddress" class="address-box pa-3 rounded-lg mb-2">
          <div class="d-flex align-start ga-2">
            <v-icon size="18" color="primary" class="mt-1 flex-shrink-0">mdi-map-marker</v-icon>
            <div class="flex-grow-1 min-w-0">
              <div class="text-body-2 font-weight-medium">
                {{ geocodeResult.formattedAddress }}
              </div>
              <div
                v-if="geocodeResult.city || geocodeResult.country"
                class="text-caption on-surface-variant mt-1"
              >
                {{ [geocodeResult.country, geocodeResult.city].filter(Boolean).join(' · ') }}
              </div>
            </div>
          </div>
          <div class="d-flex justify-end mt-2">
            <v-btn
              variant="text"
              color="primary"
              prepend-icon="mdi-tag-plus"
              @click="addAddressToTags"
            >
              {{ t('yarj.lightbox.applyAddressToTags', '加为地名标签') }}
            </v-btn>
          </div>
        </div>

        <div class="d-flex flex-column ga-2 mt-2">
          <v-btn
            v-if="photo.gps_lon != null && photo.gps_lat != null"
            variant="outlined"
            block
            prepend-icon="mdi-crosshairs-gps"
            @click="handleLocateCurrentPhoto"
          >
            {{ t('yarj.drawer.locate', '定位到地图中心') }}
          </v-btn>
          <v-btn
            v-if="!currentGuessedGps"
            variant="outlined"
            block
            prepend-icon="mdi-map-marker-plus-outline"
            @click="emit('pick-gps', photo)"
          >
            {{ t('yarj.drawer.changeGps', '在地图上点击拾取/更改坐标') }}
          </v-btn>
        </div>
      </div>

      <!-- 标签与备注编辑区域 -->
      <div class="info-group">
        <div class="text-caption font-weight-bold on-surface-variant mb-2">
          {{ t('yarj.lightbox.tagsAndNotes', '标签与备注') }}
        </div>

        <!-- 查看态 -->
        <div v-if="!isEditing">
          <div v-if="photo.appendix?.comment" class="photo-comment text-body-2 mb-3">
            <v-icon size="16" class="mr-1 text-primary">mdi-comment-text-outline</v-icon>
            <span>{{ photo.appendix.comment }}</span>
          </div>

          <div class="d-flex flex-wrap align-center ga-2">
            <v-chip
              v-for="tag in Array.isArray(photo.appendix?.tags) ? photo.appendix.tags : []"
              :key="String(tag)"
              variant="tonal"
              color="primary"
              class="param-chip"
            >
              {{ tag }}
            </v-chip>
            <span
              v-if="!Array.isArray(photo.appendix?.tags) || !photo.appendix.tags.length"
              class="text-caption on-surface-variant"
            >
              {{ t('yarj.popup.noTags', '暂无标签') }}
            </span>
          </div>
        </div>

        <!-- 编辑态 -->
        <div v-else class="d-flex flex-column ga-3">
          <v-text-field
            v-model="editLat"
            :label="t('yarj.lightbox.latLabel', '纬度 (Latitude, 如 35.6895)')"
            density="compact"
            variant="outlined"
            hide-details
          />
          <v-text-field
            v-model="editLon"
            :label="t('yarj.lightbox.lonLabel', '经度 (Longitude, 如 139.6917)')"
            density="compact"
            variant="outlined"
            hide-details
          />
          <v-text-field
            v-model="editTags"
            :label="t('yarj.drawer.tagsLabel', '标签（逗号或空格分隔）')"
            density="compact"
            variant="outlined"
            hide-details
          />
          <v-textarea
            v-model="editComment"
            :label="t('yarj.drawer.commentLabel', '备注 / 旅途记录')"
            density="compact"
            variant="outlined"
            rows="2"
            hide-details
            no-resize
          />
          <div class="d-flex align-center justify-end ga-2 pt-2">
            <v-btn variant="text" @click="isEditing = false">
              {{ t('yarj.drawer.cancel', '取消') }}
            </v-btn>
            <v-btn color="primary" variant="flat" :loading="saving" @click="saveLightboxEdit">
              {{ t('yarj.drawer.save', '保存修改') }}
            </v-btn>
          </div>
        </div>
      </div>

      <!-- 完整元数据 (JSON 树) -->
      <div class="info-group">
        <div
          class="d-flex align-center justify-space-between cursor-pointer py-1"
          @click="showJsonMetadata = !showJsonMetadata"
        >
          <div class="d-flex align-center ga-2">
            <v-icon size="18" color="primary">mdi-code-json</v-icon>
            <span class="text-caption font-weight-bold on-surface-variant">
              {{ t('yarj.lightbox.metadataTree', '完整数据库元数据 (JSON)') }}
            </span>
          </div>
          <v-btn
            size="small"
            variant="text"
            :icon="showJsonMetadata ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          />
        </div>

        <v-expand-transition>
          <div v-if="showJsonMetadata" class="pt-2">
            <JsonTreeView
              :data="photo"
              root-name="photo"
              :editable="isEditing"
              @save="onSaveJsonTree"
            />
          </div>
        </v-expand-transition>
      </div>

      <!-- 外部应用打开与定位操作 -->
      <div class="info-group d-flex flex-column ga-2 mt-2">
        <v-btn
          v-if="isVideoFile(photo.path)"
          variant="outlined"
          color="primary"
          block
          prepend-icon="mdi-play-circle"
          @click="openExternalVideo(photo.path)"
        >
          {{ t('yarj.lightbox.openExternalPlayer', '在系统播放器中打开') }}
        </v-btn>
        <v-btn
          variant="outlined"
          block
          prepend-icon="mdi-folder-open-outline"
          @click="openInFolder(photo.path)"
        >
          {{ t('yarj.lightbox.showInFolder', '在文件夹中打开') }}
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lightbox-info-drawer {
  flex-shrink: 0;
  width: 420px;
  height: 100%;
  background: rgba(var(--v-theme-surface), 0.92);
  backdrop-filter: blur(28px) saturate(1.2);
  -webkit-backdrop-filter: blur(28px) saturate(1.2);
  border-left: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  display: flex;
  flex-direction: column;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
  z-index: 20;
}

.drawer-header {
  flex-shrink: 0;
}

.drawer-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.drawer-scroll::-webkit-scrollbar {
  width: 6px;
}

.drawer-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.4);
  border-radius: 3px;
}

.param-chip {
  min-height: 24px !important;
  padding-block: 4px !important;
}

.address-box {
  background: rgba(var(--v-theme-primary), 0.08);
  border: 1px solid rgba(var(--v-theme-primary), 0.2);
}

.corrected-box {
  background: rgba(var(--v-theme-secondary), 0.08);
  border: 1px solid rgba(var(--v-theme-secondary), 0.35);
}

.guess-box {
  background: rgba(var(--v-theme-warning), 0.08);
  border: 1px solid rgba(var(--v-theme-warning), 0.35);
}

.photo-comment {
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface), 0.5);
  border-left: 3px solid rgb(var(--v-theme-primary));
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
