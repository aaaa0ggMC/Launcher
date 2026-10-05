/**
 * 内置 svg 插件（显示类）：把回答里的 ```svg 代码块安全地显示成图。
 *
 * 没有工具；启用时给系统提示词加一段固定的英文说明（不翻译、不随配置变化，提示词缓存稳定），
 * 让模型知道 ```svg 代码块会显示成图、以及净化规则（避免它依赖会被删掉的东西）。
 * 渲染端见同目录 ui.ts / SvgView.vue（净化 + data URL <img> 显示）。
 */
import { t } from '../../../../main/process/i18n'
import type { YayaPlugin } from '../../services/plugins/types'

/** 固定英文（与其他插件的 instructions 一致：不随界面语言变，提示词缓存不失效） */
const INSTRUCTIONS = [
  '## SVG images',
  'The chat UI displays fenced ```svg code blocks in your replies as images (the user can still view',
  'the source). Use them for icons, simple illustrations or custom charts that mermaid cannot express.',
  '- Write one complete, well-formed XML <svg> root with xmlns="http://www.w3.org/2000/svg" and a',
  '  viewBox; invalid XML is shown as plain code. It is a static image scaled to the chat width.',
  '- It is sanitized first: <script>, <foreignObject>, on* event handlers and every href /',
  '  xlink:href except #fragment references are removed, so no interactivity, HTML text or embedded',
  '  images. Use <text> for text, <defs>/<use> for reuse, and attributes or inline <style> for styling.'
].join('\n')

const plugin: YayaPlugin = {
  id: 'svg',
  kind: 'builtin',
  label: 'SVG 预览',
  labelKey: 'yaya.plugin.svg.label',
  description: '把 ```svg 代码块净化后显示成图片（不执行其中的脚本），只影响显示',
  descriptionKey: 'yaya.plugin.svg.desc',
  icon: 'mdi-svg',
  // 显示类插件没有工具
  tools: () => [],
  instructions: () => INSTRUCTIONS,
  // 用户 @ 点名时：只拼一句附注，不改系统提示词
  mention: () => ({
    note: t('yaya.plugin.svg.mention', '可以直接输出 ```svg 代码块，界面会显示成图')
  })
}

export default plugin
