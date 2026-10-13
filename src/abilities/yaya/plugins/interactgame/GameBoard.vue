<script setup lang="ts">
/**
 * C1 修正版的棋盘条带（`PluginUi.bottomStrip` → 滚动区底部、**文档流的最后一块**）：
 * 单次游戏固定在滚动内容底部——新消息插在它上面，它随内容一起滚、上翻可看历史
 * （用户澄清原意：非悬浮、不与输入框同级）。
 * 数据来自 `gameView`（所有 `<g|ttt|…>` 标记经 BoardAnchor 汇聚）：
 * - 状态行 = 胜负 / 轮次 / 落子等待 /「AI 思考中…」（流式与落子等待都算）；
 * - 旁白行 = 标记里的 `note=`（AI 的一句话评论显示在条带上，不往聊天里堆棋盘卡）；
 * - 点格子 = 发一条 `<g|ttt|move=N>` 消息（与旧内联模式同一通路）。
 * 无对局 / 不是当前会话的对局时整条不渲染（容器为空即不占位）；× 收起本次展示
 * （下一次走子/流式更新会把它带回来）。
 */
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../../main/ui/i18n'
import { gameView, pendingCell } from './state'

const props = defineProps<{ sessionId?: string }>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const busy = ref(false)

/** 只在「有对局且属于当前会话」时显示（切走的会话不带棋盘过来） */
const visible = computed(
  () =>
    !!gameView.value &&
    (!props.sessionId || !gameView.value.sessionId || gameView.value.sessionId === props.sessionId)
)

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
  if (!gameView.value) return ''
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

/** 收起条带（本次展示）；下一次走子 / 流式更新标记时会重新出现 */
function dismiss(): void {
  pendingCell.value = null
  gameView.value = null
}
</script>

<template>
  <div
    v-if="visible"
    class="gboard"
    role="group"
    :aria-label="t('yaya.plugin.interactgame.label', '对话小游戏')"
  >
    <div class="gboard-head">
      <div class="gboard-status text-medium-emphasis">
        <v-icon :icon="statusIcon" size="16" />
        <span>{{ status }}</span>
      </div>
      <v-btn
        icon="mdi-close"
        variant="text"
        size="x-small"
        :title="t('yaya.input.collapse', '收起')"
        :aria-label="t('yaya.input.collapse', '收起')"
        @click="dismiss"
      />
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
  box-sizing: border-box;
  /* 文档流里的一块（像张消息卡）：宽度随内容，不撑满整行 */
  width: fit-content;
  max-width: 100%;
  /* 悬浮/常驻面板必须有自己的底（同 TtsPlayer 的房子样式 / AGENTS 玻璃面板规范）：
     透明会让聊天文字透上来、两层内容互相穿插不可读 */
  border-radius: 16px;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.92));
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.5));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  color: rgb(var(--v-theme-on-surface));
}
.gboard-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gboard-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  min-height: 20px;
  flex: 1 1 auto;
  min-width: 0;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
