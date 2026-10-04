/**
 * 隐私授权窗口（主进程）—— docs/agent-access-design.md §5.4。
 *
 * 把 privacy.ts 的待处理请求呈现在一个**独立子窗口**里（`?view=PrivacyConsent`）：
 *  - 窗口 id / view 保留，渲染端无法经 `window:create/destroy/control` 创建、替换或关闭它；
 *  - 决定只走 `privacy:decide` IPC，且校验 sender 必须是这个窗口——不是注册命令，
 *    CLI / 脚本 / agent 都调用不到；
 *  - P1 的 inspector 不得检查或向这个窗口注入输入（白名单只含主窗口）。
 * 用户直接关掉窗口 = 拒绝全部待处理请求。
 */
import { BrowserWindow, ipcMain, Notification } from 'electron'
import {
  setConsentPresenter,
  setPrivacyAudit,
  setPrivacyPolicy,
  normalizePrivacyPolicy,
  decideConsent,
  denyAllPending,
  listPendingRequests,
  type ConsentDecision,
  type ConsentRequest,
  toConsentView as toView,
  type ConsentRequestView
} from './privacy'
import { createChildWindow, getChildWindow, getMainWindow } from './windows'
import { readJson } from './util'
import { CONFIG_JSON } from './paths'
import { makeLogger } from './logger'
import { t } from './i18n'

export type { ConsentRequestView }

const log = makeLogger('privacy')

export const CONSENT_WINDOW_ID = 'cockpit-privacy-consent'
const CONSENT_VIEW = 'PrivacyConsent'

export function isReservedWindowId(id: unknown): boolean {
  return typeof id === 'string' && id === CONSENT_WINDOW_ID
}

export function isReservedWindowView(view: unknown): boolean {
  return typeof view === 'string' && view === CONSENT_VIEW
}

function consentWindow(): BrowserWindow | null {
  return getChildWindow(CONSENT_WINDOW_ID)
}

/** 授权窗口在 uiScale = 1 时的尺寸 */
const BASE_WIDTH = 580
const BASE_HEIGHT = 580
let uiScale = 1.1

let closedHooked: BrowserWindow | null = null
let notifiedFor = new Set<string>()

function present(list: ConsentRequest[]): void {
  if (list.length === 0) {
    notifiedFor = new Set()
    const win = consentWindow()
    if (win) {
      closedHooked = null // closing because the queue is empty, not a user dismissal
      win.close()
    }
    return
  }
  let win = consentWindow()
  if (!win) {
    // 渲染端按 uiScale 等比缩放（setZoomFactor），窗口尺寸同步放大，内容才不会溢出
    const res = createChildWindow({
      id: CONSENT_WINDOW_ID,
      view: CONSENT_VIEW,
      title: t('privacy.consent.window_title', 'Linux Cockpit — 隐私授权'),
      width: Math.round(BASE_WIDTH * uiScale),
      height: Math.round(BASE_HEIGHT * uiScale),
      frameless: false,
      resizable: true,
      alwaysOnTop: true,
      center: true
    })
    if (!res.ok) {
      log.error('consent window failed', res.error)
      return
    }
    win = consentWindow()
    // 有边框的子窗口默认带 File/Edit/View 菜单栏，授权窗口不需要
    win?.removeMenu()
  }
  if (!win) return
  if (closedHooked !== win) {
    closedHooked = win
    const self = win
    win.on('closed', () => {
      // 用户主动关窗 → 拒绝全部；队列清空导致的关闭在 present([]) 里已解除挂钩
      if (closedHooked === self) {
        closedHooked = null
        const n = denyAllPending()
        if (n) log.info('consent window closed by user → denied pending', { count: n })
      }
    })
  }
  win.webContents.send('privacy:pending', list.map(toView))
  if (!win.isFocused()) win.focus()

  // 主窗口不在前台时再发一条系统通知（每个请求只通知一次）
  const fresh = list.filter((r) => !notifiedFor.has(r.id))
  const main = getMainWindow()
  if (fresh.length && Notification.isSupported() && !(main && main.isFocused())) {
    for (const r of fresh) notifiedFor.add(r.id)
    new Notification({
      title: t('privacy.consent.notify_title', 'AI 请求查看隐私数据'),
      body: t('privacy.consent.notify_body', '请在「隐私授权」窗口中确认或拒绝。')
    }).show()
  }
}

/**
 * 从 config.json 重新读取 `agent.privacy` 与 `uiScale`（启动时 + config.set 之后）。
 * uiScale 用于按比例放大授权窗口的初始尺寸。
 */
export async function reloadPrivacyPolicy(): Promise<void> {
  const cfg = await readJson<{ agent?: { privacy?: unknown }; uiScale?: unknown }>(CONFIG_JSON)
  setPrivacyPolicy(normalizePrivacyPolicy(cfg?.agent?.privacy))
  const scale = Number(cfg?.uiScale)
  uiScale = Number.isFinite(scale) && scale > 0 ? Math.min(Math.max(scale, 0.5), 2.5) : 1.1
}

function fromConsentWindow(e: Electron.IpcMainInvokeEvent): boolean {
  const win = consentWindow()
  return !!win && e.sender === win.webContents
}

const DECISIONS: ReadonlySet<ConsentDecision> = new Set(['deny', 'once', 'agent', 'session'])

/** 启动时调用一次（registerIpc 之后）。 */
export function initPrivacyConsent(): void {
  setConsentPresenter(present)
  setPrivacyAudit((e) => {
    if (e.type === 'redact') return // 太频繁，不进日志
    log.info(`privacy ${e.type}`, e)
  })
  void reloadPrivacyPolicy().catch((err) => log.warn('load privacy policy failed', String(err)))

  ipcMain.handle('privacy:pending', (e) =>
    fromConsentWindow(e) ? listPendingRequests().map(toView) : []
  )
  ipcMain.handle('privacy:decide', (e, id: unknown, decision: unknown) => {
    if (!fromConsentWindow(e)) {
      log.warn('privacy:decide from a non-consent sender rejected')
      return false
    }
    if (typeof id !== 'string' || !DECISIONS.has(decision as ConsentDecision)) return false
    return decideConsent(id, decision as ConsentDecision)
  })
  ipcMain.handle('privacy:deny-all', (e) => (fromConsentWindow(e) ? denyAllPending() : 0))
}
