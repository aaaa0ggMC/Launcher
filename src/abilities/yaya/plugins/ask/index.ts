/**
 * 内置 ask 插件：模型用 `ask_user` 向用户提问，问题在对话里渲染成一张卡片（选项 / 多选 / 自由补充），
 * 用户提交之后工具才返回，模型拿着回答继续同一轮回答——不用另发一条消息。
 *
 * - 工具在主进程挂起等待（ask.ts 的挂起表），卡片经 `yaya.ask-answer`（agent: deny）提交；
 * - 停止运行 = 中止等待；应用重启后挂起表清空，卡片显示「已失效」；
 * - 卡片视图见 ui.ts 的 `toolCards`：固定显示在回答里，不收进过程卡片。
 */
import type { ToolContentResult, YayaPlugin } from '../../services/plugins/types'
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  answerText,
  normalizeQuestions,
  waitForAnswer,
  type AskDisplay
} from './ask'

/** 用户可能离开很久；停止运行会立刻中止等待 */
const WAIT_MS = 24 * 60 * 60 * 1000

const INSTRUCTIONS = [
  '## Asking the user',
  'When a request is ambiguous, has several reasonable approaches, or needs a preference only the user',
  'can give, call ask_user instead of guessing or ending your reply with a list of options. The question',
  'is shown as a card with clickable options; your turn pauses until the user answers, then continues',
  'with the answer as the tool result. Offer 2-4 concrete options (put the recommended one first and',
  'append " (Recommended)" to its label); the user can always type their own answer. Group related',
  'questions into one call (up to 4). Do not ask about trivial details you can decide yourself, and do',
  'not ask for permission to run tools — tool approval is handled separately.'
].join('\n')

const DOCS = `# Ask 询问用户

给 AI 一个 \`ask_user\` 工具：需求有歧义、有几种做法、或者需要你的偏好时，AI 会在对话里弹出一张**问题卡片**，
而不是自己瞎猜或者在回答末尾列一堆选项。

- 每次最多 ${MAX_QUESTIONS} 个问题，每题 2~${MAX_OPTIONS} 个选项，可以单选或多选；
- 每题都能写一句自己的答案（「其他」），也可以跳过某一题，或者整组「不回答」；
- 提交后 AI 在**同一轮回答**里接着干，不需要另发消息；
- 等待回答时点「停止」会结束这次运行；应用重启后没回答的卡片会显示「已失效」。
`

const plugin: YayaPlugin = {
  id: 'ask',
  kind: 'builtin',
  label: 'Ask 询问用户',
  labelKey: 'yaya.plugin.ask.label',
  description: 'AI 需要你做决定时，在对话里弹出问题卡片让你点选，回答后接着干',
  descriptionKey: 'yaya.plugin.ask.desc',
  icon: 'mdi-help-circle-outline',
  defaultEnabled: true,
  docs: DOCS,
  instructions: () => INSTRUCTIONS,
  mention: () => ({
    note: 'If anything about this request is unclear, ask the user with the ask_user tool before proceeding.'
  }),
  tools: () => [
    {
      name: 'user',
      description:
        'Ask the user one or more multiple-choice questions and wait for the answer. Use it to clarify ' +
        'ambiguous requirements, let the user pick between approaches, or collect preferences. The user ' +
        'can pick options, write a free-form answer, or skip.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            description: `1-${MAX_QUESTIONS} questions shown together on one card`,
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The full question, ending with a question mark'
                },
                header: {
                  type: 'string',
                  description: 'Very short topic label shown above the question (max ~12 chars)'
                },
                options: {
                  type: 'array',
                  maxItems: MAX_OPTIONS,
                  description:
                    '2-4 distinct choices. Leave empty for a purely free-text question. ' +
                    'Do not add an "Other" option: free text is always available.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Short choice text (1-5 words)' },
                      description: {
                        type: 'string',
                        description: 'What this choice means or its trade-off'
                      }
                    },
                    required: ['label']
                  }
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Allow picking several options (default false)'
                }
              },
              required: ['question']
            }
          }
        },
        required: ['questions']
      },
      approval: 'auto',
      timeoutMs: WAIT_MS,
      docs: '在对话里显示问题卡片，等你点选 / 填写后把回答交给 AI。',
      async run(args, ctx): Promise<ToolContentResult> {
        const questions = normalizeQuestions(args)
        const res = await waitForAnswer(ctx.sessionId, ctx.callId ?? '', questions, ctx.signal)
        const display: AskDisplay = { questions, answers: res.answers }
        if (res.dismissed) display.dismissed = true
        return { content: [{ type: 'text', text: answerText(questions, res) }], display }
      }
    }
  ]
}

export default plugin
