export interface ChatCommandDef {
  name: string
  args: string
  descKey: string
  descFallback: string
  /** Other spellings ChatView's `handleCommand` accepts (e.g. `/pc` → `/persist`). */
  aliases?: string[]
  /**
   * Backend commands / named jobs this slash command actually triggers — the
   * cross-layer map an agent needs (a UI slash name is NOT a backend command).
   * Named jobs carry a `job:` prefix (start via `background.job --name <name>`).
   * Only calls that make up the flow are listed; the shared progress poller
   * (`aidj.stream-status`) is used by /pr and by plain chat alike, so it is not
   * part of any slash command's mapping.
   */
  backend: string[]
}

export const CHAT_COMMANDS: ChatCommandDef[] = [
  {
    name: 'random',
    args: '<number>',
    descKey: 'aidj.cmd.random.desc',
    descFallback: '随机选取 N 首歌曲',
    backend: ['aidj.random']
  },
  {
    name: 'pr',
    args: '<number>',
    descKey: 'aidj.cmd.pr.desc',
    descFallback: 'AI 从随机候选中精选歌单',
    backend: ['aidj.curate']
  },
  {
    name: 'explore',
    args: '<number>',
    descKey: 'aidj.cmd.explore.desc',
    descFallback: '发现未听过/最少播放的歌曲',
    backend: ['aidj.explore']
  },
  {
    name: 'ftop',
    args: '<N | -N | A B>',
    descKey: 'aidj.cmd.ftop.desc',
    descFallback: '推送播放次数 Top/倒数/区间',
    backend: ['aidj.ftop']
  },
  {
    name: 'analyse',
    args: '<language|emotion|genre|loudness>',
    descKey: 'aidj.cmd.analyse.desc',
    descFallback: '元数据分布统计（system 消息）',
    backend: ['aidj.analyse']
  },
  {
    name: 'filter',
    args: '[--count] [--compare] [--ignorecase] <表达式>  [字段:值]',
    descKey: 'aidj.cmd.filter.desc',
    descFallback: '按表达式过滤曲库（title/lyrics/all + [字段:值] 元数据筛选）',
    backend: ['aidj.filter']
  },
  {
    name: 'persist',
    args: '<消息>',
    descKey: 'aidj.cmd.persist.desc',
    descFallback: '分支当前会话为持久会话并后台自动播放',
    aliases: ['pc'],
    // forks the current session, resolves the push target, then runs the
    // persistent chat job — deliberately NOT the legacy `aidj.start-persistent`.
    backend: ['aidj.session-fork', 'aidj.status', 'job:aidj.chat']
  },
  {
    name: 'persist-stop',
    args: '',
    descKey: 'aidj.cmd.persistStop.desc',
    descFallback: '停止运行中的持久会话',
    aliases: ['pc-stop'],
    // stops the background task the job returned — not `aidj.stop-persistent`.
    backend: ['background.stop']
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
