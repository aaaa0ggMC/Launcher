export interface ChatCommandDef {
  name: string
  args: string
  descKey: string
  descFallback: string
}

export const CHAT_COMMANDS: ChatCommandDef[] = [
  {
    name: 'random',
    args: '<number>',
    descKey: 'aidj.cmd.random.desc',
    descFallback: '随机选取 N 首歌曲'
  },
  {
    name: 'pr',
    args: '<number>',
    descKey: 'aidj.cmd.pr.desc',
    descFallback: 'AI 从随机候选中精选歌单'
  },
  {
    name: 'explore',
    args: '<number>',
    descKey: 'aidj.cmd.explore.desc',
    descFallback: '发现未听过/最少播放的歌曲'
  },
  {
    name: 'ftop',
    args: '<N | -N | A B>',
    descKey: 'aidj.cmd.ftop.desc',
    descFallback: '推送播放次数 Top/倒数/区间'
  },
  {
    name: 'analyse',
    args: '<language|emotion|genre|loudness>',
    descKey: 'aidj.cmd.analyse.desc',
    descFallback: '元数据分布统计（system 消息）'
  },
  {
    name: 'filter',
    args: '[--count] [--compare] [--ignorecase] <表达式>  [字段:值]',
    descKey: 'aidj.cmd.filter.desc',
    descFallback: '按表达式过滤曲库（title/lyrics/all + [字段:值] 元数据筛选）'
  },
  {
    name: 'persist',
    args: '<消息>',
    descKey: 'aidj.cmd.persist.desc',
    descFallback: '分支当前会话为持久会话并后台自动播放'
  },
  {
    name: 'persist-stop',
    args: '',
    descKey: 'aidj.cmd.persistStop.desc',
    descFallback: '停止运行中的持久会话'
  }
]

export function filterChatCommands(raw: string): ChatCommandDef[] {
  if (!raw.startsWith('/')) return []
  const first = raw.slice(1).split(/\s+/)[0].toLowerCase()
  const matched = CHAT_COMMANDS.filter((c) => c.name.startsWith(first))
  if (matched.length === 0) return []
  const exact = CHAT_COMMANDS.find((c) => c.name === first)
  if (exact && /\s/.test(raw.slice(1))) return [exact]
  return matched
}

export function applyChatCommand(raw: string, cmd: ChatCommandDef): string {
  const rest = raw.replace(/^\/\S*/, '')
  return `/${cmd.name}${rest || ' '}`
}
