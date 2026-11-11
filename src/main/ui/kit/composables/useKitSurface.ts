import { onScopeDispose } from 'vue'

/**
 * 玻璃材质（kit 唯一一组表面变量）——「popup / 卡片的背景透明&模糊沿用全局 UI 配置」。
 *
 * 设置 → 外观里调的 `window.fuseAlpha`（背景蒙层不透明度）与 `window.fuseBlur`
 * （Fuse 蒙层模糊）原来只作用于背景层（FuseLayer.vue）。kit 把同一组值接成表面变量：
 *
 *   --kit-glass-alpha   表面不透明度（= fuseAlpha，默认 1 = 不透，保持旧观感）
 *   --kit-glass-blur    表面模糊（= fuseBlur；window.blur=off/auto窄屏 时为 0）
 *   --kit-surface       表面基色（= --v-theme-surface，主题切换自动跟随）
 *   --kit-border        表面描边（on-surface 12%）
 *
 * 所有 kit 表面（卡片 / 分区 / popup / dialog / sheet / chip 底 / 代码块）只用这组变量，
 * 不各写各的 backdrop-filter。用户改外观里的背景透明 / 模糊时即时跟随
 * （订阅 cockpit:config-changed）。
 *
 * 幂等：任何 kit 组件在 setup 里调一次即可；先同步写默认值（首帧就是实心 surface，
 * 不会出现「没有背景色」的一帧），再用异步读到的配置修正。
 */

const DEFAULTS = { alpha: 1, blur: 0 }

let installed = false
let unsub: (() => void) | null = null

function write(alpha: number, blur: number): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement.style
  root.setProperty('--kit-glass-alpha', String(alpha))
  root.setProperty('--kit-glass-blur', `${blur}px`)
  root.setProperty('--kit-surface', 'var(--v-theme-surface)')
  root.setProperty('--kit-border', 'rgba(var(--v-theme-on-surface), 0.12)')
}

function num(v: unknown, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

async function applyFromConfig(): Promise<void> {
  try {
    const cfg = (await window.cockpit.getConfig()) as {
      window?: { fuseAlpha?: unknown; fuseBlur?: unknown; blur?: unknown }
    } | null
    const win = cfg?.window ?? {}
    const alpha = num(win.fuseAlpha, DEFAULTS.alpha)
    const blurMode = win.blur
    const blurOff = blurMode === 'off' || blurMode === 'auto'
    write(alpha, blurOff ? 0 : num(win.fuseBlur, DEFAULTS.blur))
  } catch {
    // 读不到配置就保持默认（实心 surface）
  }
}

/** 安装一次：写默认值 + 读配置 + 订阅变化 */
export function installKitSurface(): void {
  if (typeof document === 'undefined') return
  if (!installed) {
    installed = true
    write(DEFAULTS.alpha, DEFAULTS.blur)
    void applyFromConfig()
  }
  if (unsub || typeof window.cockpit?.on !== 'function') return
  unsub = window.cockpit.on('cockpit:config-changed', () => void applyFromConfig())
}

/** 组件里调用：保证表面变量已就位（幂等） */
export function useKitSurface(): void {
  installKitSurface()
  onScopeDispose(() => {
    // 只退订阅不删变量：变量挂在 <html> 上，其他 kit 表面还在用
    if (!unsub) return
    unsub()
    unsub = null
  })
}
