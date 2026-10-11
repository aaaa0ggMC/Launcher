<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import type { BlockViewProps } from '../../components/plugin-ui'

/**
 * 井字棋棋盘（对话内块级小部件）：AI 的 `<g|ttt|STATE|turn=WHO>` 渲染成 3×3 棋盘，
 * 用户点格子 = 发一条 `<g|ttt|move=N>` 用户消息，AI 用新棋盘回。
 * 「增量渲染」就是 `source` 变化 → 只有格子内容重画（key 是稳定下标，棋盘外壳不重挂）；
 * 落子后到新棋盘回来之前整盘只读，防止连点出两步。
 */
const props = defineProps<BlockViewProps>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const busy = ref(false)
/** 已发出、还在等 AI 回棋盘的那一步 */
const sent = ref<number | null>(null)
watch(
  () => props.source,
  () => {
    sent.value = null
  }
)

const cells = computed(() => {
  const state = (props.source.split('|')[0] ?? '').replace(/[^XO.]/g, '')
  return (state + '.........').slice(0, 9).split('')
})

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
]
function winnerOf(c: string[]): 'X' | 'O' | null {
  for (const [a, b, d] of LINES)
    if (c[a] !== '.' && c[a] === c[b] && c[a] === c[d]) return c[a] as 'X' | 'O'
  return null
}

const winner = computed(() => winnerOf(cells.value))
const over = computed(() => !!winner.value || cells.value.every((c) => c !== '.'))
/** 轮次：AI 没写 `turn=` 时，没结束就当轮到用户（写法见插件 instructions） */
const turn = computed<'X' | 'O' | 'end'>(() => {
  if (over.value) return 'end'
  const m = /turn=([XO])/i.exec(props.source)
  return m ? (m[1].toUpperCase() as 'X' | 'O') : 'O'
})
const myTurn = computed(
  () => !props.streaming && !busy.value && sent.value === null && turn.value === 'O'
)

const status = computed(() => {
  if (winner.value === 'O') return t('yaya.game.you_win', '你赢了')
  if (winner.value === 'X') return t('yaya.game.ai_win', 'AI 赢了')
  if (over.value) return t('yaya.game.draw', '平局')
  if (props.streaming || sent.value !== null || turn.value === 'X')
    return t('yaya.game.ai_think', 'AI 思考中…')
  return t('yaya.game.your_turn', '轮到你了，点格子落子（O）')
})
const statusIcon = computed(() => {
  if (winner.value === 'O') return 'mdi-trophy-outline'
  if (winner.value === 'X') return 'mdi-robot-outline'
  if (over.value) return 'mdi-handshake-outline'
  if (props.streaming || sent.value !== null || turn.value === 'X') return 'mdi-brain'
  return 'mdi-cursor-default-click-outline'
})

async function play(i: number): Promise<void> {
  if (!myTurn.value || cells.value[i] !== '.' || !props.sessionId) return
  busy.value = true
  sent.value = i
  try {
    await window.cockpit.command('yaya.workflow-start', {
      session: props.sessionId,
      prompt: `<g|ttt|move=${i}>`
    })
  } catch (e) {
    sent.value = null
    console.warn('[yaya] tic-tac-toe move failed', e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="ttt" role="group" :aria-label="t('yaya.plugin.interactgame.label', '对话小游戏')">
    <div class="ttt-status text-medium-emphasis">
      <v-icon :icon="statusIcon" size="16" />
      <span>{{ status }}</span>
    </div>
    <div class="ttt-grid">
      <button
        v-for="(c, i) in cells"
        :key="i"
        type="button"
        class="ttt-cell"
        :class="{
          'is-x': c === 'X',
          'is-o': c === 'O',
          'is-clickable': myTurn && c === '.',
          'is-pending': sent === i
        }"
        :disabled="!(myTurn && c === '.')"
        :aria-label="te('yaya.game.cell', { n: String(i + 1) }, '第 {n} 格')"
        @click="play(i)"
      >
        <v-progress-circular v-if="sent === i" :size="22" width="2" indeterminate />
        <span v-else-if="c !== '.'">{{ c }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ttt {
  display: inline-flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  max-width: 100%;
  border-radius: 14px;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.78));
  backdrop-filter: blur(16px) saturate(1.15);
  -webkit-backdrop-filter: blur(16px) saturate(1.15);
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.6));
}
.ttt-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  min-height: 20px;
}
.ttt-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: min(248px, 100%);
}
.ttt-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.4));
  background: rgba(var(--v-theme-surface-variant, var(--v-theme-surface)), 0.55);
  color: rgb(var(--v-theme-on-surface));
  font-size: clamp(1.5rem, 7vw, 2.1rem);
  font-weight: 600;
  line-height: 1;
  cursor: default;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.ttt-cell.is-x {
  color: rgb(var(--v-theme-primary));
}
.ttt-cell.is-o {
  color: rgb(var(--v-theme-secondary, var(--v-theme-primary)));
}
.ttt-cell.is-clickable {
  cursor: pointer;
}
.ttt-cell.is-clickable:hover,
.ttt-cell.is-clickable:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.1);
}
.ttt-cell:disabled {
  opacity: 1;
}
.ttt-cell.is-pending {
  border-color: rgba(var(--v-theme-primary), 0.5);
}
</style>
