import type { CommandSpec } from '../../../../main/process/commands/types'
import { loadYayaConfig } from '../../services/config'
import { mentionCandidates } from '../../services/plugins/mention'

const commands: CommandSpec[] = [
  {
    name: 'yaya.mention-candidates',
    description: '输入框 @ 的候选插件，按名字、描述或工具名过滤',
    usage: 'yaya.mention-candidates [--query <文本>]',
    ui: ['YAYA 输入框输入 @ / 工具栏 @ 按钮'],
    related: ['yaya.workflow-start', 'yaya.session-mentions'],
    run: (ctx) => mentionCandidates(loadYayaConfig(), String(ctx.named.query ?? ''))
  }
]
export default commands
