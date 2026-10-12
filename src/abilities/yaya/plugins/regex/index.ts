/**
 * 内置 Regex 插件：用户自定义替换规则，作用在「用户输入」与「AI 输出」上。
 *
 * 每条规则四个维度（见 `services/text-rules.ts`）：
 * - `target`：替换用户 / 替换 AI / 两边都换；
 * - `mode`：`visual` 只改显示（渲染端）/ `raw` 改原文（用户侧入库前 `userText`、AI 侧落库前 `assistantText`）；
 * - `format`：标准 `regex` 或 `html`（把替换结果当 HTML 片段注入——只对 AI 输出生效）。
 *
 * 规则存在插件配置的 `rules`（JSON 字符串），编辑器见同目录 `RegexRulesView.vue`
 * （首次消费插件 SDK 的 `settingsView`）；渲染端见 `ui.ts`（首次消费 `inlineTokens` 的函数形式）。
 */
import { assistantConfig, sessionAssistantId } from '../../assistants'
import { loadYayaConfig } from '../../services/config'
import { getSession } from '../../services/db'
import { applyTextRules, parseTextRules, type TextRule } from '../../services/text-rules'
import type { YayaPlugin } from '../../services/plugins/types'

/** 该会话助手作用域下的规则（渲染端经 plugins-list 拿的是同一份合并结果） */
function rulesOf(sessionId: string): TextRule[] {
  const cfg = assistantConfig(loadYayaConfig(), sessionAssistantId(getSession(sessionId)))
  return parseTextRules(cfg.pluginConfig?.regex?.rules)
}

const plugin: YayaPlugin = {
  id: 'regex',
  kind: 'builtin',
  // 规则默认为空（什么都不改），开着无副作用
  defaultEnabled: true,
  label: 'Regex 替换规则',
  labelKey: 'yaya.regex.label',
  description: '按正则替换用户输入与 AI 输出：可指定替换谁、只改显示还是改原文、纯文本还是 HTML',
  descriptionKey: 'yaya.regex.desc',
  icon: 'mdi-regex',
  tools: () => [],
  // 不注入 instructions：规则是显示 / 文案层的事，模型无需知道（raw 替换发生在它说完之后）
  configSchema: [
    {
      key: 'rules',
      type: 'text',
      label: '替换规则（JSON 数组）',
      labelKey: 'yaya.regex.cfg_rules',
      description:
        '每条 {pattern, flags, replacement, target: user|ai|both, mode: visual|raw, format: regex|html}；用本页编辑器维护更省事',
      descriptionKey: 'yaya.regex.cfg_rules_desc',
      default: '[]'
    }
  ],
  hooks: {
    // 用户消息入库前（manager 在写库前调用）
    userText: ({ sessionId, text }) =>
      applyTextRules(text, rulesOf(sessionId), { side: 'user', mode: 'raw' }),
    // AI 输出落库前（runner 在生成结束 / 中断 / 出错时调用）
    assistantText: ({ sessionId, text }) =>
      applyTextRules(text, rulesOf(sessionId), { side: 'ai', mode: 'raw' })
  }
}

export default plugin
