/** 消息右键 / 长按菜单的请求（由消息组件发出，View 决定有哪些菜单项） */
export interface MessageMenuRequest {
  /** 视口坐标（菜单出现的位置） */
  x: number
  y: number
  kind: 'user' | 'assistant'
  /** user = 该用户消息；assistant = 本轮第一个 assistant 节点 */
  messageId: string
  /** 所在会话（插件注入的操作如「朗读」需要） */
  sessionId: string
  /** 整条消息 / 本轮回答的纯文本（Markdown 原文） */
  text: string
  /** 打开菜单时选中的文字（没有则为空串） */
  selection: string
  /** assistant：含思考与工具调用的完整过程（Markdown） */
  fullText?: string
  /**
   * assistant：最终回答的正文（不含中间步骤）。
   * 插件操作（朗读）用它，与底部操作栏的按钮读同一段文字；旧数据没有时回落 `text`。
   */
  answerText?: string
  /**
   * 打开方式：
   * - `context` = 右键 / 长按（操作栏不在眼前，菜单给全套动作）；
   * - `button` = 点消息下方的「⋮」（操作栏就在旁边，其中已显示的动作不再进菜单，避免重复）。
   */
  via: 'context' | 'button'
}

export interface MessageMenuItem {
  key: string
  icon: string
  label: string
  danger?: boolean
  disabled?: boolean
  /** 在此项之前画分隔线 */
  divider?: boolean
}
