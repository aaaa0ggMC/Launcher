import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useContainerWidth } from './useAdaptive'
import { fitScale, fitState, type BoxSize, type FitState } from '../layout/fit'

/**
 * 「80% 内容率」的运行时原语：量容器与内容，超了就自动降档。
 *
 * - 容器：ResizeObserver（带 8px 滞回，见 useContainerWidth）
 * - 内容：ResizeObserver 量内容盒子（rAF 里批量读，先读后写）
 * - 产出：`fit`（roomy / tight / overflow）与 `scale`（把内容压回 80% 的系数），
 *   调用方把 scale 用成字号 / 内边距的乘子（CSS var `--kit-fit-scale`），
 *   或者按 fit 状态切更激进的退化（藏次要信息）。
 */
export function useFitBox(): {
  /** 绑到容器上 */
  target: Ref<HTMLElement | null>
  /** 绑到内容上 */
  content: Ref<HTMLElement | null>
  fit: Ref<FitState>
  scale: Ref<number>
  /** 重新量一次（内容变化时调） */
  refresh: () => void
} {
  const { target, width: containerW } = useContainerWidth()
  const content = ref<HTMLElement | null>(null)
  const contentSize = ref<BoxSize>({ width: 0, height: 0 })
  const containerH = ref(0)

  const fit = ref<FitState>('roomy')
  const scale = ref(1)

  let observer: ResizeObserver | null = null
  let frame = 0

  function measure(): void {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const box = target.value
      const inner = content.value
      const c: BoxSize = {
        width: box?.clientWidth ?? containerW.value,
        height: box?.clientHeight ?? containerH.value
      }
      const n: BoxSize = {
        width: inner?.scrollWidth ?? contentSize.value.width,
        height: inner?.scrollHeight ?? contentSize.value.height
      }
      containerH.value = c.height
      contentSize.value = n
      fit.value = fitState(n, c)
      scale.value = fitScale(n, c)
    })
  }

  watch([target, content], () => {
    observer?.disconnect()
    observer = null
    if (!target.value) return
    observer = new ResizeObserver(measure)
    observer.observe(target.value)
    if (content.value) observer.observe(content.value)
    measure()
  })

  onScopeDispose(() => {
    observer?.disconnect()
    observer = null
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  })

  return { target, content, fit, scale, refresh: measure }
}
