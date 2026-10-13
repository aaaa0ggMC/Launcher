import { ref } from 'vue'

/**
 * 棋盘的跨模块状态（同一模块 = 页面内唯一一份）：
 * - `pendingCell`：已发出、还没等到新棋盘的那一步（显示转圈 + 整盘只读），
 *   新棋盘一更新就清掉。
 *
 * **C1 修正版：棋盘是文档流的最后一块、只有一块、原地实时更新**——
 * `gameView` 是所有 `<g|ttt|…>` 标记汇聚出来的「当前对局」视图（锚点组件喂、
 * 条带 GameBoard 读），旁白 `note` 与「AI 思考中」的流式状态都显示在条带上，
 * 不往聊天里追加棋盘卡（新消息插在条带上面，它随内容一起滚）。用户澄清原意：**不是悬浮窗**。
 */
export const pendingCell = ref<number | null>(null)

/** 当前对局视图（锚点组件每次收到标记就更新；没有对局时为 null） */
export interface GameViewState {
  /** 9 字符棋盘 `X.O.X....` */
  state: string
  turn: 'X' | 'O' | 'end'
  /** AI 的一句话旁白（标记里的 `note=`，显示在面板上） */
  note: string
  /** 这条回答还在流式输出（面板显示「AI 思考中…」） */
  streaming: boolean
  /** 标记所在会话（点格子落子时用；条带只显示当前会话的对局） */
  sessionId: string
}

export const gameView = ref<GameViewState | null>(null)
