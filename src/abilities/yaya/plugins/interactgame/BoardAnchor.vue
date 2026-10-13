<script setup lang="ts">
/**
 * C1 修正版的「锚点」：`<g|ttt|…>` 标记的占位组件——**不画可见棋盘**，
 * 把每条标记汇聚成 `gameView`（当前对局）喂给输入框上方的固定条带
 * （`PluginUi.bottomStrip` → GameBoard.vue）：棋盘钉在聊天窗口底部、
 * 消息在它上面出现，原地实时更新，不悬浮、不遮消息、不抢滚动。
 */
import { onMounted, watch } from 'vue'
import type { BlockViewProps } from '../../components/plugin-ui'
import { gameView } from './state'

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

function push(): void {
  const p = parse(props.source)
  gameView.value = {
    state: p.state,
    turn: p.turn,
    note: p.note,
    streaming: props.streaming,
    sessionId: props.sessionId
  }
}

onMounted(push)
watch(
  () => [props.source, props.streaming] as const,
  () => push()
)
</script>

<template>
  <!-- 棋盘本体在输入框上方的固定条带里渲染；这里只是标记汇聚点 -->
  <span class="game-anchor" hidden />
</template>

<style scoped>
/* 锚点不产生可见内容（棋盘 = bottomStrip 条带） */
.game-anchor {
  display: none;
}
</style>
