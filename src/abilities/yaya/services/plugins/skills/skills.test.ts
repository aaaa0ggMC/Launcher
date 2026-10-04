/**
 * Skill 提供方自检：SKILL.md frontmatter 解析、路径逃逸、instructions 稳定性。
 *
 * 安全纪律：只操作 os.tmpdir() 下的临时目录当 skills root；并且先把 HOME 指到
 * 临时目录再动态 import provider——间接依赖的 logger 在模块加载时会
 * mkdirSync(LOG_DIR)，不改 HOME 就会写进真实 ~/.config。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { parseSkillMd } from './skill-md'
import type { PluginTool, ToolContentResult, ToolRunContext } from '../types'
import type { YayaConfig } from '../../../types'

type Provider = typeof import('./provider')

const TMP_ROOT = tmpdir()
process.env.HOME = sandboxHome()

let provider!: Provider
const tmpRoots: string[] = []
const ctx = {} as ToolRunContext

/**
 * HOME 指到 os.tmpdir() 下的固定沙箱目录（先清掉上一轮的遗留）：
 * 间接依赖的 logger 会在模块加载时把日志写进去，绝不能落到真实 ~/.config。
 * 这里不注册 after() 清理——logger 的异步写盘会在删除后报 ENOENT，
 * 反而把测试判失败；下一轮启动时先清即可。
 */
function sandboxHome(): string {
  const dir = mkdtempSync(join(TMP_ROOT, 'yaya-skills-home-'))
  assert.ok(dir.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  return dir
}

/** 在 os.tmpdir() 下建临时目录；本测试绝不读写真实用户目录 */
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(TMP_ROOT, prefix))
  assert.ok(dir.startsWith(`${TMP_ROOT}${sep}`), '临时目录必须位于 os.tmpdir() 下')
  tmpRoots.push(dir)
  return dir
}

function writeSkill(root: string, dirName: string, md: string): string {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf8')
  return dir
}

function cfg(root: string, pluginEnabled?: Record<string, boolean>): YayaConfig {
  return { skillsDir: root, pluginEnabled } as unknown as YayaConfig
}

before(async () => {
  provider = await import('./provider')
})

after(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响结果
    }
  }
})

describe('parseSkillMd', () => {
  it('parses name / description and the body', () => {
    const md = ['---', 'name: demo', 'description: 演示 skill', '---', '', '# 正文', '内容'].join(
      '\n'
    )
    assert.deepEqual(parseSkillMd(md), {
      name: 'demo',
      description: '演示 skill',
      body: '# 正文\n内容'
    })
  })

  it('accepts quoted values with colons / hashes inside', () => {
    const md = ['---', 'name: "quoted-demo"', "description: 'it''s a # test: ok'", '---', 'x'].join(
      '\n'
    )
    const parsed = parseSkillMd(md)
    assert.equal(parsed?.name, 'quoted-demo')
    assert.equal(parsed?.description, "it's a # test: ok")
  })

  it('folds `>` block scalars into one line', () => {
    const md = ['---', 'name: folded', 'description: >', '  第一行', '  第二行', '---', 'b'].join(
      '\n'
    )
    assert.equal(parseSkillMd(md)?.description, '第一行 第二行')
  })

  it('keeps newlines and relative indent in `|` block scalars', () => {
    const md = [
      '---',
      'name: literal',
      'description: |',
      '  第一行',
      '    缩进',
      '  第三行',
      '---',
      'b'
    ].join('\n')
    assert.equal(parseSkillMd(md)?.description, '第一行\n  缩进\n第三行')
  })

  it('ignores unknown keys, comments and blank lines in frontmatter', () => {
    const md = [
      '---',
      '# 注释',
      'name: kept',
      '',
      'license: MIT',
      'allowed-tools: [bash]',
      'description: 保留',
      '---',
      'body'
    ].join('\n')
    const parsed = parseSkillMd(md)
    assert.equal(parsed?.name, 'kept')
    assert.equal(parsed?.description, '保留')
    assert.equal(parsed?.body, 'body')
  })

  it('returns null without frontmatter / without name / with broken frontmatter', () => {
    assert.equal(parseSkillMd('# 只有正文\n没有 frontmatter'), null)
    assert.equal(parseSkillMd('---\ndescription: 缺 name\n---\nbody'), null)
    assert.equal(parseSkillMd('---\nname: x\ndescription: 漏了闭合\nbody'), null)
  })

  it('unquoted empty value becomes an empty description', () => {
    const parsed = parseSkillMd('---\nname: empty\ndescription:\n---\nbody')
    assert.equal(parsed?.description, '')
    assert.equal(parsed?.body, 'body')
  })
})

describe('skillSlug', () => {
  it('makes safe single-segment slugs and falls back to a stable hash', () => {
    assert.equal(provider.skillSlug('My Skill!'), 'my-skill')
    assert.equal(provider.skillSlug('..'), provider.skillSlug('..'))
    assert.match(provider.skillSlug('中文目录'), /^[0-9a-f]{12}$/)
    // 目录名不同 → 插件 id 不同（中文名不会互相撞车）
    assert.notEqual(provider.skillSlug('目录一'), provider.skillSlug('目录二'))
  })
})

describe('resolveInside', () => {
  it('rejects absolute paths, `..` escapes and symlink escapes', () => {
    const root = tmpDir('yaya-skills-inside-')
    const base = join(root, 'skill')
    mkdirSync(base, { recursive: true })
    writeFileSync(join(root, 'outside.txt'), 'secret', 'utf8')
    symlinkSync(join(root, 'outside.txt'), join(base, 'evil-link'))

    assert.equal(provider.resolveInside(base, '/etc/passwd'), null)
    assert.equal(provider.resolveInside(base, ''), null)
    assert.equal(provider.resolveInside(base, '../outside.txt'), null)
    assert.equal(provider.resolveInside(base, 'docs/../../outside.txt'), null)
    assert.equal(provider.resolveInside(base, 'evil-link'), null)
    assert.ok(provider.resolveInside(base, 'docs/a.md')?.endsWith(`docs${sep}a.md`))
    assert.equal(provider.resolveInside(base, 'a/../b.md'), provider.resolveInside(base, 'b.md'))
    // 不存在的路径也先过边界校验，返回 null 一律视为越界，「文件不存在」由读取时报
    const missing = provider.resolveInside(base, 'missing-dir/a.md')
    assert.ok(missing && missing.startsWith(`${base}${sep}`))
  })
})

describe('skills provider', () => {
  it('scans by directory name, lists skills in instructions and stays byte-stable', () => {
    const root = tmpDir('yaya-skills-root-')
    writeSkill(root, 'zzz-last', '---\nname: Zeta\ndescription: 最后\n---\nzeta body')
    writeSkill(root, 'aaa-first', '---\nname: Alpha\ndescription: 最前\n---\nalpha body')
    // 没有 SKILL.md 的一级目录不算 skill
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })
    // frontmatter 缺 name 的目录被跳过
    writeSkill(root, 'broken', '# 没有 frontmatter')

    const plugins = provider.skillsProvider.sync(cfg(root))
    const skillIds = plugins.filter((p) => p.kind === 'skill' && p.id !== 'skills').map((p) => p.id)
    assert.deepEqual(skillIds, ['skill-aaa-first', 'skill-zzz-last'])

    const hub = plugins.find((p) => p.id === 'skills')
    assert.ok(hub)
    const expected =
      "The following skills are available. When the user's request matches a skill's " +
      'description, call skill_load to read its full instructions before acting on the task; ' +
      "read that skill's extra files (references, scripts) with skill_read_file.\n\n" +
      '- Alpha: 最前\n- Zeta: 最后'
    const firstRun = hub.instructions?.() ?? ''
    assert.equal(firstRun, expected)
    // 同配置再 sync 一次，输出必须逐字节相同
    const hub2 = provider.skillsProvider.sync(cfg(root)).find((p) => p.id === 'skills')
    assert.equal(hub2?.instructions?.() ?? '', firstRun)

    // 渐进披露：skill 插件本身不带工具，枢纽插件两个只读工具
    for (const p of plugins.filter((x) => x.kind === 'skill' && x.id !== 'skills')) {
      assert.deepEqual(p.tools(), [])
    }
    const tools = hub.tools()
    assert.deepEqual(
      tools.map((x) => x.name),
      ['load', 'read_file']
    )
    assert.ok(tools.every((x) => x.approval === 'auto'))
  })

  it('honours pluginEnabled: disabled skills drop out of instructions and tools', () => {
    const root = tmpDir('yaya-skills-off-')
    writeSkill(root, 'only', '---\nname: Only\ndescription: 唯一\n---\nbody')

    const off = provider.skillsProvider.sync(cfg(root, { 'skill-only': false }))
    const hubOff = off.find((p) => p.id === 'skills')
    assert.equal(hubOff?.instructions?.() ?? '', '')
    assert.deepEqual(hubOff?.tools(), [])

    const on = provider.skillsProvider.sync(cfg(root))
    const hubOn = on.find((p) => p.id === 'skills')
    assert.equal(hubOn?.tools().length, 2)
    assert.ok((hubOn?.instructions?.() ?? '').includes('- Only: 唯一'))
  })

  it('skill_load returns the body plus the aux file list, skill_read_file reads it', async () => {
    const root = tmpDir('yaya-skills-files-')
    const dir = writeSkill(root, 'pdf-tools', '---\nname: pdf\ndescription: PDF\n---\ns Kill body')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'ref.md'), '参考内容', 'utf8')
    writeFileSync(join(dir, 'helper.sh'), '#!/bin/sh\n', 'utf8')
    writeFileSync(join(dir, 'notes.md'), '跳过清单里的名字', 'utf8')
    // 隐藏项与 node_modules 不出现在附属文件清单里
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8')
    writeFileSync(join(dir, '.hidden'), 'x', 'utf8')

    const hub = provider.skillsProvider.sync(cfg(root)).find((p) => p.id === 'skills')
    const load = hub!.tools().find((x) => x.name === 'load') as PluginTool
    const readFile = hub!.tools().find((x) => x.name === 'read_file') as PluginTool

    const loaded = (await load.run({ name: 'pdf' }, ctx)) as string
    assert.ok(loaded.startsWith('s Kill body'))
    assert.ok(loaded.includes('- docs/ref.md'))
    assert.ok(loaded.includes('- helper.sh'))
    assert.ok(loaded.includes('- notes.md'))
    assert.ok(!loaded.includes('SKILL.md'))
    assert.ok(!loaded.includes('node_modules'))
    assert.ok(!loaded.includes('.hidden'))

    const text = (await readFile.run({ name: 'pdf', path: 'docs/ref.md' }, ctx)) as string
    assert.equal(text, '参考内容')

    // 未知 skill / 越界路径都报错
    const unknown = (await readFile.run({ name: 'nope', path: 'docs/ref.md' }, ctx)) as {
      isError?: boolean
    }
    assert.equal(unknown.isError, true)
    const escape = (await readFile.run(
      { name: 'pdf', path: '../../../etc/passwd' },
      ctx
    )) as ToolContentResult
    assert.equal(escape.isError, true)
  })
})
