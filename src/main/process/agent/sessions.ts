/**
 * Agent 会话登记：每个 MCP 会话 / Remote 客户端 / 进程内 agent（YAYA 的一次运行，transport `local`）一条，
 * 供标题栏 AgentBar、设置页展示与断开。
 * 会话可以登记控制器（`setSessionControl`）：用户在 AgentBar 上暂停 / 继续 / 停止它——人和 AI 共用界面时
 * 中途叫停 AI 的统一入口。
 * 会话结束时撤销它的 once 授权（privacy.revokeSessionGrants）。
 */
import { getBroadcast } from '../broadcast'
import { revokeSessionGrants } from '../privacy'
import { makeLogger } from '../logger'
import { CONFIG_JSON } from '../paths'
import { readJson } from '../util'

const log = makeLogger('agent')

export interface AgentSession {
  id: string
  transport: 'mcp' | 'remote' | 'local'
  client: string
  startedAt: number
  lastSeen: number
  calls: number
  /** 没有自带头像时用的默认图标（AGENT_ICONS 之一），同名客户端重连尽量拿回同一个 */
  icon: string
  /** 该会话独立视图的状态：未创建 = 无；hidden = 后台运行；shown = 用户正在 follow */
  view?: 'hidden' | 'shown'
  /** agent 视图当前所在页面（能力 id；视图自己上报，用于悬停提示） */
  page?: string
  /** 头像：仅接受小体积 data: 图片（见 sanitizeAvatar），空 = 用首字母 */
  avatar?: string
  /** agent 自报「我在忙什么」（set_status 工具），过期由渲染端按 `at` 判断 */
  status?: { text: string; progress?: number; at: number }
  /** 登记了控制器的会话支持哪些动作（AgentBar 据此显示暂停 / 停止） */
  controls?: { pause: boolean; stop: boolean }
  /** 已被用户暂停 */
  paused?: boolean
  /** 点击「打开」时跳转的能力页（如 yaya） */
  openAbility?: string
  /** 能力自行解释的跳转参数（如 YAYA 对话 id）。 */
  openTarget?: Record<string, unknown>
}

export interface SessionControl {
  pause?: () => void
  resume?: () => void
  stop?: () => void
}

const AVATAR_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/
/** agent 的头像来自不可信输入：只收 data: 小图（<img> 渲染，svg 脚本不执行），不抓远程 URL（会泄露 IP / 被追踪）。 */
export function sanitizeAvatar(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 24000 && AVATAR_RE.test(v) ? v : undefined
}

/** initialize 握手完成后才知道客户端的真实名字（会话登记时还是占位名）。 */
export function setSessionClient(id: string, client: string): void {
  const s = sessions.get(id)
  if (!s || !client || s.client === client) return
  renameClient(s, client)
  changed()
}

/** 改名后：若新名字有记忆里的图标且没被占用就换过去，否则保留当前并记到新名下。 */
function renameClient(s: AgentSession, client: string): void {
  s.client = client
  const old = rememberedIcons.get(client)
  const taken = [...sessions.values()].some((o) => o.id !== s.id && o.icon === old)
  if (old && !taken) s.icon = old
  rememberedIcons.set(client, s.icon)
}

export function setSessionAvatar(id: string, avatar: unknown, overwrite = true): void {
  const a = sanitizeAvatar(avatar)
  const s = sessions.get(id)
  if (!s || !a || s.avatar === a || (!overwrite && s.avatar)) return
  s.avatar = a
  changed()
}

/** text 为空 = 清除。文本截断到 120 字符，去掉控制字符。 */
export function setSessionStatus(id: string, text: string, progress?: number): void {
  const s = sessions.get(id)
  if (!s) return
  const clean = [...text]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .trim()
    .slice(0, 120)
  s.status = clean
    ? {
        text: clean,
        progress:
          typeof progress === 'number' && Number.isFinite(progress)
            ? Math.min(100, Math.max(0, Math.round(progress)))
            : undefined,
        at: Date.now()
      }
    : undefined
  changed()
}

/**
 * 默认图标池（16 个）：全部取自 @mdi/font（扁平填充风格，和界面其余图标一致）。
 * 格式 `mdi:<name>` = `mdi-<name>`；渲染端另支持 `gi:<name>`（game-icon-pack，
 * 插画风、与扁平界面不搭，所以默认池不用）。
 */
export const AGENT_ICONS = [
  'mdi:robot-happy',
  'mdi:owl',
  'mdi:penguin',
  'mdi:panda',
  'mdi:koala',
  'mdi:unicorn',
  'mdi:rabbit',
  'mdi:duck',
  'mdi:cat',
  'mdi:dog',
  'mdi:jellyfish',
  'mdi:ghost',
  'mdi:butterfly',
  'mdi:dolphin',
  'mdi:turtle',
  'mdi:elephant'
] as const

/** 客户端名 → 上次分到的图标（仅内存），让 agent 重连后还是同一个形象。 */
const rememberedIcons = new Map<string, string>()

/** 随机取一个没被在线会话占用的图标；全占满时在使用最少的里面随机。同名客户端优先复用旧图标。 */
function pickIcon(client: string, selfId?: string): string {
  const used = new Map<string, number>()
  for (const o of sessions.values())
    if (o.id !== selfId) used.set(o.icon, (used.get(o.icon) ?? 0) + 1)
  const old = rememberedIcons.get(client)
  if (old && !used.has(old)) return old
  const least = Math.min(...AGENT_ICONS.map((i) => used.get(i) ?? 0))
  const pool = AGENT_ICONS.filter((i) => (used.get(i) ?? 0) === least)
  return pool[Math.floor(Math.random() * pool.length)]
}

const sessions = new Map<string, AgentSession>()
const closers = new Map<string, () => void>()
const controllers = new Map<string, SessionControl>()

/** 登记会话控制器（YAYA 运行开始时）；会话结束自动清除 */
export function setSessionControl(
  id: string,
  control: SessionControl,
  openAbility?: string,
  openTarget?: Record<string, unknown>
): void {
  const s = sessions.get(id)
  if (!s) return
  controllers.set(id, control)
  s.controls = { pause: Boolean(control.pause && control.resume), stop: Boolean(control.stop) }
  if (openAbility) s.openAbility = openAbility
  if (openTarget) s.openTarget = openTarget
  changed()
}

/** 控制器自己汇报暂停状态（暂停闸门真正停下 / 放行时） */
export function setSessionPaused(id: string, paused: boolean): void {
  const s = sessions.get(id)
  if (!s || Boolean(s.paused) === paused) return
  s.paused = paused
  changed()
}

/** 用户对会话的控制（AgentBar / 快捷键）；返回是否有对应的控制器 */
export function controlSession(id: string, action: 'pause' | 'resume' | 'stop'): boolean {
  const c = controllers.get(id)
  const fn = c?.[action]
  if (!fn) return false
  fn()
  return true
}

/** 暂停所有可暂停的会话（「暂停所有 AI 操作」快捷键）；返回暂停了几个 */
export function pauseAllSessions(): number {
  let n = 0
  for (const [id, c] of controllers) {
    if (c.pause && !sessions.get(id)?.paused) {
      c.pause()
      n++
    }
  }
  return n
}

type Hook = () => void
const changedHooks: Hook[] = []
const endedHooks: ((id: string) => void)[] = []
/** 会话列表变化（改名、视图状态…）——独立视图据此更新窗口标题。 */
export function onSessionsChanged(cb: Hook): void {
  changedHooks.push(cb)
}
/** 会话结束——独立视图据此销毁。 */
export function onSessionEnded(cb: (id: string) => void): void {
  endedHooks.push(cb)
}

function changed(): void {
  getBroadcast()('cockpit:agent-sessions', listSessions())
  for (const h of changedHooks) h()
}

export function setSessionView(id: string, view: AgentSession['view']): void {
  const s = sessions.get(id)
  if (!s || s.view === view) return
  s.view = view
  changed()
}

/** 视图上报自己当前的页面（只收能力 id 形态的短字符串）。 */
export function setSessionPage(id: string, page: unknown): void {
  const s = sessions.get(id)
  if (!s || typeof page !== 'string' || !/^[\w.-]{1,64}$/.test(page) || s.page === page) return
  s.page = page
  changed()
}

export function getSession(id: string): AgentSession | undefined {
  return sessions.get(id)
}

export function touchSession(
  id: string,
  transport: AgentSession['transport'],
  client: string,
  close?: () => void,
  tool?: string
): AgentSession {
  const now = Date.now()
  let s = sessions.get(id)
  if (!s) {
    s = { id, transport, client, startedAt: now, lastSeen: now, calls: 0, icon: '' }
    s.icon = pickIcon(client, id)
    rememberedIcons.set(client, s.icon)
    sessions.set(id, s)
    startIdleSweep()
    if (close) closers.set(id, close)
    changed()
  }
  if (client && s.client !== client) renameClient(s, client)
  s.lastSeen = now
  s.calls++
  // 每次调用都广播一下，渲染端据此显示「谁正在操作」的全局描边
  getBroadcast()('cockpit:agent-activity', {
    id: s.id,
    client: s.client,
    transport: s.transport,
    tool: tool ?? '',
    at: now
  })
  return s
}

export function endSession(id: string): void {
  if (!sessions.delete(id)) return
  closers.delete(id)
  controllers.delete(id)
  revokeSessionGrants(id)
  for (const h of endedHooks) h(id)
  changed()
}

/** 设置页「断开」：关闭底层连接（MCP transport）并清理。 */
export function disconnectSession(id: string): boolean {
  const close = closers.get(id)
  if (!sessions.has(id)) return false
  try {
    close?.()
  } finally {
    endSession(id)
  }
  return true
}

export function endTransportSessions(transport: AgentSession['transport']): void {
  for (const s of [...sessions.values()]) if (s.transport === transport) disconnectSession(s.id)
}

export function listSessions(): AgentSession[] {
  return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

/**
 * 清理已死的会话：客户端被 kill / 崩溃时不会发 DELETE，会话会一直挂着。
 * `agent.ui.kickIdleAfterMin`（默认 0 = 不清理）分钟内没有任何调用就断开；
 * 若客户端其实还活着，它下次请求收到 404 后会重新 initialize。每分钟读一次最新配置。
 */
let sweepTimer: ReturnType<typeof setInterval> | null = null
function startIdleSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    void sweepIdle().catch(() => {})
  }, 60_000)
  sweepTimer.unref?.()
}

async function sweepIdle(): Promise<void> {
  if (sessions.size === 0) {
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
    return
  }
  const cfg = await readJson<{ agent?: { ui?: { kickIdleAfterMin?: unknown } } }>(CONFIG_JSON)
  const min = Number(cfg?.agent?.ui?.kickIdleAfterMin)
  if (!Number.isFinite(min) || min <= 0) return
  const limit = Math.min(min, 10080) * 60_000
  const now = Date.now()
  for (const s of [...sessions.values()]) {
    // 进程内 agent 的会话随运行结束而结束（长时间等模型 / 等审批也不算空闲）
    if (s.transport === 'local') continue
    if (now - s.lastSeen < limit) continue
    log.info('kicking idle agent session', {
      id: s.id,
      client: s.client,
      idleMin: Math.round((now - s.lastSeen) / 60000)
    })
    disconnectSession(s.id)
  }
}
