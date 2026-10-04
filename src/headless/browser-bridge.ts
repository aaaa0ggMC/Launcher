/**
 * 无头浏览器 UI 桥（页面侧）—— 主进程 `src/main/process/browser-ui.ts` 的配套。
 *
 * 每个网页标签页加载时登记一个随机 clientId（web-shim），宿主只把**固定方法**的请求
 * 定向发给「发起本次 YAYA 工作流的那个标签页」，本文件执行后经 `/api/ui-result` 回传。
 *
 * 硬规则（与 Electron 的 CDP inspector 对齐，但受网页能力限制）：
 *  - 不执行任意代码：只有 snapshot / pageInfo / navigate / click / clickAt / type / key /
 *    scroll / wait 这几个固定方法；
 *  - 没有截图、没有可信输入：click / type / key 都是**合成事件**（isTrusted = false），
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

const MAX_SNAPSHOT_LINES = 900
const MAX_NODES = 6000

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
  if (ctx.lines.length >= MAX_SNAPSHOT_LINES) {
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
  const text = ctx.lines.join('\n')
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
      text: text + (ctx.truncated ? `\n… (truncated at ${MAX_SNAPSHOT_LINES} lines)` : ''),
      ...(ctx.truncated ? { truncated: true } : {})
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
// 固定方法表（没有 eval / 任意 JS 通道）
// ---------------------------------------------------------------------------

type Handler = (args: BridgeArgs) => Promise<Reply>

const HANDLERS: Record<string, Handler> = {
  snapshot: doSnapshot,
  pageInfo: doPageInfo,
  navigate: doNavigate,

  click: async (args) => elementOp(args, needRef(args), (el) => clickEl(el as Element, args)),

  clickAt: async (args) => {
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, code: 'bad_args', error: '需要数字坐标 x / y（CSS 像素）' }
    }
    return elementOp(args, document.elementFromPoint(x, y), (el) => clickEl(el as Element, args))
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
      if (Number.isFinite(x) && Number.isFinite(y)) el = document.elementFromPoint(x, y)
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
const READONLY_METHODS: ReadonlySet<string> = new Set(['snapshot', 'pageInfo', 'wait'])

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
