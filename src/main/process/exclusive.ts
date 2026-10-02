/**
 * 独占 SDK —— 有状态资源同一时刻只能有一个拥有者（设计见 docs/exclusive-and-script-design.md）。
 *
 * 用法和隐私 SDK 一样：能力只声明，框架执行。
 *   export const GB = defineExclusiveScopes('gameboy', { rom: { label: 'gameboy.excl.rom' } })
 *   { name: 'gameboy.press', exclusive: { scope: GB.rom, key: () => currentRomId() }, … }
 * 命令注册表在执行前自动 `acquire` / 续期，handler 通过 `ctx.lease.epoch` 拿到当前 epoch，
 * 写盘处调用 `assertFence(scope, key, epoch)`——被抢占的旧拥有者已经发出去的写入靠它挡住。
 *
 * 规则（全在主进程）：
 * - 用户永远优先：用户来源（ui / cli / script）对被 AI 占用的资源 = 直接接管，epoch +1，
 *   旧 AI 的下一次调用收到 LeaseLostError；
 * - AI 对被别人（另一个 AI / 用户）占用的资源 = 立即失败（ExclusiveBusyError），不排队不抢；
 * - 租约只在内存：会话结束、空闲超过 TTL、主动释放、用户接管都会释放；应用重启即清空；
 * - epoch 对 (scope, key) 单调递增，释放后再获取也不会复用旧值。
 */
import { getBroadcast } from './broadcast'
import { CONFIG_JSON } from './paths'
import { currentOrigin, isAgentOrigin, type CallOrigin } from './privacy'
import { getSession, onSessionEnded } from './agent/sessions'
import { makeLogger } from './logger'
import { readJson } from './util'

const log = makeLogger('exclusive')

export type ExclusivePolicy = 'exclusive' | 'fork'

export interface ExclusiveScopeDef {
  /** exclusive（默认）：一份资源一个拥有者；fork：每个 agent 会话用自己的派生键（`forkKey`） */
  policy?: ExclusivePolicy
  /** 翻译键（界面显示「掌机 · 宝可梦红」之类时用） */
  label: string
}

const scopeDefs = new Map<string, ExclusiveScopeDef & { ability: string }>()

/** 声明本能力的独占范围；返回 `{ 名: '<能力id>.<名>' }`。重复声明同名范围会抛错。 */
export function defineExclusiveScopes<T extends Record<string, ExclusiveScopeDef>>(
  ability: string,
  defs: T
): { [K in keyof T]: string } {
  const out = {} as { [K in keyof T]: string }
  for (const [name, def] of Object.entries(defs)) {
    const id = `${ability}.${name}`
    if (scopeDefs.has(id)) throw new Error(`重复的独占范围: ${id}`)
    scopeDefs.set(id, { ...def, ability })
    ;(out as Record<string, string>)[name] = id
  }
  return out
}

export type Owner = { kind: 'user' } | { kind: 'agent'; session: string; client: string }

export interface LeaseInfo {
  scope: string
  key: string
  ability: string
  /** 范围的翻译键 */
  label: string
  owner: Owner
  epoch: number
  acquiredAt: number
  lastActive: number
  /** 持有者渲染进程（webContents id），需要「发给持有者」的能力用 `leaseHost()` */
  host?: number
  meta?: Record<string, unknown>
}

/** 命令 handler 拿到的租约摘要（`ctx.lease`）。 */
export interface LeaseRef {
  scope: string
  key: string
  epoch: number
}

export class ExclusiveBusyError extends Error {
  readonly code = 'exclusive_busy'
  constructor(
    readonly scope: string,
    readonly key: string,
    readonly holder: Owner,
    readonly sinceMs: number,
    readonly idleMs: number
  ) {
    const who = holder.kind === 'user' ? '用户' : `AI「${holder.client || holder.session}」`
    super(
      `资源 ${scope}:${key} 正被${who}占用（已 ${Math.round(sinceMs / 1000)} 秒，空闲 ${Math.round(idleMs / 1000)} 秒）。` +
        '请告知用户，不要重试抢占；占用者释放或空闲超时后才能使用。'
    )
    this.name = 'ExclusiveBusyError'
  }
}

export class LeaseLostError extends Error {
  readonly code = 'lease_lost'
  constructor(
    readonly scope: string,
    readonly key: string,
    readonly reason: 'taken-over' | 'expired' | 'released'
  ) {
    const why =
      reason === 'taken-over' ? '被用户接管' : reason === 'expired' ? '空闲超时已释放' : '已被释放'
    super(`你对 ${scope}:${key} 的占用${why}。再次调用会重新获取（若无人占用）；请先确认游戏状态。`)
    this.name = 'LeaseLostError'
  }
}

export class StaleEpochError extends Error {
  readonly code = 'stale_epoch'
  constructor(scope: string, key: string) {
    super(`写入被拒绝：${scope}:${key} 的租约已变更（拥有者已被替换），旧拥有者不能再写。`)
    this.name = 'StaleEpochError'
  }
}

const k = (scope: string, key: string): string => `${scope}\u0000${key}`
const leases = new Map<string, LeaseInfo>()
/** (scope,key) 的最近 epoch——释放后保留，保证 epoch 单调、旧值不会复用 */
const epochs = new Map<string, number>()
/** 被用户接管 / 超时的 agent 会话：它下一次调用要先收到 LeaseLostError */
const lost = new Map<string, { reason: LeaseLostError['reason'] }>() // key: `${scope}\0${key}\0${session}`

const lostKey = (scope: string, key: string, session: string): string =>
  `${k(scope, key)}\u0000${session}`

export function ownerOf(origin: CallOrigin = currentOrigin()): Owner {
  if (!isAgentOrigin(origin)) return { kind: 'user' }
  const session = origin.session ?? 'anonymous'
  return { kind: 'agent', session, client: getSession(session)?.client ?? origin.client ?? '' }
}

const sameOwner = (a: Owner, b: Owner): boolean =>
  a.kind === b.kind && (a.kind === 'user' || (b.kind === 'agent' && a.session === b.session))

function emitChanged(): void {
  getBroadcast()('cockpit:exclusive', listLeases())
}

function nextEpoch(id: string): number {
  const e = (epochs.get(id) ?? 0) + 1
  epochs.set(id, e)
  return e
}

function define(scope: string): ExclusiveScopeDef & { ability: string } {
  const d = scopeDefs.get(scope)
  if (!d) throw new Error(`未声明的独占范围: ${scope}（先 defineExclusiveScopes）`)
  return d
}

/** fork 策略：agent 会话得到自己的派生键（复制原数据由能力自己做）；用户用原键。 */
export function forkKey(scope: string, key: string): string {
  const owner = ownerOf()
  return define(scope).policy === 'fork' && owner.kind === 'agent'
    ? `${key}#${owner.session.slice(0, 8)}`
    : key
}

/**
 * 获取（或续期）租约，返回当前租约。
 * - 已是自己的：续期；
 * - 用户来源遇到 AI 的：接管（epoch +1，记下 AI 的 lost）；
 * - AI 来源遇到别人的：抛 ExclusiveBusyError；
 * - AI 来源且被记为 lost：先抛一次 LeaseLostError（之后可重新获取）。
 */
export function acquire(
  scope: string,
  key: string,
  opts: { host?: number; meta?: Record<string, unknown> } = {}
): LeaseInfo {
  const def = define(scope)
  const me = ownerOf()
  const id = k(scope, key)
  sweep()
  if (me.kind === 'agent') {
    const lk = lostKey(scope, key, me.session)
    const l = lost.get(lk)
    if (l) {
      lost.delete(lk)
      throw new LeaseLostError(scope, key, l.reason)
    }
  }
  const now = Date.now()
  const cur = leases.get(id)
  if (cur) {
    if (sameOwner(cur.owner, me)) {
      cur.lastActive = now
      if (opts.host !== undefined) cur.host = opts.host
      if (opts.meta) cur.meta = { ...cur.meta, ...opts.meta }
      return cur
    }
    if (me.kind === 'agent') {
      throw new ExclusiveBusyError(
        scope,
        key,
        cur.owner,
        now - cur.acquiredAt,
        now - cur.lastActive
      )
    }
    // 用户接管 AI
    if (cur.owner.kind === 'agent')
      lost.set(lostKey(scope, key, cur.owner.session), { reason: 'taken-over' })
    log.info('lease taken over by user', { scope, key, from: cur.owner })
  }
  const lease: LeaseInfo = {
    scope,
    key,
    ability: def.ability,
    label: def.label,
    owner: me,
    epoch: nextEpoch(id),
    acquiredAt: now,
    lastActive: now,
    host: opts.host,
    meta: opts.meta
  }
  leases.set(id, lease)
  emitChanged()
  return lease
}

/** 续期（命令执行完调用）；没有该租约 / 不是自己的则忽略。 */
export function touch(scope: string, key: string): void {
  const cur = leases.get(k(scope, key))
  if (cur && sameOwner(cur.owner, ownerOf())) cur.lastActive = Date.now()
}

/** 释放。agent 只能释放自己的；用户可以释放任何租约（等价于接管后放手）。返回是否释放了。 */
export function release(scope: string, key: string): boolean {
  const id = k(scope, key)
  const cur = leases.get(id)
  if (!cur) return false
  const me = ownerOf()
  if (me.kind === 'agent' && !sameOwner(cur.owner, me)) return false
  leases.delete(id)
  if (cur.owner.kind === 'agent' && me.kind === 'user') {
    lost.set(lostKey(scope, key, cur.owner.session), { reason: 'released' })
  }
  emitChanged()
  return true
}

/** 用户接管（仅用户来源）。没有租约时等于获取。 */
export function takeOver(scope: string, key: string): LeaseInfo {
  if (ownerOf().kind !== 'user') throw new Error('只有用户可以接管')
  return acquire(scope, key)
}

/** 写盘处校验：租约必须存在且 epoch 一致，否则抛 StaleEpochError。 */
export function assertFence(scope: string, key: string, epoch: number): void {
  const cur = leases.get(k(scope, key))
  if (!cur || cur.epoch !== epoch) throw new StaleEpochError(scope, key)
}

export function leaseOf(scope: string, key: string): LeaseInfo | undefined {
  return leases.get(k(scope, key))
}

/** 当前调用者是否就是该租约的拥有者（只读 rpc 据此决定发给自己的视图还是持有者的视图）。 */
export function holdsLease(scope: string, key: string): boolean {
  const cur = leases.get(k(scope, key))
  return !!cur && sameOwner(cur.owner, ownerOf())
}

/** 租约持有者的渲染进程（webContents id）。 */
export function leaseHost(scope: string, key: string): number | undefined {
  return leases.get(k(scope, key))?.host
}

export function listLeases(): LeaseInfo[] {
  return [...leases.values()].sort((a, b) => a.acquiredAt - b.acquiredAt)
}

/* ------------------------------------------------------------------ 生命周期 */

const DEFAULT_IDLE_MIN = 5
let idleMs = DEFAULT_IDLE_MIN * 60_000

/** config.json `agent.exclusive.idleMin`（1–60，默认 5）。 */
export async function refreshExclusiveConfig(): Promise<void> {
  const cfg = await readJson<{ agent?: { exclusive?: { idleMin?: unknown } } }>(CONFIG_JSON)
  const n = Number(cfg?.agent?.exclusive?.idleMin)
  idleMs =
    (Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : DEFAULT_IDLE_MIN) * 60_000
}

function sweep(): void {
  const now = Date.now()
  let changed = false
  for (const [id, l] of leases) {
    if (now - l.lastActive <= idleMs) continue
    leases.delete(id)
    changed = true
    if (l.owner.kind === 'agent')
      lost.set(lostKey(l.scope, l.key, l.owner.session), { reason: 'expired' })
    log.info('lease expired', { scope: l.scope, key: l.key })
  }
  if (changed) emitChanged()
}

/** 释放某个会话的全部租约（会话结束时）。 */
export function releaseSession(session: string): void {
  let changed = false
  for (const [id, l] of leases) {
    if (l.owner.kind === 'agent' && l.owner.session === session) {
      leases.delete(id)
      changed = true
    }
  }
  for (const key of [...lost.keys()]) if (key.endsWith(`\u0000${session}`)) lost.delete(key)
  if (changed) emitChanged()
}

let timer: ReturnType<typeof setInterval> | undefined
/** 启动一次：会话结束释放、空闲扫描。 */
export function initExclusive(): void {
  if (timer) return
  onSessionEnded(releaseSession)
  void refreshExclusiveConfig()
  timer = setInterval(() => {
    void refreshExclusiveConfig()
    sweep()
  }, 30_000)
  timer.unref()
}
