<script setup lang="ts">
import { inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { FtUiState, FtVector } from '../types'
import { translate } from '@ui/i18n'

const state = inject('ft:state') as FtUiState
const apply = inject('ft:applyVectors') as (
  vectors: FtVector[],
  opts?: { runSpeed?: number; verticesLimit?: number }
) => void

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

/**
 * One editable row. |v| is the true 3D magnitude; θ₀ (polar from +Z) and φ₀
 * (azimuth) are the vector's initial position on the sphere — edited as
 * degrees. Together they describe ANY point on the sphere and are always
 * honoured (the direction is rebuilt directly from them).
 */
interface EditableRow {
  len: string
  /** θ₀ polar angle from +Z, degrees (90 = XY plane) */
  theta0: string
  /** φ₀ azimuth in the XY plane, degrees */
  phi0: string
  /** azimuth (Z) period — the classic epicycle period */
  period: string
  /** polar (X) period — second, independent period of the double rotation */
  periodX: string
}

function toDraft(vectors: FtVector[]): EditableRow[] {
  return vectors.map((v) => {
    const z = v.z ?? 0
    const len = Math.hypot(v.x, v.y, z)
    const theta0 = len > 0 ? (Math.acos(clamp01(z / len)) * 180) / Math.PI : 90
    const phi0 = (Math.atan2(v.y, v.x) * 180) / Math.PI
    return {
      len: round(len),
      theta0: round(theta0),
      phi0: round(phi0),
      period: v.secperRound === 0 ? '0' : round(v.secperRound),
      periodX: round(v.secperRoundX ?? 0)
    }
  })
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(-1, n))
}

function round(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

const draft = ref<EditableRow[]>(toDraft(state.vectors))
const loading = ref(false)
const exporting = ref(false)
const error = ref('')

// Keep the editable table in sync when vectors change elsewhere (preset load,
// file load, this panel's own update).
watch(
  () => state.vectors,
  (v) => {
    draft.value = toDraft(v)
  },
  { deep: true }
)

function addRow(): void {
  draft.value.push({ len: '50', theta0: '90', phi0: '0', period: '1', periodX: '0' })
}

function removeRow(i: number): void {
  draft.value.splice(i, 1)
}

function buildVectors(): FtVector[] {
  return draft.value
    .map((r) => {
      const len = Number(r.len)
      const theta = (Number(r.theta0) * Math.PI) / 180
      const phi = (Number(r.phi0) * Math.PI) / 180
      const period = Number(r.period)
      const periodX = Number(r.periodX)
      if (
        !Number.isFinite(len) ||
        !Number.isFinite(theta) ||
        !Number.isFinite(phi) ||
        !Number.isFinite(period) ||
        !Number.isFinite(periodX)
      ) {
        return null
      }
      // direction directly from the two spherical angles — reaches any sphere point
      const x = len * Math.sin(theta) * Math.cos(phi)
      const y = len * Math.sin(theta) * Math.sin(phi)
      const z = len * Math.cos(theta)
      const vec: FtVector = { x, y, secperRound: period }
      // only persist a meaningful z so legacy 2D files stay untouched (θ₀ = 90 → z = 0)
      if (Math.abs(z) > 1e-9) vec.z = z
      // only persist a non-default period so legacy 2D files stay untouched
      if (periodX) vec.secperRoundX = periodX
      return vec
    })
    .filter((v): v is FtVector => v !== null)
}

/** Commit the edited table: clear + redraw, then re-sync the draft. */
function update(): void {
  error.value = ''
  apply(buildVectors())
  draft.value = toDraft(state.vectors)
}

/** Pick a JSON file → load vectors from disk (CLI-first via ft.load-file). */
async function loadFile(): Promise<void> {
  error.value = ''
  const path = await window.cockpit.pickFile({
    title: t('ft.edit.loadFileTitle'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!path) return
  loading.value = true
  try {
    const res = (await window.cockpit.command('ft.load-file', { path })) as {
      ok?: boolean
      vectors?: FtVector[]
      runSpeed?: number
      verticesLimit?: number
      error?: string
    } | null
    if (!res || res.ok === false || !Array.isArray(res.vectors)) {
      throw new Error(`${t('ft.edit.loadFailed')}: ${res?.error ?? ''}`.trim())
    }
    apply(res.vectors, { runSpeed: res.runSpeed, verticesLimit: res.verticesLimit })
    draft.value = toDraft(state.vectors)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

/** Save-as JSON via the main-process dialog, then write through ft.export. */
async function exportVectors(): Promise<void> {
  error.value = ''
  const path = await window.cockpit.pickSaveFile({
    title: t('ft.edit.exportTitle'),
    defaultPath: 'vectors.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!path) return
  exporting.value = true
  try {
    const res = (await window.cockpit.command('ft.export', {
      path,
      data: {
        vectors: buildVectors(),
        runSpeed: state.runSpeed,
        verticesLimit: state.verticesLimit
      }
    })) as { ok?: boolean; error?: string } | null
    if (!res || res.ok === false) {
      throw new Error(`${t('ft.edit.exportFailed')}: ${res?.error ?? ''}`.trim())
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="vec-edit">
    <div class="vec-edit__actions">
      <v-btn variant="tonal" prepend-icon="mdi-check" @click="update">
        {{ t('ft.edit.update') }}
      </v-btn>
      <v-btn variant="tonal" prepend-icon="mdi-file-import" :loading="loading" @click="loadFile">
        {{ t('ft.edit.loadFile') }}
      </v-btn>
    </div>

    <div v-if="error" class="vec-edit__error">{{ error }}</div>

    <div class="vec-table">
      <div class="vec-table__hint">{{ t('ft.edit.axisHint') }}</div>
      <div class="vec-table__scroll">
        <div class="vec-table__head font-family-mono">
          <span>#</span>
          <span>|v|</span>
          <span>T<sub>θ</sub></span>
          <span>T<sub>φ</sub></span>
          <span>θ<sub>0</sub></span>
          <span>φ<sub>0</sub></span>
          <span></span>
        </div>
        <div class="vec-table__body font-family-mono">
          <div v-for="(r, i) in draft" :key="i" class="vec-table__row">
            <span class="on-surface-variant">{{ i }}</span>
            <input v-model="r.len" class="vec-input" inputmode="decimal" spellcheck="false" />
            <input v-model="r.periodX" class="vec-input" inputmode="decimal" spellcheck="false" />
            <input v-model="r.period" class="vec-input" inputmode="decimal" spellcheck="false" />
            <input v-model="r.theta0" class="vec-input" inputmode="decimal" spellcheck="false" />
            <input v-model="r.phi0" class="vec-input" inputmode="decimal" spellcheck="false" />
            <v-btn
              icon
              size="x-small"
              variant="text"
              color="error"
              :title="t('ft.edit.removeRow')"
              @click="removeRow(i)"
            >
              <v-icon size="14">mdi-close</v-icon>
            </v-btn>
          </div>
          <div v-if="draft.length === 0" class="vec-table__empty">
            {{ t('ft.edit.empty') }}
          </div>
        </div>
      </div>
    </div>

    <div class="vec-edit__add">
      <v-btn variant="tonal" prepend-icon="mdi-plus" @click="addRow">
        {{ t('ft.edit.addRow') }}
      </v-btn>
    </div>
    <div class="vec-edit__export">
      <v-btn variant="tonal" prepend-icon="mdi-export" :loading="exporting" @click="exportVectors">
        {{ t('ft.edit.export') }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.vec-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vec-edit__actions {
  display: flex;
  gap: 8px;
}

.vec-edit__error {
  font-size: 0.8rem;
  color: rgb(var(--v-theme-error));
  word-break: break-all;
}

.vec-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.vec-table__hint {
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
  padding: 2px 6px;
}

/* horizontal overflow is intentional: the 7 columns are wider than the panel */
.vec-table__scroll {
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--v-theme-primary), 0.5) transparent;
}

.vec-table__scroll::-webkit-scrollbar {
  height: 8px;
}

.vec-table__scroll::-webkit-scrollbar-track {
  background: transparent;
}

.vec-table__scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-primary), 0.5);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.vec-table__scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--v-theme-primary), 0.7);
  background-clip: padding-box;
}

.vec-table__scroll::-webkit-scrollbar-button {
  display: none;
}

.vec-table__head,
.vec-table__body {
  min-width: 34rem;
}

.vec-table__head,
.vec-table__row {
  display: grid;
  grid-template-columns: 1.6rem 1fr 1fr 1fr 1fr 1fr 1.6rem;
  gap: 6px;
  align-items: center;
}

.vec-table__head {
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
  padding: 2px 6px;
}

.vec-table__body {
  max-height: calc(30px * 8 + 9px);
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--v-theme-primary), 0.5) transparent;
}

.vec-table__body::-webkit-scrollbar {
  width: 8px;
}

.vec-table__body::-webkit-scrollbar-track {
  background: transparent;
}

.vec-table__body::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-primary), 0.5);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.vec-table__body::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--v-theme-primary), 0.7);
  background-clip: padding-box;
}

/* no up/down arrow buttons on the scrollbar */
.vec-table__body::-webkit-scrollbar-button {
  display: none;
}

.vec-table__row {
  min-height: 28px;
  padding: 2px 6px;
  border-radius: 6px;
  color: rgb(var(--v-theme-on-surface));
}

.vec-table__row:hover {
  background: rgba(var(--v-theme-surface-bright), 0.35);
}

.vec-input {
  width: 100%;
  min-width: 0;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.85rem;
  color: rgb(var(--v-theme-on-surface));
  background: rgba(var(--v-theme-surface-bright), 0.15);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.3);
  border-radius: 6px;
  padding: 1px 6px;
  outline: none;
}

.vec-input:focus {
  border-color: rgba(var(--v-theme-primary), 0.8);
  background: rgba(var(--v-theme-surface-bright), 0.25);
}

.vec-table__empty {
  font-size: 0.8rem;
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
  padding: 6px;
}

.vec-edit__add {
  display: flex;
  justify-content: center;
}

.vec-edit__export {
  display: flex;
  justify-content: center;
}
</style>
