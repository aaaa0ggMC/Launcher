/**
 * 内置 mermaid 插件（显示类）：把回答里的 ```mermaid 代码块渲染成流程图 / 时序图 / 关系图。
 *
 * 没有工具；启用时给系统提示词加一段固定的英文说明（不翻译、不随配置变化，提示词缓存稳定），
 * 让模型知道 ```mermaid 代码块会被渲染成图。禁用 = 说明与渲染器一起消失。
 * 渲染端见同目录 ui.ts / MermaidView.vue。
 */
import { t } from '../../../../main/process/i18n'
import type { YayaPlugin } from '../../services/plugins/types'

/** 固定英文（与其他插件的 instructions 一致：不随界面语言变，提示词缓存不失效） */
const INSTRUCTIONS = [
  '## Diagrams (mermaid)',
  'The chat UI renders fenced ```mermaid code blocks in your replies as diagrams (flowchart, sequence,',
  'class, state, ER, gantt, pie, mindmap, timeline, etc.); the user can still view the source.',
  'Use one when a diagram explains structure or flow better than prose, and keep it focused.',
  '- The block must contain valid mermaid syntax only; on a syntax error the user sees the raw code.',
  '- Labels are plain text (no HTML or markdown); wrap labels containing special characters',
  '  such as ( ) [ ] { } : ; " in double quotes.',
  "- Colors follow the user's theme automatically; avoid hard-coded styles unless they carry meaning.",
  '- Do not use click / callback / link directives (they are disabled).'
].join('\n')

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
  instructions: () => INSTRUCTIONS,
  // 用户 @ 点名时：只拼一句附注，不改系统提示词
  mention: () => ({
    note: t(
      'yaya.plugin.mermaid.mention',
      '用户希望你在需要时用 ```mermaid 代码块画流程图 / 时序图 / 关系图，界面会渲染成图'
    )
  })
}

export default plugin
