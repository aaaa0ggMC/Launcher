/**
 * 内置 secret 插件（SecretPlugin）：用户在消息里写 `#Secret("值")`，值不进聊天记录、模型看不到，
 * 模型拿到的是 `[[secret_xxxx]]` 引用。
 *
 * - 工具调用：参数里的引用在执行前换成真值（总是替换）；结果里出现的真值换回引用；
 * - 聊天显示：配置 `replaceInChat` 打开时，回答里的引用在**界面上**显示成真值（库里与模型历史不变）；
 * - 存储与变换在 `services/secrets.ts`，这里只用插件 SDK 的数据流钩子（`hooks`）接进来。
 * 防君子不防小人：工具拿到的是真值，模型故意让工具变形输出（base64 等）照样能看到。
 */
import type { YayaPlugin } from '../../services/plugins/types'
import { extractSecrets, scrubSecrets, substituteSecrets } from '../../services/secrets'

const INSTRUCTIONS = [
  '## Secrets',
  'The user can store a secret (API key, password, token) with #Secret("..."). You never see the value:',
  'it shows up as a reference like [[secret_k3f9]]. To use it, put the reference verbatim inside tool',
  'arguments (e.g. a header, a config field, a command); it is replaced with the real value only when the',
  'tool runs, and the value is masked back to the reference in tool results. Never try to reveal, print,',
  'encode or transform a secret, and do not ask the user to paste the value in plain text.'
].join('\n')

const DOCS = `# Secret

在消息里写 \`#Secret("具体内容")\`（也认 “…” 和 '…'），这段内容就不会出现在聊天记录里，
AI 只看到一个引用，例如 \`[[secret_k3f9]]\`。值加密保存在本机，只属于这个对话，删除对话时一起删除。

- **工具调用**：AI 在工具参数里写引用，执行时换成真值；工具输出里如果出现真值，会换回引用再交给 AI。
- **聊天显示**：打开「在回答里显示真值」后，AI 回答里的引用在你的界面上显示成真值（只影响显示）。
- 防君子不防小人：工具拿到的是真值，AI 如果故意让工具把它变形输出（比如 base64），仍然能看到。
`

const plugin: YayaPlugin = {
  id: 'secret',
  kind: 'builtin',
  label: 'Secret',
  labelKey: 'yaya.plugin.secret.label',
  description: '用 #Secret("…") 给 AI 一个看不到内容的引用，工具调用时才替换成真值',
  descriptionKey: 'yaya.plugin.secret.desc',
  icon: 'mdi-shield-key-outline',
  defaultEnabled: true,
  mentionable: false,
  docs: DOCS,
  configSchema: [
    {
      key: 'replaceInChat',
      type: 'boolean',
      label: '在回答里显示真值',
      labelKey: 'yaya.plugin.secret.cfg_replace_chat',
      description: 'AI 回答里出现引用时，在你的界面上显示成真值（不改聊天记录，AI 仍然看不到）',
      descriptionKey: 'yaya.plugin.secret.cfg_replace_chat_desc',
      default: false
    }
  ],
  instructions: () => INSTRUCTIONS,
  tools: () => [],
  hooks: {
    userText: ({ sessionId, text }) => extractSecrets(sessionId, text).text,
    toolArgs: ({ sessionId, args }) => substituteSecrets(sessionId, args),
    toolResult: ({ sessionId, value }) => scrubSecrets(sessionId, value)
  }
}

export default plugin
