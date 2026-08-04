<script setup lang="ts">
import { inject } from 'vue'
import type { FtUiState } from '../types'

const state = inject('ft:state') as FtUiState

interface Row {
  index: number
  len: number
  period: string
  phase: string
}

const rows = (): Row[] =>
  state.vectors.map((v, i) => ({
    index: i,
    len: Math.hypot(v.x, v.y),
    period: v.secperRound === 0 ? '∞' : v.secperRound.toFixed(3),
    phase: ((v.orot ?? 0) % 360).toFixed(1) + '°'
  }))
</script>

<template>
  <div class="vec-table">
    <div class="vec-table__head font-family-mono">
      <span>#</span>
      <span>|v|</span>
      <span>T</span>
      <span>φ</span>
    </div>
    <div class="vec-table__body font-family-mono">
      <div v-for="r in rows()" :key="r.index" class="vec-table__row">
        <span class="on-surface-variant">{{ r.index }}</span>
        <span>{{ r.len.toFixed(1) }}</span>
        <span>{{ r.period }}</span>
        <span>{{ r.phase }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vec-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.vec-table__head,
.vec-table__row {
  display: grid;
  grid-template-columns: 2.5rem 1fr 1fr 1fr;
  gap: 6px;
}

.vec-table__head {
  font-size: 0.68rem;
  letter-spacing: 0.06em;
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
  padding: 2px 6px;
}

.vec-table__body {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.vec-table__row {
  font-size: 0.75rem;
  padding: 2px 6px;
  border-radius: 6px;
  color: rgb(var(--v-theme-on-surface));
}

.vec-table__row:hover {
  background: rgba(var(--v-theme-surface-bright), 0.35);
}
</style>
