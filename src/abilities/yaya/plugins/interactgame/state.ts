import { ref } from 'vue'

/**
 * 棋盘的跨实例状态（同一模块 = 所有棋盘共用一份）：
 * - `latestBoardSeq`：按挂载顺序编号，**只有最新那块棋盘可交互**——旧棋盘静止，
 *   否则用户在旧盘上落子会和新盘打架（也符合「同一张卡片继续下」的直觉）；
 *   内联回退模式（悬浮窗被禁用）仍然依赖它。
 * - `pendingCell`：已发出、还没等到新棋盘的那一步（显示转圈 + 整盘只读），
 *   新棋盘一挂载就清掉。
 *
 * **C1 重设计：棋盘只有一块、悬浮常驻实时更新**——`gameView` 是所有 `<g|ttt|…>`
 * 标记汇聚出来的「当前对局」视图（锚点组件喂、悬浮组件读），旁白 `note` 与
 * 「AI 思考中」的流式状态都显示在棋盘面板上，不再每步往聊天里追加棋盘卡。
 */
let seq = 0
export const latestBoardSeq = ref(0)
export const pendingCell = ref<number | null>(null)

/** 这块棋盘申领一个序号（setup 时调用） */
export function claimBoard(): number {
  return ++seq
}

/** 悬浮棋盘面板的对外 id（能力 index.ts 的 outsiders 声明键 = `<能力id>.<key>`） */
export const GAME_OUTSIDER_ID = 'yaya.game-board'

/** 当前对局视图（锚点组件每次收到标记就更新；没有对局时为 null） */
export interface GameViewState {
  /** 9 字符棋盘 `X.O.X....` */
  state: string
  turn: 'X' | 'O' | 'end'
  /** AI 的一句话旁白（标记里的 `note=`，显示在面板上） */
  note: string
  /** 这条回答还在流式输出（面板显示「AI 思考中…」） */
  streaming: boolean
  /** 标记所在会话（点格子落子时用） */
  sessionId: string
}

export const gameView = ref<GameViewState | null>(null)
