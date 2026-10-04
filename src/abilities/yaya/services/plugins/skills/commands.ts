/**
 * Skill 命令：目录查询、导入、重扫、删除。
 *
 * 导入要读用户给的任意路径 → `SCOPE_EXEC`；删除不可恢复 → agent 本人不许调。
 * 导入 / 删除 / 重扫完成后统一 refreshPlugins + 广播，界面与插件表立即同步。
 */
import type { Dirent } from 'node:fs'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { CommandSpec } from '../../../../../main/process/commands/types'
import { SCOPE_EXEC } from '../../../../../main/process/privacy'
import { getBroadcast } from '../../../../../main/process/broadcast'
import { t, te } from '../../../../../main/process/i18n'
import { makeLogger } from '../../../../../main/process/logger'
import { loadYayaConfig } from '../../config'
import { refreshPlugins } from '../registry'
import { parseSkillMd } from './skill-md'
import { SKILL_FILE_NAME, skillDirById, skillSlug, skillsDirOf } from './provider'

const log = makeLogger('yaya-skills')

/** 单个 skill 目录导入的体积上限（50MB） */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024

/** 导入 / 统计大小时统一跳过的条目：node_modules 与隐藏目录 */
function skipEntry(name: string, isDir: boolean): boolean {
  if (name === 'node_modules') return true
  return isDir && name.startsWith('.')
}
function dirSize(dir: string): number {
  let total = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    if (skipEntry(e.name, e.isDirectory())) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) total += dirSize(p)
    else if (e.isFile()) {
      try {
        total += statSync(p).size
      } catch {
        // 拷贝过程中被移除的文件忽略
      }
    }
    if (total > MAX_IMPORT_BYTES) break
  }
  return total
}

/** cpSync 的过滤器：不把 node_modules / 隐藏目录带进 skill 目录（根目录本身不过滤） */
function copyFilter(srcRoot: string) {
  return (from: string): boolean => {
    if (resolve(from) === srcRoot) return true
    const name = basename(from)
    if (name === 'node_modules') return false
    if (name.startsWith('.')) {
      try {
        return !statSync(from).isDirectory()
      } catch {
        return false
      }
    }
    return true
  }
}

/** 刷新插件表并广播（导入 / 删除 / 重扫共用） */
function refreshAndBroadcast(): number {
  const config = loadYayaConfig()
  const plugins = refreshPlugins(config)
  getBroadcast()('cockpit:yaya-plugins-changed', {})
  return plugins.filter((p) => p.kind === 'skill' && p.id !== 'skills').length
}

export const skillCommands: CommandSpec[] = [
  {
    name: 'yaya.skills-dir',
    description: t('yaya.skill.cmd_dir_desc', '获取 Skill 目录路径（不存在则创建）'),
    usage: 'yaya.skills-dir',
    run: async () => {
      const dir = skillsDirOf(loadYayaConfig())
      mkdirSync(dir, { recursive: true })
      return { path: dir }
    }
  },

  {
    name: 'yaya.skills-import',
    description: t(
      'yaya.skill.cmd_import_desc',
      '从本地目录导入 Skill（目录内需直接包含 SKILL.md）'
    ),
    usage: 'yaya.skills-import --path <dir> [--overwrite true]',
    // 读用户指定的任意路径 → 等同 system.exec；只许用户本人 / 已授权 agent 触发
    privacy: { requires: [SCOPE_EXEC] },
    run: async (ctx) => {
      const src = String(ctx.named.path ?? '')
      if (!src || !existsSync(src) || !statSync(src).isDirectory()) {
        throw new Error(te('yaya.skill.err.no_dir', { path: src }, '目录不存在：{path}'))
      }
      const skillFile = join(src, SKILL_FILE_NAME)
      if (!existsSync(skillFile)) {
        throw new Error(
          te('yaya.skill.err.no_skill_md', { path: src }, '目录下没有 SKILL.md：{path}')
        )
      }
      const parsed = parseSkillMd(readFileSync(skillFile, 'utf8'))
      if (!parsed) {
        throw new Error(
          te(
            'yaya.skill.err.bad_skill_md',
            { path: skillFile },
            'SKILL.md 解析失败（frontmatter 至少要有 name）：{path}'
          )
        )
      }
      if (dirSize(src) > MAX_IMPORT_BYTES) {
        throw new Error(
          te(
            'yaya.skill.err.too_large',
            { path: src, limit: '50MB' },
            '目录体积超过 50MB 上限：{path}'
          )
        )
      }

      const root = skillsDirOf(loadYayaConfig())
      mkdirSync(root, { recursive: true })
      const destName = skillSlug(parsed.name)
      const dest = join(root, destName)
      const sourcePath = realpathSync(src)
      const destinationPath = existsSync(dest)
        ? realpathSync(dest)
        : join(realpathSync(root), destName)
      if (
        sourcePath === destinationPath ||
        destinationPath.startsWith(sourcePath + sep) ||
        sourcePath.startsWith(destinationPath + sep)
      ) {
        throw new Error(t('yaya.skill.err.overlap', '导入来源与目标目录不能相同或互相包含'))
      }
      const overwrite = ctx.named.overwrite === true || ctx.named.overwrite === 'true'
      if (existsSync(dest)) {
        if (!overwrite) {
          throw new Error(
            te(
              'yaya.skill.err.exists',
              { name: parsed.name },
              'Skill {name} 已存在；加 --overwrite true 覆盖导入'
            )
          )
        }
        rmSync(dest, { recursive: true, force: true })
      }

      cpSync(src, dest, { recursive: true, filter: copyFilter(resolve(src)) })
      refreshAndBroadcast()
      log.info('skill imported', { name: parsed.name, dir: destName })
      return { ok: true, id: `skill-${destName}`, name: parsed.name }
    }
  },

  {
    name: 'yaya.skills-rescan',
    description: t('yaya.skill.cmd_rescan_desc', '重新扫描 Skill 目录并刷新插件表'),
    usage: 'yaya.skills-rescan',
    run: async () => {
      const count = refreshAndBroadcast()
      return { ok: true, count }
    }
  },

  {
    name: 'yaya.skills-remove',
    description: t('yaya.skill.cmd_remove_desc', '删除一个已导入的 Skill（删除其目录，不可恢复）'),
    usage: 'yaya.skills-remove --id <skill plugin id>',
    // 破坏性操作：只许用户本人执行
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const root = skillsDirOf(loadYayaConfig())
      const dir = skillDirById(id, root)
      if (!dir) throw new Error(te('yaya.skill.err.not_found', { id }, 'Skill 不存在：{id}'))
      rmSync(dir, { recursive: true, force: true })
      refreshAndBroadcast()
      log.info('skill removed', { id, dir })
      return { ok: true, id }
    }
  }
]
