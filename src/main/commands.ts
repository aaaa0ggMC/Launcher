import type { AppEntry } from '../shared/types'
import {
  listAllApps,
  getEntry,
  updateEntry,
  deleteEntry,
  addSearchRoot,
  removeSearchRoot,
  getAppsConfig,
  writeRegistry
} from './registry'
import { rescanRoot } from './scanner'
import { launchEntry } from './launcher'
import { getMirrorInfo, toggleMirror, testMirrors } from './mirror'
import { listAutostart, toggleAutostart } from './autostart'
import { listSystemd, systemdAction } from './systemd'
import { listDocker, dockerAction } from './docker'
import { gpuInfo, readPmValue, togglePm } from './gpu'
import { listWallpapers, applyWallpaper, listOutputs } from './display'
import { systemStats } from './system'
import { getDashboardLayout, setDashboardLayout, resetDashboardLayout } from './ui-state'
import { readJson, writeJsonAtomic } from './util'
import { CONFIG_JSON } from './paths'
import { BrowserWindow } from 'electron'

// ---------------------------------------------------------------------------
// CLI-first command registry. Every ability operation is a registered command;
// the CLI REPL and the UI (window.cockpit.command) dispatch through here.
// ---------------------------------------------------------------------------

export interface CommandContext {
  /** --key value pairs (CLI) or structured object (UI via IPC). */
  named: Record<string, unknown>
  /** bare positional tokens (CLI). */
  positional: string[]
}

export interface CommandSpec {
  /** kebab-case, namespaced `<ability>.<command>` */
  name: string
  description: string
  usage?: string
  run: (ctx: CommandContext) => unknown | Promise<unknown>
}

const commands = new Map<string, CommandSpec>()

function register(
  name: string,
  description: string,
  usage: string | undefined,
  run: CommandSpec['run']
): void {
  commands.set(name, { name, description, usage, run })
}

// -- config ---------------------------------------------------------------
register('config.get', '读取全局配置', 'config.get', async () => readJson(CONFIG_JSON))
register(
  'config.set',
  '更新全局配置 (--patch <json>)',
  'config.set --patch {"theme":"pureblack"}',
  async (ctx) => {
    const patch = ctx.named.patch as Record<string, unknown>
    if (typeof patch === 'string') {
      try {
        return await applyConfigPatch(JSON.parse(patch))
      } catch {
        return { ok: false, error: 'patch 不是合法 JSON' }
      }
    }
    return await applyConfigPatch(patch ?? {})
  }
)

async function applyConfigPatch(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = (await readJson<Record<string, unknown>>(CONFIG_JSON)) ?? {}
  const merged = { ...cfg, ...patch }
  await writeJsonAtomic(CONFIG_JSON, merged)
  return merged
}

// -- apps registry ----------------------------------------------------------
register('apps.list', '列出所有搜索目录下的应用', 'apps.list', async () => listAllApps())
register(
  'apps.get',
  '读取单个条目 (--root --id)',
  'apps.get --root ~/Apps --id bili-viewer',
  async (ctx) => {
    const root = String(ctx.named.root ?? '')
    const id = String(ctx.named.id ?? '')
    return await getEntry(root, id)
  }
)
register('apps.config', '读取 Apps 能力配置 (搜索目录等)', 'apps.config', async () =>
  getAppsConfig()
)
register(
  'apps.update',
  '更新/创建条目 (--root --id --patch <json>)',
  'apps.update --root ~/Apps --id bili-viewer --patch {"name":"x"}',
  async (ctx) => {
    const root = String(ctx.named.root ?? '')
    const id = String(ctx.named.id ?? '')
    const patch = ctx.named.patch
    if (!root || !id) return { ok: false, error: '需要 --root 与 --id' }
    const p = typeof patch === 'string' ? JSON.parse(patch) : ((patch ?? {}) as Partial<AppEntry>)
    return await updateEntry(root, id, p)
  }
)
register(
  'apps.delete',
  '删除条目 (--root --id)',
  'apps.delete --root ~/Apps --id start-rdp',
  async (ctx) => {
    const root = String(ctx.named.root ?? '')
    const id = String(ctx.named.id ?? '')
    if (!root || !id) return { ok: false, error: '需要 --root 与 --id' }
    await deleteEntry(root, id)
    return { ok: true }
  }
)
register(
  'apps.add-root',
  '添加搜索目录 (--path)',
  'apps.add-root --path /home/aaaa0ggmc/Apps',
  async (ctx) => addSearchRoot(String(ctx.named.path ?? ''))
)
register(
  'apps.remove-root',
  '移除搜索目录 (--path)',
  'apps.remove-root --path /home/aaaa0ggmc/Apps',
  async (ctx) => removeSearchRoot(String(ctx.named.path ?? ''))
)
register(
  'apps.rescan',
  '重扫目录生成草稿 (--root)',
  'apps.rescan --root /home/aaaa0ggmc/Apps',
  async (ctx) => {
    const root = String(ctx.named.root ?? '')
    const reg = await rescanRoot(root)
    await writeRegistry(root, reg)
    return reg
  }
)

// -- launcher ----------------------------------------------------------------
register(
  'launch.run',
  '启动应用 (--root --id)',
  'launch.run --root ~/Apps --id bili-viewer',
  async (ctx) => {
    const root = String(ctx.named.root ?? '')
    const id = String(ctx.named.id ?? '')
    const entry = await getEntry(root, id)
    if (!entry) return { ok: false, error: `未找到条目: ${id}` }
    return await launchEntry(entry)
  }
)

// -- system ------------------------------------------------------------------
register('system.stats', '系统实时状态 (host/GPU/docker/RAM/disk)', 'system.stats', async () =>
  systemStats()
)

// -- dashboard layout ----------------------------------------------------------
register('dashboard.get-layout', '读取总览排版', 'dashboard.get-layout', async () =>
  getDashboardLayout()
)
register(
  'dashboard.set-layout',
  '保存总览排版 (--layout <json>)',
  'dashboard.set-layout --layout []',
  async (ctx) => {
    const layout = ctx.named.layout
    const arr = typeof layout === 'string' ? JSON.parse(layout) : layout
    if (!Array.isArray(arr)) return { ok: false, error: 'layout 必须是数组' }
    await setDashboardLayout(arr)
    return { ok: true }
  }
)
register('dashboard.reset-layout', '重置总览排版为默认', 'dashboard.reset-layout', async () => {
  await resetDashboardLayout()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('cockpit:dashboard-reset')
  }
  return { ok: true }
})

// -- mirror ------------------------------------------------------------------
register('mirror.get', '当前镜像源列表与状态', 'mirror.get', async () => getMirrorInfo())
register(
  'mirror.toggle',
  '启用/禁用镜像源 (--name --enable true|false, pkexec)',
  'mirror.toggle --name USTC --enable true',
  async (ctx) => {
    const name = String(ctx.named.name ?? '')
    const enabled = ctx.named.enable === 'true' || ctx.named.enable === true
    if (!name) return { ok: false, error: '需要 --name' }
    return await toggleMirror(name, enabled)
  }
)
register('mirror.test', '测试所有镜像源连通性与速度', 'mirror.test', async () => testMirrors())

// -- autostart ---------------------------------------------------------------
register('autostart.list', '列出开机自启动项', 'autostart.list', async () => listAutostart())
register(
  'autostart.toggle',
  '启用/禁用启动项 (--file --hidden true|false)',
  'autostart.toggle --file "Clash Verge.desktop" --hidden true',
  async (ctx) => {
    const file = String(ctx.named.file ?? '')
    const hidden = ctx.named.hidden === 'true' || ctx.named.hidden === true
    if (!file) return { ok: false, error: '需要 --file' }
    await toggleAutostart(file, hidden)
    return await listAutostart()
  }
)

// -- systemd -----------------------------------------------------------------
register('systemd.list', '列出用户 systemd 服务', 'systemd.list', async () => listSystemd())
register(
  'systemd.action',
  '启动/停止/重启服务 (--name --action)',
  'systemd.action --name myservice --action restart',
  async (ctx) => {
    const name = String(ctx.named.name ?? '')
    const action = String(ctx.named.action ?? '') as 'start' | 'stop' | 'restart'
    if (!name) return { ok: false, error: '需要 --name' }
    return await systemdAction(name, action)
  }
)

// -- docker ------------------------------------------------------------------
register('docker.list', '列出 Docker 容器', 'docker.list', async () => listDocker())
register(
  'docker.action',
  '启动/停止/重启容器 (--name --action)',
  'docker.action --name new-api --action start',
  async (ctx) => {
    const name = String(ctx.named.name ?? '')
    const action = String(ctx.named.action ?? '') as 'start' | 'stop' | 'restart'
    if (!name) return { ok: false, error: '需要 --name' }
    return await dockerAction(name, action)
  }
)

// -- hardware -----------------------------------------------------------------
register('hardware.gpu', 'GPU 信息 (nvidia-smi)', 'hardware.gpu', async () => gpuInfo())
register('hardware.pm', '读取 NVreg_PreserveVideoMemoryAllocations', 'hardware.pm', async () =>
  readPmValue()
)
register('hardware.pm-toggle', '切换 0↔1 (pkexec, 重启生效)', 'hardware.pm-toggle', async () =>
  togglePm()
)

// -- display ------------------------------------------------------------------
register(
  'display.wallpapers',
  '列出壁纸 (--dir)',
  'display.wallpapers --dir ~/Pictures/Wallpapers',
  async (ctx) => listWallpapers(String(ctx.named.dir ?? ''))
)
register(
  'display.apply',
  '应用壁纸 (--path)',
  'display.apply --path /abs/to/wallpaper.jpg',
  async (ctx) => {
    const path = String(ctx.named.path ?? '')
    if (!path) return { ok: false, error: '需要 --path' }
    return { ok: await applyWallpaper(path) }
  }
)
register('display.outputs', '列出显示输出', 'display.outputs', async () => listOutputs())

// ---------------------------------------------------------------------------

export function listCommands(): CommandSpec[] {
  return [...commands.values()]
}

/** Parse `--key value` pairs + bare positional tokens. */
export function parseArgs(tokens: string[]): {
  named: Record<string, string>
  positional: string[]
} {
  const named: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('--') && t.length > 2) {
      const key = t.slice(2)
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        named[key] = next
        i++
      } else {
        named[key] = 'true'
      }
    } else {
      positional.push(t)
    }
  }
  return { named, positional }
}

function formatResult(r: unknown): string {
  if (r === null || r === undefined) return '(无结果)'
  if (typeof r === 'string') return r
  if (typeof r === 'number' || typeof r === 'boolean') return String(r)
  if (Array.isArray(r)) {
    if (r.length === 0) return '(空)'
    return r
      .map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)))
      .join('\n')
  }
  return JSON.stringify(r, null, 2)
}

/**
 * Try to run `input` as a registered command. Returns formatted CLI text, or
 * null when the first token is not a registered command (caller may fall back
 * to app-alias logic).
 */
export async function tryRunCommand(input: string): Promise<string | null> {
  const tokens = input.trim().split(/\s+/)
  const name = tokens[0]
  const spec = commands.get(name)
  if (!spec) return null
  const { named, positional } = parseArgs(tokens.slice(1))
  try {
    const result = await spec.run({ named, positional })
    return formatResult(result)
  } catch (e) {
    return `错误: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Run a command with structured args (UI path). Returns the raw structured result. */
export async function runCommand(
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const spec = commands.get(name)
  if (!spec) throw new Error(`未知命令: ${name}`)
  return await spec.run({ named: args, positional: [] })
}
