/**
 * 仅无头宿主注册的命令（Electron 版有原生对话框，不需要）。
 *
 * `host.fs.list` 给网页端的「宿主文件选择器」用：浏览器拿不到宿主机上的绝对路径，
 * 只能让用户在宿主文件系统里点选。这是用户交互动作，agent 一律拒绝（`agent: 'deny'`）。
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { registerAll } from '../main/process/commands/registry'
import type { CommandSpec } from '../main/process/commands/types'

interface FsEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
}

export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
  /** 快捷入口：家目录、根、Termux 共享存储等 */
  roots: { label: string; path: string }[]
  error?: string
}

function quickRoots(): FsListing['roots'] {
  const home = homedir()
  const roots = [{ label: 'home', path: home }]
  // Termux：`termux-setup-storage` 之后 ~/storage/shared 指向手机存储
  const shared = join(home, 'storage', 'shared')
  if (existsSync(shared)) roots.push({ label: 'storage', path: shared })
  roots.push({ label: 'root', path: resolve('/') })
  return roots
}

async function list(dirArg: unknown): Promise<FsListing> {
  const path = resolve(typeof dirArg === 'string' && dirArg ? dirArg : homedir())
  const base = { path, parent: dirname(path) === path ? null : dirname(path), roots: quickRoots() }
  try {
    const names = await readdir(path, { withFileTypes: true })
    const entries: FsEntry[] = []
    for (const d of names) {
      let isDir = d.isDirectory()
      let size: number | undefined
      try {
        // 符号链接要跟进，才能判断指向的是目录还是文件
        const st = await stat(join(path, d.name))
        isDir = st.isDirectory()
        size = isDir ? undefined : st.size
      } catch {
        continue // 断链 / 无权限的条目直接略过
      }
      entries.push({ name: d.name, type: isDir ? 'dir' : 'file', size })
    }
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
    )
    return { ...base, entries }
  } catch (e) {
    return { ...base, entries: [], error: (e as NodeJS.ErrnoException).code ?? String(e) }
  }
}

const commands: CommandSpec[] = [
  {
    name: 'host.fs.list',
    description: '列出宿主机目录（网页端文件选择器用）；缺省为家目录',
    usage: 'host.fs.list [--path <dir>]',
    privacy: { agent: 'deny' },
    ui: ['网页模式下的文件 / 文件夹选择对话框'],
    run: (ctx) => list(ctx.named.path)
  }
]

export function registerHostCommands(): void {
  registerAll(commands, 'headless')
}
