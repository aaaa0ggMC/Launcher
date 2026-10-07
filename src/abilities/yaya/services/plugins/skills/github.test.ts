/**
 * GitHub 导入自检：链接解析、ref 带斜杠的分界、定位 SKILL.md、下载过滤。
 * 网络全部用假的 fetch；只写 os.tmpdir() 下的临时目录。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { downloadGithubSkill, parseGithubUrl, type FetchLike } from './github'

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'yaya-gh-test-'))
  tmps.push(d)
  return d
}
after(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** 假仓库 demo/skills：分支 main 与 feature/x，两个 Skill 加一个根 README */
const FILES: Record<string, string> = {
  'README.md': '# demo',
  'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: d\n---\nbody',
  'skills/pdf/scripts/run.py': 'print(1)',
  'skills/pdf/.git/config': 'x',
  'skills/pdf/node_modules/a.js': 'x',
  'skills/pdf/.env': 'KEEP=1',
  'skills/docx/SKILL.md': '---\nname: docx\ndescription: d\n---\nbody'
}
const tree = (): unknown[] => [
  { path: 'skills', type: 'tree' },
  { path: 'skills/pdf', type: 'tree' },
  { path: 'skills/docx', type: 'tree' },
  ...Object.entries(FILES).map(([path, c]) => ({
    path,
    type: 'blob',
    mode: '100644',
    size: c.length
  })),
  { path: 'skills/pdf/link', type: 'blob', mode: '120000', size: 3 }
]

function fakeFetch(calls: string[] = []): FetchLike {
  const resp = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({
    ok: status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer as ArrayBuffer
  })
  return async (url) => {
    calls.push(url)
    const api = url.match(/^https:\/\/api\.github\.com\/repos\/demo\/skills\/git\/trees\/([^?]+)/)
    if (api) {
      const ref = decodeURIComponent(api[1])
      return ['HEAD', 'main', 'feature/x'].includes(ref)
        ? resp(200, { tree: tree() })
        : resp(404, {})
    }
    const raw = url.match(
      /^https:\/\/raw\.githubusercontent\.com\/demo\/skills\/(HEAD|main|feature\/x)\/(.+)$/
    )
    if (raw) {
      const f = FILES[decodeURIComponent(raw[2])]
      return f === undefined ? resp(404, '') : resp(200, f)
    }
    return resp(404, {})
  }
}

describe('parseGithubUrl', () => {
  it('解析各种链接', () => {
    assert.deepEqual(parseGithubUrl('https://github.com/demo/skills'), {
      owner: 'demo',
      repo: 'skills',
      rest: [],
      file: false
    })
    assert.deepEqual(parseGithubUrl('demo/skills.git')?.repo, 'skills')
    assert.deepEqual(parseGithubUrl('github.com/demo/skills/tree/feature/x/skills/pdf')?.rest, [
      'feature',
      'x',
      'skills',
      'pdf'
    ])
    assert.equal(parseGithubUrl('https://github.com/demo/skills/blob/main/a/SKILL.md')?.file, true)
    assert.deepEqual(
      parseGithubUrl('https://raw.githubusercontent.com/demo/skills/refs/heads/main/a/SKILL.md')
        ?.rest,
      ['main', 'a', 'SKILL.md']
    )
  })
  it('拒绝非 GitHub 与奇怪路径', () => {
    assert.equal(parseGithubUrl('https://gitlab.com/a/b'), null)
    assert.equal(parseGithubUrl('https://github.com/a'), null)
    assert.equal(parseGithubUrl('https://github.com/a/b/issues/1'), null)
    assert.equal(parseGithubUrl(''), null)
  })
})

describe('downloadGithubSkill', () => {
  it('仓库首页有多个 Skill → 返回候选', async () => {
    const r = await downloadGithubSkill('https://github.com/demo/skills', tmp(), {
      fetchImpl: fakeFetch()
    })
    assert.deepEqual(r.candidates, ['skills/docx', 'skills/pdf'])
  })

  it('带斜杠的分支 + 子目录：下载并跳过隐藏目录 / node_modules / 符号链接', async () => {
    const calls: string[] = []
    const root = tmp()
    const r = await downloadGithubSkill(
      'https://github.com/demo/skills/tree/feature/x/skills/pdf',
      root,
      { fetchImpl: fakeFetch(calls) }
    )
    assert.equal(r.dir, join(root, 'pdf'))
    assert.ok(readFileSync(join(r.dir!, 'SKILL.md'), 'utf8').includes('name: pdf'))
    assert.ok(existsSync(join(r.dir!, 'scripts', 'run.py')))
    assert.ok(existsSync(join(r.dir!, '.env')), '隐藏文件保留，与本地导入一致')
    assert.ok(!existsSync(join(r.dir!, '.git')))
    assert.ok(!existsSync(join(r.dir!, 'node_modules')))
    assert.ok(!existsSync(join(r.dir!, 'link')))
    assert.ok(calls.some((u) => u.includes('/raw.githubusercontent.com/demo/skills/feature/x/')))
  })

  it('blob / raw 的 SKILL.md 链接取所在目录', async () => {
    for (const u of [
      'https://github.com/demo/skills/blob/main/skills/docx/SKILL.md',
      'https://raw.githubusercontent.com/demo/skills/main/skills/docx/SKILL.md'
    ]) {
      const r = await downloadGithubSkill(u, tmp(), { fetchImpl: fakeFetch() })
      assert.ok(r.dir?.endsWith('docx'), u)
    }
  })

  it('pick 指定候选；不存在的路径报错', async () => {
    const r = await downloadGithubSkill('demo/skills', tmp(), {
      fetchImpl: fakeFetch(),
      pick: 'skills/docx'
    })
    assert.ok(r.dir?.endsWith('docx'))
    await assert.rejects(
      downloadGithubSkill('https://github.com/demo/skills/tree/main/nope', tmp(), {
        fetchImpl: fakeFetch()
      }),
      /没有这个路径/
    )
    await assert.rejects(
      downloadGithubSkill('https://github.com/demo/skills/tree/nobranch', tmp(), {
        fetchImpl: fakeFetch()
      }),
      /找不到/
    )
  })
})
