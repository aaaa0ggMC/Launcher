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
  // 合并成动画结束后的一次（尾随 60ms）；但**首帧立即跟进**——收键盘时布局视口已经
  // 恢复，纯尾随防抖会让外壳停留在挤压高度 ~200ms（半屏空白 + 猛然回弹，B4）。
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastApply = 0
  const apply = (): void => {
    lastApply = Date.now()
    requestAnimationFrame(update)
  }
  const schedule = (): void => {
    // 正在输入 = 键盘动画进行中（resize 逐帧来）：**逐帧跟上**——原生侧这期间在逐帧调
    // padding 缩 WebView 表面（MainActivity 的 WindowInsetsAnimationCallback），两边同步，
    // 输入框才会贴着键盘丝滑上浮（90ms 缓动把它抹得更顺）。代价集中在键盘动画的几百毫秒。
    if (isEditing()) {
      apply()
      return
    }
    const now = Date.now()
    if (!timer && now - lastApply > 200) {
      apply()
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      apply()
    }, 60)
  }
  // B7：键盘弹出时浏览器会对聚焦输入框做 scrollIntoView——即使 html/body 是
  // overflow:hidden 也能被**程序滚动**，整个外壳被向下顶出去（顶部留白、顶栏消失，
  // 高度更新后才弹回）。document 没有任何合法滚动场景，一律按回原点；
  // 内部滚动容器（聊天 / 设置列表）有自己的 scrollTop，不受影响。
  const resetScroll = (): void => {
    const se = document.scrollingElement
    if (se && (se.scrollTop !== 0 || se.scrollLeft !== 0)) {
      se.scrollTop = 0
      se.scrollLeft = 0
    }
  }
  window.addEventListener('scroll', resetScroll, { capture: true })
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
  window.visualViewport?.addEventListener('resize', schedule)
  // 键盘收起不一定伴随可靠的 resize：失焦后再量一次（用的高度来源也随之切回 innerHeight）
  document.addEventListener('focusout', schedule)
  document.addEventListener('focusin', schedule)
  update()
}
