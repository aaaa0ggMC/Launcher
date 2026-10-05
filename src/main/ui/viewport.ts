/**
 * 网页模式下的外壳高度（`--app-vh`）：用 JS 量，而不是信任 CSS 的 100dvh。
 *
 * 手机浏览器上 100dvh 可能比真正可见的区域高（把底部手势条 / 工具栏那一块也算进去），应用外壳
 * 又是锁在视口里的（html/body 不滚动，滚动发生在内部容器），结果就是底部内容被切掉、滚不到。
 * 这里改为：可见高度 = visualViewport.height（键盘弹出时会缩）− env(safe-area-inset-bottom)，
 * 再除以根元素 CSS zoom（网页版的页面缩放，见 web-shim 的 setZoom）。
 *
 * 只在没有自有窗口的宿主（网页）里启用；Electron 的视口由窗口决定，保持 CSS 默认。
 * 同时把量到的各种高度作为一条 warn 日志写进主机日志，便于在真机上排查（日志里能看到真实数值）。
 */
/** 焦点在可输入的元素上（软键盘可能弹出） */
function isEditing(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true
  return (
    el instanceof HTMLInputElement &&
    !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(el.type)
  )
}

export function installViewportVar(): void {
  if (window.cockpit.hasCap('window.frame')) return
  const root = document.documentElement
  const probe = document.createElement('div')
  // 探针：用 CSS 单位量出 dvh / svh / lvh 与安全区，仅用于计算和日志
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:100dvh;visibility:hidden;pointer-events:none;' +
    'padding-bottom:env(safe-area-inset-bottom,0px)'
  const probeS = document.createElement('div')
  probeS.style.cssText = 'position:fixed;left:0;top:0;width:0;height:100svh;visibility:hidden'
  const probeL = document.createElement('div')
  probeL.style.cssText = 'position:fixed;left:0;top:0;width:0;height:100lvh;visibility:hidden'
  document.body.append(probe, probeS, probeL)
  root.classList.add('vh-js')

  let lastLogged = ''
  let logTimer: ReturnType<typeof setTimeout> | null = null
  let pendingLog: Record<string, unknown> | null = null
  const update = (): void => {
    const vv = window.visualViewport
    // 只有正在输入时才可能有软键盘：此时用 visualViewport（不缩布局视口的浏览器里只有它会变小）；
    // 其余时候用 innerHeight。安卓 WebView 里键盘收起后 visualViewport.height 可能停在键盘弹出时的
    // 旧值，外壳就一直只有半屏高（日志页只剩一截）；捏合缩放时 visualViewport 也会变小，同样不该用。
    const visible = vv && isEditing() ? Math.min(vv.height, window.innerHeight) : window.innerHeight
    const safe = parseFloat(getComputedStyle(probe).paddingBottom) || 0
    const zoom = parseFloat(getComputedStyle(root).zoom) || 1
    if (visible <= 0) return
    const px = Math.max(0, (visible - safe) / zoom)
    root.style.setProperty('--app-vh', `${px}px`)
    // 宽度同理：CSS zoom 下 100vw 不会除以倍数，按视口宽度夹取的规则要用这个（见 global.css 的 .page-menu-pop）
    root.style.setProperty('--app-vw', `${window.innerWidth / zoom}px`)

    const info = {
      innerHeight: Math.round(window.innerHeight),
      visualViewport: vv ? Math.round(vv.height) : null,
      dvh: Math.round(probe.getBoundingClientRect().height),
      svh: Math.round(probeS.getBoundingClientRect().height),
      lvh: Math.round(probeL.getBoundingClientRect().height),
      clientHeight: root.clientHeight,
      screenHeight: window.screen.height,
      safeBottom: Math.round(safe),
      zoom,
      dpr: window.devicePixelRatio,
      appVh: Math.round(px)
    }
    // 日志只记稳定后的结果：键盘动画期间每帧一条 warn 会被转发成一次宿主请求（曾因此卡顿数秒）
    pendingLog = info
    if (logTimer) clearTimeout(logTimer)
    logTimer = setTimeout(() => {
      const key = JSON.stringify(pendingLog)
      if (pendingLog && key !== lastLogged) {
        lastLogged = key
        console.warn('[viewport]', pendingLog)
      }
    }, 1000)
  }
  // 键盘弹出 / 收起动画期间 resize 几乎每帧一次，每次都要整页重排（含毛玻璃重绘）：
  // 合并成动画结束后的一次（尾随 120ms），外壳一步到位，不跟着逐帧抖
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      requestAnimationFrame(update)
    }, 120)
  }
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
  // 键盘收起不一定伴随可靠的 resize：失焦后再量一次（用的高度来源也随之切回 innerHeight）
  document.addEventListener('focusout', schedule)
  document.addEventListener('focusin', schedule)
  update()
}
