/** 消息右键 / 长按菜单的请求（由消息组件发出，View 决定有哪些菜单项） */
export interface MessageMenuRequest {
  /** 视口坐标（菜单出现的位置） */
  x: number
  y: number
  kind: 'user' | 'assistant'
  /** user = 该用户消息；assistant = 本轮第一个 assistant 节点 */
  messageId: string
  /** 整条消息 / 本轮回答的纯文本（Markdown 原文） */
  text: string
  /** 打开菜单时选中的文字（没有则为空串） */
  selection: string
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
