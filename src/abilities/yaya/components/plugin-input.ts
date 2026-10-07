/** Composer SDK: extensions own their UI/state; the host owns text, focus and submission. */
import type { Ref } from 'vue'

export interface InputTrigger {
  /** Literal prefix, e.g. @, / or a keyword. */
  prefix: string
  /** Defaults to true: only match at the start or after whitespace. */
  boundary?: boolean
  maxQueryLength?: number
}

export interface InputTriggerMatch {
  prefix: string
  query: string
  start: number
  end: number
}

export function matchInputTrigger(
  text: string,
  caret: number,
  triggers: InputTrigger[]
): InputTriggerMatch | null {
  const before = text.slice(0, caret)
  for (const trigger of triggers) {
    if (!trigger.prefix) continue
    const start = before.lastIndexOf(trigger.prefix)
    if (start < 0) continue
    if (trigger.boundary !== false && start > 0 && !/\s/.test(before[start - 1])) continue
    const query = before.slice(start + trigger.prefix.length)
    if (/\s/.test(query) || query.includes(trigger.prefix)) continue
    if (query.length > (trigger.maxQueryLength ?? 64)) continue
    return { prefix: trigger.prefix, query, start, end: caret }
  }
  return null
}

export interface PluginInputHooks {
  triggers?: InputTrigger[]
  onTrigger?: (match: InputTriggerMatch | null) => void
  /** Return true to consume the event before the composer's Enter handling. */
  onKeyDown?: (event: KeyboardEvent) => boolean
  /** Add existing transport references, without bypassing backend permissions. */
  collect?: () => { mentions?: string[] }
  hasContent?: () => boolean
  reset?: () => void
  /**
   * Load references back into the composer (editing a sent message). Records are what the
   * message stored in `meta.mentions`; each extension picks the ones it understands.
   */
  restore?: (state: { mentions?: { ref: string; label: string; kind: string }[] }) => void
}

/**
 * 输入框「+」面板里的一项（Rikkahub 式：输入框只留最常用的按钮，其余收进「+」）。
 * - `tile`：面板顶部的大按钮宫格（添加附件 / 拍照 / 语音输入这类「往输入框里放东西」的动作）；
 * - `item`：下面的列表行（开关 / 模式 / 打开某个设置），给了 `active` 就显示成开关。
 * 窄屏 / 触屏下面板是底部弹层，桌面是输入框上方的弹出菜单。
 */
export interface InputMenuAction {
  /** 插件内唯一 */
  id: string
  /** mdi 图标 */
  icon: string
  /** 已翻译的显示名 */
  label: string
  /** 列表行的副标题（tile 不显示） */
  description?: string
  /** 缺省 tile */
  placement?: 'tile' | 'item'
  /** 排序（小的在前，缺省 100；宿主自带的「文件」是 0） */
  order?: number
  /** 开关状态：给了就在列表行末尾显示开关，tile 显示成选中态 */
  active?: () => boolean
  disabled?: () => boolean
  /** 点完保持面板打开（开关类）；缺省点完就关 */
  keepOpen?: boolean
  run: () => void | Promise<void>
}

export interface PluginInputContext {
  draft: Ref<string>
  sessionId: Readonly<Ref<string>>
  /**
   * Mount toolbar controls using Teleport after this target becomes available.
   * 工具栏只放「每条消息都可能用到」的东西；其余请用 `addAction` 放进「+」面板，否则输入框会被挤爆。
   */
  toolbarTarget: Ref<HTMLElement | null>
  /** 往「+」面板加一项，返回移除函数（组件卸载时调用） */
  addAction: (action: InputMenuAction) => () => void
  focus: () => void
  selection: () => { start: number; end: number }
  replaceRange: (start: number, end: number, text: string) => void
  /** One registration per mounted extension; dispose on unmount. */
  register: (hooks: PluginInputHooks) => () => void
}

export interface PluginInputProps {
  context: PluginInputContext
}
