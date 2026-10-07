/**
 * storyteller 插件的命令：读当前分支上的故事档案（输入框「+」→「故事档案」用）。
 */
import type { CommandSpec } from '../../../../main/process/commands/types'
import { getMessageBranch, getSession } from '../../services/db'
import type { StoryBible } from './bible'
import { STORY_WORKFLOW_ID } from './index'

/** 从叶子往上找最近一次保存的故事档案（与工作流 ctx.loadState 同一规则） */
export function bibleOnBranch(leafId: string | null | undefined): StoryBible | null {
  const branch = getMessageBranch(leafId)
  for (let i = branch.length - 1; i >= 0; i--) {
    const st = branch[i].meta?.workflowState
    if (st && Object.prototype.hasOwnProperty.call(st, STORY_WORKFLOW_ID))
      return (st[STORY_WORKFLOW_ID] as StoryBible) ?? null
  }
  return null
}

const commands: CommandSpec[] = [
  {
    name: 'yaya.storyteller-bible',
    description:
      '读取会话当前分支上的故事档案（StoryTeller「故事模式」维护：世界、角色、线索、剧情摘要）；没有返回 null',
    usage: 'yaya.storyteller-bible --session <会话 id> [--leaf <消息 id>]',
    ui: ['YAYA → 输入框「+」→ 故事档案'],
    run: async (ctx) => {
      const session = getSession(String(ctx.named.session ?? ''))
      if (!session) throw new Error('session not found')
      const leaf = typeof ctx.named.leaf === 'string' ? ctx.named.leaf : session.activeLeafId
      return bibleOnBranch(leaf)
    }
  }
]

export default commands
