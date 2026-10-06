/**
 * 宿主「停顿」诊断：区分两种看起来一样的情况——
 *
 * - **整个进程被系统暂停**（手机深度休眠、厂商 ROM 把后台的 Termux 冻结）：主线程和看门狗线程一起停，
 *   恢复后才发现时间跳了一大段。此时对外表现是宿主完全不响应，切回 Termux 往往就恢复了。
 * - **主线程被卡住**（同步 I/O 卡在共享存储 / 死循环）：看门狗线程照常走，能在卡住期间就报出来；
 *   卡住不恢复时只能重启宿主。
 *
 * 看门狗线程在主线程卡住期间直接写 stderr（worker 的 console 要经主线程转发，卡住时出不来）。
 */
import { Worker } from 'node:worker_threads'
import { makeLogger } from '../main/process/logger'

const log = makeLogger('watchdog')

/** 共享内存槽位：主线程心跳 / 看门狗线程最近一次自身停顿（单位 100ms） */
const MAIN_BEAT = 0
const WORKER_GAP = 1

const WORKER_SRC = `
const { workerData } = require('node:worker_threads')
const { writeSync } = require('node:fs')
const shared = new Int32Array(workerData.sab)
const t0 = workerData.t0
const now = () => Math.floor((Date.now() - t0) / 100)
let last = now()
let reportedAt = 0
setInterval(() => {
  const t = now()
  const gap = t - last - 10
  last = t
  // 自己也停了一大段：整个进程被系统暂停过（记下来给主线程恢复后判断）
  if (gap > 20) Atomics.store(shared, ${WORKER_GAP}, Math.max(Atomics.load(shared, ${WORKER_GAP}), gap))
  const stuck = t - Atomics.load(shared, ${MAIN_BEAT})
  // 看门狗自己这一拍也是刚从停顿里醒来（整个进程被暂停过）：主线程还没来得及跳，不算卡住
  if (gap > 20) return
  if (stuck > 150) {
    if (t - reportedAt >= 300) {
      reportedAt = t
      try {
        writeSync(2, new Date().toISOString() + ' [WARN] [watchdog] 主线程已卡住 ' + Math.round(stuck / 10) +
          ' 秒（不是系统休眠：看门狗线程仍在运行）。宿主此时不响应任何请求；长时间不恢复请重启宿主并附上这段日志\\n')
      } catch {}
    }
  } else reportedAt = 0
}, 1000)
`

export function startWatchdog(): void {
  const t0 = Date.now()
  const sab = new SharedArrayBuffer(8)
  const shared = new Int32Array(sab)
  const now = (): number => Math.floor((Date.now() - t0) / 100)
  Atomics.store(shared, MAIN_BEAT, now())
  try {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { sab, t0 } })
    w.unref()
    w.on('error', (e) => log.warn('watchdog worker failed', String(e)))
  } catch (e) {
    log.warn('watchdog worker unavailable', String(e))
  }
  let last = Date.now()
  setInterval(() => {
    const t = Date.now()
    const lag = t - last - 1000
    last = t
    Atomics.store(shared, MAIN_BEAT, now())
    if (lag <= 3000) return
    // 进程整体恢复时两个线程的定时器谁先跑不一定：等看门狗线程也走一拍再判断
    setTimeout(() => {
      const workerGapMs = Atomics.exchange(shared, WORKER_GAP, 0) * 100
      // 看门狗线程也停了差不多这么久 → 整个进程被暂停；否则是主线程自己卡住
      if (workerGapMs >= lag * 0.7)
        log.warn('host process was paused by the system (device asleep or Termux frozen)', {
          ms: lag,
          hint: '把 Termux 锁定在后台、电池设为无限制'
        })
      else log.warn('main thread was blocked', { ms: lag })
    }, 1500)
  }, 1000).unref()
}
