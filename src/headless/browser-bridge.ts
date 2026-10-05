/**
 * 无头浏览器 UI 桥（页面侧）—— 主进程 `src/main/process/browser-ui.ts` 的配套。
 *
 * 每个网页标签页加载时登记一个随机 clientId（web-shim），宿主只把**固定方法**的请求
 * 定向发给「发起本次 YAYA 工作流的那个标签页」，本文件执行后经 `/api/ui-result` 回传。
 *
 * 硬规则（与 Electron 的 CDP inspector 对齐，但受网页能力限制）：
 *  - 不执行任意代码：只有 snapshot / screenshot / pageInfo / navigate / click / clickAt / move /
 *    mouse / drag / type / key / scroll / wait 这几个固定方法；
 *  - 截图是 DOM 光栅化（见 doScreenshot）；没有可信输入：点击 / 输入 / 按键都是**合成事件**（isTrusted = false），
 *    打不开文件选择器、原生菜单之类的依赖真实手势的东西；
 *  - 隐私：`data-privacy` 子树 / `[data-agent="forbidden"]` 子树 / 密码框的值**一律脱敏**
 *    （与用户是否点开明文无关）；DOM 操作同时查祖先与后代（点到禁区的父容器也拒绝）；
 *  - 受保护动作先预检并返回 scopes（**不执行**），主机 guard 后带许可与目标令牌重试，
 *    这里复核「同一个元素 + 许可仍覆盖」才动手；
 *  - 本标签页的数据只回给宿主，不发给其他标签页。
 */
import { bridgePost, emitLocal } from './web-shim'

const CHANNEL = 'cockpit:browser-ui'
const CANCEL_CHANNEL = 'cockpit:browser-ui-cancel'
/** 预检通过后打在目标元素上的身份令牌（retry 时核对该目标没变） */
const TAG_ATTR = 'data-cockpit-bui-token'

/** 一页的行数；超出的用 offset 翻页（与 Electron 版一致） */
const MAX_SNAPSHOT_LINES = 1500
/** 整棵树最多收集的行数 / 访问的节点数 */
const SNAPSHOT_HARD_LINES = 12000
const MAX_NODES = 40000

interface BridgeArgs {
  [key: string]: unknown
}

interface BridgeRequest {
  id: string
  method: string
  args: BridgeArgs
  session?: string
}

type Reply =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: string
      code?: string
      scopes?: string[]
      token?: string
      label?: string
    }

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function uuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 正在执行的请求的取消信号（请求串行执行，同一时刻只有一个） */
let activeSignal: AbortSignal | null = null

class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

/** 动作前检查：宿主已取消（停止 / 超时）就不再动手 */
function checkCancelled(): void {
  if (activeSignal?.aborted) throw new CancelledError()
}

/** 可被取消的等待：取消时立即抛 CancelledError */
function sleep(ms: number): Promise<void> {
  const signal = activeSignal
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const redacted = (scope: string): string => `«redacted:${scope}»`

function quote(s: string, max = 120): string {
  const t = s.length > max ? `${s.slice(0, max)}…` : s
  return JSON.stringify(t)
}

/** 目标的安全描述（只用于授权理由；绝不用 innerText）。 */
function safeLabel(el: Element): string {
  const raw =
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    safeText(el) ||
    el.tagName.toLowerCase()
  return raw.replace(/\s+/g, ' ').trim().slice(0, 40)
}

/**
 * 递归拼接安全文本：跳过隐私 / 禁区子树与表单控件的值。
 * 不用 innerText —— 父容器里含有隐私后代时会把它带出明文。
 */
function safeText(el: Element): string {
  let out = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const e = node as Element
    if (e.getAttribute('data-agent') === 'forbidden') return
    if (e.hasAttribute('data-privacy')) return
    const tag = e.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return
    for (const c of Array.from(e.childNodes)) walk(c)
  }
  for (const c of Array.from(el.childNodes)) walk(c)
  return out.replace(/\s+/g, ' ').trim()
}

function ownText(el: Element): string {
  let out = ''
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? ''
  }
  return out.replace(/\s+/g, ' ').trim()
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true
  if (el.closest('[aria-hidden="true"]')) return true
  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
    return true
  }
  if (parseFloat(cs.opacity || '1') === 0) return true
  const r = el.getBoundingClientRect()
  return r.width <= 0 || r.height <= 0
}

function currentAbility(): string {
  return (
    document.querySelector('[data-current-ability]')?.getAttribute('data-current-ability') ?? ''
  )
}

function readyAbility(): string {
  return document.querySelector('[data-current-ability]')?.getAttribute('data-ability-ready') ?? ''
}

/** 等 DOM 安静（懒加载 / 异步取数）：安静 quietMs，上限 maxMs。返回耗时。 */
function quiet(quietMs = 300, maxMs = 4000): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now()
    let timer = 0
    const done = (): void => {
      obs.disconnect()
      window.clearTimeout(timer)
      window.clearTimeout(maxTimer)
      resolve(Date.now() - start)
    }
    const obs = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(done, quietMs)
    })
    obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true })
    timer = window.setTimeout(done, quietMs)
    const maxTimer = window.setTimeout(done, maxMs)
  })
}

/** 等当前能力页面加载完（`data-ability-ready`），上限 maxMs。 */
async function waitReady(expect?: string, maxMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const cur = currentAbility()
    const target = expect ?? cur
    if (!target || readyAbility() === target) return
    await sleep(50)
  }
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'listbox',
  'treeitem',
  'disclosuretriangle'
])

const STRUCTURAL_ROLES = new Set([
  'heading',
  'dialog',
  'alertdialog',
  'navigation',
  'main',
  'banner',
  'complementary',
  'region',
  'form',
  'tablist',
  'tabpanel',
  'menu',
  'toolbar',
  'alert',
  'status',
  'table',
  'grid',
  'row',
  'list',
  'listitem',
  'article',
  'image',
  'img',
  'progressbar',
  'canvas',
  'group'
])

const TEXTISH =
  /^(P|SPAN|LI|LABEL|TD|TH|H1|H2|H3|H4|H5|H6|BUTTON|A|SUMMARY|FIGCAPTION|DIV|STRONG|EM|SMALL)$/

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit.trim()
  const tag = el.tagName
  if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'generic'
  if (tag === 'BUTTON') return 'button'
  if (tag === 'INPUT') {
    const t = (el as HTMLInputElement).type
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    if (t === 'range') return 'slider'
    if (t === 'number') return 'spinbutton'
    if (t === 'search') return 'searchbox'
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
    return 'textbox'
  }
  if (tag === 'TEXTAREA') return 'textbox'
  if (tag === 'SELECT') return el.hasAttribute('multiple') ? 'listbox' : 'combobox'
  if (tag === 'OPTION') return 'option'
  if (tag === 'IMG') return 'image'
  if (tag === 'CANVAS') return 'canvas'
  if (
    tag === 'H1' ||
    tag === 'H2' ||
    tag === 'H3' ||
    tag === 'H4' ||
    tag === 'H5' ||
    tag === 'H6'
  ) {
    return 'heading'
  }
  if (tag === 'NAV') return 'navigation'
  if (tag === 'MAIN') return 'main'
  if (tag === 'HEADER') return 'banner'
  if (tag === 'FOOTER') return 'contentinfo'
  if (tag === 'ASIDE') return 'complementary'
  if (tag === 'SECTION') return 'region'
  if (tag === 'FORM') return 'form'
  if (tag === 'TABLE') return 'table'
  if (tag === 'TR') return 'row'
  if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') return 'rowgroup'
  if (tag === 'LI') return 'listitem'
  if (tag === 'UL' || tag === 'OL') return 'list'
  if (tag === 'DIALOG') return 'dialog'
  if (tag === 'HR') return 'separator'
  if (tag === 'PROGRESS') return 'progressbar'
  return 'generic'
}

/** 纯图标按钮（mdi 图标名）——与 CDP 版的 icon hint 对齐。 */
function iconHint(el: Element): string {
  const i = el.classList.contains('mdi') ? el : el.querySelector('.mdi, [class*="mdi-"]')
  const c = i ? Array.from(i.classList).find((x) => x.startsWith('mdi-') && x !== 'mdi-set') : null
  return c ? c.slice(4) : ''
}

function nameOf(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria && aria.trim()) return aria.trim()
  const title = el.getAttribute('title')
  if (title && title.trim()) return title.trim()
  const ph = el.getAttribute('placeholder')
  if (ph && ph.trim()) return ph.trim()
  // <label for> 可能位于隐私区 / 禁区里（控件本身在外面）：这种标签不能拿来当名字
  const guarded = (l: Element): boolean => !!l.closest('[data-privacy],[data-agent="forbidden"]')
  const labels = (el as HTMLInputElement).labels
  const label = labels ? Array.from(labels).find((l) => !guarded(l)) : undefined
  if (label) {
    const t = safeText(label)
    if (t) return t
  }
  const wrap = el.closest('label')
  if (wrap && wrap !== el && !guarded(wrap)) {
    const t = safeText(wrap)
    if (t) return t
  }
  return safeText(el)
}

function scrollNote(el: Element): string {
  const sy =
    el.scrollHeight > el.clientHeight + 4 &&
    (getComputedStyle(el).overflowY === 'auto' || getComputedStyle(el).overflowY === 'scroll')
  const sx =
    el.scrollWidth > el.clientWidth + 4 &&
    (getComputedStyle(el).overflowX === 'auto' || getComputedStyle(el).overflowX === 'scroll')
  if (!sy && !sx) return ''
  if (!sy) return '[scroll 0% · end]'
  const pct = Math.round((el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100)
  const below = el.scrollHeight - el.clientHeight - el.scrollTop > 4
  return `[scroll ${pct}%${below ? ' · more below' : ' · end'}]`
}

interface SnapCtx {
  lines: string[]
  truncated: boolean
  nodes: number
  mode: 'interactive' | 'full'
  refs: Map<string, Element>
}

/** 本标签页的 ref 表：每次快照重建，页面变化后旧 ref 失效。 */
let currentRefs = new Map<string, Element>()

function push(ctx: SnapCtx, depth: number, line: string): void {
  if (ctx.lines.length >= SNAPSHOT_HARD_LINES) {
    ctx.truncated = true
    return
  }
  ctx.lines.push(`${'  '.repeat(depth)}- ${line}`)
}

function newRef(ctx: SnapCtx, el: Element): string {
  const ref = `e${ctx.refs.size + 1}`
  ctx.refs.set(ref, el)
  return ref
}

function pushFlags(el: Element, role: string, parts: string[]): void {
  const input = el as HTMLInputElement
  if (input.disabled === true || el.getAttribute('aria-disabled') === 'true') {
    parts.push('[disabled]')
  }
  const checked =
    (input.type === 'checkbox' || input.type === 'radio' ? input.checked === true : false) ||
    el.getAttribute('aria-checked') === 'true'
  if (checked) parts.push('[checked]')
  const exp = el.getAttribute('aria-expanded')
  if (exp === 'true') parts.push('[expanded]')
  else if (exp === 'false') parts.push('[collapsed]')
  if (el.getAttribute('aria-pressed') === 'true') parts.push('[pressed]')
  if (el.getAttribute('aria-selected') === 'true') parts.push('[selected]')
  if (el.getAttribute('aria-required') === 'true' || input.required === true) {
    parts.push('[required]')
  }
  if (role === 'heading') {
    const lvl = Number(el.tagName.slice(1))
    if (lvl >= 1 && lvl <= 6) parts.push(`[level=${lvl}]`)
  }
}

function walkEl(ctx: SnapCtx, el: Element, depth: number, scope: string | null): void {
  if (ctx.truncated) return
  if (++ctx.nodes > MAX_NODES) {
    ctx.truncated = true
    return
  }
  if (isHidden(el)) return
  // 悬浮层（Outsider）对 AI 不可见、点击穿透：整层略过。它铺满全屏，报成禁区会让 AI 以为整页都不能操作
  if (el.hasAttribute('data-outsider-layer')) return
  if (el.getAttribute('data-agent') === 'forbidden') {
    push(ctx, depth, 'region [forbidden]')
    return
  }
  const own = el.getAttribute('data-privacy')
  if (own && !scope) {
    // 隐私区：只露出占位与其中的可交互元素（名字 / 值同样脱敏）
    push(ctx, depth, `group ${redacted(own)} [privacy=${own}]`)
    for (const c of Array.from(el.children)) walkEl(ctx, c, depth + 1, own)
    return
  }

  const role = roleOf(el)
  const rawName = nameOf(el)
  const name = scope ? redacted(scope) : rawName
  const tag = el.tagName
  const isForm = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  const interactive = INTERACTIVE_ROLES.has(role) || (el.hasAttribute('tabindex') && !!rawName)
  const scroll = scrollNote(el)
  let value = ''
  if (isForm) {
    const v = (el as HTMLInputElement).value ?? ''
    value =
      tag === 'INPUT' && (el as HTMLInputElement).type === 'password'
        ? redacted('secret')
        : scope
          ? redacted(scope)
          : v
  }
  const decorative = (role === 'image' || role === 'img' || role === 'progressbar') && !rawName
  const structural = STRUCTURAL_ROLES.has(role) && !decorative

  let emitted = false
  if (interactive || structural || scroll) {
    const parts = [role === 'generic' ? 'scrollable' : role]
    if (name) parts.push(quote(name))
    else if (interactive) {
      const h = iconHint(el)
      if (h) parts.push(`(icon: ${h})`)
    }
    if (interactive) {
      const ref = newRef(ctx, el)
      if (ref) parts.push(`[ref=${ref}]`)
    }
    pushFlags(el, role, parts)
    if (value) parts.push(`value=${quote(value, 80)}`)
    if (scope) parts.push(`[privacy=${scope}]`)
    const actionAttr = el.getAttribute('data-privacy-action')
    if (actionAttr) parts.push(`[privacy-action=${actionAttr}]`)
    if (scroll) parts.push(scroll)
    push(ctx, depth, parts.join(' '))
    emitted = true
  }

  if (ctx.mode === 'full' && !interactive) {
    const own2 = ownText(el)
    const textish = el.childElementCount === 0 || TEXTISH.test(tag)
    // 隐私区里的文本一律不输出（与用户是否点开明文无关）——区域行已经标了占位
    if (own2 && own2 !== rawName && textish && !scope) {
      push(ctx, depth, `text ${quote(own2, 200)}`)
    }
  }

  const childDepth = emitted ? depth + 1 : depth
  for (const c of Array.from(el.children)) walkEl(ctx, c, childDepth, scope)
}

async function doSnapshot(args: BridgeArgs): Promise<Reply> {
  const mode: 'interactive' | 'full' = args.mode === 'full' ? 'full' : 'interactive'
  await waitReady()
  const settledMs = await quiet()
  // 旧 ref 与预检令牌全部作废
  for (const el of Array.from(document.querySelectorAll(`[${TAG_ATTR}]`))) {
    el.removeAttribute(TAG_ATTR)
  }
  currentRefs = new Map()
  const ctx: SnapCtx = { lines: [], truncated: false, nodes: 0, mode, refs: currentRefs }
  if (document.body) walkEl(ctx, document.body, 0, null)
  const total = ctx.lines.length
  const from = Math.max(0, Math.min(Math.floor(Number(args.offset) || 0), Math.max(0, total - 1)))
  const to = Math.min(total, from + MAX_SNAPSHOT_LINES)
  let text = ctx.lines.slice(from, to).join('\n')
  if (from > 0) text = `… (lines ${from + 1}–${to} of ${total})\n` + text
  if (to < total) text += `\n… (${total - to} more lines; call again with offset=${to} to continue)`
  else if (ctx.truncated) text += `\n… (page too large: stopped at ${SNAPSHOT_HARD_LINES} lines)`
  const truncated = to < total || ctx.truncated
  return {
    ok: true,
    result: {
      ok: true,
      page: currentAbility(),
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        zoom: window.devicePixelRatio || 1
      },
      scale: window.devicePixelRatio || 1,
      settledMs,
      refs: ctx.refs.size,
      text,
      totalLines: total,
      ...(truncated ? { truncated: true } : {})
    }
  }
}

async function doPageInfo(): Promise<Reply> {
  const seen = new Map<string, string>()
  for (const el of Array.from(document.querySelectorAll('[data-ability-id]'))) {
    const id = el.getAttribute('data-ability-id')
    if (!id || seen.has(id)) continue
    seen.set(id, el.getAttribute('aria-label') || el.getAttribute('title') || safeText(el) || id)
  }
  return {
    ok: true,
    result: { page: currentAbility(), abilities: [...seen].map(([id, name]) => ({ id, name })) }
  }
}

async function doNavigate(args: BridgeArgs): Promise<Reply> {
  const ability = String(args.ability ?? '')
  if (!ability) {
    return { ok: false, code: 'bad_args', error: '需要页面 id' }
  }
  const available = [
    ...new Set(
      Array.from(document.querySelectorAll('[data-ability-id]'))
        .map((e) => e.getAttribute('data-ability-id') ?? '')
        .filter(Boolean)
    )
  ]
  if (!available.includes(ability)) {
    return {
      ok: true,
      result: { ok: false, error: `侧栏里没有能力：${ability}`, available }
    }
  }
  // 走与 ui.navigate 相同的事件（App.vue 订阅 cockpit:navigate）
  emitLocal('cockpit:navigate', ability)
  const start = Date.now()
  let page = currentAbility()
  while (Date.now() - start < 3000 && page !== ability) {
    await sleep(50)
    page = currentAbility()
  }
  if (page === ability) await waitReady(ability)
  const settledMs = await quiet()
  return {
    ok: true,
    result:
      page === ability ? { ok: true, page, settledMs } : { ok: false, page, error: '切换超时' }
  }
}

// ---------------------------------------------------------------------------
// 隐私预检 / 复核
// ---------------------------------------------------------------------------

type Precheck =
  | { kind: 'ok' }
  | { kind: 'clearance'; scopes: string[]; label: string }
  | { kind: 'forbidden' }
  | { kind: 'secret' }

/**
 * 同时查**祖先与后代**：
 *  - 祖先 / 后代里的禁区或密码框（点到禁区的父容器也拒绝）；
 *  - 自身是密码框（任何动作 / 重试都拒绝，不是只有输入）；
 *  - **全部**祖先与后代的隐私 / 揭示类 scope 收集起来，交由主机 guard（宁多勿漏）。
 */
function precheck(el: Element): Precheck {
  if (el.closest('[data-agent="forbidden"]')) return { kind: 'forbidden' }
  if (el.matches('input[type="password"]')) return { kind: 'secret' }
  if (el.querySelector('[data-agent="forbidden"], input[type="password"]')) {
    return { kind: 'forbidden' }
  }
  const scopes: string[] = []
  const add = (value: string | null): void => {
    if (!value) return
    for (const s of value.split(',')) {
      const v = s.trim()
      if (v) scopes.push(v)
    }
  }
  // 祖先（含多层嵌套的隐私区）
  for (let n: Element | null = el; n; n = n.parentElement) {
    add(n.getAttribute('data-privacy'))
    add(n.getAttribute('data-privacy-action'))
  }
  // 后代（点父容器时，里面的隐私区 / 揭示按钮同样要许可）
  for (const d of Array.from(el.querySelectorAll('[data-privacy],[data-privacy-action]'))) {
    add(d.getAttribute('data-privacy'))
    add(d.getAttribute('data-privacy-action'))
  }
  const uniq = [...new Set(scopes)]
  if (uniq.length) return { kind: 'clearance', scopes: uniq, label: safeLabel(el) }
  return { kind: 'ok' }
}

/** 主机 guard 通过后的复核：必须是**同一个元素**、自身不是密码框，且许可仍覆盖它。 */
function retryCheck(el: Element, permitted: string[], token: string): Reply | null {
  if (el.getAttribute(TAG_ATTR) !== token) {
    return { ok: false, code: 'target_changed', error: '目标已变化（预检后页面改了），请重新发起' }
  }
  const now = precheck(el)
  if (now.kind === 'forbidden') {
    return { ok: false, code: 'forbidden', error: '目标位于 AI 禁区，不能操作' }
  }
  if (now.kind === 'secret') {
    return { ok: false, code: 'secret', error: '密码输入框不能由 AI 操作' }
  }
  if (now.kind === 'clearance' && !now.scopes.every((s) => permitted.includes(s))) {
    return { ok: false, code: 'clearance_expired', error: '授权已不再覆盖该目标，请重新申请' }
  }
  el.removeAttribute(TAG_ATTR)
  return null
}

type Target = Element | null | 'stale'

function needRef(args: BridgeArgs): Target {
  const ref = args.ref
  if (typeof ref !== 'string' || !ref) return null
  const el = currentRefs.get(ref)
  return el && el.isConnected ? el : 'stale'
}

/** 坐标处的目标元素：跳过悬浮层（Outsider）——AI 的操作穿过悬浮窗，碰不到它的按钮 */
function pointTarget(x: number, y: number): Element | null {
  return document.elementsFromPoint(x, y).find((e) => !e.closest('[data-outsider-layer]')) ?? null
}

function focusTarget(): Element | null {
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return null
  return el
}

/**
 * 受保护元素操作的统一入口：
 *  - 首次：预检（不执行）→ 保护区返回 scopes + 目标令牌；
 *  - 重试（带 permitted + token）：复核同一个目标与许可，通过才执行。
 * target 为 null = 没有明确目标（如无焦点的按键），直接执行。
 */
async function elementOp(
  args: BridgeArgs,
  target: Target,
  perform: (el: Element | null) => Promise<unknown>
): Promise<Reply> {
  if (target === 'stale') {
    return {
      ok: false,
      code: 'stale_ref',
      error: 'ref 已失效（页面可能变了），请重新做一次界面快照'
    }
  }
  const permitted = Array.isArray(args.permitted) ? args.permitted.map((x) => String(x)) : null
  const token = typeof args.token === 'string' ? args.token : null

  if (!target) {
    checkCancelled()
    return { ok: true, result: await perform(null) }
  }

  if (permitted && token) {
    const bad = retryCheck(target, permitted, token)
    if (bad) return bad
  } else {
    const pre = precheck(target)
    if (pre.kind === 'forbidden') {
      return { ok: false, code: 'forbidden', error: '目标位于 AI 禁区，不能操作' }
    }
    if (pre.kind === 'secret') {
      return { ok: false, code: 'secret', error: '密码输入框不能由 AI 填写' }
    }
    if (pre.kind === 'clearance') {
      const tk = uuid()
      target.setAttribute(TAG_ATTR, tk)
      return {
        ok: false,
        code: 'clearance_required',
        scopes: pre.scopes,
        token: tk,
        label: pre.label,
        error: '需要用户授权后才能操作该区域'
      }
    }
  }
  try {
    checkCancelled()
    const result = await perform(target)
    target.removeAttribute(TAG_ATTR)
    return { ok: true, result }
  } catch (e) {
    target.removeAttribute(TAG_ATTR)
    throw e
  }
}

// ---------------------------------------------------------------------------
// 合成输入（isTrusted = false，如实说明局限）
// ---------------------------------------------------------------------------

const NAMED_KEYS: Record<string, { code: string; keyCode: number; key?: string; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, key: ' ', text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 }
}

function keyDef(
  name: string
): { key: string; code: string; keyCode: number; text?: string } | null {
  const n = NAMED_KEYS[name]
  if (n) return { key: n.key ?? name, code: n.code, keyCode: n.keyCode, text: n.text }
  if (/^F([1-9]|1[0-2])$/.test(name)) {
    return { key: name, code: name, keyCode: 111 + Number(name.slice(1)) }
  }
  if (/^[a-zA-Z]$/.test(name)) {
    const up = name.toUpperCase()
    return { key: name, code: `Key${up}`, keyCode: up.charCodeAt(0), text: name }
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, keyCode: 48 + Number(name), text: name }
  }
  if (name.length === 1) return { key: name, code: '', keyCode: 0, text: name }
  return null
}

async function sendKey(
  name: string,
  modifiers: string[],
  action: 'press' | 'down' | 'up',
  holdMs = 0
): Promise<void> {
  const def = keyDef(name)
  if (!def) throw new Error(`不支持的按键：${name}`)
  const mods = modifiers.filter((m) => ['Shift', 'Control', 'Alt', 'Meta'].includes(m))
  const flags = {
    shiftKey: mods.includes('Shift'),
    ctrlKey: mods.includes('Control'),
    altKey: mods.includes('Alt'),
    metaKey: mods.includes('Meta')
  }
  const withText = !!(def.text && !flags.ctrlKey && !flags.altKey && !flags.metaKey)
  const target = document.activeElement ?? document.body
  const mk = (type: string, d: { key: string; code: string }): KeyboardEvent =>
    new KeyboardEvent(type, {
      key: d.key,
      code: d.code,
      bubbles: true,
      cancelable: true,
      ...flags
    })
  if (action !== 'up') {
    for (const m of mods) target.dispatchEvent(mk('keydown', keyDef(m)!))
    target.dispatchEvent(mk('keydown', def))
    if (withText) {
      target.dispatchEvent(
        new KeyboardEvent('keypress', {
          key: def.key,
          code: def.code,
          bubbles: true,
          cancelable: true,
          charCode: def.text!.charCodeAt(0),
          ...flags
        })
      )
    }
  }
  try {
    if (action === 'press' && holdMs > 0) await sleep(Math.min(Math.max(holdMs, 0), 10000))
  } finally {
    // 按住期间被取消也要松开，不留下「按着」的键
    if (action !== 'down') {
      target.dispatchEvent(mk('keyup', def))
      for (const m of [...mods].reverse()) target.dispatchEvent(mk('keyup', keyDef(m)!))
    }
  }
}

/** Vue 受控输入：必须走原型上的原生 setter，再派发 input / change。 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  if (desc && desc.set) desc.set.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function clickEl(el: Element, args: BridgeArgs): Promise<unknown> {
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const button = args.button === 'right' ? 2 : args.button === 'middle' ? 1 : 0
  const times = args.double === true ? 2 : 1
  const opts = { bubbles: true, cancelable: true, view: window, button }
  // 与真实浏览器一致：只有左键产生 click；中键是 auxclick，右键是 contextmenu
  for (let i = 1; i <= times; i++) {
    const seq = { ...opts, detail: i }
    el.dispatchEvent(new MouseEvent('mousedown', seq))
    el.dispatchEvent(new MouseEvent('mouseup', seq))
    if (button === 0) el.dispatchEvent(new MouseEvent('click', seq))
    else if (button === 1) el.dispatchEvent(new MouseEvent('auxclick', seq))
    else el.dispatchEvent(new MouseEvent('contextmenu', seq))
  }
  if (times === 2 && button === 0)
    el.dispatchEvent(new MouseEvent('dblclick', { ...opts, detail: 2 }))
  ;(el as HTMLElement).focus?.()
  return { ok: true, target: safeLabel(el), settledMs: await quiet() }
}

/** 按下时的目标：松开时若仍是同一元素才补 click（与真实浏览器一致） */
let pressed: { el: Element; button: number } | null = null

/** 合成一组指针 + 鼠标事件（isTrusted=false）。held = 移动时按键仍按着 */
function pointerAt(
  kind: 'move' | 'down' | 'up',
  el: Element | null,
  x: number,
  y: number,
  button: number,
  held = false
): void {
  const target = el ?? document.body
  const buttons = kind === 'down' || held ? (button === 2 ? 2 : button === 1 ? 4 : 1) : 0
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button: kind === 'move' ? -1 : button,
    buttons
  }
  const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  if (kind === 'move') {
    target.dispatchEvent(new PointerEvent('pointerover', ptr))
    target.dispatchEvent(new PointerEvent('pointermove', ptr))
    target.dispatchEvent(new MouseEvent('mouseover', base))
    target.dispatchEvent(new MouseEvent('mousemove', base))
    return
  }
  if (kind === 'down') {
    target.dispatchEvent(new PointerEvent('pointerdown', ptr))
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, detail: 1 }))
    ;(target as HTMLElement).focus?.()
    pressed = { el: target, button }
    return
  }
  target.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0 }))
  target.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, detail: 1 }))
  if (
    pressed &&
    pressed.button === button &&
    (pressed.el === target || pressed.el.contains(target))
  ) {
    const type = button === 0 ? 'click' : button === 1 ? 'auxclick' : 'contextmenu'
    target.dispatchEvent(new MouseEvent(type, { ...base, buttons: 0, detail: 1 }))
  }
  pressed = null
}

/** 能直接写值的 input 类型（file / checkbox / range 之类写值没有意义或会抛错） */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'email',
  'tel',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'color'
])

async function typeInto(el: Element, args: BridgeArgs, text: string): Promise<unknown> {
  if (el.tagName === 'INPUT' && !TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)) {
    throw new Error(`该输入框（type=${(el as HTMLInputElement).type}）不能写入文本`)
  }
  if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) {
    throw new Error('该输入框已禁用或只读')
  }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  ;(el as HTMLElement).focus?.()
  const clear = args.clear === true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const input = el as HTMLInputElement
    setNativeValue(input, clear ? text : `${input.value ?? ''}${text}`)
  } else if ((el as HTMLElement).isContentEditable) {
    if (clear && el.firstChild) el.textContent = ''
    el.textContent = `${el.textContent ?? ''}${text}`
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (text) {
    for (const ch of text) await sendKey(ch, [], 'press')
  }
  if (args.submit === true) await sendKey('Enter', [], 'press')
  return { ok: true, settledMs: await quiet() }
}

function scrollableOf(el: Element): Element | null {
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n)
    const sy =
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 4
    const sx =
      (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 4
    if (sy || sx) return n
  }
  return null
}

function findSafeText(needle: string): boolean {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement
    if (!p) continue
    if (p.closest('[data-privacy],[data-agent="forbidden"]')) continue
    if ((n.textContent ?? '').includes(needle)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 截图（DOM 光栅化）
//
// 浏览器没有「截自己」的 API：用 modern-screenshot 把 DOM 克隆进 SVG foreignObject 再画到
// canvas。隐私处理两层：
//  1. 克隆时**不带**被遮盖元素的子孙（内容根本不进 SVG）；元素自身保留，盒子尺寸不变；
//  2. 画完后在 canvas 上按元素的实时位置涂实心遮罩（canvas 绘制是同步确定的，不存在
//     Electron capturePage 那种「遮罩还没合成进画面」的问题）。
// 悬浮层（Outsider）整层不进图。canvas 内容按当前帧复制（WebGL 未开 preserveDrawingBuffer
// 时可能是空白，如实说明）。
// ---------------------------------------------------------------------------

const MASK_BG = '#1b1b1f'
const MASK_FG = '#e6e1e5'

/**
 * 页面全部 @font-face，字体文件内嵌成 data URL，交给 modern-screenshot 的 `font.cssText`。
 *
 * modern-screenshot 只按**元素自身**的 font-family 决定嵌哪些字体；mdi 图标的字体写在
 * `.mdi::before` 伪元素上（元素本身是正文字体），于是图标字体从不被嵌入，截图里全是方框。
 * 这里自己收集，一页只做一次（字体文件不会变），之后每次截图复用。
 */
let fontCssPromise: Promise<string> | null = null

function collectFontFaces(): CSSFontFaceRule[] {
  const out: CSSFontFaceRule[] = []
  const walk = (rules: CSSRuleList): void => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSFontFaceRule) out.push(r)
      else if ('cssRules' in r && (r as CSSGroupingRule).cssRules)
        walk((r as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules)
    } catch {
      /* 跨域样式表读不了规则：跳过 */
    }
  }
  return out
}

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null)
      fr.onerror = () => resolve(null)
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

async function buildFontCss(): Promise<string> {
  const parts: string[] = []
  for (const rule of collectFontFaces()) {
    const src = rule.style.getPropertyValue('src')
    // 每条规则只取一个格式（优先 woff2），其余格式不下载
    const urls = [
      ...src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*['"]?([\w-]+)['"]?\s*\))?/g)
    ]
    if (!urls.length) continue
    const pick = urls.find((m) => m[3] === 'woff2' || /\.woff2(\?|#|$)/.test(m[2])) ?? urls[0]
    if (pick[2].startsWith('data:')) {
      parts.push(rule.cssText)
      continue
    }
    const base = rule.parentStyleSheet?.href ?? location.href
    const data = await toDataUrl(new URL(pick[2], base).href)
    if (!data) continue
    const decl = ['font-family', 'font-style', 'font-weight', 'font-display', 'unicode-range']
      .map((k) => [k, rule.style.getPropertyValue(k)] as const)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}:${v};`)
      .join('')
    parts.push(`@font-face{${decl}src:url("${data}")${pick[3] ? ` format("${pick[3]}")` : ''};}`)
  }
  return parts.join('\n')
}

function fontCss(): Promise<string> {
  if (!fontCssPromise)
    fontCssPromise = buildFontCss().catch(() => {
      fontCssPromise = null
      return ''
    })
  return fontCssPromise
}

async function doScreenshot(args: BridgeArgs): Promise<Reply> {
  await waitReady()
  await quiet()
  checkCancelled()
  const cleared = new Set(Array.isArray(args.cleared) ? args.cleared.map((x) => String(x)) : [])
  const maskForbidden = args.maskForbidden !== false
  let target: Element = document.documentElement
  if (typeof args.ref === 'string' && args.ref) {
    const t = needRef(args)
    if (t === 'stale' || !t) {
      return {
        ok: false,
        code: 'stale_ref',
        error: 'ref 已失效（页面可能变了），请重新做一次界面快照'
      }
    }
    if (t.closest('[data-agent="forbidden"]') && maskForbidden) {
      return { ok: false, code: 'forbidden', error: '目标位于 AI 禁区，不能截图' }
    }
    target = t
  }

  // 需要遮盖的元素：未授权的隐私区、禁区、密码框
  const masked = new Set<Element>()
  const scopes = new Set<string>()
  const shown = new Set<string>()
  for (const el of Array.from(
    document.querySelectorAll('[data-privacy],[data-agent="forbidden"],input[type="password"]')
  )) {
    // 悬浮层不进图（见 filter），也就不用遮——它铺满全屏，涂黑会把整屏盖掉
    if (el.closest('[data-outsider-layer]')) continue
    if (isHidden(el)) continue
    const forbidden = el.getAttribute('data-agent') === 'forbidden'
    if (forbidden && !maskForbidden) continue
    const scope = el.getAttribute('data-privacy') || (forbidden ? 'forbidden' : 'secret')
    if (!forbidden && cleared.has(scope)) {
      shown.add(scope)
      continue
    }
    masked.add(el)
    if (!forbidden) scopes.add(scope)
  }
  const inMasked = (n: Node | null): boolean => {
    for (let e = n instanceof Element ? n : (n?.parentElement ?? null); e; e = e.parentElement)
      if (masked.has(e)) return true
    return false
  }

  const { domToCanvas } = await import('modern-screenshot')
  const box = target.getBoundingClientRect()
  const full = target === document.documentElement
  const width = Math.max(1, Math.round(full ? innerWidth : box.width))
  const height = Math.max(1, Math.round(full ? innerHeight : box.height))
  const bg = getComputedStyle(document.body).backgroundColor
  const cssText = await fontCss()
  checkCancelled()
  const canvas = await domToCanvas(target, {
    // 自己提供字体（含伪元素用的图标字体），见 fontCss()；拿不到时交给库自己扫描
    ...(cssText ? { font: { cssText } } : {}),
    width,
    height,
    // 1 张截图像素 = 1 CSS 像素：坐标可以直接交给 click_at（无头的坐标一律是 CSS 像素）
    scale: 1,
    backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff',
    timeout: 8000,
    filter: (node: Node) => {
      if (node instanceof Element && node.closest('[data-outsider-layer]')) return false
      if (node instanceof Element && node.classList.contains('__cockpit_ai_marker')) return false
      // 被遮盖元素自身保留（占位尺寸不变），子孙一律不进克隆
      const parent = node.parentElement
      return !(parent && inMasked(parent))
    }
  })
  checkCancelled()
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) return { ok: false, code: 'screenshot_failed', error: '无法绘制截图' }
  const kx = canvas.width / width
  const ky = canvas.height / height
  const ox = full ? 0 : box.left
  const oy = full ? 0 : box.top
  let n = 0
  ctx2d.font = `${Math.round(11 * kx)}px monospace`
  ctx2d.textAlign = 'center'
  ctx2d.textBaseline = 'middle'
  for (const el of masked) {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const x = (r.left - 4 - ox) * kx
    const y = (r.top - 4 - oy) * ky
    const w = (r.width + 8) * kx
    const h = (r.height + 8) * ky
    if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) continue
    ctx2d.fillStyle = MASK_BG
    ctx2d.fillRect(x, y, w, h)
    const label =
      el.getAttribute('data-privacy') ||
      (el.getAttribute('data-agent') === 'forbidden' ? 'forbidden' : 'secret')
    if (w > 40 && h > 14) {
      ctx2d.fillStyle = MASK_FG
      ctx2d.fillText(`🔒 ${label}`, x + w / 2, y + h / 2, w - 8)
    }
    n++
  }
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return {
    ok: true,
    result: {
      ok: true,
      mime: 'image/jpeg',
      width: canvas.width,
      height: canvas.height,
      scale: kx,
      redactedRegions: n,
      scopes: [...scopes],
      shown: [...shown],
      data: dataUrl.slice(dataUrl.indexOf(',') + 1)
    }
  }
}

// ---------------------------------------------------------------------------
// 固定方法表（没有 eval / 任意 JS 通道）
// ---------------------------------------------------------------------------

type Handler = (args: BridgeArgs) => Promise<Reply>

const HANDLERS: Record<string, Handler> = {
  snapshot: doSnapshot,
  screenshot: doScreenshot,
  pageInfo: doPageInfo,
  navigate: doNavigate,

  click: async (args) => elementOp(args, needRef(args), (el) => clickEl(el as Element, args)),

  clickAt: async (args) => {
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, code: 'bad_args', error: '需要数字坐标 x / y（CSS 像素）' }
    }
    return elementOp(args, pointTarget(x, y), (el) => clickEl(el as Element, args))
  },

  move: async (args) => {
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, code: 'bad_args', error: '需要数字坐标 x / y（CSS 像素）' }
    }
    return elementOp(args, pointTarget(x, y), async (el) => {
      pointerAt('move', el, x, y, 0)
      return { ok: true, settledMs: await quiet(150, 1500) }
    })
  },

  mouse: async (args) => {
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, code: 'bad_args', error: '需要数字坐标 x / y（CSS 像素）' }
    }
    const button = args.button === 'right' ? 2 : args.button === 'middle' ? 1 : 0
    const action = args.action === 'up' ? 'up' : 'down'
    if (action === 'up') {
      // 松开不需要许可（只结束之前已经许可过的按下）；但不把事件派发给禁区 / 密码框
      const hit = pointTarget(x, y)
      const pre = hit ? precheck(hit) : null
      const el = pre && pre.kind !== 'forbidden' && pre.kind !== 'secret' ? hit : null
      pointerAt('up', el, x, y, button)
      return { ok: true, result: { ok: true, settledMs: await quiet() } }
    }
    return elementOp(args, pointTarget(x, y), async (el) => {
      pointerAt('down', el, x, y, button)
      return { ok: true, target: el ? safeLabel(el) : '', settledMs: await quiet(150, 1500) }
    })
  },

  drag: async (args) => {
    const from = args.from as { x?: unknown; y?: unknown } | undefined
    const to = args.to as { x?: unknown; y?: unknown } | undefined
    const ax = Number(from?.x)
    const ay = Number(from?.y)
    const bx = Number(to?.x)
    const by = Number(to?.y)
    if (![ax, ay, bx, by].every(Number.isFinite)) {
      return { ok: false, code: 'bad_args', error: '需要数字坐标 from / to（CSS 像素）' }
    }
    // 终点同样不能落在禁区 / 未授权隐私区（起点由 elementOp 预检）
    const end = pointTarget(bx, by)
    if (end) {
      const pre = precheck(end)
      if (pre.kind === 'forbidden' || pre.kind === 'secret') {
        return { ok: false, code: 'forbidden', error: '拖动终点位于 AI 禁区，不能操作' }
      }
      const permitted = Array.isArray(args.permitted) ? args.permitted.map(String) : []
      if (pre.kind === 'clearance' && !pre.scopes.every((sc) => permitted.includes(sc))) {
        return {
          ok: false,
          code: 'forbidden',
          error: '拖动终点在需要授权的隐私区：请先点击 / 操作该区域取得授权后再拖动'
        }
      }
    }
    const button = args.button === 'right' ? 2 : args.button === 'middle' ? 1 : 0
    const steps = Math.min(Math.max(Math.round(Number(args.steps ?? 12)), 1), 100)
    const pause = Math.min(Math.max(Number(args.durationMs ?? 240), 0), 5000) / steps
    return elementOp(args, pointTarget(ax, ay), async (el) => {
      pointerAt('down', el, ax, ay, button)
      for (let i = 1; i <= steps; i++) {
        checkCancelled()
        const x = ax + ((bx - ax) * i) / steps
        const y = ay + ((by - ay) * i) / steps
        pointerAt('move', pointTarget(x, y), x, y, button, true)
        if (pause) await sleep(pause)
      }
      pointerAt('up', pointTarget(bx, by), bx, by, button)
      return { ok: true, settledMs: await quiet() }
    })
  },

  type: async (args) => {
    const text = typeof args.text === 'string' ? args.text : ''
    const ref = typeof args.ref === 'string' && args.ref
    const target: Target = ref ? needRef(args) : focusTarget()
    return elementOp(args, target, (el) => typeInto(el as Element, args, text))
  },

  key: async (args) => {
    const name = String(args.key ?? '')
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map((x) => String(x)) : []
    const action =
      args.action === 'down' || args.action === 'up' ? (args.action as 'down' | 'up') : 'press'
    const holdMs = Number(args.holdMs ?? 0)
    const run = async (): Promise<unknown> => {
      await sendKey(name, modifiers, action, holdMs)
      return { ok: true, settledMs: await quiet() }
    }
    if (action === 'up') return { ok: true, result: await run() }
    // 按键目标是当前焦点（可能没有：直接派发到 body）
    return elementOp(args, focusTarget(), () => run())
  },

  scroll: async (args) => {
    const dx = Number(args.dx ?? 0)
    const dy = Number(args.dy ?? 400)
    const ref = typeof args.ref === 'string' && args.ref ? args.ref : null
    let el: Element | null = null
    if (ref) {
      const found = needRef(args)
      if (found === 'stale') {
        return {
          ok: false,
          code: 'stale_ref',
          error: 'ref 已失效（页面可能变了），请重新做一次界面快照'
        }
      }
      el = found
    } else if (args.at && typeof args.at === 'object') {
      const at = args.at as { x?: unknown; y?: unknown }
      const x = Number(at.x)
      const y = Number(at.y)
      if (Number.isFinite(x) && Number.isFinite(y)) el = pointTarget(x, y)
    }
    if (!el) {
      window.scrollBy(dx, dy)
      return { ok: true, result: { ok: true, settledMs: 0 } }
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const sc = scrollableOf(el) ?? el
    sc.scrollTop += dy
    sc.scrollLeft += dx
    return {
      ok: true,
      result: { ok: true, settledMs: 0, scroll: { top: sc.scrollTop, left: sc.scrollLeft } }
    }
  },

  wait: async (args) => {
    const start = Date.now()
    const ms = Number(args.ms ?? 0)
    if (Number.isFinite(ms) && ms > 0) await sleep(Math.min(ms, 30000))
    const text = typeof args.text === 'string' && args.text ? args.text : null
    if (!text) {
      return {
        ok: true,
        result: { ok: true, waitedMs: Date.now() - start, settledMs: await quiet() }
      }
    }
    const timeout = Math.min(Number(args.timeoutMs ?? 10000) || 10000, 30000)
    while (Date.now() - start < timeout) {
      if (findSafeText(text)) {
        return { ok: true, result: { ok: true, waitedMs: Date.now() - start } }
      }
      await sleep(200)
    }
    return { ok: true, result: { ok: false, waitedMs: Date.now() - start } }
  }
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

/** agent 输入标记窗口：注入的操作引发的命令 / IPC 归属 YAYA 会话（agent-ui）。
 *  长操作（等待 / 快照 / 导航）随后续等待放宽；窗口过期后命令按用户来源计——
 *  只会「少算」agent，不会把用户的操作误记成 agent。 */
function tagMs(req: BridgeRequest): number {
  if (req.method === 'wait' || req.method === 'snapshot' || req.method === 'navigate') {
    const to = Number(req.args?.timeoutMs ?? 0)
    return Math.max(8000, (Number.isFinite(to) ? to : 0) + 4000)
  }
  return 6000
}

async function reply(id: string, body: Reply): Promise<void> {
  try {
    await bridgePost('/api/ui-result', { id, ...body })
  } catch {
    // 宿主可能已经超时 / 断开：忽略（结果不会被执行第二次）
  }
}

/**
 * 只读方法：不注入任何输入，也就**不打 agent 输入标记**（与主进程
 * `browser-ui.ts` 的 READONLY_BROWSER_UI_METHODS 保持一致，渲染端不能 import 主进程模块）。
 */
const READONLY_METHODS: ReadonlySet<string> = new Set([
  'snapshot',
  'screenshot',
  'pageInfo',
  'wait'
])

/** 已被宿主取消、但还没轮到执行的请求 id（有上限，防止迟到的取消帧堆积） */
const cancelledIds = new Set<string>()
const MAX_CANCELLED = 256
let active: { id: string; ctrl: AbortController } | null = null
/** 请求串行执行：上一个动作没做完不开始下一个，取消才有明确的「之前 / 之后」 */
let chain: Promise<void> = Promise.resolve()

function onCancel(id: unknown): void {
  if (typeof id !== 'string' || !id) return
  if (active?.id === id) {
    active.ctrl.abort()
    return
  }
  cancelledIds.add(id)
  if (cancelledIds.size > MAX_CANCELLED) {
    const oldest = cancelledIds.values().next().value
    if (oldest !== undefined) cancelledIds.delete(oldest)
  }
}

async function handle(req: BridgeRequest): Promise<void> {
  if (!req || typeof req.id !== 'string' || typeof req.method !== 'string') return
  // 排队期间已被取消（停止 / 宿主超时）：宿主不再等结果，直接丢弃，绝不迟到执行
  if (cancelledIds.delete(req.id)) return
  const handler = HANDLERS[req.method]
  if (!handler) {
    await reply(req.id, {
      ok: false,
      code: 'unknown_method',
      error: `页面桥不支持的方法：${req.method}`
    })
    return
  }
  const ctrl = new AbortController()
  active = { id: req.id, ctrl }
  activeSignal = ctrl.signal
  try {
    if (typeof req.session === 'string' && req.session && !READONLY_METHODS.has(req.method)) {
      emitLocal('cockpit:agent-input', { session: req.session, until: Date.now() + tagMs(req) })
    }
    const args: BridgeArgs =
      req.args && typeof req.args === 'object' ? (req.args as BridgeArgs) : {}
    const result = await handler(args)
    if (!ctrl.signal.aborted) await reply(req.id, result)
  } catch (e) {
    // 取消：宿主已经放弃这个请求，不回传
    if (!(e instanceof CancelledError) && !ctrl.signal.aborted) {
      await reply(req.id, {
        ok: false,
        code: 'handler_error',
        error: e instanceof Error ? e.message : String(e)
      })
    }
  } finally {
    active = null
    activeSignal = null
  }
}

/** 由 web-shim 在创建 window.cockpit 后调用（只登记，不主动发起任何请求）。 */
export function initBrowserBridge(cockpit: {
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
}): void {
  cockpit.on(CHANNEL, (raw) => {
    const req = raw as BridgeRequest
    chain = chain.then(() => handle(req)).catch(() => undefined)
  })
  cockpit.on(CANCEL_CHANNEL, (id) => onCancel(id))
}
