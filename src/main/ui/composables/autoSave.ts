import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * 设置页「改完即保存」（与 AIDJ 设置同一惯例）：输入停顿 `delay` 毫秒后自动保存，
 * 开关 / 下拉等离散控件直接 `flush()` 立即保存；组件卸载（切走设置页）时把未落盘的改动补存。
 *
 * - 保存是串行的：保存进行中又有改动，会在这一轮结束后再存一次（以最新值为准）。
 * - `status` 给 `AutoSaveHint.vue` 显示「保存中 / 已保存 / 保存失败」，页面不必再弹 toast。
 */
export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface AutoSave {
  status: Ref<AutoSaveStatus>
  error: Ref<string>
  /** 输入类改动：延迟保存（连续输入只存最后一次）。 */
  schedule: () => void
  /** 离散改动 / 失焦：立即保存（含尚未到时的延迟保存）。 */
  flush: () => Promise<void>
}

export function useAutoSave(save: () => Promise<void>, delay = 600): AutoSave {
  const status = ref<AutoSaveStatus>('idle')
  const error = ref('')
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let again = false

  async function run(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    status.value = 'saving'
    running = (async () => {
      do {
        again = false
        try {
          await save()
          error.value = ''
          status.value = 'saved'
        } catch (e) {
          error.value = e instanceof Error ? e.message : String(e)
          status.value = 'error'
        }
      } while (again)
    })()
    try {
      await running
    } finally {
      running = null
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    status.value = 'pending'
    timer = setTimeout(() => {
      timer = null
      void run()
    }, delay)
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await run()
  }

  onBeforeUnmount(() => {
    if (timer) void flush()
  })

  return { status, error, schedule, flush }
}
