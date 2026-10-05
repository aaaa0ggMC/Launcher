/**
 * 内置 svg 插件（显示类）：把回答里的 ```svg 代码块安全地显示成图。
 *
 * **AI 无感**：没有 tools、没有 instructions，不影响提示词缓存；只提供一个后端注册，
 * 以便在设置页出现启用开关，并支持 6.3 的「@ 点名」（mention 给一句附注）。
 * 渲染端见同目录 ui.ts / SvgView.vue（净化 + data URL <img> 显示）。
 */
import { t } from '../../../../main/process/i18n'
import type { YayaPlugin } from '../../services/plugins/types'

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
  // 用户 @ 点名时：只拼一句附注，不改系统提示词
  mention: () => ({
    note: t('yaya.plugin.svg.mention', '可以直接输出 ```svg 代码块，界面会显示成图')
  })
}

export default plugin
