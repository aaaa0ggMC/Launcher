/**
 * Android App 键盘过渡的「首尾两帧遮丑」+ 原生 root 背景同步（`installImeFade`）。
 *
 * 系统 WebView 不参与 IME 视口集成（interactive-widget meta 与 visualViewport 都不跟键盘走），
 * 原生只能在键盘动画的起止各落一次 root padding——**逐帧调 = 页面每帧整页重排，真机实测
 * 掉帧比跳变更糟**（已回退）。代价是过渡期间页面保持旧布局、动画结束才一次性落地：输入框
 * 会「突然出现 / 突然落下」。
 *
 * 遮丑方式（用户提议的「中间底部 fade 一下」）：底部铺一条主题色渐隐带
 * （position: fixed、pointer-events: none），键盘即将动（底部输入框获得/失去焦点）就淡入
 * 盖住落差，`viewport.ts` 落地应用了 resize（`cockpit:viewport-applied`）后再淡出。
 *
 * 同时把页面主题背景色同步给原生（`ui.bg`）：键盘过渡期 root 的 padding 区露出的是 root
 * 底色，不同步的话浅色主题下会闪出 #121212 黑条。
 *
 * 仅 Android App（`window.cockpit.client`）启用渐隐带：浏览器自己跟键盘逐帧缩放，不需要遮丑。
 */

type Timer = ReturnType<typeof setTimeout>

let band: HTMLDivElement | null = null
let on = false
let safety: Timer | null = null
let out: Timer | null = null
let syncPending: Timer | null = null

const isApp = (): boolean => !!window.cockpit.client

/** 页面主题背景色（不透明的 #RRGGBB；半透明拿不准就放弃） */
function themeBg(): string | null {
  const hex = (s: string): string => Number(s).toString(16).padStart(2, '0')
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(
      getComputedStyle(el).backgroundColor
    )
    if (!m) continue
    if (m[4] !== undefined && parseFloat(m[4]) < 1) continue
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
  }
  return null
}

/** 主题/背景变化（applyTheme 改 <html> 的 class / style）后重新同步给原生与渐隐带 */
function scheduleSync(): void {
  if (syncPending) clearTimeout(syncPending)
  syncPending = setTimeout(() => {
    syncPending = null
    const bg = themeBg()
    if (!bg) return
    if (band) band.style.setProperty('--ime-fade-bg', bg)
    if (isApp()) void window.cockpit.client?.call('ui.bg', { color: bg }).catch(() => {})
  }, 150)
}

function ensureBand(): HTMLDivElement {
  if (band) return band
  band = document.createElement('div')
  band.className = 'ime-fade-band'
  band.setAttribute('aria-hidden', 'true')
  const fill = document.createElement('div')
  fill.className = 'ime-fade-band__fill'
  band.append(fill)
  document.body.append(band)
  return band
}

function show(): void {
  if (!isApp()) return
  ensureBand()
  if (out) {
    clearTimeout(out)
    out = null
  }
  if (safety) clearTimeout(safety)
  // 兜底：一直没有落地 resize（外接键盘等）也别一直盖着
  safety = setTimeout(hide, 900)
  if (on) return
  on = true
  band?.classList.add('on')
}

function hide(): void {
  if (safety) {
    clearTimeout(safety)
    safety = null
  }
  if (out) {
    clearTimeout(out)
    out = null
  }
  if (!on || !band) return
  on = false
  band.classList.remove('on')
}

/** 靠近视口底部的可输入元素（输入框/搜索框；按钮类与中段表单不弹键盘，不管） */
function nearBottom(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) return false
  if (
    el instanceof HTMLInputElement &&
    ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(el.type)
  )
    return false
  return el.getBoundingClientRect().bottom >= window.innerHeight - 240
}

export function installImeFade(): void {
  scheduleSync()
  new MutationObserver(scheduleSync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style']
  })
  if (!isApp()) return
  document.addEventListener('focusin', (e) => {
    if (nearBottom(e.target)) show()
  })
  // 收键盘：遮住「落下」的那一帧
  document.addEventListener('focusout', (e) => {
    if (nearBottom(e.target)) show()
  })
  window.addEventListener('cockpit:viewport-applied', () => {
    if (!on) return
    show() // 续命兜底计时
    if (out) clearTimeout(out)
    // 落地后再遮 160ms（盖住回弹/缓动），然后淡出
    out = setTimeout(hide, 160)
  })
}
