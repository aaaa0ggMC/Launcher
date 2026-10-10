/**
 * Boot services — abilities ask the shell to auto-start a background job on
 * every launch (architectural, like `startup.ts` / `background-tasks.ts`).
 *
 * An ability declares a service from its `commands.ts` (the module the main
 * process always loads):
 *
 *   registerBootService({
 *     id: 'discoverer',
 *     label: '设备发现',
 *     job: 'discoverer.scan',   // a registerJobHandler name
 *     mustComplete: false       // expendable: closing the app kills it silently
 *   })
 *
 * The user flips the switch in 设置 → 开机服务 (default OFF for everything);
 * the enable map lives in the global `config.json` under `boot`. When enabled,
 * the startup hook below starts the registered job right after command
 * registration — before the first window opens, in both the Electron app and
 * the headless host.
 *
 * `mustComplete` (default false) decides what happens when the user closes the
 * app while the task is still running:
 *  - true  → the task counts toward the quit-confirmation ("N 个后台任务仍在
 *           运行"), same as any manually started task;
 *  - false → the task is terminated directly, no dialog — its content is
 *            considered not worth guarding (a LAN beacon, a cache warmer, ...).
 */

import { existsSync } from 'fs'
import { copyFile } from 'fs/promises'
import { readJson, writeJsonAtomic } from './util'
import { CONFIG_JSON } from './paths'
import { makeLogger } from './logger'
import { registerStartupHook } from './startup'
import { startJobByName, listTasks } from './background-tasks'
import { getBroadcast } from './broadcast'

const log = makeLogger('boot-services')

export interface BootServiceDef {
  /** stable id — the key in config.json's `boot` map */
  id: string
  /** display label (Chinese default; `labelKey` wins in the settings UI) */
  label: string
  /** translation key for the label (e.g. `ability.discoverer.name`) */
  labelKey?: string
  /** one-line explanation shown under the switch */
  description?: string
  /** translation key for the description */
  descriptionKey?: string
  /** registered job handler to start (`registerJobHandler` name) */
  job: string
  /**
   * Whether quitting must ask before killing this task (default false —
   * expendable). See the module comment.
   */
  mustComplete?: boolean
  /** extra args passed to the job handler on auto-start */
  args?: Record<string, unknown>
}

/** One service + its current state, for the settings UI (`boot.list`). */
export interface BootServiceState {
  id: string
  label: string
  labelKey?: string
  description?: string
  descriptionKey?: string
  job: string
  mustComplete: boolean
  /** user switch (config.json `boot.<id>`); default false */
  enabled: boolean
  /** a task for this job is running right now */
  running: boolean
}

const services = new Map<string, BootServiceDef>()
/** service ids already auto-started in this process (no double-start) */
const started = new Set<string>()

/** Register a boot service (called once at ability load; duplicate id throws). */
export function registerBootService(def: BootServiceDef): void {
  if (!def.id || !def.job) throw new Error('registerBootService 需要 id 与 job')
  if (services.has(def.id)) throw new Error(`重复开机服务: ${def.id}`)
  services.set(def.id, def)
  log.info('boot service registered', {
    id: def.id,
    job: def.job,
    mustComplete: !!def.mustComplete
  })
}

/** Every registered boot service, sorted by id. */
export function listBootServices(): BootServiceDef[] {
  return [...services.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** config.json `boot` map: `{ '<service id>': true }` (missing = disabled). */
async function readBootMap(): Promise<Record<string, boolean>> {
  const cfg = await readJson<Record<string, unknown>>(CONFIG_JSON)
  const boot = cfg?.boot
  if (!boot || typeof boot !== 'object') return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(boot as Record<string, unknown>)) {
    if (v === true) out[k] = true
  }
  return out
}

/**
 * Flip one service's switch: read-modify-write of the whole `boot` map (same
 * safety rules as `config.set` — never merge onto an unreadable file, keep a
 * `.bak`), then broadcast `cockpit:config-changed` so every window / the web
 * client sees the new config.
 */
export async function setBootServiceEnabled(id: string, enabled: boolean): Promise<void> {
  if (!services.has(id)) throw new Error(`未知开机服务: ${id}`)
  const existed = existsSync(CONFIG_JSON)
  const current = await readJson<Record<string, unknown>>(CONFIG_JSON)
  if (existed && current === null) {
    throw new Error('config.json 存在但无法读取，为避免覆盖已有配置已中止保存')
  }
  const cfg = current ?? {}
  const boot = { ...((cfg.boot as Record<string, unknown>) ?? {}) }
  if (enabled) boot[id] = true
  else delete boot[id]
  if (existed) {
    await copyFile(CONFIG_JSON, `${CONFIG_JSON}.bak`).catch((e) =>
      log.warn('boot config backup failed', { error: e instanceof Error ? e.message : String(e) })
    )
  }
  await writeJsonAtomic(CONFIG_JSON, { ...cfg, boot })
  getBroadcast()('cockpit:config-changed', { ...cfg, boot })
  log.info('boot service switched', { id, enabled })
}

/** Services + switch state + live running state (settings UI / `boot.list`). */
export async function listBootServiceStates(): Promise<BootServiceState[]> {
  const map = await readBootMap()
  // 运行态由任务名反查（boot 启动与手动启动的任务名都 = def.label）
  const runningNames = new Set(
    listTasks()
      .filter((t) => t.status === 'running')
      .map((t) => t.name)
  )
  return listBootServices().map((def) => ({
    id: def.id,
    label: def.label,
    labelKey: def.labelKey,
    description: def.description,
    descriptionKey: def.descriptionKey,
    job: def.job,
    mustComplete: def.mustComplete === true,
    enabled: map[def.id] === true,
    running: runningNames.has(def.label)
  }))
}

/**
 * Startup hook — start every enabled service's job. Registered at module load
 * (the settings ability imports this module), so it always runs after all
 * abilities registered their services and before the first window opens.
 */
registerStartupHook(async () => {
  const map = await readBootMap()
  if (!Object.keys(map).length) return
  for (const def of listBootServices()) {
    if (map[def.id] !== true) continue
    if (started.has(def.id)) continue
    started.add(def.id)
    try {
      const info = await startJobByName(
        def.job,
        { ...(def.args ?? {}), name: def.label, description: def.description },
        { mustComplete: def.mustComplete === true }
      )
      if (!info) {
        started.delete(def.id)
        log.warn('boot service job not started', { id: def.id, job: def.job })
        continue
      }
      log.info('boot service started', {
        id: def.id,
        job: def.job,
        task: info.id,
        mustComplete: def.mustComplete === true
      })
    } catch (e) {
      started.delete(def.id)
      log.error('boot service start failed', {
        id: def.id,
        job: def.job,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
})
