import type { CommandSpec } from './commands/types'
import { commandUnavailableReason, listCommands } from './commands/registry'
import { commandOwnerOf, isAbilityDisabled } from './ability-runtime'
import { listJobHandlerNames } from './background-tasks'
import { getAbilityMeta, getLoadedAbilityIds } from './abilities-loader'

export { renderAbilityMarkdown } from './ability-describe-render'

/**
 * 能力清单（`ability.describe`）—— 从命令注册表与作业注册表**自动生成**，
 * 而不是手写文档：命令加了/门控关了/作业注册了，清单立刻跟着变，元数据不会漂移。
 * 人（`--format md`）和 agent（json）读的是同一份数据。
 */

/** 注册表里的一条命令，附上「现在能不能跑、为什么」。 */
export interface DescribedCommand {
  name: string
  description: string
  usage?: string
  available: boolean
  unavailableReason?: string
  privacy?: CommandSpec['privacy']
  related?: string[]
  ui?: string[]
}

/** 一个能力（文件夹）的完整清单。 */
export interface AbilityDescription {
  id: string
  platforms: string[]
  provides: string[]
  dependencies: string[]
  disabled: boolean
  commands: DescribedCommand[]
  /** 名字以 `<id>.` 开头的命名作业（`background.job --name <job> --args <json>` 启动）。 */
  jobs: string[]
  /** `help/` 目录下的 Markdown 页面（只列路径，不加载内容）。 */
  help: { lang: string; path: string }[]
  /** 有 help 时的读取命令。 */
  helpHint?: string
}

/**
 * 帮助目录约定（与 `abilities/help/commands.ts` 一致）：正文放在语言目录下
 * （`help/zh-cn/main.md` ↔ `help/en-us/Player/BuiltInPlayer.md`），目录名大小写
 * 不敏感并按语言族归一化；不在语言目录下的 `help/*.md` 是语言中立基准版。
 */
const HELP_LOCALE_FAMILY: Record<string, string> = {
  zh: 'zh-cn',
  'zh-cn': 'zh-cn',
  'zh-hans': 'zh-cn',
  'zh-hant': 'zh-cn',
  en: 'en-us',
  'en-us': 'en-us',
  'en-gb': 'en-us'
}

function helpLocaleOf(seg: string): string | null {
  return HELP_LOCALE_FAMILY[seg.toLowerCase()] ?? null
}

/**
 * glob key → (能力 id, 语言, 路径)。key 形如
 * `../../abilities/<id>/help/<lang>/<rel>`（Vite 会相对本文件规范化前缀，
 * 所以按 `help` 段定位，不假定前缀）；首段是语言目录时 lang 归一化、path 去掉
 * 该段。glob 只用来枚举文件，正文读取走 `help.read`。
 */
function parseHelpKey(key: string): { id: string; lang: string; path: string } | null {
  const seg = key.split('/')
  const i = seg.indexOf('help')
  if (i <= 0) return null
  const id = seg[i - 1]
  let rest = seg.slice(i + 1)
  // 首段只有在后面还有内容时才算语言目录（`help/zh-cn.md` 这类歧名按普通页面处理）。
  const loc = rest.length > 1 ? helpLocaleOf(rest[0]) : null
  const lang = loc ?? ''
  if (loc) rest = rest.slice(1)
  const path = rest.join('/')
  if (!id || !path || !path.toLowerCase().endsWith('.md')) return null
  return { id, lang, path }
}

// 与 help/commands.ts 同样的 `?raw` 查询：同一批模块被去重，不会多打包一份；
// 不带 query 的 glob 会让 rollup 把 .md 当 JS 解析而构建失败。这里只用 key。
const helpDocModules = import.meta.glob<string>('../../abilities/*/help/**/*.md', {
  eager: true,
  query: '?raw',
  import: 'default'
})

const helpDocs = new Map<string, { lang: string; path: string }[]>()
for (const key of Object.keys(helpDocModules)) {
  const parsed = parseHelpKey(key)
  if (!parsed) continue
  const list = helpDocs.get(parsed.id) ?? []
  list.push({ lang: parsed.lang, path: parsed.path })
  helpDocs.set(parsed.id, list)
}
for (const list of helpDocs.values()) {
  list.sort((a, b) => a.lang.localeCompare(b.lang) || a.path.localeCompare(b.path))
}

/** 帮助提示里用的示例页面：优先 zh-cn 的 `main.md`，其次任意语言的 `main.md`。 */
function helpRootPath(help: { lang: string; path: string }[]): string {
  return (
    help.find((h) => h.path === 'main.md' && h.lang === 'zh-cn')?.path ??
    help.find((h) => h.path === 'main.md')?.path ??
    help[0]?.path ??
    'main.md'
  )
}

/** 已知能力 id：注册过命令的文件夹 + 命令表里出现过的归属（两者取并集）。 */
function knownAbilityIds(): string[] {
  const ids = new Set(getLoadedAbilityIds())
  for (const spec of listCommands()) {
    const owner = commandOwnerOf(spec.name)
    if (owner) ids.add(owner)
  }
  return [...ids].sort()
}

/** 某个能力的命令清单（按 name 排序）。默认不列 `privacy.agent === 'deny'` 的命令。 */
async function describeCommands(id: string, includeDenied: boolean): Promise<DescribedCommand[]> {
  const specs = listCommands()
    .filter((s) => commandOwnerOf(s.name) === id)
    .filter((s) => includeDenied || s.privacy?.agent !== 'deny')
    .sort((a, b) => a.name.localeCompare(b.name))
  return Promise.all(
    specs.map(async (s) => {
      const reason = await commandUnavailableReason(s.name)
      return {
        name: s.name,
        description: s.description,
        usage: s.usage,
        available: reason === null,
        unavailableReason: reason ?? undefined,
        privacy: s.privacy,
        related: s.related,
        ui: s.ui
      }
    })
  )
}

/**
 * 生成一个能力的清单；`id` 不存在（没有任何命令、也不在已加载能力里）时返回 null。
 */
export async function describeAbility(
  id: string,
  opts?: { includeDenied?: boolean }
): Promise<AbilityDescription | null> {
  if (!knownAbilityIds().includes(id)) return null
  const meta = getAbilityMeta(id)
  const commands = await describeCommands(id, opts?.includeDenied === true)
  const help = helpDocs.get(id) ?? []
  return {
    id,
    platforms: meta.platforms ?? [],
    provides: meta.provides ?? [],
    dependencies: meta.dependencies ?? [],
    disabled: isAbilityDisabled(id),
    commands,
    jobs: listJobHandlerNames().filter((n) => n.startsWith(`${id}.`)),
    help,
    helpHint: help.length
      ? `help.read --ability ${id} --path ${helpRootPath(help)} [--lang zh|en-US]`
      : undefined
  }
}

/** 所有能力的摘要（不带 `--id` 时的 `ability.describe` 结果）。 */
export async function describeAllAbilities(): Promise<
  { id: string; commands: number; available: number; jobs: number; help: boolean }[]
> {
  const out: { id: string; commands: number; available: number; jobs: number; help: boolean }[] = []
  for (const id of knownAbilityIds()) {
    const d = await describeAbility(id)
    if (!d) continue
    out.push({
      id,
      commands: d.commands.length,
      available: d.commands.filter((c) => c.available).length,
      jobs: d.jobs.length,
      help: d.help.length > 0
    })
  }
  return out
}
