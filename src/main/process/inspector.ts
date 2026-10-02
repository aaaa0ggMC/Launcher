/**
 * UI inspector（主进程）—— docs/agent-access-design.md §4。
 *
 * 让脚本 / AI 像用户一样「看」和「操作」主窗口：
 *  - snapshot：Chromium 无障碍树（CDP Accessibility.getFullAXTree）→ 带 ref 的文本树，
 *    比 toMarkdown 精细：role / name / value / 状态 / 可滚动区域；
 *  - click / type / key / scroll：CDP Input.* 可信输入（isTrusted = true），与真实用户操作一致；
 *  - screenshot：截图前在页面上覆盖遮罩，隐私区域不进图；
 *  - 每次操作 / 快照前先等页面稳定（无进行中的命令 + DOM 300ms 无变化），应对懒加载。
 *
 * 隐私：按 DOM 标签（v-privacy / v-agent-forbidden / password 输入框）脱敏，**与用户是否点开明文无关**；
 * 点击受保护元素前 guard，禁区直接拒绝。只能检查主窗口——授权窗口等子窗口永远不在范围内。
 * 走 `webContents.debugger`（进程内 CDP），不需要 --remote-debugging-port。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage, type NativeImage, type WebContents } from 'electron'
import { getMainWindow } from './windows'
import { registerPreRunHook } from './commands/registry'
import { isolateViewEnabled, screenshotModeSetting } from './agent/config'
import { agentViewContents, prepareAgentView } from './agent/views'
import { inflightCommands } from './ipc'
import { USER_CONFIG_DIR } from './paths'
import {
  currentOrigin,
  guard,
  hasClearance,
  isAgentOrigin,
  isAgentReader,
  listPrivacyScopes,
  noteRedaction,
  redactedMarker,
  PrivacyDeniedError,
  SCOPE_SECRET
} from './privacy'

/** agent 输入后，渲染端 IPC 被标成 agent-ui 的时长（覆盖 点击 → 处理函数 → IPC）。 */
const AGENT_INPUT_TAG_MS = 3000
const SETTLE_QUIET_MS = 300
const SETTLE_MAX_MS = 4000
const MAX_SNAPSHOT_LINES = 1500

type Cdp = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * agent 调用的目标会话：agent 来源（mcp / remote / 脚本）且带会话 id。
 * `agent-ui` 不算——那是视图自己发出的 IPC，不是对视图的操作。
 */
function agentTargetSession(): string | null {
  const o = currentOrigin()
  return isAgentOrigin(o) && o.kind !== 'agent-ui' && o.session ? o.session : null
}

/**
 * 操作目标：agent 会话有独立视图就用它，否则用户的主窗口。
 * 同步取用——视图由 `prepareTarget()`（`ui.*` 命令的 pre-run 钩子）提前建好并等加载完。
 */
function mainContents(): WebContents {
  const s = agentTargetSession()
  const view = s ? agentViewContents(s) : null
  if (view) return view
  const w = getMainWindow()
  if (!w || w.isDestroyed()) throw new Error('主窗口不可用')
  return w.webContents
}

/** agent 的 `ui.*` 调用前：开启隔离时，确保该会话的独立视图存在且已加载。 */
async function prepareTarget(): Promise<void> {
  const s = agentTargetSession()
  if (!s || !(await isolateViewEnabled())) return
  await prepareAgentView(s)
}
registerPreRunHook('ui.', prepareTarget)

/** 每个视图各自的输入 / 引用状态——主窗口与 agent 视图不能共用同一份 ref 表和鼠标位置。 */
interface ViewState {
  refMap: Map<string, number>
  held: number
  last: Point | null
}
const viewStates = new WeakMap<WebContents, ViewState>()
function vs(): ViewState {
  const wc = mainContents()
  let st = viewStates.get(wc)
  if (!st) {
    st = { refMap: new Map(), held: 0, last: null }
    viewStates.set(wc, st)
  }
  return st
}

function cdpFor(wc: WebContents): Cdp {
  const dbg = wc.debugger
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3')
    } catch (e) {
      throw new Error(
        `无法附加调试协议（可能已有其他调试器）：${e instanceof Error ? e.message : e}`
      )
    }
  }
  return (method, params) => dbg.sendCommand(method, params ?? {})
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = (await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } }
  if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.text ?? ''}`)
  return r.result?.value as T
}

// ---------------------------------------------------------------------------
// 稳定等待（懒加载 / 异步取数）
// ---------------------------------------------------------------------------

const QUIET_JS = (quiet: number, max: number): string => `new Promise((resolve) => {
  let t; const start = Date.now()
  const done = () => { obs.disconnect(); resolve(Date.now() - start) }
  const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ${quiet}) })
  // 只看节点增删与文本变化：属性动画（进度条、过渡）会一直触发，导致永远等不到安静
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true })
  t = setTimeout(done, ${quiet})
  setTimeout(done, ${max})
})`

/**
 * 等当前页面就绪：App 在异步页面组件加载、挂载、过渡结束后把根节点的 `data-ability-ready`
 * 设为当前能力 id。加载期间 DOM 不变，单靠 settle 会误判成「已稳定」而拍到空白占位。
 */
const READY_MAX_MS = 8000
async function waitPageReady(cdp: Cdp, expect?: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < READY_MAX_MS) {
    const st = await evaluate<{ cur: string; ready: string }>(
      cdp,
      `(() => { const el = document.querySelector('[data-current-ability]'); return { cur: el?.getAttribute('data-current-ability') ?? '', ready: el?.getAttribute('data-ability-ready') ?? '' } })()`
    )
    const target = expect ?? st.cur
    if (!target || st.ready === target) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 等：没有进行中的渲染端命令，且 DOM 安静 300ms（上限 4s）。返回耗时 ms。 */
async function settle(cdp: Cdp): Promise<number> {
  const start = Date.now()
  while (inflightCommands() > 0 && Date.now() - start < SETTLE_MAX_MS) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const left = Math.max(SETTLE_MAX_MS - (Date.now() - start), SETTLE_QUIET_MS)
  await evaluate(cdp, QUIET_JS(SETTLE_QUIET_MS, left))
  return Date.now() - start
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface AXValue {
  value?: unknown
}
interface AXProperty {
  name: string
  value: AXValue
}
interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: AXProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
}

interface Mark {
  privacy?: string
  /** 揭示类操作要求的 scope（点击前需许可） */
  action?: string
  forbidden?: boolean
  password?: boolean
  /** "scrollTop,scrollHeight,clientHeight" */
  scroll?: string
  /** <canvas>：无障碍树里通常没有语义，但游戏 / 图表需要按坐标操作，单独给 ref */
  canvas?: boolean
}

const INTERACTIVE = new Set([
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
const STRUCTURAL = new Set([
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
  'progressbar'
])
const TEXT_ROLES = new Set(['StaticText', 'text'])
/** interactive 模式下也展开其中文本的容器（错误提示 / 状态 / 对话框内容不能丢） */
const TEXT_CONTAINERS = new Set(['alert', 'alertdialog', 'status', 'dialog', 'tooltip'])
const SKIP_ROLES = new Set(['InlineTextBox', 'LineBreak'])

/** ref → backendDOMNodeId（每次 snapshot 重建；页面变化后旧 ref 可能失效）。 */

const MARK_SELECTOR =
  '[data-privacy],[data-privacy-action],[data-agent="forbidden"],input[type="password"],[data-cockpit-scroll],canvas'

/** 页面端：给当前可滚动的容器打上 data-cockpit-scroll（位置信息），供快照标注。 */
const TAG_SCROLLABLES_JS = `(() => {
  for (const el of document.querySelectorAll('[data-cockpit-scroll]')) el.removeAttribute('data-cockpit-scroll')
  let n = 0
  const all = document.querySelectorAll('body *')
  for (const el of all) {
    if (el.scrollHeight <= el.clientHeight + 4 || el.clientHeight < 40) continue
    const oy = getComputedStyle(el).overflowY
    if (oy !== 'auto' && oy !== 'scroll') continue
    el.setAttribute('data-cockpit-scroll', [Math.round(el.scrollTop), el.scrollHeight, el.clientHeight].join(','))
    if (++n > 40) break
  }
  const se = document.scrollingElement
  if (se && se.scrollHeight > se.clientHeight + 4) se.setAttribute('data-cockpit-scroll', [Math.round(se.scrollTop), se.scrollHeight, se.clientHeight].join(','))
  return n
})()`

async function collectMarks(cdp: Cdp): Promise<Map<number, Mark>> {
  await evaluate(cdp, TAG_SCROLLABLES_JS)
  const doc = (await cdp('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } }
  const { nodeIds } = (await cdp('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: MARK_SELECTOR
  })) as { nodeIds: number[] }
  const marks = new Map<number, Mark>()
  for (const nodeId of nodeIds) {
    const { node } = (await cdp('DOM.describeNode', { nodeId })) as {
      node: { backendNodeId: number; attributes?: string[]; nodeName?: string }
    }
    const attrs = new Map<string, string>()
    const a = node.attributes ?? []
    for (let i = 0; i + 1 < a.length; i += 2) attrs.set(a[i], a[i + 1])
    marks.set(node.backendNodeId, {
      privacy: attrs.get('data-privacy') || undefined,
      action: attrs.get('data-privacy-action') || undefined,
      forbidden: attrs.get('data-agent') === 'forbidden',
      password: node.nodeName === 'INPUT' && attrs.get('type') === 'password',
      scroll: attrs.get('data-cockpit-scroll'),
      canvas: node.nodeName === 'CANVAS'
    })
  }
  return marks
}

function str(v: AXValue | undefined): string {
  const x = v?.value
  return x === undefined || x === null ? '' : String(x).replace(/\s+/g, ' ').trim()
}

function quote(s: string, max = 120): string {
  const t = s.length > max ? s.slice(0, max) + '…' : s
  return JSON.stringify(t)
}

function flagsOf(n: AXNode): string[] {
  const out: string[] = []
  for (const p of n.properties ?? []) {
    const v = p.value?.value
    if (p.name === 'disabled' && v === true) out.push('disabled')
    else if (p.name === 'checked' && (v === true || v === 'true')) out.push('checked')
    else if (p.name === 'checked' && v === 'mixed') out.push('mixed')
    else if (p.name === 'selected' && v === true) out.push('selected')
    else if (p.name === 'expanded') out.push(v === true ? 'expanded' : 'collapsed')
    else if (p.name === 'pressed' && (v === true || v === 'true')) out.push('pressed')
    else if (p.name === 'focused' && v === true) out.push('focused')
    else if (p.name === 'required' && v === true) out.push('required')
    else if (p.name === 'level' && typeof v === 'number') out.push(`level=${v}`)
  }
  return out
}

function isFocusable(n: AXNode): boolean {
  return (n.properties ?? []).some((p) => p.name === 'focusable' && p.value?.value === true)
}

function scrollNote(spec: string): string {
  const [top, height, client] = spec.split(',').map(Number)
  if (!Number.isFinite(height) || height <= client) return ''
  const pct = Math.round((top / (height - client)) * 100)
  const below = height - client - top > 4
  return `[scroll ${pct}%${below ? ' · more below' : ' · end'}]`
}

const ICON_HINT_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement
  const t = el.getAttribute('title') || el.getAttribute('data-tooltip')
  if (t) return t
  const i = el.classList.contains('mdi') ? el : el.querySelector('.mdi, [class*="mdi-"]')
  const c = i ? [...i.classList].find((x) => x.startsWith('mdi-') && x !== 'mdi-set') : null
  return c ? c.slice(4) : ''
}`

/** 没有可访问名称的可交互元素（纯图标按钮）：用 title 或 mdi 图标名给个提示。 */
async function namelessIconHints(cdp: Cdp, nodes: AXNode[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const targets = nodes.filter(
    (n) => !n.ignored && n.backendDOMNodeId && INTERACTIVE.has(str(n.role)) && !str(n.name)
  )
  for (const n of targets.slice(0, 80)) {
    try {
      const { object } = (await cdp('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId })) as {
        object: { objectId: string }
      }
      const r = (await cdp('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: ICON_HINT_FN,
        returnByValue: true
      })) as { result: { value?: string } }
      if (r.result.value) out.set(n.backendDOMNodeId!, r.result.value)
    } catch {
      /* node vanished — no hint */
    }
  }
  return out
}

export interface SnapshotOptions {
  /** interactive（默认）：可交互元素 + 结构；full：外加全部文本 */
  mode?: 'interactive' | 'full'
  /** 给每个 ref 附上它在截图上的位置 `@(x,y wxh)`（截图像素），便于对照截图按坐标操作 */
  boxes?: boolean
}

export interface SnapshotResult {
  ok: true
  page: string
  url: string
  viewport: { width: number; height: number; zoom: number }
  /** 截图像素 / CSS 像素；ui.click_at 等默认按截图像素接收坐标 */
  scale: number
  settledMs: number
  /** 快照时仍在进行中的渲染端命令数（> 0 = 页面还在加载，稍后可再 snapshot） */
  pendingCommands: number
  refs: number
  text: string
  truncated?: boolean
}

export async function snapshot(opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const t0 = Date.now()
  await waitPageReady(cdp)
  await settle(cdp)
  const settledMs = Date.now() - t0
  const full = opts.mode === 'full'
  const reader = isAgentReader()
  const marks = await collectMarks(cdp)
  const { nodes } = (await cdp('Accessibility.getFullAXTree')) as { nodes: AXNode[] }
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const meta = await evaluate<{ page: string; w: number; h: number; zoom: number }>(
    cdp,
    `({ page: document.querySelector('[data-current-ability]')?.getAttribute('data-current-ability') ?? '', w: innerWidth, h: innerHeight, zoom: devicePixelRatio })`
  )

  vs().refMap = new Map()
  const lines: string[] = []
  let truncated = false
  const emit = (depth: number, line: string): void => {
    if (lines.length >= MAX_SNAPSHOT_LINES) {
      truncated = true
      return
    }
    lines.push('  '.repeat(depth) + '- ' + line)
  }
  const newRef = (n: AXNode): string => {
    if (!n.backendDOMNodeId) return ''
    const ref = `e${vs().refMap.size + 1}`
    vs().refMap.set(ref, n.backendDOMNodeId)
    return ref
  }

  /** privacy = 当前所在的未授权隐私区 scope（已授权 / 非 agent 时为 undefined） */
  const walk = (
    n: AXNode | undefined,
    depth: number,
    privacy: string | undefined,
    parentName: string,
    showText = full
  ): void => {
    if (!n || truncated) return
    const mark = n.backendDOMNodeId ? marks.get(n.backendDOMNodeId) : undefined
    if (mark?.forbidden && reader) {
      emit(depth, 'region [forbidden]')
      return
    }
    let scope = privacy
    let enteredPrivacy = false
    if (mark?.privacy && reader && !hasClearance(mark.privacy) && !scope) {
      scope = mark.privacy
      enteredPrivacy = true
    }
    const role = str(n.role)
    const kids = (): void => {
      for (const c of n.childIds ?? []) walk(byId.get(c), depth, scope, parentName, showText)
    }
    const kidsDeeper = (name: string, text = showText): void => {
      for (const c of n.childIds ?? []) walk(byId.get(c), depth + 1, scope, name, text)
    }

    if (enteredPrivacy) {
      // 隐私区：只露出 scope 占位与其中的可交互元素（名字同样脱敏）
      noteRedaction(scope!)
      emit(depth, `group ${redactedMarker(scope!)} [privacy=${scope}]`)
      kidsDeeper('')
      return
    }
    if (mark?.canvas) {
      // 画布（游戏 / 图表）：无障碍树里没有内容，给个 ref + 位置，供按坐标操作
      const ref = newRef(n)
      const label = str(n.name)
      emit(
        depth,
        [
          'canvas',
          label ? quote(label) : '',
          ref ? `[ref=${ref}]` : '',
          scope ? `[privacy=${scope}]` : ''
        ]
          .filter(Boolean)
          .join(' ')
      )
      return
    }
    if (n.ignored || SKIP_ROLES.has(role)) {
      kids()
      return
    }
    let name = str(n.name)
    let value = str(n.value)
    if (scope) {
      if (name) name = redactedMarker(scope)
      if (value) value = redactedMarker(scope)
    }
    if (mark?.password && reader && value) {
      value = redactedMarker(SCOPE_SECRET)
      noteRedaction(SCOPE_SECRET)
    }

    if (TEXT_ROLES.has(role)) {
      if (showText && name && name !== parentName && !scope) emit(depth, `text ${quote(name, 200)}`)
      return
    }

    const interactive =
      INTERACTIVE.has(role) || (isFocusable(n) && !!name && role !== 'RootWebArea')
    // 没有名字的图片 / 进度条是装饰（图标、加载动画），对理解界面没有帮助
    const decorative = (role === 'image' || role === 'img' || role === 'progressbar') && !name
    const structural = STRUCTURAL.has(role) && !decorative
    const scroll = mark?.scroll ? scrollNote(mark.scroll) : ''
    if (!interactive && !structural && !scroll) {
      kids()
      return
    }
    const parts = [role === 'generic' ? 'scrollable' : role]
    if (name) parts.push(quote(name))
    else if (interactive && n.backendDOMNodeId && iconHints.get(n.backendDOMNodeId)) {
      parts.push(`(icon: ${iconHints.get(n.backendDOMNodeId)})`)
    }
    if (interactive) {
      const ref = newRef(n)
      if (ref) parts.push(`[ref=${ref}]`)
    }
    for (const f of flagsOf(n)) parts.push(`[${f}]`)
    if (value) parts.push(`value=${quote(value)}`)
    if (scope) parts.push(`[privacy=${scope}]`)
    if (mark?.action && reader) parts.push(`[privacy-action=${mark.action}]`)
    if (scroll) parts.push(scroll)
    emit(depth, parts.join(' '))
    // 可交互元素的子文本通常就是它的名字，interactive 模式下不展开
    if (interactive && !showText) {
      for (const c of n.childIds ?? []) walkInteractiveOnly(byId.get(c), depth + 1, scope)
      return
    }
    kidsDeeper(name, showText || TEXT_CONTAINERS.has(role))
  }

  /** 可交互元素内部：只找嵌套的可交互元素（如列表项里的按钮），跳过文本。 */
  const walkInteractiveOnly = (
    n: AXNode | undefined,
    depth: number,
    scope: string | undefined
  ): void => {
    if (!n || truncated) return
    const role = str(n.role)
    if (!n.ignored && INTERACTIVE.has(role)) {
      walk(n, depth, scope, '')
      return
    }
    for (const c of n.childIds ?? []) walkInteractiveOnly(byId.get(c), depth, scope)
  }

  const iconHints = await namelessIconHints(cdp, nodes)
  walk(nodes[0], 0, undefined, '')
  let text = lines.join('\n')
  if (opts.boxes) text = await appendBoxes(cdp, text, meta.zoom)
  return {
    ok: true,
    page: meta.page,
    url: wc.getURL(),
    viewport: { width: meta.w, height: meta.h, zoom: meta.zoom },
    scale: meta.zoom,
    settledMs,
    pendingCommands: inflightCommands(),
    refs: vs().refMap.size,
    text: text + (truncated ? `\n… (truncated at ${MAX_SNAPSHOT_LINES} lines)` : ''),
    ...(truncated ? { truncated } : {})
  }
}

/** 给快照里每个 `[ref=eN]` 追加 `@(x,y wxh)`（截图像素，左上角 + 尺寸）；不在可视区内的标 `@offscreen`。 */
async function appendBoxes(cdp: Cdp, text: string, scale: number): Promise<string> {
  const vp = await evaluate<{ w: number; h: number }>(cdp, '({ w: innerWidth, h: innerHeight })')
  const boxes = new Map<string, string>()
  let n = 0
  for (const [ref, backendNodeId] of vs().refMap) {
    if (++n > 400) break
    try {
      const { quads } = (await cdp('DOM.getContentQuads', { backendNodeId })) as {
        quads: number[][]
      }
      const q = quads?.[0]
      if (!q) continue
      const xs = [q[0], q[2], q[4], q[6]]
      const ys = [q[1], q[3], q[5], q[7]]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const w = Math.max(...xs) - x
      const h = Math.max(...ys) - y
      const visible = x + w > 0 && y + h > 0 && x < vp.w && y < vp.h
      boxes.set(
        ref,
        visible
          ? `@(${Math.round(x * scale)},${Math.round(y * scale)} ${Math.round(w * scale)}x${Math.round(h * scale)})`
          : '@offscreen'
      )
    } catch {
      /* node without layout (display:none etc.) */
    }
  }
  return text.replace(/\[ref=(e\d+)\]/g, (m, ref: string) =>
    boxes.has(ref) ? `${m} ${boxes.get(ref)}` : m
  )
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface ElementInfo {
  privacy: string | null
  /** 揭示类操作要求的 scope（逗号分隔） */
  action: string | null
  /** 元素可见文字（只用于授权窗口的理由，AI 看不到授权窗口） */
  label: string
  forbidden: boolean
  x: number
  y: number
  w: number
  h: number
}

const ELEMENT_INFO_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  const p = el.closest('[data-privacy]')
  const a = el.closest('[data-privacy-action]')
  return {
    privacy: p ? p.getAttribute('data-privacy') : null,
    action: a ? a.getAttribute('data-privacy-action') : null,
    label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().slice(0, 40),
    forbidden: !!el.closest('[data-agent="forbidden"]'),
    x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height
  }
}`

async function objectIdOf(cdp: Cdp, ref: string): Promise<string> {
  const backendNodeId = vs().refMap.get(ref)
  if (!backendNodeId) throw new Error(`未知或已失效的 ref：${ref}（请重新 ui.snapshot）`)
  try {
    const r = (await cdp('DOM.resolveNode', { backendNodeId })) as { object: { objectId: string } }
    return r.object.objectId
  } catch {
    throw new Error(`ref ${ref} 对应的元素已不在页面上（请重新 ui.snapshot）`)
  }
}

/**
 * 隐私检查（ref 操作与坐标操作共用）：禁区直接拒绝；隐私区 / 揭示类按钮先 guard。
 * 只对 agent 来源生效——用户自己（ui / cli）的操作不受影响。
 */
async function guardElement(info: ElementInfo, action: string, fallback: string): Promise<void> {
  if (!isAgentOrigin()) return
  if (info.forbidden) {
    throw new PrivacyDeniedError('agent_denied', [], `${fallback} 位于 AI 禁区，不能${action}`)
  }
  const scopes = [
    ...(info.privacy ? [info.privacy] : []),
    ...(info.action ? info.action.split(',').map((x) => x.trim()) : [])
  ].filter(Boolean)
  if (scopes.length) {
    await guard(
      [...new Set(scopes)],
      info.label ? `${action}「${info.label}」` : `${action} ${fallback}`
    )
  }
}

/** 定位元素 + 隐私检查。 */
async function prepare(cdp: Cdp, ref: string, action: string): Promise<ElementInfo> {
  const objectId = await objectIdOf(cdp, ref)
  const r = (await cdp('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: ELEMENT_INFO_FN,
    returnByValue: true
  })) as { result: { value: ElementInfo } }
  const info = r.result.value
  await guardElement(info, action, ref)
  if (info.w <= 0 || info.h <= 0) throw new Error(`${ref} 不可见（尺寸为 0），无法${action}`)
  return info
}

// -- 坐标操作 ---------------------------------------------------------------------

/** 坐标空间：image = 截图像素（默认，AI 对着截图找位置）；css = 页面 CSS 像素。 */
export type CoordSpace = 'image' | 'css'

export interface Point {
  x: number
  y: number
}

async function toCss(cdp: Cdp, p: Point, space: CoordSpace = 'image'): Promise<Point> {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('坐标需要是数字')
  if (space === 'css') return p
  const scale = await evaluate<number>(cdp, 'devicePixelRatio')
  return { x: p.x / scale, y: p.y / scale }
}

/** 坐标命中测试：该点下面是哪个元素、是否在隐私区 / 禁区（不滚动页面）。 */
const HIT_FN = (x: number, y: number): string => `(() => {
  const el = document.elementFromPoint(${x}, ${y})
  if (!el) return null
  const p = el.closest('[data-privacy]')
  const a = el.closest('[data-privacy-action]')
  const r = el.getBoundingClientRect()
  return {
    privacy: p ? p.getAttribute('data-privacy') : null,
    action: a ? a.getAttribute('data-privacy-action') : null,
    label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.tagName.toLowerCase()).trim().slice(0, 40),
    forbidden: !!el.closest('[data-agent="forbidden"]'),
    x: ${x}, y: ${y}, w: r.width, h: r.height
  }
})()`

/** 坐标点的命中 + 隐私检查；点在窗口外 → 报错。返回命中元素的简述（给 AI 确认点到了什么）。 */
async function guardPoint(cdp: Cdp, p: Point, action: string): Promise<string> {
  const info = await evaluate<ElementInfo | null>(cdp, HIT_FN(p.x, p.y))
  if (!info) throw new Error(`坐标 (${Math.round(p.x)}, ${Math.round(p.y)}) 不在窗口内`)
  await guardElement(info, action, `(${Math.round(p.x)}, ${Math.round(p.y)})`)
  // 隐私区里的元素，返回给 agent 的描述不能带出文字
  if (info.privacy && !hasClearance(info.privacy)) {
    noteRedaction(info.privacy)
    return redactedMarker(info.privacy)
  }
  return info.label
}

/** AI 操作位置的可视提示：屏幕上闪一个圆点，让用户看到 AI 点了哪里（不拦截事件）。 */
async function showMarker(
  cdp: Cdp,
  p: Point,
  kind: 'click' | 'press' | 'move' = 'click'
): Promise<void> {
  if (!isAgentOrigin()) return
  const size = kind === 'move' ? 10 : 22
  await evaluate(
    cdp,
    `(() => {
      const d = document.createElement('div')
      d.className = '__cockpit_ai_marker'
      d.style.cssText = 'position:fixed;left:${p.x - size / 2}px;top:${p.y - size / 2}px;width:${size}px;height:${size}px;border-radius:50%;pointer-events:none;z-index:2147483646;border:2px solid rgb(var(--v-theme-primary));background:rgba(var(--v-theme-primary),0.25);transition:opacity .6s ease, transform .6s ease'
      document.documentElement.appendChild(d)
      requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'scale(1.8)' })
      setTimeout(() => d.remove(), 700)
    })()`
  ).catch(() => {})
}

/** 当前按住的鼠标键（CDP 的 buttons 位掩码：左 1 / 右 2 / 中 4），拖动时 mouseMoved 要带上。 */
/** 最近一次派发鼠标事件的位置（CSS 像素），时间轴里带 duration_ms 的平滑移动从这里起步。 */
const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 }

export type MouseButton = 'left' | 'right' | 'middle'

interface ActOptions {
  space?: CoordSpace
  /** false = 不等页面稳定（游戏等连续操作）；默认等 */
  settle?: boolean
}

async function finish(cdp: Cdp, opts: ActOptions): Promise<number> {
  return opts.settle === false ? 0 : settle(cdp)
}

/** 在坐标处点击（可右键 / 双击）。点到隐私区会先要求许可，点到禁区直接拒绝。 */
export async function clickAt(
  point: Point,
  opts: ActOptions & { button?: MouseButton; double?: boolean } = {}
): Promise<{ ok: true; target: string; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const p = await toCss(cdp, point, opts.space)
  const target = await guardPoint(cdp, p, '点击')
  tagAgentInput(wc)
  await showMarker(cdp, p)
  await mouseClick(cdp, p.x, p.y, opts.button ?? 'left', opts.double ? 2 : 1)
  return { ok: true, target, settledMs: await finish(cdp, opts) }
}

/** 移动鼠标（悬停）；按住键时即拖动中的移动。 */
export async function moveTo(
  point: Point,
  opts: ActOptions = {}
): Promise<{ ok: true; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const p = await toCss(cdp, point, opts.space)
  tagAgentInput(wc)
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: p.x,
    y: p.y,
    buttons: vs().held
  })
  vs().last = p
  if (vs().held) await showMarker(cdp, p, 'move')
  return { ok: true, settledMs: await finish(cdp, opts) }
}

/** 单独按下 / 松开鼠标键（按住不放、配合 moveTo 做复杂拖动）。按下的位置同样做隐私检查。 */
export async function mouseButton(
  action: 'down' | 'up',
  point: Point,
  opts: ActOptions & { button?: MouseButton } = {}
): Promise<{ ok: true; target?: string; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const p = await toCss(cdp, point, opts.space)
  const button = opts.button ?? 'left'
  const target = action === 'down' ? await guardPoint(cdp, p, '按下') : undefined
  tagAgentInput(wc)
  vs().last = p
  if (action === 'down') {
    vs().held |= BUTTON_MASK[button]
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      buttons: vs().held
    })
    await showMarker(cdp, p, 'press')
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: p.x,
      y: p.y,
      button,
      buttons: vs().held,
      clickCount: 1
    })
  } else {
    vs().held &= ~BUTTON_MASK[button]
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: p.x,
      y: p.y,
      button,
      buttons: vs().held,
      clickCount: 1
    })
  }
  return {
    ok: true,
    ...(target !== undefined ? { target } : {}),
    settledMs: await finish(cdp, opts)
  }
}

/** 拖动：按下 → 分步移动 → 松开。起点与终点都做隐私检查。 */
export async function drag(
  from: Point,
  to: Point,
  opts: ActOptions & { button?: MouseButton; steps?: number; durationMs?: number } = {}
): Promise<{ ok: true; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const a = await toCss(cdp, from, opts.space)
  const b = await toCss(cdp, to, opts.space)
  await guardPoint(cdp, a, '拖动')
  await guardPoint(cdp, b, '拖动到')
  const button = opts.button ?? 'left'
  const steps = Math.min(Math.max(Math.round(opts.steps ?? 12), 1), 100)
  const pause = Math.min(Math.max(opts.durationMs ?? 240, 0), 5000) / steps
  tagAgentInput(wc)
  await showMarker(cdp, a, 'press')
  vs().held |= BUTTON_MASK[button]
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: a.x,
    y: a.y,
    buttons: vs().held
  })
  await cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: a.x,
    y: a.y,
    button,
    buttons: vs().held,
    clickCount: 1
  })
  try {
    for (let i = 1; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps
      const y = a.y + ((b.y - a.y) * i) / steps
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: vs().held })
      if (pause > 0) await new Promise((r) => setTimeout(r, pause))
    }
  } finally {
    vs().held &= ~BUTTON_MASK[button]
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: b.x,
      y: b.y,
      button,
      buttons: vs().held,
      clickCount: 1
    })
  }
  vs().last = b
  await showMarker(cdp, b)
  return { ok: true, settledMs: await finish(cdp, opts) }
}

/** 注入输入前通知渲染端：接下来的 IPC 归属 agent（只降权）。 */
function tagAgentInput(wc: WebContents, extraMs = 0): void {
  const o = currentOrigin()
  if (!isAgentOrigin(o)) return
  wc.send('cockpit:agent-input', {
    session: o.session ?? o.kind,
    until: Date.now() + AGENT_INPUT_TAG_MS + extraMs
  })
}

async function mouseClick(
  cdp: Cdp,
  x: number,
  y: number,
  button = 'left',
  clickCount = 1
): Promise<void> {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: vs().held })
  vs().last = { x, y }
  const mask = BUTTON_MASK[button] ?? 1
  for (let i = 1; i <= clickCount; i++) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: vs().held | mask,
      clickCount: i
    })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: vs().held,
      clickCount: i
    })
  }
}

export async function click(
  ref: string,
  opts: { button?: MouseButton; double?: boolean } = {}
): Promise<{ ok: true; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const info = await prepare(cdp, ref, '点击')
  tagAgentInput(wc)
  await showMarker(cdp, info)
  await mouseClick(cdp, info.x, info.y, opts.button ?? 'left', opts.double ? 2 : 1)
  return { ok: true, settledMs: await settle(cdp) }
}

// -- 键盘 ---------------------------------------------------------------------------

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED_KEYS: Record<string, Omit<KeyDef, 'key'> & { key?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
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

/** 按键名 → CDP 键定义：命名键、单个字母 / 数字 / 符号、F1–F12。 */
function keyDef(name: string): KeyDef {
  const named = NAMED_KEYS[name]
  if (named)
    return { key: named.key ?? name, code: named.code, keyCode: named.keyCode, text: named.text }
  if (/^F([1-9]|1[0-2])$/.test(name)) {
    return { key: name, code: name, keyCode: 111 + Number(name.slice(1)) }
  }
  if (/^[a-zA-Z]$/.test(name)) {
    const up = name.toUpperCase()
    return { key: name, code: `Key${up}`, keyCode: up.charCodeAt(0), text: name }
  }
  if (/^[0-9]$/.test(name))
    return { key: name, code: `Digit${name}`, keyCode: 48 + Number(name), text: name }
  if (name.length === 1) return { key: name, code: '', keyCode: 0, text: name }
  throw new Error(
    `不支持的按键：${name}（可用：${Object.keys(NAMED_KEYS).join(', ')}、F1–F12、单个字母 / 数字 / 符号）`
  )
}

export type Modifier = 'Shift' | 'Control' | 'Alt' | 'Meta'
const MOD_MASK: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

async function keyEvent(
  cdp: Cdp,
  type: 'keyDown' | 'keyUp',
  def: KeyDef,
  modifiers: number
): Promise<void> {
  // 带 Control / Alt / Meta 的组合键不产生文本输入（Ctrl+A 不能插入「a」）
  const withText = type === 'keyDown' && def.text && (modifiers & ~MOD_MASK.Shift) === 0
  await cdp('Input.dispatchKeyEvent', {
    type: withText ? 'keyDown' : type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers,
    ...(withText ? { text: def.text } : {})
  })
}

async function pressKey(
  cdp: Cdp,
  name: string,
  opts: { modifiers?: Modifier[]; holdMs?: number; action?: 'press' | 'down' | 'up' } = {}
): Promise<void> {
  const def = keyDef(name)
  const mods = opts.modifiers ?? []
  const mask = mods.reduce((m, k) => m | (MOD_MASK[k] ?? 0), 0)
  const action = opts.action ?? 'press'
  if (action !== 'up') {
    for (const m of mods) await keyEvent(cdp, 'keyDown', keyDef(m), mask)
    await keyEvent(cdp, 'keyDown', def, mask)
  }
  if (action === 'press') {
    const hold = Math.min(Math.max(opts.holdMs ?? 0, 0), 10_000)
    if (hold > 0) await new Promise((r) => setTimeout(r, hold))
  }
  if (action !== 'down') {
    await keyEvent(cdp, 'keyUp', def, mask)
    for (const m of [...mods].reverse()) await keyEvent(cdp, 'keyUp', keyDef(m), 0)
  }
}

/** 往当前焦点元素输入前的隐私检查（焦点在隐私区 / 禁区的输入框里）。 */
async function guardFocused(cdp: Cdp): Promise<void> {
  const info = await evaluate<ElementInfo | null>(
    cdp,
    `(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const p = el.closest('[data-privacy]')
      return {
        privacy: p ? p.getAttribute('data-privacy') : null,
        action: null,
        label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName.toLowerCase()).slice(0, 40),
        forbidden: !!el.closest('[data-agent="forbidden"]'),
        x: 0, y: 0, w: 1, h: 1
      }
    })()`
  )
  if (info) await guardElement(info, '输入', '当前焦点')
}

/** 输入文本：给 ref 先点击聚焦；不给 ref 则输入到当前焦点（如游戏 / 已聚焦的输入框）。 */
export async function type(
  ref: string | undefined,
  text: string,
  opts: { clear?: boolean; submit?: boolean } = {}
): Promise<{ ok: true; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  if (ref) {
    const info = await prepare(cdp, ref, '输入')
    tagAgentInput(wc)
    await showMarker(cdp, info)
    await mouseClick(cdp, info.x, info.y)
    if (opts.clear) {
      const objectId = await objectIdOf(cdp, ref)
      await cdp('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          const el = this.matches?.('input,textarea') ? this : this.querySelector?.('input,textarea') ?? document.activeElement
          el?.select?.()
        }`
      })
    }
  } else {
    await guardFocused(cdp)
    tagAgentInput(wc)
    if (opts.clear) await pressKey(cdp, 'a', { modifiers: ['Control'] })
  }
  if (text) await cdp('Input.insertText', { text })
  if (opts.submit) await pressKey(cdp, 'Enter')
  return { ok: true, settledMs: await settle(cdp) }
}

/**
 * 按键：press（默认，可 holdMs 按住一段时间，适合游戏移动）/ down / up（自己控制按住与松开）。
 * modifiers 组合键，如 ['Control'] + 'a'。
 */
export async function key(
  name: string,
  opts: ActOptions & {
    modifiers?: Modifier[]
    holdMs?: number
    action?: 'press' | 'down' | 'up'
  } = {}
): Promise<{ ok: true; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  if (opts.action !== 'up') await guardFocused(cdp)
  tagAgentInput(wc)
  await pressKey(cdp, name, opts)
  return { ok: true, settledMs: await finish(cdp, opts) }
}

/** 滚轮：在 ref 上、指定坐标处，或页面中央。 */
export async function scroll(
  opts: ActOptions & { ref?: string; at?: Point; dy?: number; dx?: number } = {}
): Promise<{ ok: true; settledMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  let x: number
  let y: number
  if (opts.ref) {
    const objectId = await objectIdOf(cdp, opts.ref)
    const r = (await cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () { const el = this.nodeType === 1 ? this : this.parentElement; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 200) } }`,
      returnByValue: true
    })) as { result: { value: { x: number; y: number } } }
    ;({ x, y } = r.result.value)
  } else if (opts.at) {
    ;({ x, y } = await toCss(cdp, opts.at, opts.space))
  } else {
    const vp = await evaluate<{ w: number; h: number }>(cdp, '({ w: innerWidth, h: innerHeight })')
    x = vp.w / 2
    y = vp.h / 2
  }
  tagAgentInput(wc)
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: opts.dx ?? 0,
    deltaY: opts.dy ?? 400
  })
  return { ok: true, settledMs: await finish(cdp, opts) }
}

// -- 输入时间轴（键盘 + 鼠标 + 截帧，按相对时间精确派发） -----------------------------

/**
 * 时间轴事件（外部格式，CLI / MCP / Remote 共用，字段 snake_case）。`t` = 相对开始的毫秒。
 *  - key：press（默认，按住 hold_ms 后松开，默认 50ms）/ down / up；modifiers 组合键
 *  - mouse：move（duration_ms > 0 → 从当前位置平滑移动）/ down / up / click（hold_ms 长按，double 双击）/ wheel（dx / dy）
 *  - screenshot：在该时刻截一帧（隐私遮罩照常），不阻塞后续输入
 */
export type TimelineEvent =
  | {
      t: number
      type: 'key'
      key: string
      action?: 'press' | 'down' | 'up'
      hold_ms?: number
      modifiers?: Modifier[]
    }
  | {
      t: number
      type: 'mouse'
      action: 'move' | 'down' | 'up' | 'click' | 'wheel'
      x: number
      y: number
      button?: MouseButton
      hold_ms?: number
      duration_ms?: number
      double?: boolean
      dx?: number
      dy?: number
    }
  | { t: number; type: 'screenshot'; label?: string }

const TIMELINE_MAX_MS = 30_000
const TIMELINE_MAX_EVENTS = 500
const TIMELINE_MAX_FRAMES = 6
const TIMELINE_DEFAULT_PRESS_MS = 50
/** 平滑移动的步长（约一帧） */
const TIMELINE_MOVE_STEP_MS = 16

export interface TimelineFrame {
  /** 计划时刻（ms） */
  t: number
  /** 实际截取时刻（ms，相对开始） */
  at: number
  label?: string
  mime: 'image/jpeg'
  width: number
  height: number
  redactedRegions: number
  data?: string
  path?: string
}

export interface TimelineResult {
  ok: true
  /** 实际总耗时 */
  durationMs: number
  /** 展开后的底层输入步数（含平滑移动的中间点） */
  steps: number
  /** 底层步骤相对计划时刻的最大延迟（ms），用于判断节奏是否可信 */
  maxLateMs: number
  /** 结束时仍按着、被自动松开的键 / 鼠标键 */
  autoReleased: string[]
  scale: number
  frames: TimelineFrame[]
}

function tlNum(v: unknown, what: string, i: number, min = -Infinity): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min) {
    throw new Error(`events[${i}].${what} 需要是${min === 0 ? '非负' : ''}数字`)
  }
  return n
}

/** 校验 + 规范化（接受 JSON 字符串或数组）。 */
export function parseTimeline(raw: unknown): TimelineEvent[] {
  const list = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  if (!Array.isArray(list) || list.length === 0) throw new Error('events 需要是非空数组')
  if (list.length > TIMELINE_MAX_EVENTS) throw new Error(`events 最多 ${TIMELINE_MAX_EVENTS} 条`)
  return list.map((e: Record<string, unknown>, i): TimelineEvent => {
    if (!e || typeof e !== 'object') throw new Error(`events[${i}] 需要是对象`)
    const t = tlNum(e.t ?? 0, 't', i, 0)
    if (t > TIMELINE_MAX_MS) throw new Error(`events[${i}].t 超过上限 ${TIMELINE_MAX_MS}ms`)
    const opt = (k: string): number | undefined =>
      e[k] === undefined ? undefined : tlNum(e[k], k, i, k === 'dx' || k === 'dy' ? -Infinity : 0)
    if (e.type === 'key') {
      const action = e.action ?? 'press'
      if (action !== 'press' && action !== 'down' && action !== 'up')
        throw new Error(`events[${i}].action 只能是 press / down / up`)
      const key = String(e.key ?? '')
      keyDef(key) // 不支持的键名立刻报错，而不是跑到一半
      const mods = Array.isArray(e.modifiers) ? e.modifiers.map(String) : []
      for (const m of mods)
        if (!(m in MOD_MASK)) throw new Error(`events[${i}].modifiers 不支持：${m}`)
      return { t, type: 'key', key, action, hold_ms: opt('hold_ms'), modifiers: mods as Modifier[] }
    }
    if (e.type === 'mouse') {
      const action = String(e.action ?? '')
      if (!['move', 'down', 'up', 'click', 'wheel'].includes(action))
        throw new Error(`events[${i}].action 只能是 move / down / up / click / wheel`)
      const button = e.button ?? 'left'
      if (!(String(button) in BUTTON_MASK))
        throw new Error(`events[${i}].button 只能是 left / right / middle`)
      return {
        t,
        type: 'mouse',
        action: action as 'move',
        x: tlNum(e.x, 'x', i),
        y: tlNum(e.y, 'y', i),
        button: button as MouseButton,
        hold_ms: opt('hold_ms'),
        duration_ms: opt('duration_ms'),
        double: e.double === true || e.double === 'true',
        dx: opt('dx'),
        dy: opt('dy')
      }
    }
    if (e.type === 'screenshot') {
      return { t, type: 'screenshot', label: e.label === undefined ? undefined : String(e.label) }
    }
    throw new Error(`events[${i}].type 只能是 key / mouse / screenshot`)
  })
}

/** 时间轴中途的快速隐私检查：不弹授权（会卡住节奏），未授权的隐私区 / 禁区直接中止。 */
function timelineCheck(info: ElementInfo | null, what: string): void {
  if (!info || !isAgentOrigin()) return
  if (info.forbidden) {
    throw new PrivacyDeniedError('agent_denied', [], `时间轴中途${what}落到 AI 禁区，已中止`)
  }
  const scopes = [
    ...(info.privacy ? [info.privacy] : []),
    ...(info.action ? info.action.split(',').map((x) => x.trim()) : [])
  ].filter((s) => s && !hasClearance(s))
  if (scopes.length) {
    throw new Error(
      `时间轴中途${what}落到未授权的隐私区（${scopes.join(', ')}），已中止并松开所有按键；先 request_clearance 再重试`
    )
  }
}

const FOCUS_INFO_JS = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const p = el.closest('[data-privacy]')
  return { privacy: p ? p.getAttribute('data-privacy') : null, action: null, label: '',
    forbidden: !!el.closest('[data-agent="forbidden"]'), x: 0, y: 0, w: 1, h: 1 }
})()`

interface TlStep {
  at: number
  seq: number
  run: () => Promise<void>
}

/**
 * 输入时间轴：一次提交「哪个时刻按下 / 松开什么」，主进程按相对时间派发，中途不经过 agent 往返。
 * 键盘与鼠标可交错（如按住 → 的同时在 150ms 跳、450ms 松开跳、同时移动准星），
 * 可在任意时刻截帧，结束 / 出错时自动松开本次按下仍未松开的键。不等页面稳定（为游戏设计）。
 * 隐私：开始前对所有按下 / 点击坐标与当前焦点做完整 guard（可能要求授权）；
 * 中途只做快速检查，落到未授权区域直接中止（不在中途弹授权窗口打乱节奏）。
 */
export async function inputTimeline(
  rawEvents: unknown,
  opts: { space?: CoordSpace; save?: boolean } = {}
): Promise<TimelineResult> {
  const events = parseTimeline(rawEvents)
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const scale = await evaluate<number>(cdp, 'devicePixelRatio')
  const css = (x: number, y: number): Point =>
    opts.space === 'css' ? { x, y } : { x: x / scale, y: y / scale }

  if (events.filter((e) => e.type === 'screenshot').length > TIMELINE_MAX_FRAMES) {
    throw new Error(`screenshot 最多 ${TIMELINE_MAX_FRAMES} 帧`)
  }

  // 开始前的完整隐私检查（会按需申请授权）
  if (events.some((e) => e.type === 'key')) await guardFocused(cdp)
  const seen = new Set<string>()
  for (const e of events) {
    if (e.type !== 'mouse' || (e.action !== 'down' && e.action !== 'click')) continue
    const p = css(e.x, e.y)
    const k = `${Math.round(p.x)},${Math.round(p.y)}`
    if (seen.has(k)) continue
    seen.add(k)
    await guardPoint(cdp, p, '按下')
  }

  // 展开成底层步骤（按时间稳定排序）
  const steps: TlStep[] = []
  let seq = 0
  const at = (t: number, run: () => Promise<void>): void => {
    if (t > TIMELINE_MAX_MS + 10_000) throw new Error('时间轴（含按住时长）过长')
    steps.push({ at: t, seq: seq++, run })
  }
  const heldKeys = new Map<string, { def: KeyDef; mods: Modifier[]; mask: number }>()
  const tlButtons = new Set<MouseButton>()
  const frames: TimelineFrame[] = []
  const pending: Promise<void>[] = []
  let start = 0

  const keyDown = (name: string, mods: Modifier[]) => async (): Promise<void> => {
    timelineCheck(await evaluate<ElementInfo | null>(cdp, FOCUS_INFO_JS), '按键')
    const def = keyDef(name)
    const mask = mods.reduce((m, k) => m | MOD_MASK[k], 0)
    for (const m of mods) await keyEvent(cdp, 'keyDown', keyDef(m), mask)
    await keyEvent(cdp, 'keyDown', def, mask)
    heldKeys.set(name, { def, mods, mask })
  }
  const keyUp = (name: string, mods: Modifier[]) => async (): Promise<void> => {
    const held = heldKeys.get(name)
    const def = held?.def ?? keyDef(name)
    const m = held?.mods ?? mods
    await keyEvent(cdp, 'keyUp', def, held?.mask ?? m.reduce((a, k) => a | MOD_MASK[k], 0))
    for (const k of [...m].reverse()) await keyEvent(cdp, 'keyUp', keyDef(k), 0)
    heldKeys.delete(name)
  }
  const mouseMove = (p: Point) => async (): Promise<void> => {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      buttons: vs().held
    })
    vs().last = p
  }
  const mouseDown =
    (p: Point, button: MouseButton, clickCount = 1) =>
    async (): Promise<void> => {
      timelineCheck(await evaluate<ElementInfo | null>(cdp, HIT_FN(p.x, p.y)), '按下')
      vs().held |= BUTTON_MASK[button]
      tlButtons.add(button)
      await cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: p.x,
        y: p.y,
        buttons: vs().held
      })
      vs().last = p
      void showMarker(cdp, p, 'press')
      await cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: p.x,
        y: p.y,
        button,
        buttons: vs().held,
        clickCount
      })
    }
  const mouseUp =
    (p: Point, button: MouseButton, clickCount = 1) =>
    async (): Promise<void> => {
      vs().held &= ~BUTTON_MASK[button]
      tlButtons.delete(button)
      await cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: p.x,
        y: p.y,
        button,
        buttons: vs().held,
        clickCount
      })
      vs().last = p
    }

  // 平滑移动需要知道起点：按时间顺序模拟鼠标位置
  let simMouse = vs().last
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i)
  for (const { e } of ordered) {
    if (e.type === 'key') {
      const mods = e.modifiers ?? []
      if (e.action === 'down') at(e.t, keyDown(e.key, mods))
      else if (e.action === 'up') at(e.t, keyUp(e.key, mods))
      else {
        at(e.t, keyDown(e.key, mods))
        at(e.t + (e.hold_ms ?? TIMELINE_DEFAULT_PRESS_MS), keyUp(e.key, mods))
      }
    } else if (e.type === 'mouse') {
      const p = css(e.x, e.y)
      const button = e.button ?? 'left'
      if (e.action === 'move') {
        const dur = e.duration_ms ?? 0
        if (dur > 0 && simMouse) {
          const from = simMouse
          const n = Math.max(1, Math.round(dur / TIMELINE_MOVE_STEP_MS))
          for (let k = 1; k <= n; k++) {
            const q = { x: from.x + ((p.x - from.x) * k) / n, y: from.y + ((p.y - from.y) * k) / n }
            at(e.t + (dur * k) / n, mouseMove(q))
          }
        } else at(e.t, mouseMove(p))
      } else if (e.action === 'down') at(e.t, mouseDown(p, button))
      else if (e.action === 'up') at(e.t, mouseUp(p, button))
      else if (e.action === 'click') {
        const hold = e.hold_ms ?? 0
        at(e.t, mouseDown(p, button, 1))
        at(e.t + hold, mouseUp(p, button, 1))
        if (e.double) {
          at(e.t + hold, mouseDown(p, button, 2))
          at(e.t + hold, mouseUp(p, button, 2))
        }
      } else {
        at(e.t, async () => {
          await cdp('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: p.x,
            y: p.y,
            deltaX: e.dx ?? 0,
            deltaY: e.dy ?? 0
          })
          vs().last = p
        })
      }
      simMouse = p
    } else {
      const planned = e.t
      const label = e.label
      at(planned, async () => {
        // 截帧不阻塞后续输入：后台进行，结束时统一等待
        const shotAt = Date.now() - start
        pending.push(
          captureMasked(wc, cdp, { format: 'jpeg', quality: 80 }).then(
            ({ buf, redactedRegions }) => {
              frames.push({
                t: planned,
                at: shotAt,
                ...(label ? { label } : {}),
                mime: 'image/jpeg',
                width: 0,
                height: 0,
                redactedRegions,
                data: buf.toString('base64')
              })
            }
          )
        )
      })
    }
  }
  steps.sort((a, b) => a.at - b.at || a.seq - b.seq)
  const total = steps.length ? steps[steps.length - 1].at : 0

  tagAgentInput(wc, total)
  start = Date.now()
  let maxLateMs = 0
  const autoReleased: string[] = []
  try {
    for (const s of steps) {
      const wait = start + s.at - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      maxLateMs = Math.max(maxLateMs, Date.now() - start - s.at)
      await s.run()
    }
  } finally {
    // 无论成功还是中止，都别留下「卡住」的键
    for (const [name, h] of [...heldKeys]) {
      autoReleased.push(name)
      await keyEvent(cdp, 'keyUp', h.def, h.mask).catch(() => {})
      for (const k of [...h.mods].reverse())
        await keyEvent(cdp, 'keyUp', keyDef(k), 0).catch(() => {})
    }
    heldKeys.clear()
    for (const b of [...tlButtons]) {
      autoReleased.push(`mouse:${b}`)
      vs().held &= ~BUTTON_MASK[b]
      const p = vs().last ?? { x: 0, y: 0 }
      await cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: p.x,
        y: p.y,
        button: b,
        buttons: vs().held,
        clickCount: 1
      }).catch(() => {})
    }
    await Promise.allSettled(pending)
  }
  await Promise.all(pending) // 截帧失败时报错（已在上面等完，这里只是把异常抛出来）
  const durationMs = Date.now() - start

  const vp = await evaluate<{ w: number; h: number }>(cdp, '({ w: innerWidth, h: innerHeight })')
  frames.sort((a, b) => a.t - b.t)
  const save = opts.save ?? !isAgentReader()
  for (const f of frames) {
    f.width = Math.round(vp.w * scale)
    f.height = Math.round(vp.h * scale)
    if (save && f.data) {
      const dir = join(USER_CONFIG_DIR, 'screenshots')
      await mkdir(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      f.path = join(dir, `timeline-${stamp}-t${f.t}.jpg`)
      await writeFile(f.path, Buffer.from(f.data, 'base64'))
      delete f.data
    }
  }
  return { ok: true, durationMs, steps: steps.length, maxLateMs, autoReleased, scale, frames }
}

/** 切换到某个能力页面（等价于点击侧栏条目）。 */
export async function navigate(
  ability: string
): Promise<{ ok: boolean; page?: string; error?: string; available?: string[] }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const available = await evaluate<string[]>(
    cdp,
    `[...new Set([...document.querySelectorAll('[data-ability-id]')].map((e) => e.getAttribute('data-ability-id')))]`
  )
  if (!available.includes(ability)) {
    return { ok: false, error: `侧栏里没有能力：${ability}`, available }
  }
  tagAgentInput(wc)
  wc.send('cockpit:navigate', ability)
  const start = Date.now()
  let page = ''
  while (Date.now() - start < 3000) {
    page = await evaluate<string>(
      cdp,
      `document.querySelector('[data-current-ability]')?.getAttribute('data-current-ability') ?? ''`
    )
    if (page === ability) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (page === ability) await waitPageReady(cdp, ability)
  await settle(cdp)
  return page === ability ? { ok: true, page } : { ok: false, page, error: '切换超时' }
}

/** 等待：页面出现某段文本（不搜索隐私区 / 禁区，避免被当成探测隐私值的工具）或固定时长。 */
export async function waitFor(
  opts: { text?: string; ms?: number; timeoutMs?: number } = {}
): Promise<{ ok: boolean; waitedMs: number }> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  const start = Date.now()
  if (opts.ms) await new Promise((r) => setTimeout(r, Math.min(opts.ms!, 30_000)))
  if (opts.text) {
    const needle = JSON.stringify(opts.text)
    const timeout = Math.min(opts.timeoutMs ?? 10_000, 30_000)
    while (Date.now() - start < timeout) {
      const found = await evaluate<boolean>(
        cdp,
        `(() => {
          const skip = (el) => el.closest('[data-privacy],[data-agent="forbidden"]')
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            if (n.textContent.includes(${needle}) && !skip(n.parentElement)) return true
          }
          return false
        })()`
      )
      if (found) return { ok: true, waitedMs: Date.now() - start }
      await new Promise((r) => setTimeout(r, 200))
    }
    return { ok: false, waitedMs: Date.now() - start }
  }
  await settle(cdp)
  return { ok: true, waitedMs: Date.now() - start }
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

const OVERLAY_ID = '__cockpit_redact_overlay'
const REDACT_CLASS = '__cockpit_redact_mask'
/** 不能承载子节点 / 表格结构标签 → 退回全局顶层遮罩。 */
const REDACT_VOID_TAGS = [
  'INPUT',
  'IMG',
  'BR',
  'HR',
  'AREA',
  'BASE',
  'COL',
  'EMBED',
  'LINK',
  'META',
  'PARAM',
  'SOURCE',
  'TRACK',
  'WBR',
  'TR',
  'COLGROUP'
]

/**
 * 截图隐私遮罩（z-order 规划）。
 *
 * 默认把遮罩作为隐私元素的**子节点**，并给该元素 `isolation:isolate` 造一个层叠
 * 上下文，遮罩的极高 z-index 只在这个元素内部生效：
 *  - 隐私元素被更高层的页面浮层/弹窗盖住时，遮罩跟着元素一起被盖住，不会像旧的
 *    全局 fixed 顶层遮罩那样糊到弹窗内容上面；
 *  - 隐私元素自己就是弹窗（`v-agent-forbidden`）时，遮罩仍在该弹窗之上，正常遮盖；
 *  - 被盖住的部分本来就看不清，未盖住的部分依旧遮住，隐私优先。
 *
 * 兜底：不能承载子节点的标签（input/img/canvas…）或祖先带 `opacity < 1` /
 * `filter` / `mix-blend-mode`（会让遮罩本身变透明/模糊）时，退回全局顶层遮罩——
 * 宁可遮多，不可漏。
 *
 * 子窗口边界：截图只抓主窗口的 webContents（`mainContents()` 的
 * `capturePage`），子窗口是独立 BrowserWindow，根本不在这一张图里，
 * 因此既不需要、也无法用 DOM z-index 去覆盖它（也不会把它拍进来造成泄露）。若将来
 * 改为抓某个子窗口，本函数在目标 webContents 内运行即可同样生效。
 */
const OVERLAY_JS = (cleared: string[], maskForbidden: boolean): string => `(() => {
  const cleared = new Set(${JSON.stringify(cleared)})
  const VOID = new Set(${JSON.stringify(REDACT_VOID_TAGS)})
  const clearMasks = () => {
    document.getElementById('${OVERLAY_ID}')?.remove()
    for (const m of document.querySelectorAll('.${REDACT_CLASS}')) m.remove()
    for (const e of document.querySelectorAll('[data-cockpit-redact-iso]')) {
      e.style.isolation = ''
      e.removeAttribute('data-cockpit-redact-iso')
    }
  }
  const maskSafe = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.opacity !== '' && parseFloat(cs.opacity) < 1) return false
      if (cs.filter && cs.filter !== 'none') return false
      if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return false
    }
    return true
  }
  const maskCss = 'background:#1b1b1f;color:#e6e1e5;font:11px monospace;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:4px;pointer-events:none;z-index:2147483647'
  clearMasks()
  const host = document.createElement('div')
  host.id = '${OVERLAY_ID}'
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  let n = 0
  const seen = new Set()
  const shown = new Set()
  for (const el of document.querySelectorAll('[data-privacy],[data-agent="forbidden"],input[type="password"]')) {
    const forbidden = el.getAttribute('data-agent') === 'forbidden'
    if (forbidden && !${maskForbidden}) continue
    const scope = el.getAttribute('data-privacy') || (forbidden ? 'forbidden' : 'secret')
    if (!forbidden && cleared.has(scope)) {
      if (el.getBoundingClientRect().width > 0) shown.add(scope)
      continue
    }
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const b = document.createElement('div')
    b.className = '${REDACT_CLASS}'
    b.textContent = '🔒 ' + scope
    if (!VOID.has(el.tagName) && maskSafe(el)) {
      if (getComputedStyle(el).isolation !== 'isolate') {
        el.setAttribute('data-cockpit-redact-iso', '')
        el.style.isolation = 'isolate'
      }
      if (getComputedStyle(el).position !== 'static') {
        b.style.cssText = 'position:absolute;inset:-4px;' + maskCss
        el.appendChild(b)
      } else {
        // 静态定位元素不是绝对定位子节点的包含块：inset 会相对外层定位祖先（常是整张卡片）
        // 铺开、把整张卡片涂黑。先放在包含块原点，量出偏差再平移到元素自身的矩形上。
        b.style.cssText = 'position:absolute;left:0;top:0;width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;' + maskCss
        el.appendChild(b)
        const br = b.getBoundingClientRect()
        b.style.left = (r.left - 4 - br.left) + 'px'
        b.style.top = (r.top - 4 - br.top) + 'px'
      }
    } else {
      b.style.cssText = 'position:fixed;left:' + (r.left - 4) + 'px;top:' + (r.top - 4) + 'px;width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;' + maskCss
      host.appendChild(b)
    }
    n++
    if (!forbidden) seen.add(scope)
  }
  document.documentElement.appendChild(host)
  for (const m of document.querySelectorAll('.__cockpit_ai_marker')) m.remove()
  // 探测点：遮罩边缘内侧 5px 的 8 个候选（四角 + 四边中点，避开居中的文字与圆角），
  // 取第一个遮罩确实在最上层的点（部分被弹窗盖住时用露出来的那部分）。
  // 截图后核对这些点是遮罩色，确认遮罩真的进了画面。
  const probes = []
  for (const m of document.querySelectorAll('.${REDACT_CLASS}')) {
    const rb = m.getBoundingClientRect()
    if (rb.width < 12 || rb.height < 12) continue
    const xs = [rb.left + 5, rb.left + rb.width / 2, rb.right - 6]
    const ys = [rb.top + 5, rb.top + rb.height / 2, rb.bottom - 6]
    // 顺序：四角 → 上下边中点 → 左右边中点（与居中的「🔒 scope」文字同一行，窄遮罩上可能打到文字，放最后）
    const cand = [
      [xs[0], ys[0]], [xs[2], ys[0]], [xs[0], ys[2]], [xs[2], ys[2]],
      [xs[1], ys[0]], [xs[1], ys[2]],
      [xs[0], ys[1]], [xs[2], ys[1]]
    ]
    // elementFromPoint 会跳过 pointer-events:none 的元素，命中测试时临时打开
    m.style.pointerEvents = 'auto'
    for (const [x, y] of cand) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
      const top = document.elementFromPoint(x, y)
      if (top && (top === m || m.contains(top))) {
        probes.push([x, y])
        break
      }
    }
    m.style.pointerEvents = 'none'
  }
  const out = { n, scopes: [...seen], shown: [...shown], probes, vw: innerWidth }
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(out))))
})()`

export interface ScreenshotResult {
  ok: true
  mime: 'image/png'
  width: number
  height: number
  /** 截图像素 / CSS 像素；ui.click_at 等默认就用截图像素坐标，无需换算 */
  scale: number
  redactedRegions: number
  /** base64（save=false 时） */
  data?: string
  /** 保存路径（save=true 时） */
  path?: string
}

/**
 * 加遮罩 → 截图 → 撤遮罩（不等页面稳定，由调用方决定）。
 * 遮罩：未授权 scope 的隐私区 + 凭据输入框 + 禁区；非 agent 来源不遮。
 *
 * 默认走 `webContents.capturePage`（直接拷贝已合成的画面）而不是 CDP `Page.captureScreenshot`：
 * 后者会让 Chromium 重新出一帧，透明主窗口在 Wayland 上会空白闪一下。clip 为 CSS 像素。
 * 代价：窗口被遮挡 / 降帧时拿到的是旧画面，遮罩进不了图。配置 `agent.ui.screenshotMode`：
 * capture（只用 capturePage）/ cdp（只用 Page.captureScreenshot，不受遮挡影响）/ auto（默认，capture 核对不过再退 cdp）。
 */
const MASK_CAPTURE_ATTEMPTS = 6
const MASK_CAPTURE_RETRY_MS = 40
/** 有遮罩但没有探测点可核对时，截图前的固定等待（数帧） */
const MASK_BLIND_WAIT_MS = 150

/**
 * 截图里每个探测点（CSS 像素，相对页面）是否已是遮罩底色 #1b1b1f。
 * 没有探测点（无遮罩 / 遮罩全被更高层浮层盖住）视为通过。
 */
function masksVisible(
  img: NativeImage,
  probes: [number, number][],
  origin: { x: number; y: number },
  cssWidth: number
): boolean {
  if (!probes.length) return true
  const bmp = img.toBitmap()
  const size = img.getSize()
  if (!bmp.length || !size.width || !size.height) return false
  // 位图是设备像素（BGRA），尺寸可能是 DIP 尺寸的倍数：按字节数反推像素宽
  const pxW = Math.round(Math.sqrt(((bmp.length / 4) * size.width) / size.height))
  const pxH = Math.round(bmp.length / 4 / pxW)
  const k = pxW / cssWidth
  for (const [x, y] of probes) {
    const px = Math.round((x - origin.x) * k)
    const py = Math.round((y - origin.y) * k)
    if (px < 0 || py < 0 || px >= pxW || py >= pxH) continue
    const i = (py * pxW + px) * 4
    const near = (v: number | undefined, t: number): boolean =>
      v !== undefined && Math.abs(v - t) <= 12
    if (!(near(bmp[i], 0x1f) && near(bmp[i + 1], 0x1b) && near(bmp[i + 2], 0x1b))) return false
  }
  return true
}

/** CDP `Page.captureScreenshot`：按需渲染新帧（不依赖窗口当前是否在出帧）。clip 为 CSS 像素。 */
async function captureViaCdp(
  cdp: Cdp,
  clip?: { x: number; y: number; width: number; height: number; scale: number }
): Promise<NativeImage> {
  const r = (await cdp('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    ...(clip ? { clip } : {})
  })) as { data: string }
  return nativeImage.createFromBuffer(Buffer.from(r.data, 'base64'))
}

async function captureMasked(
  wc: WebContents,
  cdp: Cdp,
  opts: {
    clip?: { x: number; y: number; width: number; height: number; scale: number }
    format?: 'png' | 'jpeg'
    quality?: number
  } = {}
): Promise<{ buf: Buffer; redactedRegions: number; shownScopes: string[] }> {
  const reader = isAgentReader()
  const cleared = reader
    ? [...listPrivacyScopes().map((s) => s.id), SCOPE_SECRET].filter((id) => hasClearance(id))
    : [...listPrivacyScopes().map((s) => s.id), SCOPE_SECRET]
  let redactedRegions = 0
  let shownScopes: string[] = []
  let buf: Buffer
  try {
    const masked = await evaluate<{
      n: number
      scopes: string[]
      shown: string[]
      probes: [number, number][]
      vw: number
    }>(cdp, OVERLAY_JS(cleared, reader))
    redactedRegions = masked.n
    shownScopes = masked.shown
    if (reader) for (const sc of masked.scopes) noteRedaction(sc)
    // capturePage 的 rect 是 DIP（窗口坐标），CSS 像素要乘页面缩放（uiScale = setZoomFactor）
    const zoom = wc.getZoomFactor()
    const rect = opts.clip && {
      x: Math.round(opts.clip.x * zoom),
      y: Math.round(opts.clip.y * zoom),
      width: Math.max(1, Math.round(opts.clip.width * zoom)),
      height: Math.max(1, Math.round(opts.clip.height * zoom))
    }
    // capturePage 拷贝的是已合成的画面，比页面渲染晚一到数帧（Wayland 透明窗口实测）：
    // 刚插入的遮罩可能还没进画面 → 截到未遮盖的隐私内容。逐个核对探测点是遮罩色，
    // 没到就稍等重截；始终对不上就拒绝返回截图（宁可失败，不可泄露）。
    const origin = opts.clip ? { x: opts.clip.x, y: opts.clip.y } : { x: 0, y: 0 }
    // 有遮罩却没有可核对的探测点（各自露出的部分都太小 / 被浮层盖住）：无法确认遮罩已进画面，
    // 先固定多等几帧再截，避免拍到遮罩之前的旧帧
    if (masked.n > 0 && masked.probes.length === 0) {
      await new Promise((r) => setTimeout(r, MASK_BLIND_WAIT_MS))
    }
    const cssWidth = rect ? rect.width / zoom : masked.vw
    const mode = await screenshotModeSetting()
    let img: NativeImage | null = null
    if (mode !== 'cdp') {
      for (let attempt = 0; attempt < MASK_CAPTURE_ATTEMPTS; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, MASK_CAPTURE_RETRY_MS))
        const shot = rect ? await wc.capturePage(rect) : await wc.capturePage()
        if (masksVisible(shot, masked.probes, origin, cssWidth)) {
          img = shot
          break
        }
      }
    }
    if (!img && mode !== 'capture') {
      // capturePage 拿到的是旧画面（窗口被遮挡 / 降帧）：让 Chromium 按需渲染一帧，DOM 里的遮罩一定在里面
      const shot = await captureViaCdp(cdp, opts.clip)
      if (masksVisible(shot, masked.probes, origin, cssWidth)) img = shot
    }
    if (!img) {
      throw new Error(
        mode === 'capture'
          ? '截图隐私遮罩未能进入画面，已拒绝返回截图（窗口可能被遮挡；可在设置 → AI 与远程 里把截图方式改成「自动」）'
          : '截图隐私遮罩未能进入画面，已拒绝返回截图（请重试）'
      )
    }
    buf = opts.format === 'jpeg' ? img.toJPEG(opts.quality ?? 80) : img.toPNG()
  } finally {
    await evaluate(
      cdp,
      `(() => {
        document.getElementById('${OVERLAY_ID}')?.remove()
        for (const m of document.querySelectorAll('.${REDACT_CLASS}')) m.remove()
        for (const e of document.querySelectorAll('[data-cockpit-redact-iso]')) {
          e.style.isolation = ''
          e.removeAttribute('data-cockpit-redact-iso')
        }
      })()`
    ).catch(() => {})
  }
  return { buf, redactedRegions, shownScopes }
}

export async function screenshot(
  opts: { ref?: string; save?: boolean } = {}
): Promise<ScreenshotResult> {
  const wc = mainContents()
  const cdp = cdpFor(wc)
  await settle(cdp)
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
  if (opts.ref) {
    const info = await prepare(cdp, opts.ref, '截图')
    clip = {
      x: Math.max(0, info.x - info.w / 2),
      y: Math.max(0, info.y - info.h / 2),
      width: info.w,
      height: info.h,
      scale: 1
    }
  }
  const reader = isAgentReader()
  const { buf, redactedRegions } = await captureMasked(wc, cdp, { clip })
  const scale = await evaluate<number>(cdp, 'devicePixelRatio')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const save = opts.save ?? !reader
  if (save) {
    const dir = join(USER_CONFIG_DIR, 'screenshots')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    await writeFile(path, buf)
    return { ok: true, mime: 'image/png', width, height, scale, redactedRegions, path }
  }
  return {
    ok: true,
    mime: 'image/png',
    width,
    height,
    scale,
    redactedRegions,
    data: buf.toString('base64')
  }
}

/** 当前页面与侧栏可跳转的能力（id + 显示名），给 agent 的 overview 用。 */
export async function pageInfo(): Promise<{
  page: string
  abilities: { id: string; name: string }[]
}> {
  await prepareTarget()
  const cdp = cdpFor(mainContents())
  return evaluate(
    cdp,
    `(() => {
      const seen = new Map()
      for (const el of document.querySelectorAll('[data-ability-id]')) {
        const id = el.getAttribute('data-ability-id')
        if (!seen.has(id)) seen.set(id, (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim())
      }
      return {
        page: document.querySelector('[data-current-ability]')?.getAttribute('data-current-ability') ?? '',
        abilities: [...seen].map(([id, name]) => ({ id, name }))
      }
    })()`
  )
}
