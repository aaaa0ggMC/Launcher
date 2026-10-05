/**
 * 内置 mermaid 插件（显示类）：把回答里的 ```mermaid 代码块渲染成流程图 / 时序图 / 关系图。
 *
 * **AI 无感**：没有 tools、没有 instructions，不影响提示词缓存；只提供一个后端注册，
 * 以便在设置页出现启用开关，并支持 6.3 的「@ 点名」（mention 给一句附注）。
 * 渲染端见同目录 ui.ts / MermaidView.vue。
 */
import { t } from '../../../../main/process/i18n'
import type { YayaPlugin } from '../../services/plugins/types'

const plugin: YayaPlugin = {
  id: 'mermaid',
  kind: 'builtin',
  label: 'Mermaid 图表',
  labelKey: 'yaya.plugin.mermaid.label',
  description: '把 ```mermaid 代码块渲染成流程图 / 时序图 / 关系图，只影响显示',
  descriptionKey: 'yaya.plugin.mermaid.desc',
  icon: 'mdi-sitemap-outline',
  // 显示类插件没有工具
  tools: () => [],
  // 用户 @ 点名时：只拼一句附注，不改系统提示词
  mention: () => ({
    note: t(
      'yaya.plugin.mermaid.mention',
      '用户希望你在需要时用 ```mermaid 代码块画流程图 / 时序图 / 关系图，界面会渲染成图'
    )
  })
}

export default plugin
