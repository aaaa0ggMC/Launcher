import { definePluginUi } from '../../components/plugin-ui'
import type { InlineTokenRule } from '../../components/plugin-ui'
import { pluginConfigValues, pluginEnabled } from '../../components/plugin-ui-registry'
import { applyTextRule, compileRule, parseTextRules } from '../../services/text-rules'

/**
 * 渲染端：把配置里的 `visual` 规则变成正文记号（**函数形式**——每次渲染读配置，随保存即时生效）。
 *
 * - `html` 规则只在 AI 输出那侧注入（`ctx.role` 判定）：用户气泡不是 HTML 管线；
 * - 已知限制：`applyInlineTokensHtml` 作用在所有文本段上，代码块里的匹配也会被视觉替换
 *   （与 secret 记号同一取舍），需要规避就用 `^` / 上下文锚定；
 * - 插件被停用时直接不产规则（用户配置的变换，关掉就该停）。
 */
function visualRules(): InlineTokenRule[] {
  if (!pluginEnabled('regex')) return []
  const rules = parseTextRules(pluginConfigValues('regex').rules)
  const out: InlineTokenRule[] = []
  for (const r of rules) {
    if (r.enabled === false || (r.mode ?? 'visual') !== 'visual') continue
    const re = compileRule(r)
    if (!re) continue
    out.push({
      pattern: re,
      render: (m, ctx) => {
        if (r.format === 'html' && ctx.role === 'user') return null
        const replaced = applyTextRule(r, m[0])
        if (replaced === m[0]) return null
        return r.format === 'html'
          ? { html: replaced, text: replaced, tone: 'plain' }
          : { text: replaced, tone: 'plain' }
      }
    })
  }
  return out
}

export default definePluginUi({
  pluginId: 'regex',
  // 函数形式：每次渲染求值 → 保存规则后即时生效（且随配置响应式）
  inlineTokens: visualRules,
  // 规则编辑器（首次消费 SDK 的 settingsView：替代 schema 自动生成的表单）
  settingsView: () => import('./RegexRulesView.vue')
})
