/**
 * 框架级隐私 SDK（主进程 only）—— 设计见 docs/agent-access-design.md §3/§5。
 *
 * 用法与 `encrypt.ts` 一样：**能力在产生数据的地方自己 wrap**，框架不做猜测式过滤。
 *
 *  - 调用来源（origin）经 AsyncLocalStorage 贯穿整条调用链：网关 / CLI / IPC 在入口
 *    `withOrigin(...)`，命令里再调命令、脚本里 `ctx.command(...)` 都自动继承。
 *  - 非 agent 来源（ui / cli）下所有 API 都是**原样透传**，对现有行为零影响。
 *  - agent 来源（remote / mcp / script-agent）下：
 *      shield(scope, v)       无许可 → 占位符 `«redacted:<scope>»`（同步、不弹窗）
 *      shieldFields(obj, fn)  按字段批量 shield
 *      secret(v)              永远占位符（凭据只写不读）
 *      guard(scope, reason)   无许可 → 发起授权请求并等待用户决定；拒绝抛 PrivacyDeniedError
 *
 * 本文件不依赖 electron / logger（便于 `tsx --test`）：授权窗口由
 * `privacy-consent.ts` 通过 `setConsentPresenter` 注入，审计经 `setPrivacyAudit` 注入。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * - ui / cli：用户本人（IPC / CLI REPL 入口打标）
 * - script：用户在 scripting 页面运行的脚本（可信，仅用于审计区分）
 * - remote / mcp：外部 agent（网关入口打标）
 * - script-agent：agent 发起的脚本（沙箱脚本 RPC 入口打标）
 * - agent-ui：agent 经 inspector 点击 UI 后，渲染端在那段时间里发出的 IPC（渲染端自行降权打标）
 * - local-agent：进程内的 LLM agent（YAYA 执行工具时打标，session = `yaya:<会话 id>:<运行 id>`）
 * 在 agent 上下文里启动的脚本会继承 agent 来源，不会被「降级」成 script。
 * 渲染端只能把自己的 IPC 标成 agent（降权），不能声明成 ui（见 ipc.ts）。
 */
export type OriginKind =
  | 'ui'
  | 'cli'
  | 'script'
  | 'remote'
  | 'mcp'
  | 'script-agent'
  | 'agent-ui'
  /** 进程内的 LLM agent（YAYA 的工具调用）：和外部 agent 一样受隐私 SDK 约束 */
  | 'local-agent'

export interface CallOrigin {
  kind: OriginKind
  /** agent 会话 id（同一 MCP / WS 连接）；once 授权按会话记录 */
  session?: string
  /** 客户端名称（MCP clientInfo.name 等），显示在授权窗口里 */
  client?: string
}

const AGENT_KINDS: ReadonlySet<OriginKind> = new Set([
  'remote',
  'mcp',
  'script-agent',
  'agent-ui',
  'local-agent'
])
const UI_ORIGIN: CallOrigin = Object.freeze({ kind: 'ui' })

const originStore = new AsyncLocalStorage<CallOrigin>()

/** 在指定来源下执行 fn（嵌套调用、await 之后都继承该来源）。 */
export function withOrigin<T>(origin: CallOrigin, fn: () => T): T {
  return originStore.run(origin, fn)
}

/** 当前调用来源；没有显式上下文时视为 ui（主进程内部定时器、启动钩子等可信代码）。 */
export function currentOrigin(): CallOrigin {
  return originStore.getStore() ?? UI_ORIGIN
}

/** 动作判定：agent 发起的调用（含 agent 点击 UI 后渲染端发出的 agent-ui）。guard / requires / deny 用它。 */
export function isAgentOrigin(origin: CallOrigin = currentOrigin()): boolean {
  return AGENT_KINDS.has(origin.kind)
}

/**
 * 读判定：结果会直接回到 agent 手里的调用。shield / secret 等脱敏用它。
 * agent-ui 不算——那些数据只进渲染端（用户自己的界面），回到 agent 的出口是
 * inspector 的快照 / 截图，它们按 DOM 标签脱敏。若按 agent-ui 脱敏，用户界面会显示占位符。
 */
export function isAgentReader(origin: CallOrigin = currentOrigin()): boolean {
  return AGENT_KINDS.has(origin.kind) && origin.kind !== 'agent-ui'
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export type PrivacyLevel = 'public' | 'personal' | 'sensitive' | 'secret'
/** 能力类 scope（不是数据，而是「能做什么」） */
export type CapabilityKind = 'exec' | 'control'

export interface PrivacyScopeDef {
  id: string
  /** 所属 ability id（`system` 为框架内建） */
  ability: string
  level: PrivacyLevel
  /** 能力类 scope 标记；授权窗口对 exec 用警告样式 */
  capability?: CapabilityKind
  /** 翻译键（渲染端 translate），缺省用 id */
  label?: string
  /** 翻译键：这个 scope 包含哪些数据 */
  description?: string
}

/** 调用方决定执行什么（任意命令行 / 代码）——需许可，永久授权不包含。 */
export const SCOPE_EXEC = 'system.exec'
/** 行为固定但会改变系统状态——用户在设置里选择允许 / 询问。 */
export const SCOPE_CONTROL = 'system.control'
/** secret() 使用的占位 scope */
export const SCOPE_SECRET = 'secret'

const scopes = new Map<string, PrivacyScopeDef>()

scopes.set(SCOPE_EXEC, {
  id: SCOPE_EXEC,
  ability: 'system',
  level: 'sensitive',
  capability: 'exec',
  label: 'privacy.scope.system_exec',
  description: 'privacy.scope.system_exec_desc'
})
scopes.set(SCOPE_CONTROL, {
  id: SCOPE_CONTROL,
  ability: 'system',
  level: 'sensitive',
  capability: 'control',
  label: 'privacy.scope.system_control',
  description: 'privacy.scope.system_control_desc'
})

type ScopeInput = Omit<PrivacyScopeDef, 'id' | 'ability'>

/**
 * 声明一个 ability 的隐私 scope。返回 `{ key: '<ability>.<key>' }`，供 shield/guard 使用：
 *
 *   export const P = definePrivacyScopes('campusinfo', {
 *     identity: { level: 'sensitive', label: 'campusinfo.privacy.identity' }
 *   })
 *   shield(P.identity, sid)
 */
export function definePrivacyScopes<K extends string>(
  ability: string,
  defs: Record<K, ScopeInput>
): Record<K, string> {
  const out = {} as Record<K, string>
  for (const key of Object.keys(defs) as K[]) {
    const id = `${ability}.${key}`
    scopes.set(id, { ...defs[key], id, ability })
    out[key] = id
  }
  return out
}

export function getPrivacyScope(id: string): PrivacyScopeDef | undefined {
  return scopes.get(id)
}

export function listPrivacyScopes(): PrivacyScopeDef[] {
  return [...scopes.values()]
}

/** 未声明的 scope 一律按 sensitive 处理（漏声明时偏安全）。 */
function levelOf(scope: string): PrivacyLevel {
  if (scope === SCOPE_SECRET) return 'secret'
  return scopes.get(scope)?.level ?? 'sensitive'
}

// ---------------------------------------------------------------------------
// Policy（config.json → agent.privacy，只能由设置页写入）
// ---------------------------------------------------------------------------

export interface PrivacyPolicy {
  /** personal 级别对 agent：allow 默认可见 / ask 需申请 */
  personal: 'allow' | 'ask'
  /** system.control：allow / ask */
  control: 'allow' | 'ask'
  /** 永久授权的 scope（不含 secret / system.exec） */
  alwaysAllow: string[]
  /** 永久授权全部（不含 secret / system.exec） */
  alwaysAllowAll: boolean
}

export const DEFAULT_PRIVACY_POLICY: Readonly<PrivacyPolicy> = Object.freeze({
  personal: 'allow',
  control: 'allow',
  alwaysAllow: [],
  alwaysAllowAll: false
})

let policy: PrivacyPolicy = { ...DEFAULT_PRIVACY_POLICY, alwaysAllow: [] }

/** 从 config.json 的 `agent.privacy` 归一化（字段缺失 / 非法时回落默认）。 */
export function normalizePrivacyPolicy(raw: unknown): PrivacyPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    personal: r.personal === 'ask' ? 'ask' : 'allow',
    control: r.control === 'ask' ? 'ask' : 'allow',
    alwaysAllow: Array.isArray(r.alwaysAllow)
      ? r.alwaysAllow.filter((s): s is string => typeof s === 'string')
      : [],
    alwaysAllowAll: r.alwaysAllowAll === true
  }
}

export function setPrivacyPolicy(p: PrivacyPolicy): void {
  policy = { ...p, alwaysAllow: [...p.alwaysAllow] }
}

export function getPrivacyPolicy(): PrivacyPolicy {
  return { ...policy, alwaysAllow: [...policy.alwaysAllow] }
}

// ---------------------------------------------------------------------------
// Clearance（许可）
// ---------------------------------------------------------------------------

/** once 授权的有效期：同一会话在此时间内对该 scope 的读取 / 动作都放行。 */
export const ONCE_GRANT_MS = 60_000
/** 用户未处理的请求过期时间。 */
export const REQUEST_EXPIRE_MS = 120_000
/** 被拒绝后同一会话重复请求同一 scope 自动拒绝的冷却时间（防刷屏）。 */
export const DENY_COOLDOWN_MS = 30_000

/** 本次运行始终允许（应用退出即失效）。 */
const sessionGrants = new Set<string>()
/** `${session}\0${scope}` → 过期时间 */
const onceGrants = new Map<string, number>()
/** `${session}\0${scope}` → 拒绝时间 */
const recentDenials = new Map<string, number>()
/**
 * `${session}\0${scope}` → once 授权过期的时间。保留一段时间，让 agent 看到的
 * 占位符能说明「授权已过期、可重新申请」，而不是被误读成数据本身没有值。
 */
const expiredGrants = new Map<string, number>()
/** 过期记录保留多久。 */
export const EXPIRED_NOTICE_MS = 30 * 60_000

let now: () => number = () => Date.now()
/** 测试用：替换时钟。 */
export function __setPrivacyClock(fn: () => number): void {
  now = fn
}

function sessionKey(origin: CallOrigin, scope: string): string {
  return `${origin.session ?? origin.kind}\0${scope}`
}

/** 该 scope 可以通过申请获得吗（secret 永远不行）。 */
export function isGrantable(scope: string): boolean {
  return levelOf(scope) !== 'secret'
}

/** 当前来源是否持有该 scope 的许可。非 agent 来源恒为 true。 */
export function hasClearance(scope: string, origin: CallOrigin = currentOrigin()): boolean {
  return clearanceVia(scope, origin) !== null
}

type ClearanceVia = 'non-agent' | 'policy' | 'run' | 'once'

/** hasClearance 的实现：返回许可来自哪里（null = 未持有）。once 过期时顺带记录过期时间。 */
function clearanceVia(scope: string, origin: CallOrigin): ClearanceVia | null {
  if (!isAgentOrigin(origin)) return 'non-agent'
  const level = levelOf(scope)
  if (level === 'secret') return null
  if (level === 'public') return 'policy'
  if (level === 'personal' && policy.personal === 'allow') return 'policy'
  if (scope === SCOPE_CONTROL && policy.control === 'allow') return 'policy'
  if (scope !== SCOPE_EXEC) {
    if (policy.alwaysAllowAll) return 'policy'
    if (policy.alwaysAllow.includes(scope)) return 'policy'
  }
  if (sessionGrants.has(scope)) return 'run'
  const key = sessionKey(origin, scope)
  const until = onceGrants.get(key)
  if (until !== undefined) {
    if (until > now()) return 'once'
    onceGrants.delete(key)
    expiredGrants.set(key, until)
  }
  return null
}

export interface ClearanceInfo {
  scope: string
  held: boolean
  /** policy = 设置页策略放行；run = 本次运行始终允许；once = 限时授权 */
  via?: 'policy' | 'run' | 'once'
  /** once 授权的到期时间（ms epoch）；policy / run 没有到期时间 */
  expiresAt?: number
  /** 未持有、但本会话的 once 授权在这个时间过期了（近 EXPIRED_NOTICE_MS 内） */
  expiredAt?: number
}

/** 许可详情：持有方式与到期时间，或「刚过期」。给 agent 的 TTL 信号都从这里来。 */
export function clearanceInfo(scope: string, origin: CallOrigin = currentOrigin()): ClearanceInfo {
  const via = clearanceVia(scope, origin)
  const key = sessionKey(origin, scope)
  if (via === 'once') return { scope, held: true, via, expiresAt: onceGrants.get(key) }
  if (via !== null) return { scope, held: true, via: via === 'non-agent' ? 'policy' : via }
  const at = expiredGrants.get(key)
  if (at !== undefined && now() - at > EXPIRED_NOTICE_MS) expiredGrants.delete(key)
  return at !== undefined && now() - at <= EXPIRED_NOTICE_MS
    ? { scope, held: false, expiredAt: at }
    : { scope, held: false }
}

/** 撤销某个会话的全部 once 授权（会话断开时调用）。 */
export function revokeSessionGrants(session: string): void {
  for (const map of [onceGrants, expiredGrants]) {
    for (const key of [...map.keys()]) {
      if (key.startsWith(`${session}\0`)) map.delete(key)
    }
  }
}

/** 撤销「本次运行始终允许」（设置页「撤销授权」）。不传 = 全部。 */
export function revokeRunGrants(scope?: string): void {
  if (scope) sessionGrants.delete(scope)
  else sessionGrants.clear()
}

export function listRunGrants(): string[] {
  return [...sessionGrants]
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export type Redacted = `«redacted:${string}»`

export function redactedMarker(scope: string): Redacted {
  return `«redacted:${scope}»`
}

/**
 * 每次 agent 工具调用的脱敏收集器：网关在调用外层 `collectRedactions`，期间所有
 * shield / shieldFields / inspector 产生的占位符都记下 scope，最后汇总成
 * `privacyNotice` 随结果返回——agent 因此知道「这是脱敏，不是没值」以及该不该重新申请。
 */
const redactionStore = new AsyncLocalStorage<Set<string>>()

/** 登记一次脱敏（不在收集器内则忽略）。产生 «redacted:…» 的地方都应调用。 */
export function noteRedaction(scope: string): void {
  redactionStore.getStore()?.add(scope)
}

export async function collectRedactions<T>(
  fn: () => Promise<T>
): Promise<{ value: T; redacted: string[] }> {
  const set = new Set<string>()
  const value = await redactionStore.run(set, fn)
  return { value, redacted: [...set] }
}

export interface PrivacyNotice {
  /** 本次结果里被脱敏的 scope */
  redacted: string[]
  /** 其中：之前持有的 once 授权已过期的 scope（重新 request_clearance 即可） */
  expired: { scope: string; expiredAt: number }[]
  /** 其中：可以申请的 scope（secret 永远不行） */
  requestable: string[]
  hint: string
}

/** 把收集到的脱敏 scope 变成给 agent 的结构化说明；没有脱敏返回 null。 */
export function privacyNotice(
  redacted: string[],
  origin: CallOrigin = currentOrigin()
): PrivacyNotice | null {
  if (redacted.length === 0) return null
  const expired: PrivacyNotice['expired'] = []
  for (const s of redacted) {
    const info = clearanceInfo(s, origin)
    if (!info.held && info.expiredAt !== undefined)
      expired.push({ scope: s, expiredAt: info.expiredAt })
  }
  const requestable = redacted.filter((s) => isGrantable(s))
  const hint = expired.length
    ? `Your clearance for ${expired.map((e) => e.scope).join(', ')} EXPIRED — the «redacted:…» values are hidden, not empty. Call request_clearance again if you still need them.`
    : requestable.length
      ? 'Values shown as «redacted:<scope>» are hidden by privacy, not empty. Call request_clearance with a reason if you need them.'
      : 'Values shown as «redacted:secret» are credentials and can never be revealed.'
  return { redacted, expired, requestable, hint }
}

export function isRedacted(v: unknown): v is Redacted {
  return typeof v === 'string' && v.startsWith('«redacted:') && v.endsWith('»')
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === ''
}

/**
 * 同步脱敏：agent 且无许可 → 占位符；否则原样。
 * 空值（null / undefined / ''）原样保留——「没有数据」本身不算隐私，保留它 AI 才能判断状态。
 * 数字也替换成字符串占位符：故意破坏类型，避免 AI 把 0 当成真实余额。
 */
export function shield<T>(scope: string, value: T): T | Redacted {
  if (isEmpty(value) || !isAgentReader() || hasClearance(scope)) return value
  audit({ type: 'redact', scope })
  noteRedaction(scope)
  return redactedMarker(scope)
}

/** 凭据：agent 永远拿到占位符，不可申请。 */
export function secret<T>(value: T): T | Redacted {
  if (isEmpty(value) || !isAgentReader()) return value
  noteRedaction(SCOPE_SECRET)
  return redactedMarker(SCOPE_SECRET)
}

/**
 * 字段级批量脱敏。`resolve(key, value, parent)` 返回该字段的 scope（或 null = 不处理、继续向下递归）。
 * 返回新结构，不修改入参。非 agent 来源直接返回入参（零开销）。
 */
export function shieldFields<T>(
  obj: T,
  resolve:
    | Record<string, string>
    | ((key: string, value: unknown, parent: Record<string, unknown>) => string | null)
): T {
  if (!isAgentReader()) return obj
  const fn =
    typeof resolve === 'function'
      ? resolve
      : (key: string): string | null => (resolve as Record<string, string>)[key] ?? null
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 32 || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(src)) {
      const scope = fn(k, val, src)
      out[k] =
        scope === null
          ? walk(val, depth + 1)
          : scope === SCOPE_SECRET
            ? secret(val)
            : val !== null && typeof val === 'object'
              ? hasClearance(scope)
                ? val
                : (noteRedaction(scope), redactedMarker(scope))
              : shield(scope, val)
    }
    return out
  }
  return walk(obj, 0) as T
}

/** 兜底：key 名像凭据的字段（未声明 privacy 的命令结果会再过一遍）。 */
export const SECRET_KEY_RE =
  /^(password|passwd|pwd|token|access_?token|refresh_?token|secret|client_?secret|api_?key|apikey|cookie|cookies|sessdata|bili_jct|authorization|auth|credential|credentials)$/i

export function redactSecretKeys<T>(value: T): T {
  if (!isAgentReader()) return value
  return shieldFields(value, (k) => (SECRET_KEY_RE.test(k) ? SCOPE_SECRET : null))
}

// -- 已知凭据值指纹：日志 / 任务输出里出现就替换 -----------------------------------

const knownSecrets = new Set<string>()
const MIN_SECRET_LEN = 6
const MAX_KNOWN_SECRETS = 512

/** 由 encrypt.decryptSecret 等登记：本次运行解密 / 使用过的凭据明文。 */
export function noteSecretValue(plain: string): void {
  if (typeof plain !== 'string' || plain.length < MIN_SECRET_LEN) return
  if (knownSecrets.size >= MAX_KNOWN_SECRETS) {
    const first = knownSecrets.values().next().value
    if (first !== undefined) knownSecrets.delete(first)
  }
  knownSecrets.add(plain)
}

/** 把文本里出现的已知凭据替换成占位符（agent 读日志 / 任务输出时用）。 */
export function scrubKnownSecrets(text: string): string {
  if (!text || knownSecrets.size === 0) return text
  let out = text
  for (const s of knownSecrets) {
    if (out.includes(s)) {
      out = out.split(s).join(redactedMarker(SCOPE_SECRET))
      noteRedaction(SCOPE_SECRET)
    }
  }
  return out
}

/** agent 读取日志 / 非自身任务输出时的出口脱敏：已知凭据值 + 凭据 key。 */
export function scrubForAgent<T>(value: T): T {
  if (!isAgentReader()) return value
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return scrubKnownSecrets(v)
    if (depth > 32 || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] =
        SECRET_KEY_RE.test(k) && !isEmpty(val)
          ? (noteRedaction(SCOPE_SECRET), redactedMarker(SCOPE_SECRET))
          : walk(val, depth + 1)
    }
    return out
  }
  return walk(value, 0) as T
}

// ---------------------------------------------------------------------------
// Consent requests
// ---------------------------------------------------------------------------

export type ConsentDecision = 'deny' | 'once' | 'session'
export type RequestStatus = 'pending' | 'granted' | 'denied' | 'expired'

export interface ConsentRequest {
  id: string
  scopes: string[]
  /** AI 提供的理由（原样显示，标明来自 AI） */
  reason: string
  origin: CallOrigin
  createdAt: number
  expiresAt: number
  status: RequestStatus
  decision?: ConsentDecision
}

export class PrivacyDeniedError extends Error {
  /**
   * - privacy_pending：已发起授权请求，用户还没决定；**本次动作已取消**，批准后重试（见 requestId）
   * - privacy_denied / privacy_expired：用户拒绝 / 超时未处理
   * - privacy_secret：凭据类，不可申请
   * - agent_denied：该命令 / 区域永远不允许 agent 操作
   */
  readonly code:
    'privacy_pending' | 'privacy_denied' | 'privacy_expired' | 'privacy_secret' | 'agent_denied'
  readonly scopes: string[]
  readonly requestId?: string
  constructor(
    code: PrivacyDeniedError['code'],
    scopes: string[],
    message?: string,
    requestId?: string
  ) {
    super(message ?? `${code}: ${scopes.join(', ')}`)
    this.code = code
    this.scopes = scopes
    this.requestId = requestId
    this.name = 'PrivacyDeniedError'
  }
}

/** guard 的最长等待：低于常见 MCP 客户端 60s 超时。 */
export const GUARD_WAIT_MS = 45_000

interface PendingEntry {
  req: ConsentRequest
  waiters: ((r: ConsentRequest) => void)[]
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingEntry>()
/** 已结束的请求保留一会，供 wait 查询结果 */
const settled = new Map<string, ConsentRequest>()
const SETTLED_KEEP = 200

type Presenter = (pendingList: ConsentRequest[]) => void
let presenter: Presenter = () => {}

/** privacy-consent.ts 注入：待处理列表变化时调用（打开 / 刷新 / 关闭授权窗口）。 */
export function setConsentPresenter(fn: Presenter): void {
  presenter = fn
}

export interface PrivacyAuditEvent {
  type: 'redact' | 'request' | 'decide' | 'expire' | 'auto-deny' | 'deny-agent'
  scope?: string
  scopes?: string[]
  requestId?: string
  decision?: ConsentDecision
  origin?: CallOrigin
}
let auditSink: (e: PrivacyAuditEvent) => void = () => {}
export function setPrivacyAudit(fn: (e: PrivacyAuditEvent) => void): void {
  auditSink = fn
}
function audit(e: PrivacyAuditEvent): void {
  try {
    auditSink({ ...e, origin: e.origin ?? currentOrigin() })
  } catch {
    /* audit must never break a call */
  }
}

export function listPendingRequests(): ConsentRequest[] {
  return [...pending.values()].map((p) => ({ ...p.req }))
}

function notifyPresenter(): void {
  try {
    presenter(listPendingRequests())
  } catch {
    /* presenter failure must not break the request path */
  }
}

function settle(entry: PendingEntry, status: RequestStatus, decision?: ConsentDecision): void {
  clearTimeout(entry.timer)
  pending.delete(entry.req.id)
  entry.req.status = status
  entry.req.decision = decision
  settled.set(entry.req.id, entry.req)
  if (settled.size > SETTLED_KEEP) {
    const first = settled.keys().next().value
    if (first !== undefined) settled.delete(first)
  }
  for (const w of entry.waiters) w({ ...entry.req })
  notifyPresenter()
}

/**
 * 用户在授权窗口做出决定。**只允许 privacy-consent.ts 的 IPC（已校验 sender）调用**——
 * 绝不能注册成命令，否则 agent 可以自己批准自己。
 */
export function decideConsent(requestId: string, decision: ConsentDecision): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  const { req } = entry
  if (decision === 'deny') {
    for (const s of req.scopes) recentDenials.set(sessionKey(req.origin, s), now())
    audit({ type: 'decide', requestId, scopes: req.scopes, decision, origin: req.origin })
    settle(entry, 'denied', decision)
    return true
  }
  for (const s of req.scopes) {
    if (!isGrantable(s)) continue
    if (decision === 'session') sessionGrants.add(s)
    else onceGrants.set(sessionKey(req.origin, s), now() + ONCE_GRANT_MS)
  }
  audit({ type: 'decide', requestId, scopes: req.scopes, decision, origin: req.origin })
  settle(entry, 'granted', decision)
  return true
}

/** 一键拒绝全部待处理请求。 */
export function denyAllPending(): number {
  const ids = [...pending.keys()]
  for (const id of ids) decideConsent(id, 'deny')
  return ids.length
}

export interface ClearanceResult {
  status: RequestStatus
  requestId?: string
  /** 已持有 / 本次获得的 scope */
  granted: string[]
  /** 不可申请的 scope（secret） */
  refused: string[]
  /** 已持有 scope 的持有方式与到期时间（once 授权有 expiresAt，到期后结果会重新脱敏） */
  grants?: ClearanceInfo[]
}

function withGrants(r: ClearanceResult, origin: CallOrigin): ClearanceResult {
  return r.granted.length ? { ...r, grants: r.granted.map((s) => clearanceInfo(s, origin)) } : r
}

/**
 * 申请许可。已全部持有 → 立即 granted；含 secret → 那部分放进 refused；
 * 否则创建请求（或复用同一会话同样 scope 的待处理请求），最多等待 `waitMs`。
 * `waitMs` 到了仍未处理 → 返回 pending + requestId，调用方可再 `waitClearance`。
 */
export async function requestClearance(
  scopeList: string[],
  reason: string,
  opts: { waitMs?: number } = {}
): Promise<ClearanceResult> {
  const origin = currentOrigin()
  const uniq = [...new Set(scopeList.filter((s) => typeof s === 'string' && s))]
  const refused = uniq.filter((s) => !isGrantable(s))
  const wanted = uniq.filter((s) => isGrantable(s) && !hasClearance(s, origin))
  const held = uniq.filter((s) => isGrantable(s) && hasClearance(s, origin))
  if (wanted.length === 0) {
    return withGrants(
      { status: refused.length ? 'denied' : 'granted', granted: held, refused },
      origin
    )
  }

  // 冷却：刚被拒绝的 scope 自动拒绝，防止 AI 反复弹窗
  const t = now()
  if (
    wanted.some((s) => {
      const at = recentDenials.get(sessionKey(origin, s))
      return at !== undefined && t - at < DENY_COOLDOWN_MS
    })
  ) {
    audit({ type: 'auto-deny', scopes: wanted, origin })
    return { status: 'denied', granted: held, refused }
  }

  const key = [...wanted].sort().join(',')
  let entry = [...pending.values()].find(
    (p) =>
      (p.req.origin.session ?? p.req.origin.kind) === (origin.session ?? origin.kind) &&
      [...p.req.scopes].sort().join(',') === key
  )
  if (!entry) {
    const req: ConsentRequest = {
      id: randomUUID(),
      scopes: wanted,
      reason: String(reason ?? '').slice(0, 500),
      origin: { ...origin },
      createdAt: t,
      expiresAt: t + REQUEST_EXPIRE_MS,
      status: 'pending'
    }
    const created: PendingEntry = {
      req,
      waiters: [],
      timer: setTimeout(() => {
        audit({ type: 'expire', requestId: req.id, scopes: req.scopes, origin: req.origin })
        settle(created, 'expired')
      }, REQUEST_EXPIRE_MS)
    }
    created.timer.unref?.()
    pending.set(req.id, created)
    entry = created
    audit({ type: 'request', requestId: req.id, scopes: wanted, origin })
    notifyPresenter()
  }
  const res = await waitClearance(entry.req.id, opts.waitMs)
  const nowHeld = uniq.filter((s) => isGrantable(s) && hasClearance(s, origin))
  return withGrants({ ...res, granted: nowHeld, refused }, origin)
}

/** 等待某个请求的结果，最多 `waitMs`（缺省等到结束）。 */
export function waitClearance(requestId: string, waitMs?: number): Promise<ClearanceResult> {
  const done = settled.get(requestId)
  if (done) return Promise.resolve(toResult(done))
  const entry = pending.get(requestId)
  if (!entry) return Promise.resolve({ status: 'expired', requestId, granted: [], refused: [] })
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const waiter = (r: ConsentRequest): void => {
      if (timer) clearTimeout(timer)
      resolve(toResult(r))
    }
    entry.waiters.push(waiter)
    if (waitMs !== undefined && waitMs >= 0) {
      timer = setTimeout(() => {
        const i = entry.waiters.indexOf(waiter)
        if (i >= 0) entry.waiters.splice(i, 1)
        resolve({ status: 'pending', requestId, granted: [], refused: [] })
      }, waitMs)
      timer.unref?.()
    }
  })
}

function toResult(r: ConsentRequest): ClearanceResult {
  return withGrants(
    {
      status: r.status,
      requestId: r.id,
      granted: r.status === 'granted' ? r.scopes : [],
      refused: []
    },
    r.origin
  )
}

/**
 * 动作守卫：agent 来源且无许可 → 发起授权请求，最多等 `waitMs`。
 * 用户在等待期内批准 → 返回，动作继续；拒绝 / 过期 / secret → 抛 PrivacyDeniedError；
 * 等待期内未决定 → 抛 `privacy_pending`（带 requestId）并**放弃本次动作**——
 * 不能让动作在调用方超时放弃之后才「突然」执行。请求保留，批准后 agent 重试即可。
 */
export async function guard(
  scope: string | string[],
  reason = '',
  opts: { waitMs?: number } = {}
): Promise<void> {
  if (!isAgentOrigin()) return
  const list = Array.isArray(scope) ? scope : [scope]
  const missing = list.filter((s) => !hasClearance(s))
  if (missing.length === 0) return
  const secretOnes = missing.filter((s) => !isGrantable(s))
  if (secretOnes.length) throw new PrivacyDeniedError('privacy_secret', secretOnes)
  const res = await requestClearance(missing, reason, { waitMs: opts.waitMs ?? GUARD_WAIT_MS })
  if (res.status === 'granted' && missing.every((s) => hasClearance(s))) return
  if (res.status === 'pending') {
    throw new PrivacyDeniedError(
      'privacy_pending',
      missing,
      `waiting for user approval (request ${res.requestId}); the action was NOT performed — call wait_clearance, then retry`,
      res.requestId
    )
  }
  throw new PrivacyDeniedError(
    res.status === 'expired' ? 'privacy_expired' : 'privacy_denied',
    missing
  )
}

/** 测试用：清空全部运行期状态。 */
export function __resetPrivacyState(): void {
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  settled.clear()
  sessionGrants.clear()
  onceGrants.clear()
  recentDenials.clear()
  expiredGrants.clear()
  knownSecrets.clear()
  policy = { ...DEFAULT_PRIVACY_POLICY, alwaysAllow: [] }
  presenter = () => {}
  auditSink = () => {}
  now = () => Date.now()
}
