import type { CommandSpec } from '../../../../main/process/commands/types'
import { pendingCalls, submitAnswer } from './ask'

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

const commands: CommandSpec[] = [
  {
    name: 'yaya.ask-answer',
    // 只有用户本人能回答 AI 的提问：AI 不能经命令替自己作答
    privacy: { agent: 'deny' },
    description: '回答 AI 的提问卡片（ask_user）',
    usage:
      'yaya.ask-answer --session <会话 id> --call <工具调用 id> --answers <JSON 数组> | --dismissed',
    run: (ctx) => {
      const session = String(ctx.named.session ?? '')
      const call = String(ctx.named.call ?? '')
      const dismissed = ctx.named.dismissed === true || ctx.named.dismissed === 'true'
      const answers = parseJson(ctx.named.answers)
      return { ok: submitAnswer(session, call, dismissed ? { dismissed } : { answers }) }
    }
  },
  {
    name: 'yaya.ask-pending',
    description: '本对话正在等待回答的提问（工具调用 id）',
    usage: 'yaya.ask-pending --session <会话 id>',
    run: (ctx) => ({ calls: pendingCalls(String(ctx.named.session ?? '')) })
  }
]
export default commands
