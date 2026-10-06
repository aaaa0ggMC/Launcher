import type { CommandSpec } from '../../../../main/process/commands/types'
import { listSecretIds, secretValues } from '../../services/secrets'

const commands: CommandSpec[] = [
  {
    name: 'yaya.secret-list',
    description: '本对话保存的 Secret 引用（只有 id，不含值）',
    usage: 'yaya.secret-list --session <会话 id>',
    run: (ctx) => ({ ids: listSecretIds(String(ctx.named.session ?? '')) })
  },
  {
    name: 'yaya.secret-values',
    // 真值只给用户本人的界面（「在回答里显示真值」）；AI 永远拿不到
    privacy: { agent: 'deny' },
    description: '本对话 Secret 的真值（仅用户界面显示用）',
    usage: 'yaya.secret-values --session <会话 id>',
    run: (ctx) => ({ values: secretValues(String(ctx.named.session ?? '')) })
  }
]
export default commands
