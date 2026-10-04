/**
 * Skill 插件提供方：扫描 `<skillsDir>/<目录>/SKILL.md`，一个 skill 一个插件，
 * 外加一个 `skills` 枢纽插件（`skill_load` / `skill_read_file` 两个渐进披露工具）。
 *
 * - 只在 sync 时扫描目录，**不监听文件变化**（同配置下输出逐字节稳定 → 提示词缓存友好）；
 * - 扫描结果按目录名排序；每个 skill 的 id = `skill-<slug(目录名)>`，同配置下不变；
 * - 系统提示词里只出现 skill 的 name + description，正文与附属文件由模型按需读取。
 */
import type { Dirent } from 'node:fs'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, dirname, join, resolve, sep } from 'node:path'
import { USER_CONFIG_DIR } from '../../../../../main/process/paths'
import { makeLogger } from '../../../../../main/process/logger'
import { t } from '../../../../../main/process/i18n'
import { isPluginEnabled, registerPluginProvider } from '../registry'
import type { PluginProvider, PluginTool, ToolContentResult, YayaPlugin } from '../types'
import type { YayaConfig } from '../../../types'
import { parseSkillMd } from './skill-md'

const log = makeLogger('yaya-skills')

export const SKILL_FILE_NAME = 'SKILL.md'
/** 附属文件清单上限（渐进披露：只给路径，不进上下文） */
const MAX_AUX_FILES = 200
/** 读取附属文本文件的上限，超出截断并注明 */
const MAX_TEXT_BYTES = 200 * 1024
/** 判二进制的前导字节 sniff 长度 */
const BINARY_SNIFF = 8000

export interface SkillEntry {
  /** 插件 id（`skill-<slug(目录名)>`） */
  id: string
  /** skillsDir 下的一级目录名（排序 / 定位用，稳定） */
  dirName: string
  /** frontmatter 的 name（模型与 skill_load 对话的句柄） */
  name: string
  description: string
  /** skill 目录的绝对路径 */
  dir: string
  /** SKILL.md 正文（frontmatter 已去掉） */
  body: string
}

/** 目录名 → 插件 id 用的 slug：只留 [a-z0-9-]；不可转换时退回稳定哈希 */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || createHash('sha1').update(name).digest('hex').slice(0, 12)
}

/** 配置里的 skillsDir，缺省 `~/.config/LinuxCockpit/yaya/skills` */
export function skillsDirOf(config: YayaConfig): string {
  const dir = typeof config.skillsDir === 'string' ? config.skillsDir.trim() : ''
  return dir || join(USER_CONFIG_DIR, 'yaya', 'skills')
}

/** 最近一次 sync 的结果：目录扫描 + 启用情况（tools / instructions 读它） */
interface SkillState {
  root: string
  entries: SkillEntry[]
  /** 已启用 skill 的 id（sync 时的配置快照） */
  enabled: Set<string>
}

const EMPTY_STATE: SkillState = { root: '', entries: [], enabled: new Set() }
let state: SkillState = EMPTY_STATE

/**
 * 扫描 skillsDir 的一级子目录（按目录名排序）：有 SKILL.md 且解析出 name 的才算
 * skill，解析失败只记日志并跳过，不拖垮整个插件表。
 */
export function scanSkillEntries(root: string): SkillEntry[] {
  let dirNames: string[]
  try {
    dirNames = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
  dirNames.sort((a, b) => a.localeCompare(b))

  const used = new Set<string>()
  const out: SkillEntry[] = []
  for (const dirName of dirNames) {
    const file = join(root, dirName, SKILL_FILE_NAME)
    let raw: string
    try {
      if (!existsSync(file)) continue
      if (!resolveInside(join(root, dirName), SKILL_FILE_NAME)) {
        log.warn('SKILL.md resolves outside its directory, skipped', { dir: dirName })
        continue
      }
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      log.warn('failed to read SKILL.md, skill skipped', { dir: dirName, error: String(e) })
      continue
    }
    const parsed = parseSkillMd(raw)
    if (!parsed) {
      log.warn('SKILL.md without a usable name, skill skipped', { dir: dirName })
      continue
    }
    const base = `skill-${skillSlug(dirName)}`
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`
    used.add(id)
    out.push({
      id,
      dirName,
      name: parsed.name,
      description: parsed.description,
      dir: join(root, dirName),
      body: parsed.body
    })
  }
  return out
}

function enabledEntries(): SkillEntry[] {
  return state.entries.filter((e) => state.enabled.has(e.id))
}

// ---------------------------------------------------------------------------
// 系统提示词：固定英文引导 + 每个已启用 skill 一行（按目录名排序 → 逐字节稳定）
// ---------------------------------------------------------------------------

const SKILL_HINT =
  "The following skills are available. When the user's request matches a skill's description, " +
  "call skill_load to read its full instructions before acting on the task; read that skill's " +
  'extra files (references, scripts) with skill_read_file.'

function buildSkillInstructions(): string {
  const entries = enabledEntries()
  if (entries.length === 0) return ''
  const lines = entries.map((e) =>
    e.description ? `- ${e.name}: ${e.description}` : `- ${e.name}`
  )
  return `${SKILL_HINT}\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// 附属文件：清单 + 读取（路径必须留在 skill 目录内）
// ---------------------------------------------------------------------------

/** 递归列出附属文件（相对路径，`/` 分隔）：跳过隐藏项与 node_modules，最多 MAX_AUX_FILES 个 */
export function listAuxFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    if (out.length >= MAX_AUX_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= MAX_AUX_FILES) return
      if (e.name.startsWith('.') || (e.isDirectory() && e.name === 'node_modules')) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(child)
      // SKILL.md 是主文件（skill_load 已给正文），不算附属文件
      else if (e.isFile() && child !== SKILL_FILE_NAME) out.push(child)
    }
  }
  walk('')
  return out
}

/**
 * 把 skill 内的相对路径解析成绝对路径；越界一律 null——
 * 绝对路径、空路径、`..` 逃逸、realpath 后不在 skill 目录内（符号链接）。
 * 目标不存在时退到最近的真实祖先校验（拦住指向目录外的符号链接目录）。
 */
export function resolveInside(base: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath)) return null
  const target = resolve(base, relPath)
  if (target !== base && !target.startsWith(base + sep)) return null
  let realBase: string
  try {
    realBase = realpathSync(base)
  } catch {
    return null
  }
  let probe = target
  for (;;) {
    let real: string
    try {
      real = realpathSync(probe)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return null
      probe = parent
      continue
    }
    const inside = real === realBase || real.startsWith(realBase + sep)
    return inside ? target : null
  }
}

/** 读附属文件：二进制返回占位说明，文本超过 MAX_TEXT_BYTES 截断并注明 */
function readSkillFile(file: string, size: number): string {
  const fd = openSync(file, 'r')
  try {
    const sniff = Buffer.alloc(BINARY_SNIFF)
    const sniffed = readSync(fd, sniff, 0, BINARY_SNIFF, 0)
    if (sniff.subarray(0, sniffed).includes(0)) return `[binary file, ${size} bytes]`
    const cap = Math.min(size, MAX_TEXT_BYTES)
    const buf = Buffer.alloc(cap)
    let filled = 0
    while (filled < cap) {
      const n = readSync(fd, buf, filled, cap - filled, filled)
      if (n <= 0) break
      filled += n
    }
    const text = buf.toString('utf8')
    return size > cap ? `${text}\n\n[truncated: first ${cap} of ${size} bytes]` : text
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// 渐进披露工具（只读，approval: 'auto'）
// ---------------------------------------------------------------------------

function findEnabledSkill(name: string): SkillEntry | null {
  const entries = enabledEntries()
  return entries.find((e) => e.name === name) ?? entries.find((e) => e.dirName === name) ?? null
}

function unavailableSkill(name: string): ToolContentResult {
  const available = enabledEntries()
    .map((e) => e.name)
    .filter(Boolean)
    .join(', ')
  return {
    content: [
      {
        type: 'text',
        text: available
          ? `Unknown skill "${name}". Available skills: ${available}`
          : `Unknown skill "${name}". No skill is currently enabled.`
      }
    ],
    isError: true
  }
}

const loadTool: PluginTool = {
  name: 'load',
  description:
    "Load a skill's full instructions by name (names are listed in the system prompt). " +
    'Returns the skill body plus the relative paths of its extra files.',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Skill name as listed in the system prompt' }
    }
  },
  approval: 'auto',
  run: async (args) => {
    const name = String(args.name ?? '')
    const entry = findEnabledSkill(name)
    if (!entry) return unavailableSkill(name)
    const files = listAuxFiles(entry.dir)
    const parts = [entry.body]
    if (files.length > 0) {
      parts.push(
        `Extra files in this skill (read them with skill_read_file):\n${files
          .map((f) => `- ${f}`)
          .join('\n')}`
      )
    }
    return parts.filter((p) => p).join('\n\n')
  }
}

const readFileTool: PluginTool = {
  name: 'read_file',
  description: "Read a file inside a skill's directory (path relative to the skill, read-only).",
  parameters: {
    type: 'object',
    required: ['name', 'path'],
    properties: {
      name: { type: 'string', description: 'Skill name as listed in the system prompt' },
      path: {
        type: 'string',
        description: 'File path relative to the skill directory (e.g. "docs/reference.md")'
      }
    }
  },
  approval: 'auto',
  run: async (args) => {
    const name = String(args.name ?? '')
    const rel = String(args.path ?? '')
    const entry = findEnabledSkill(name)
    if (!entry) return unavailableSkill(name)
    const file = resolveInside(entry.dir, rel)
    if (!file) {
      return {
        content: [
          { type: 'text', text: `Invalid path (must stay inside the skill directory): ${rel}` }
        ],
        isError: true
      }
    }
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(file)
    } catch {
      return { content: [{ type: 'text', text: `File not found: ${rel}` }], isError: true }
    }
    if (!st.isFile()) {
      return { content: [{ type: 'text', text: `Not a file: ${rel}` }], isError: true }
    }
    return readSkillFile(file, st.size)
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

function skillPlugin(entry: SkillEntry): YayaPlugin {
  return {
    id: entry.id,
    kind: 'skill',
    label: entry.name,
    description: entry.description || t('yaya.skill.no_desc', '（无描述）'),
    icon: 'mdi-book-open-page-variant-outline',
    defaultEnabled: true,
    // 给人看的文档 = SKILL.md 正文
    docs: entry.body,
    // skill 本身不带工具，工具集中在 skills 枢纽插件上
    tools: () => []
  }
}

function skillsHub(): YayaPlugin {
  return {
    id: 'skills',
    kind: 'skill',
    label: t('yaya.skill.hub_label', 'Skills'),
    labelKey: 'yaya.skill.hub_label',
    description: t('yaya.skill.hub_desc', '按需读取 Skill 的完整说明与附属文件'),
    descriptionKey: 'yaya.skill.hub_desc',
    icon: 'mdi-book-multiple-outline',
    // wire name = skill_load / skill_read_file
    namespace: 'skill',
    defaultEnabled: true,
    instructions: () => buildSkillInstructions(),
    tools: () => (state.enabled.size > 0 ? [loadTool, readFileTool] : [])
  }
}

export const skillsProvider: PluginProvider = {
  id: 'skills',
  sync: (config: YayaConfig): YayaPlugin[] => {
    const root = skillsDirOf(config)
    const entries = scanSkillEntries(root)
    // 启用判定走注册表统一入口（config.pluginEnabled[id] 优先于缺省值）
    const plugins = entries.map(skillPlugin)
    state = {
      root,
      entries,
      enabled: new Set(plugins.filter((p) => isPluginEnabled(p, config)).map((p) => p.id))
    }
    return [skillsHub(), ...plugins]
  }
}
registerPluginProvider(skillsProvider)

/** 供命令用：把插件 id 解析回 skill 目录（只认最近一次扫描到的、位于 root 内的一级子目录） */
export function skillDirById(id: string, root: string): string | null {
  if (!id.startsWith('skill-') || id === 'skills') return null
  if (state.root !== root) return null
  const entry = state.entries.find((e) => e.id === id)
  if (!entry) return null
  const dir = resolve(entry.dir)
  return dir === root || dir.startsWith(root + sep) ? dir : null
}
