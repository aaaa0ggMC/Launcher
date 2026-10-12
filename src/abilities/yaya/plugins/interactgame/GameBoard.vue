<script setup lang="ts">
/**
 * C1 的悬浮棋盘面板（outsider `yaya.game-board`）：**一整局只有一块、原地实时更新**。
 * 数据来自 `gameView`（所有 `<g|ttt|…>` 标记经 BoardAnchor 汇聚）：
 * - 状态行 = 胜负 / 轮次 / 落子等待 /「AI 思考中…」（流式与落子等待都算）；
 * - 旁白行 = 标记里的 `note=`（AI 的一句话评论显示在板上，不再往聊天里堆棋盘卡）；
 * - 点格子 = 发一条 `<g|ttt|move=N>` 消息（与内联模式同一通路）。
 * 面板由 OutsiderItem 提供拖动 / 贴边 / 关闭 / 位置记忆。
 */
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import { gameView, pendingCell } from './state'

const props = defineProps<{ sessionId?: string }>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const busy = ref(false)

const cells = computed(() => (gameView.value?.state ?? '.........').split(''))

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
const pending = computed(() => pendingCell.value)
const streaming = computed(() => gameView.value?.streaming ?? false)
const myTurn = computed(
  () =>
    !!gameView.value &&
    !streaming.value &&
    pending.value === null &&
    !over.value &&
    gameView.value.turn === 'O'
)

const status = computed(() => {
  if (!gameView.value) return t('yaya.game.idle', '还没有对局——在对话里让 AI 开一盘')
  if (winner.value === 'O') return t('yaya.game.you_win', '你赢了')
  if (winner.value === 'X') return t('yaya.game.ai_win', 'AI 赢了')
  if (over.value) return t('yaya.game.draw', '平局')
  if (streaming.value || pending.value !== null) return t('yaya.game.ai_think', 'AI 思考中…')
  if (gameView.value.turn === 'X')
    return t('yaya.game.ai_pending', '轮到 AI——若没动静，在对话里说一句「继续」')
  return t('yaya.game.your_turn', '轮到你了，点格子落子（O）')
})
const statusIcon = computed(() => {
  if (!gameView.value) return 'mdi-grid'
  if (winner.value === 'O') return 'mdi-trophy-outline'
  if (winner.value === 'X') return 'mdi-robot-outline'
  if (over.value) return 'mdi-handshake-outline'
  if (streaming.value || pending.value !== null || gameView.value.turn === 'X') return 'mdi-brain'
  return 'mdi-cursor-default-click-outline'
})

async function play(i: number): Promise<void> {
  if (!myTurn.value || cells.value[i] !== '.') return
  const session = props.sessionId ?? gameView.value?.sessionId
  if (!session) return
  busy.value = true
  pendingCell.value = i
  try {
    await window.cockpit.command('yaya.workflow-start', {
      session,
      prompt: `<g|ttt|move=${i}>`
    })
  } catch (e) {
    pendingCell.value = null
    console.warn('[yaya] tic-tac-toe move failed', e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="gboard" role="group" :aria-label="t('yaya.plugin.interactgame.label', '对话小游戏')">
    <div class="gboard-status text-medium-emphasis">
      <v-icon :icon="statusIcon" size="16" />
      <span>{{ status }}</span>
    </div>

    <!-- 旁白上板：AI 的一句话评论显示在这里，不再往聊天里追加棋盘卡 -->
    <div v-if="gameView?.note" class="gboard-note">
      <v-icon icon="mdi-comment-quote-outline" size="14" class="note-icon" />
      <span>{{ gameView.note }}</span>
    </div>

    <div class="gboard-grid">
      <button
        v-for="(c, i) in cells"
        :key="i"
        type="button"
        class="gboard-cell"
        :class="{
          'is-x': c === 'X',
          'is-o': c === 'O',
          'is-clickable': myTurn && c === '.',
          'is-pending': pending === i
        }"
        :disabled="!(myTurn && c === '.')"
        :aria-label="te('yaya.game.cell', { n: String(i + 1) }, '第 {n} 格')"
        @click="play(i)"
      >
        <v-progress-circular v-if="pending === i" :size="22" width="2" indeterminate />
        <span v-else-if="c !== '.'">{{ c }}</span>
      </button>
    </div>

    <div class="gboard-legend text-medium-emphasis">
      <span class="legend-x">X = AI</span>
      <span class="legend-o">O = 你</span>
    </div>
  </div>
</template>

<style scoped>
.gboard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  min-width: 236px;
}
.gboard-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  min-height: 20px;
}
.gboard-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 0.8rem;
  line-height: 1.45;
  color: rgb(var(--v-theme-on-surface));
  background: rgba(var(--v-theme-primary), 0.08);
  border: 1px solid rgba(var(--v-theme-primary), 0.22);
  border-radius: 8px;
  padding: 6px 8px;
}
.gboard-note .note-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: rgb(var(--v-theme-primary));
}
.gboard-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: 216px;
  max-width: 100%;
}
.gboard-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.4));
  background: rgba(var(--v-theme-surface-variant, var(--v-theme-surface)), 0.55);
  color: rgb(var(--v-theme-on-surface));
  font-size: clamp(1.4rem, 6vw, 1.9rem);
  font-weight: 600;
  line-height: 1;
  cursor: default;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.gboard-cell.is-x {
  color: rgb(var(--v-theme-primary));
}
.gboard-cell.is-o {
  color: rgb(var(--v-theme-secondary, var(--v-theme-primary)));
}
.gboard-cell.is-clickable {
  cursor: pointer;
}
.gboard-cell.is-clickable:hover,
.gboard-cell.is-clickable:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.1);
}
.gboard-cell:disabled {
  opacity: 1;
}
.gboard-cell.is-pending {
  border-color: rgba(var(--v-theme-primary), 0.5);
}
.gboard-legend {
  display: flex;
  justify-content: space-between;
  font-size: 0.72rem;
}
.legend-x {
  color: rgb(var(--v-theme-primary));
}
.legend-o {
  color: rgb(var(--v-theme-secondary, var(--v-theme-primary)));
}
</style>
