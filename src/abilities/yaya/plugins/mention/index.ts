/**
 * 内置 mention 插件：输入框 `@` 点名（PLAN 6.3）的宿主实现。
 *
 * 它**没有工具、不加系统提示词**——只提供输入框扩展界面（同目录 `ui.ts` 注册
 * `inputExtension` → `MentionInput.vue`）：输入 `@` 或点工具栏 @ 按钮弹出候选，
 * 选中的插件以标签显示，随这条消息发送（`session.meta.mentions` 本会话启用）。
 * 候选与效果仍由主进程 `services/plugins/mention.ts` 统一执行，插件只负责界面。
 *
 * `mentionable: false`：用户不可能点名「点名功能」自己，候选里不出现它
 * （界面侧 `select.ts` 也会再滤一遍）。
 */
import { t } from '../../../../main/process/i18n'
import type { YayaPlugin } from '../../services/plugins/types'

const DOCS = `# @ 点名（mention）

输入框里输入 \`@\`（行首或空白之后）就会弹出候选：内置插件、Skill、MCP 服务器，
按名字 / 描述 / 工具名过滤；工具栏的 @ 按钮打开同样的弹窗并带一个搜索框。

点中的插件以标签显示在输入框上方，随这条消息发送：从这条消息起**本会话强制启用**它的全部工具
（即使它在设置里是全局禁用状态——点名是用户主动的选择），附注拼在这条用户消息后面，
系统提示词与历史都不变（提示词缓存照常命中）。

会话菜单里能看到并撤销本会话的点名；隐私边界不变：工具内部的 guard、\`agent: 'deny'\`、
审批都照旧，点名不等于免审批。
`

const plugin: YayaPlugin = {
  id: 'mention',
  kind: 'builtin',
  label: '@ 点名',
  labelKey: 'yaya.plugin.mention.label',
  description:
    '输入 @ 点名插件 / Skill / MCP 服务器，本对话启用它们的工具；输入框与工具栏的 @ 都走这里',
  descriptionKey: 'yaya.plugin.mention.desc',
  icon: 'mdi-at',
  defaultEnabled: true,
  // 没有工具、不加系统提示词：只提供输入框界面
  tools: () => [],
  // 点名功能自己不进候选
  mentionable: false,
  get docs() {
    return t('yaya.plugin.mention.docs', DOCS)
  }
}

export default plugin
