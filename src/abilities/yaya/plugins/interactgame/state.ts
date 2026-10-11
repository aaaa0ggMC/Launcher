import { ref } from 'vue'

/**
 * 棋盘的跨实例状态（同一模块 = 所有棋盘共用一份）：
 * - `latestBoardSeq`：按挂载顺序编号，**只有最新那块棋盘可交互**——旧棋盘静止，
 *   否则用户在旧盘上落子会和新盘打架（也符合「同一张卡片继续下」的直觉）；
 * - `pendingCell`：已发出、还没等到新棋盘的那一步（显示转圈 + 整盘只读），
 *   新棋盘一挂载就清掉。
 */
let seq = 0
export const latestBoardSeq = ref(0)
export const pendingCell = ref<number | null>(null)

/** 这块棋盘申领一个序号（setup 时调用） */
export function claimBoard(): number {
  return ++seq
}
