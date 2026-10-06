/**
 * 内置 widget 插件（显示类）：回答里的 ```widget 代码块（一段 HTML + CSS + JS）在隔离沙箱里运行。
 *
 * 没有工具；启用时给系统提示词加一段固定英文说明（不随配置 / 语言变化，提示词缓存稳定）。
 * 只接 `widget` 语言，不接 `html`——普通的 HTML 示例代码不应该被当成小部件运行。
 * 沙箱见 `frame.ts`（外壳页 + CSP）与 `WidgetView.vue`（点击才运行）。
 */
import { t } from '../../../../main/process/i18n'
import type { YayaPlugin } from '../../services/plugins/types'

const INSTRUCTIONS = [
  '## Interactive widgets',
  'You CAN draw, animate and build small interactive things directly in your reply: the chat UI',
  'runs a fenced ```widget code block as a live HTML widget (the user clicks Run first).',
  'When the user asks you to draw, animate, visualize or demo something with HTML / CSS / SVG /',
  'canvas / JavaScript (e.g. "an SVG animation of a pelican riding a bicycle", a calculator, a small',
  'simulation, an interactive chart), answer with one ```widget block. Do not reach for tools for',
  'this: no headless browser, Playwright, screenshots or writing files to render it - the chat',
  'renders the block itself. Keep ordinary code examples the user will copy in ```html.',
  '- Animations are fine: CSS animations, SVG animate elements and requestAnimationFrame all work.',
  '- Write a self-contained HTML fragment or document with inline <style> and <script>. It runs in a',
  '  sandboxed iframe with an opaque origin and a strict CSP: no network at all (no fetch, no external',
  '  scripts, fonts or images; data: URLs are fine), no cookies or storage, no popups, no forms,',
  '  and no access to the chat or the app.',
  '- The frame width follows the chat column and its height follows the content (max ~800px).',
  '  The background is transparent; use the CSS variables --yaya-fg, --yaya-bg and --yaya-primary',
  '  (and color-scheme) to match the app theme.'
].join('\n')

const plugin: YayaPlugin = {
  id: 'widget',
  kind: 'builtin',
  label: 'HTML 小部件',
  labelKey: 'yaya.plugin.widget.label',
  description: '```widget 代码块点击后在隔离沙箱里运行（无网络、无法访问 Cockpit），只影响显示',
  descriptionKey: 'yaya.plugin.widget.desc',
  icon: 'mdi-application-brackets-outline',
  tools: () => [],
  instructions: () => INSTRUCTIONS,
  mention: () => ({
    note: t(
      'yaya.plugin.widget.mention',
      '可以输出 ```widget 代码块（自包含的 HTML / CSS / JS），界面会在沙箱里运行它'
    )
  })
}

export default plugin
