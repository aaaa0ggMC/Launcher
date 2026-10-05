import type { NativeClient } from '../preload/api'

/**
 * 安卓 App 里的系统媒体控制（通知栏媒体卡片 / 锁屏 / 灵动岛类胶囊）。
 *
 * Chrome 会把网页的 `navigator.mediaSession` 交给系统，WebView 不会——App 里放歌时系统看不到
 * 任何媒体会话。这里不改各能力的代码：在 App 里给 `navigator.mediaSession` 套一层，
 * 页面照常写 metadata / setActionHandler / setPositionState，同时转发给原生
 * （`client.call('media.update', …)`，原生侧 MediaBridge.java 建 MediaSession + MediaStyle 通知）；
 * 系统按钮回来是原生事件 `media-action`，按页面注册的处理函数执行。
 *
 * 播放 / 暂停状态：页面写了 `playbackState` 就用它；否则跟踪最近一次 `play()` 的媒体元素
 * （播放器的 <audio> 往往不在 DOM 里，document 上收不到事件，所以包一层 `play()`）。
 * 封面在页面里取回并缩成 ≤512px 的 JPEG data URL 再交给原生——原生不用处理宿主鉴权。
 * 旧版 App 不认 `media.update` 时静默停用。
 */

type Action = 'play' | 'pause' | 'previoustrack' | 'nexttrack' | 'stop' | 'seekto'
const ACTIONS: Action[] = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop', 'seekto']

interface Snapshot {
  title: string
  artist: string
  album: string
  artKey: string
  state: 'playing' | 'paused' | 'none'
  position: number
  duration: number
  rate: number
  actions: Action[]
}

export function installNativeMedia(
  client: NativeClient,
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
): void {
  const ms = navigator.mediaSession as MediaSession | undefined
  if (!ms) return
  let disabled = false

  const handlers = new Map<Action, MediaSessionActionHandler>()
  let position: { position: number; duration: number; rate: number; at: number } | null = null
  let lastMedia: HTMLMediaElement | null = null

  // ---- 拦截页面对 mediaSession 的写入 ----
  const proto = Object.getPrototypeOf(ms) as object
  const metaDesc = Object.getOwnPropertyDescriptor(proto, 'metadata')
  const stateDesc = Object.getOwnPropertyDescriptor(proto, 'playbackState')
  if (metaDesc?.set && metaDesc.get) {
    Object.defineProperty(ms, 'metadata', {
      configurable: true,
      get: () => metaDesc.get!.call(ms),
      set: (v: MediaMetadata | null) => {
        metaDesc.set!.call(ms, v)
        schedule()
      }
    })
  }
  if (stateDesc?.set && stateDesc.get) {
    Object.defineProperty(ms, 'playbackState', {
      configurable: true,
      get: () => stateDesc.get!.call(ms),
      set: (v: MediaSessionPlaybackState) => {
        stateDesc.set!.call(ms, v)
        schedule()
      }
    })
  }
  const origSetHandler = ms.setActionHandler.bind(ms)
  ms.setActionHandler = (action, handler) => {
    if ((ACTIONS as string[]).includes(action)) {
      if (handler) handlers.set(action as Action, handler)
      else handlers.delete(action as Action)
      schedule()
    }
    try {
      origSetHandler(action, handler)
    } catch {
      /* WebView 不支持的动作照样记下，由原生按钮触发 */
    }
  }
  const origSetPosition = ms.setPositionState?.bind(ms)
  ms.setPositionState = (state?: MediaPositionState) => {
    position = state?.duration
      ? {
          position: state.position ?? 0,
          duration: state.duration,
          rate: state.playbackRate ?? 1,
          at: Date.now()
        }
      : null
    schedule()
    try {
      origSetPosition?.(state)
    } catch {
      /* noop */
    }
  }

  // ---- 跟踪正在播放的媒体元素（推断播放 / 暂停） ----
  const tracked = new WeakSet<HTMLMediaElement>()
  const origPlay = HTMLMediaElement.prototype.play
  function track(el: HTMLMediaElement): void {
    lastMedia = el
    if (tracked.has(el)) return
    tracked.add(el)
    for (const ev of ['playing', 'pause', 'ended', 'emptied']) {
      el.addEventListener(ev, () => {
        if (ev === 'playing') lastMedia = el
        schedule()
      })
    }
  }
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    track(this)
    return origPlay.call(this)
  }

  function currentState(): Snapshot['state'] {
    const explicit = ms!.playbackState
    if (explicit === 'playing' || explicit === 'paused') return explicit
    if (!ms!.metadata) return 'none'
    if (lastMedia && !lastMedia.paused && !lastMedia.ended) return 'playing'
    return lastMedia ? 'paused' : 'none'
  }

  function snapshot(): Snapshot {
    const meta = ms!.metadata
    const state = currentState()
    let pos = 0
    let dur = 0
    let rate = 1
    if (position) {
      const elapsed = state === 'playing' ? ((Date.now() - position.at) / 1000) * position.rate : 0
      pos = Math.min(position.duration, position.position + elapsed)
      dur = position.duration
      rate = position.rate
    } else if (lastMedia && Number.isFinite(lastMedia.duration)) {
      pos = lastMedia.currentTime
      dur = lastMedia.duration
      rate = lastMedia.playbackRate || 1
    }
    return {
      title: meta?.title ?? '',
      artist: meta?.artist ?? '',
      album: meta?.album ?? '',
      artKey: meta?.artwork?.[0]?.src ?? '',
      state,
      position: pos,
      duration: dur,
      rate,
      actions: [...handlers.keys()]
    }
  }

  // ---- 封面：取回 → 缩到 512px → JPEG data URL（按 src 缓存一张） ----
  let artCache: { key: string; data: string | null } | null = null
  async function artworkData(src: string): Promise<string | null> {
    if (artCache?.key === src) return artCache.data
    let data: string | null = null
    try {
      const url = new URL(src, location.href).href
      const blob = await (await fetch(url, { credentials: 'include' })).blob()
      const bmp = await createImageBitmap(blob)
      const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bmp.width * scale))
      canvas.height = Math.max(1, Math.round(bmp.height * scale))
      canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      bmp.close()
      data = canvas.toDataURL('image/jpeg', 0.85)
    } catch {
      data = null
    }
    artCache = { key: src, data }
    return data
  }

  // ---- 推送（合并 + 只在有变化时发；进度只在偏离原生外推 >1.5s 时发） ----
  let timer: ReturnType<typeof setTimeout> | null = null
  let sent: (Snapshot & { at: number }) | null = null
  let sentArtKey: string | null = null
  let sending = false

  function schedule(): void {
    if (disabled || timer) return
    timer = setTimeout(() => {
      timer = null
      void push()
    }, 150)
  }

  function sameExceptPosition(a: Snapshot, b: Snapshot): boolean {
    return (
      a.title === b.title &&
      a.artist === b.artist &&
      a.album === b.album &&
      a.artKey === b.artKey &&
      a.state === b.state &&
      a.duration === b.duration &&
      a.rate === b.rate &&
      a.actions.join() === b.actions.join()
    )
  }

  async function push(): Promise<void> {
    if (disabled) return
    if (sending) {
      schedule()
      return
    }
    const snap = snapshot()
    if (sent && sameExceptPosition(sent, snap)) {
      const expected =
        sent.position + (sent.state === 'playing' ? ((Date.now() - sent.at) / 1000) * sent.rate : 0)
      if (Math.abs(expected - snap.position) < 1.5) return
    }
    sending = true
    try {
      const args: Record<string, unknown> = { ...snap }
      if (snap.artKey !== sentArtKey)
        args.artwork = snap.artKey ? await artworkData(snap.artKey) : null
      await client.call('media.update', args)
      sent = { ...snap, at: Date.now() }
      sentArtKey = snap.artKey
    } catch {
      // 旧版 App 没有这个方法：停用，不再打扰
      disabled = true
    } finally {
      sending = false
    }
  }

  // ---- 系统按钮 → 页面处理函数 ----
  on('cockpit:client-media-action', (raw) => {
    const ev = (raw ?? {}) as { action?: string; position?: number }
    let action = ev.action as Action | 'playpause' | undefined
    if (action === 'playpause') action = currentState() === 'playing' ? 'pause' : 'play'
    if (!action) return
    const handler = handlers.get(action)
    if (handler) {
      const details: MediaSessionActionDetails = { action }
      if (action === 'seekto') details.seekTime = Number(ev.position) || 0
      try {
        handler(details)
      } catch {
        /* noop */
      }
    } else if (lastMedia) {
      // 页面没注册处理函数：直接操作最近播放的媒体元素
      if (action === 'play') void lastMedia.play().catch(() => {})
      else if (action === 'pause' || action === 'stop') lastMedia.pause()
      else if (action === 'seekto') lastMedia.currentTime = Number(ev.position) || 0
    }
    schedule()
  })
}
