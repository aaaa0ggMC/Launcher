<script setup lang="ts">
/**
 * C1 重设计的「锚点」：`<g|ttt|…>` 标记的占位组件——**不画可见棋盘**，
 * 把每条标记汇聚成 `gameView`（当前对局）喂给悬浮面板（`yaya.game-board`），
 * 面板只有一块、原地实时更新；「AI 思考中」的流式状态与 `note=` 旁白都显示在面板上。
 *
 * 悬浮窗被用户禁用时 `openOutsider` 返回 false → **内联回退**：按老样子在标记处
 * 渲染 TicTacToe 卡（此时多块棋盘的旧交互由 TicTacToe 自己的 latestSeq 逻辑兜底）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { isOutsiderOpen, openOutsider } from '@ui/outsider'
import type { BlockViewProps } from '../../components/plugin-ui'
import TicTacToe from './TicTacToe.vue'
import { GAME_OUTSIDER_ID, gameView } from './state'

const props = defineProps<BlockViewProps>()

/** 载荷：`X.O.X....|turn=O|note=一句话` —— 第一段是棋盘，其余是 key=value 属性 */
function parse(source: string): { state: string; turn: 'X' | 'O'; note: string } {
  const segs = source.split('|')
  const raw = (segs[0] ?? '').replace(/[^XO.]/g, '')
  let turn: 'X' | 'O' = 'O'
  let note = ''
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=')
    if (eq <= 0) continue
    const k = seg.slice(0, eq).trim()
    const v = seg.slice(eq + 1).trim()
    if (k === 'turn') turn = v.toUpperCase() === 'X' ? 'X' : 'O'
    else if (k === 'note') note = v
  }
  return { state: (raw + '.........').slice(0, 9), turn, note }
}

/** 悬浮窗不可用（被禁用 / 被能力名单拦下）→ 内联渲染老棋盘卡 */
const inlineMode = ref(false)

function push(): void {
  const p = parse(props.source)
  gameView.value = {
    state: p.state,
    turn: p.turn,
    note: p.note,
    streaming: props.streaming,
    sessionId: props.sessionId
  }
  // 已经开着就不重复开；被用户关掉后下一次走子会重新拉起（对局还在进行）
  inlineMode.value = !(
    isOutsiderOpen(GAME_OUTSIDER_ID) ||
    openOutsider(GAME_OUTSIDER_ID, { sessionId: props.sessionId })
  )
}

onMounted(push)
watch(
  () => [props.source, props.streaming] as const,
  () => push()
)

const inlineProps = computed(() => props)
</script>

<template>
  <TicTacToe v-if="inlineMode" v-bind="inlineProps" />
  <div v-else class="ttt-anchor" aria-hidden="true" />
</template>

<style scoped>
/* 悬浮模式下的占位：不占任何视觉空间（标记仍要“存在”，气泡/复制剥离逻辑照旧） */
.ttt-anchor {
  height: 0;
  overflow: hidden;
}
</style>
