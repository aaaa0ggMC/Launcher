import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useDisplay } from 'vuetify'
import { installViewportVar } from '../../viewport'

/**
 * 断点令牌 —— kit 里**唯一**的一套。
 *
 * 仓里现存 480 / 520 / 560 / 600 / 640 / 720 六种断点并存（各能力各写各的），
 * kit 从这里收敛：后续能力迁移都引用这三个常量，不要再手写魔数。
 * `narrow`（720）是与全站（App.vue 侧栏、v-container 的 px-3）一致的兼容值，保留导出。
 */
export const BREAKPOINTS = {
  /** 小屏：手机 */
  sm: 600,
  /** 中屏：平板 / 窄桌面 */
  md: 960,
  /** 全站窄屏兼容值（App.vue / 各能力的 matchMedia 口径） */
  narrow: 720
} as const

/** 高度计算一律用 viewport.ts 的 --app-vh，不要写裸 100vh */
export function appVh(): number {
  if (typeof document === 'undefined') return 0
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--app-vh')
  return Number.parseFloat(raw) || 0
}

/**
 * 容器宽度（「先渲染 → 实测 → 重规划」要用的那个 ResizeObserver 原语）。
 *
 * 仓里有十几份逐字重复的实现（bili WIDE_MIN=900 抄 3 遍、yaya 6 处、
 * yarj 的 useYarjCompact 被 8 个组件各调一次），收成这一个。
 *
 * 带滞回：宽度变化不超过 `hysteresis`（默认 8px）就不更新——
 * 缩放窗口 / 键盘弹出时相邻宽度下的排版决策相同，更新了只会反复横跳；
 * 残余几像素由使用方（KitSmartRow 的 flex-shrink）兜底。
 */
export function useContainerWidth(hysteresis = 8): {
  /** 绑到要测量的元素上（模板 ref） */
  target: Ref<HTMLElement | null>
  width: Ref<number>
} {
  const target = ref<HTMLElement | null>(null)
  const width = ref(0)
  let observer: ResizeObserver | null = null
  let applied = 0

  watch(
    target,
    (el) => {
      observer?.disconnect()
      observer = null
      if (!el) {
        width.value = 0
        applied = 0
        return
      }
      observer = new ResizeObserver((entries) => {
        const next = Math.round(entries[0]?.contentRect.width ?? 0)
        if (applied !== 0 && Math.abs(next - applied) <= hysteresis) return
        applied = next
        width.value = next
      })
      observer.observe(el)
      // 首帧同步读一次：ResizeObserver 的首个回调在下一帧，同步读能少一帧「未测量」形态
      const first = el.clientWidth
      applied = first
      width.value = first
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    observer?.disconnect()
    observer = null
  })

  return { target, width }
}

/**
 * 窄屏判定（消灭仓里 7 处手写 matchMedia）。断点缺省 720（全站兼容值）。
 * `bp` 可以是数字或 Ref——调用方按容器语义换断点时不用重建监听。
 */
export function useNarrow(bp: number | Ref<number> = BREAKPOINTS.narrow): Ref<boolean> {
  const narrow = ref(false)
  let mql: MediaQueryList | null = null

  const bind = (px: number): void => {
    mql?.removeEventListener('change', onChange)
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      mql = null
      narrow.value = false
      return
    }
    mql = window.matchMedia(narrowQuery(px))
    narrow.value = mql.matches
    mql.addEventListener('change', onChange)
  }

  function onChange(e: MediaQueryListEvent): void {
    narrow.value = e.matches
  }

  watch(
    () => (typeof bp === 'number' ? bp : bp.value),
    (px) => bind(px),
    { immediate: true }
  )
  onScopeDispose(() => {
    mql?.removeEventListener('change', onChange)
    mql = null
  })

  return narrow
}

/** 窄屏判定的 media query（单独导出便于单测与检索仓里还有没有手写魔数） */
export function narrowQuery(bp: number): string {
  return `(max-width: ${bp}px)`
}

export interface Adaptive {
  /** ≤720：全站窄屏口径（手机） */
  narrow: Ref<boolean>
  /** ≤600 */
  sm: Ref<boolean>
  /** ≤960 */
  md: Ref<boolean>
  /** 视口宽度（px） */
  viewportWidth: Ref<number>
  /** Vuetify 断点快照（需要更细粒度时用） */
  display: ReturnType<typeof useDisplay>
}

/**
 * 桌面 / 手机断点：包 viewport.ts（保证 --app-vh 已安装）+ Vuetify useDisplay，
 * 再套上 kit 自己的断点令牌。引擎与 KitPage 都用它拿「当前是不是窄档」——
 * 同一个语义只在这一处定义。
 */
export function useAdaptive(): Adaptive {
  // 无头网页 / 安卓 WebView 下 --app-vh 由 viewport.ts 装上（幂等，main.ts 已调过一次）
  installViewportVar()
  const narrow = useNarrow(BREAKPOINTS.narrow)
  const sm = useNarrow(BREAKPOINTS.sm)
  const md = useNarrow(BREAKPOINTS.md)
  const display = useDisplay()
  const viewportWidth = ref(typeof window === 'undefined' ? 0 : window.innerWidth)
  if (typeof window !== 'undefined') {
    const onResize = (): void => {
      viewportWidth.value = window.innerWidth
    }
    window.addEventListener('resize', onResize)
    onScopeDispose(() => window.removeEventListener('resize', onResize))
  }
  return { narrow, sm, md, viewportWidth, display }
}
