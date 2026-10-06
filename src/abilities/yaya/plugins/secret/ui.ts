/**
 * secret 插件的界面：正文里的 `[[secret_xxxx]]` 显示成「🔒 secret_xxxx」标签；
 * 打开「在回答里显示真值」时，回答里的引用显示成真值（只在用户界面，带 secret 隐私标签，
 * AI 的快照 / 截图里会被遮住）。真值经 `yaya.secret-values`（agent: deny）按会话拉一次。
 */
import { reactive } from 'vue'
import { definePluginUi } from '../../components/plugin-ui'
import { pluginConfigValues } from '../../components/plugin-ui-registry'

const values = reactive(new Map<string, Record<string, string>>())
const loading = new Set<string>()
/** 拉过仍然没有的引用：每个只重拉一次（新存的 secret 在第一次遇到时补拉） */
const missed = new Set<string>()

function fetchValues(sessionId: string): void {
  if (loading.has(sessionId)) return
  loading.add(sessionId)
  void window.cockpit
    .command('yaya.secret-values', { session: sessionId })
    .then((r) => values.set(sessionId, (r as { values?: Record<string, string> }).values ?? {}))
    .catch(() => values.set(sessionId, values.get(sessionId) ?? {}))
    .finally(() => loading.delete(sessionId))
}

function valueOf(sessionId: string, id: string): string | undefined {
  if (!sessionId) return undefined
  const hit = values.get(sessionId)
  if (!hit) fetchValues(sessionId)
  else if (!(id in hit) && !missed.has(`${sessionId}/${id}`)) {
    missed.add(`${sessionId}/${id}`)
    fetchValues(sessionId)
  }
  return hit?.[id]
}

export default definePluginUi({
  pluginId: 'secret',
  inlineTokens: [
    {
      pattern: /\[\[(secret_[a-z0-9]{4,12})\]\]/g,
      render: (m, ctx) => {
        const id = m[1]
        if (ctx.role === 'assistant' && pluginConfigValues('secret').replaceInChat === true) {
          const value = valueOf(ctx.sessionId, id)
          if (value) return { text: value, title: id, tone: 'text', privacy: 'yaya.secret_value' }
        }
        return {
          text: id,
          icon: 'mdi-shield-key-outline',
          title: ctx.t(
            'yaya.plugin.secret.token_title',
            'Secret：AI 看不到内容，只在工具调用时替换成真值'
          )
        }
      }
    }
  ]
})
