/**
 * Agent 独立视图 —— 每个 agent 会话一个自己的渲染进程（同一个 App，`?agent=<会话>`）。
 *
 * 为什么：agent 以前直接点用户的主窗口，AI 操作与用户互相打架。现在 `ui.*` 按调用来源的
 * 会话路由到该会话的视图（inspector.ts 的 `mainContents()`），用户的主窗口不受影响；
 * 想看 AI 在做什么，点标题栏里它的头像 → follow。
 *
 * 结构：视图是一个 `WebContentsView`，平时挂在一个 1×1 的宿主窗口里，视图的 bounds 固定为
 * VIEW_W×VIEW_H（超出宿主的部分被裁掉，渲染表面仍是完整尺寸）。三种状态：
 * - background：宿主 1×1、不抢焦点、不占任务栏。**必须是 map 着的窗口**——实测从没显示过 /
 *   hide / 最小化的窗口，rAF 会掉到 0–2 fps（Wayland 下没有 map 的 surface 拿不到帧回调），
 *   游戏直接冻住；map 着的 1×1 窗口是 60 fps。
 * - inplace（默认的 follow）：把视图从宿主「搬」到用户的主窗口，盖满整个主窗口；
 *   视图里的 App 自带无边框外壳（窗口按钮 / 「返回我的界面」）。退出时搬回宿主。
 * - window：宿主放大成普通窗口（配置 `agent.ui.followMode = 'window'`）。
 * 视图里的 App 通过 `cockpit:agent-host` 事件知道自己现在在哪（background / main / window）。
 *
 * - 懒创建：该会话第一次 `ui.*` 调用（或用户点头像）才建；静音（follow 时才出声）、关闭节流。
 * - 隐私：这个 webContents 发出的所有 IPC 一律按 `agent-ui` 处理（`originOfSender`），
 *   不再靠「点击后 3 秒」的时间窗口猜测。
 * - 生命周期：会话结束即销毁；后台且空闲超过 IDLE_DESTROY_MS 也销毁（每个视图是一整份 App，
 *   几百 MB）；主窗口关闭时全部销毁。
 */
import { BrowserWindow, WebContentsView, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { makeLogger } from '../logger'
import { t } from '../i18n'
import { withOrigin, type CallOrigin } from '../privacy'
import { takeOver } from '../exclusive'
import { getMainWindow } from '../windows'
import { getSession, onSessionEnded, onSessionsChanged, setSessionView } from './sessions'

const log = makeLogger('agent-view')

/** 视图的固定渲染尺寸（后台时宿主只有 1×1，视图被裁剪但表面不缩）。 */
const VIEW_W = 1180
const VIEW_H = 780
const IDLE_DESTROY_MS = 15 * 60 * 1000
const READY_TIMEOUT_MS = 20_000

export type FollowMode = 'inplace' | 'window'
type HostMode = 'background' | 'main' | 'window'

interface View {
  host: BrowserWindow
  view: WebContentsView
  session: string
  /** 页面加载完成（App 已挂载） */
  ready: Promise<void>
  lastUse: number
  destroying: boolean
  mode: HostMode
  /** 视图当前挂在哪个窗口里 */
  parent: BrowserWindow
}

const views = new Map<string, View>()
const bySender = new Map<number, string>()
let sweeper: NodeJS.Timeout | null = null

function titleFor(session: string): string {
  const client = getSession(session)?.client || 'AI'
  return `${t('agent.view.title', 'AI 视图')} · ${client}`
}

function setHostMode(v: View, mode: HostMode): void {
  v.mode = mode
  v.view.webContents.setAudioMuted(mode === 'background')
  if (!v.view.webContents.isDestroyed()) v.view.webContents.send('cockpit:agent-host', mode)
  setSessionView(v.session, mode === 'background' ? 'hidden' : 'shown')
  syncCover()
}

/**
 * 视图盖在主窗口上时，主窗口自己的标题栏拖拽区（-webkit-app-region: drag）仍在下面——
 * 窗口的可拖拽区域是各个 view 的并集，上层视图里的 no-drag 挖不掉下层的 drag，
 * 于是视图里的「返回我的界面」和窗口按钮被当成标题栏吞掉、点不动。
 * 所以覆盖期间通知主窗口把自己的拖拽区关掉。
 */
function syncCover(): void {
  const main = getMainWindow()
  if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return
  const covered = [...views.values()].some((x) => x.mode === 'main' && !x.destroying)
  main.webContents.send('cockpit:agent-cover', covered)
}

/** 视图的 bounds：后台固定尺寸，跟随时铺满所在窗口。 */
function fit(v: View): void {
  if (v.destroying || v.parent.isDestroyed()) return
  if (v.mode === 'background') {
    v.view.setBounds({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })
  } else {
    const [width, height] = v.parent.getContentSize()
    v.view.setBounds({ x: 0, y: 0, width, height })
  }
}

function reparent(v: View, to: BrowserWindow): void {
  if (v.parent === to) return
  if (!v.parent.isDestroyed()) v.parent.contentView.removeChildView(v.view)
  to.contentView.addChildView(v.view)
  v.parent = to
}

/** 回到后台：视图搬回宿主，宿主缩成 1×1。 */
function toBackground(v: View): void {
  const main = getMainWindow()
  const wasInMain = v.mode === 'main'
  reparent(v, v.host)
  v.host.setFocusable(false)
  v.host.setResizable(false)
  v.host.setSkipTaskbar(true)
  v.host.setSize(1, 1)
  setHostMode(v, 'background')
  fit(v)
  if (wasInMain && main && !main.isDestroyed()) main.webContents.focus()
}

function create(session: string): View {
  const host = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    title: titleFor(session),
    backgroundColor: '#00000000'
  })
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      // 后台也要跑：agent 在后台视图里玩游戏 / 等动画
      backgroundThrottling: false
    }
  })
  view.setBackgroundColor('#00000000')
  host.contentView.addChildView(view)
  const wc = view.webContents
  bySender.set(wc.id, session)
  wc.setAudioMuted(true)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  const q = `agent=${encodeURIComponent(session)}&name=${encodeURIComponent(getSession(session)?.client ?? '')}`
  const ready = new Promise<void>((resolve) => {
    const done = (): void => {
      wc.send('cockpit:agent-host', v.mode)
      resolve()
    }
    wc.once('did-finish-load', done)
    wc.once('did-fail-load', done)
    setTimeout(() => resolve(), READY_TIMEOUT_MS)
  })
  const v: View = {
    host,
    view,
    session,
    ready,
    lastUse: Date.now(),
    destroying: false,
    mode: 'background',
    parent: host
  }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void wc.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${q}`)
  } else {
    void wc.loadFile(join(__dirname, '../renderer/index.html'), { search: q })
  }

  host.on('page-title-updated', (e) => e.preventDefault())
  // window 模式下用户关窗口 = 退到后台（视图要继续替 agent 干活）
  host.on('close', (e) => {
    if (v.destroying) return
    e.preventDefault()
    toBackground(v)
  })
  host.on('resize', () => fit(v))
  host.on('closed', () => {
    bySender.delete(wc.id)
    if (views.get(session) === v) views.delete(session)
  })
  views.set(session, v)
  fit(v)
  // 必须 map 着才有稳定的帧（见文件头），1×1 + 不可聚焦 = 用户基本看不到
  host.showInactive()
  setSessionView(session, 'hidden')
  log.info('agent view created', { session })
  return v
}

/** 取（必要时创建）会话的视图并等它加载完。 */
export async function prepareAgentView(session: string): Promise<void> {
  if (process.env.COCKPIT_HEADLESS === '1') {
    throw new Error('无头（Headless）模式下不支持创建 Agent UI 视图')
  }
  const v = views.get(session) ?? create(session)
  v.lastUse = Date.now()
  await v.ready
}

/** 已存在的视图的 webContents（inspector 同步取用；不存在返回 null）。 */
export function agentViewContents(session: string): WebContents | null {
  const v = views.get(session)
  if (!v || v.view.webContents.isDestroyed()) return null
  v.lastUse = Date.now()
  return v.view.webContents
}

/** 所有 agent 视图的 webContents——它们不是 BrowserWindow 自带的，广播要显式带上。 */
export function allAgentViewContents(): WebContents[] {
  return [...views.values()].map((v) => v.view.webContents).filter((w) => !w.isDestroyed())
}

/** IPC 发送者属于某个 agent 视图 → 它发出的一切都按 agent-ui 处理。 */
export function originOfSender(senderId: number): CallOrigin | null {
  const session = bySender.get(senderId)
  return session ? { kind: 'agent-ui', session } : null
}

/** 窗口按钮（最小化 / 最大化 / 关闭）该作用于哪个窗口：视图当前所在的窗口。 */
export function windowOfSender(senderId: number): BrowserWindow | null {
  const session = bySender.get(senderId)
  const v = session ? views.get(session) : undefined
  return v && !v.parent.isDestroyed() ? v.parent : null
}

/** 用户点头像：follow 该 agent 的视图（没有就先建）。同一时刻只有一个视图盖在主窗口上。 */
export async function followAgentView(session: string, mode: FollowMode): Promise<boolean> {
  if (process.env.COCKPIT_HEADLESS === '1') return false
  if (!getSession(session)) return false
  const v = views.get(session) ?? create(session)
  v.lastUse = Date.now()
  await v.ready
  for (const other of views.values()) {
    if (other !== v && other.mode === 'main') toBackground(other)
  }
  const main = getMainWindow()
  if (mode === 'inplace' && main && !main.isDestroyed()) {
    hookMain(main)
    reparent(v, main)
    setHostMode(v, 'main')
    fit(v)
    v.view.webContents.focus()
  } else {
    reparent(v, v.host)
    v.host.setFocusable(true)
    v.host.setResizable(true)
    v.host.setSkipTaskbar(false)
    v.host.setSize(VIEW_W, VIEW_H)
    v.host.center()
    setHostMode(v, 'window')
    fit(v)
    v.host.show()
    v.host.focus()
  }
  return true
}

export function unfollowAgentView(session: string): boolean {
  const v = views.get(session)
  if (!v) return false
  toBackground(v)
  return true
}

export function destroyAgentView(session: string): void {
  const v = views.get(session)
  if (!v) return
  v.destroying = true
  const wasInMain = v.mode === 'main'
  views.delete(session)
  bySender.delete(v.view.webContents.id)
  if (!v.parent.isDestroyed()) v.parent.contentView.removeChildView(v.view)
  if (!v.view.webContents.isDestroyed()) v.view.webContents.close()
  if (!v.host.isDestroyed()) v.host.destroy()
  if (wasInMain) {
    syncCover()
    getMainWindow()?.webContents.focus()
  }
  log.info('agent view destroyed', { session })
}

export function destroyAllAgentViews(): void {
  for (const id of [...views.keys()]) destroyAgentView(id)
}

let mainHooked = false
/** 视图盖在主窗口上时，主窗口尺寸变化（缩放 / 最大化 / 全屏）要带着视图一起变。主窗口晚于 init 才创建，所以首次 follow 时再挂。 */
function hookMain(main: BrowserWindow): void {
  if (mainHooked) return
  mainHooked = true
  const refit = (): void => {
    for (const v of views.values()) if (v.mode === 'main') fit(v)
  }
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    main.on(ev as 'resize', refit)
  }
}

/** 启动一次：会话结束销毁视图、标题随客户端改名、空闲视图回收、窗口控制 IPC。 */
export function initAgentViews(): void {
  onSessionEnded(destroyAgentView)
  onSessionsChanged(() => {
    for (const v of views.values()) {
      if (v.host.isDestroyed()) continue
      const title = titleFor(v.session)
      if (v.host.getTitle() !== title) v.host.setTitle(title)
    }
  })
  // 视图里 App 的「返回 / 关闭」按钮。只接受 agent 视图发来的，且这些按钮在 AI 的禁区里（v-agent-forbidden）
  ipcMain.handle(
    'agent-view:control',
    (e, action: string, payload?: { scope?: unknown; key?: unknown }) => {
      const session = bySender.get(e.sender.id)
      const v = session ? views.get(session) : undefined
      if (!v) return false
      if (action === 'back') {
        toBackground(v)
        return true
      }
      if (action === 'take-over') {
        // 用户跟随 AI 视图时点「接管」：视图里的 IPC 一律算 agent-ui，调不了「只有用户」的命令，
        // 所以走这条专用通道，以用户身份接管。按钮在 AI 禁区里（v-agent-forbidden），AI 点不到。
        if (typeof payload?.scope !== 'string' || typeof payload?.key !== 'string') return false
        withOrigin({ kind: 'ui' }, () => takeOver(payload.scope as string, payload.key as string))
        return true
      }
      if (action === 'close-app') {
        toBackground(v)
        getMainWindow()?.close()
        return true
      }
      return false
    }
  )
  sweeper ??= setInterval(() => {
    const now = Date.now()
    for (const v of [...views.values()]) {
      if (v.mode === 'background' && now - v.lastUse > IDLE_DESTROY_MS) destroyAgentView(v.session)
    }
  }, 60_000)
  sweeper.unref()
}
