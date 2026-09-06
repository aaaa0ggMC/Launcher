import { makeLogger } from '../../../main/process/logger'
import type { AidjConfig, PlayerStatus, LyricPlaybackState } from '../types'
import { loadAidjConfig } from './config'
import { loadLibrary } from './library'
import { resolveTrackPath, resolveLyricForTrackPath } from './lyrics'

const log = makeLogger('aidj-dbus')

interface DbusBus {
  getProxyObject: (name: string, path: string) => Promise<DbusProxyObject>
  disconnect: () => void
}
interface DbusProxyObject {
  getInterface: (name: string) => Record<string, unknown>
}
interface DbusVariant {
  signature: string
  value: unknown
}
interface PropertiesInterface {
  Get: (iface: string, prop: string) => Promise<DbusVariant>
  Set: (iface: string, prop: string, value: DbusVariant) => Promise<void>
}
interface PlayerInterface {
  Next: () => Promise<void>
  Previous: () => Promise<void>
  Play: () => Promise<void>
  Pause: () => Promise<void>
  PlayPause: () => Promise<void>
  Stop: () => Promise<void>
  OpenUri: (uri: string) => Promise<void>
  Seek: (offsetMicros: number) => Promise<void>
}
interface TrackListInterface {
  AddTrack: (uri: string, afterTrack: string, setAsCurrent: boolean) => Promise<void>
}
interface DBusDaemon {
  ListNames: () => Promise<string[]>
}

export function unwrapVariant(v: unknown): unknown {
  if (v && typeof v === 'object' && 'signature' in v && 'value' in v) {
    return unwrapVariant((v as DbusVariant).value)
  }
  return v
}

export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    p.then((v) => {
      clearTimeout(timer)
      resolve(v)
    }).catch(() => {
      clearTimeout(timer)
      resolve(fallback)
    })
  })
}

export class DBusManager {
  private bus: DbusBus | null = null
  private playerProxy: DbusProxyObject | null = null
  private propsProxy: Record<string, unknown> | null = null
  private playerName: string = ''
  private preferredTarget: string
  private _autoMode = true

  constructor(preferredTarget = 'vlc') {
    this.preferredTarget = preferredTarget
  }

  get autoMode(): boolean {
    return this._autoMode
  }

  async connect(): Promise<boolean> {
    try {
      const dbus = await import('dbus-next')
      this.bus = dbus.sessionBus()
      if (!this._autoMode) {
        const players = await this.listPlayers()
        const target = this.resolvePlayer(players)
        if (!target) return false
        this.playerName = target
        this.playerProxy = await this.bus.getProxyObject(target, '/org/mpris/MediaPlayer2')
        this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
      }
      return true
    } catch (e) {
      log.warn('dbus connect failed', { error: String(e) })
      return false
    }
  }

  private async autoDetectPlayer(): Promise<string | null> {
    try {
      const players = await this.listPlayers()
      if (!players.length) return null
      for (const name of players) {
        try {
          const obj = await withTimeout(
            this.bus!.getProxyObject(name, '/org/mpris/MediaPlayer2'),
            3000,
            null
          )
          if (!obj) continue
          let props: PropertiesInterface | null = null
          try {
            props = obj.getInterface(
              'org.freedesktop.DBus.Properties'
            ) as unknown as PropertiesInterface
          } catch {
            continue
          }
          if (!props) continue
          const statusV = await withTimeout(
            props.Get('org.mpris.MediaPlayer2.Player', 'PlaybackStatus'),
            3000,
            { value: '', signature: '' }
          )
          if (statusV.value === 'Playing') return name
        } catch {
          /* skip */
        }
      }
      const preferred = players.find((p) =>
        p.toLowerCase().includes(this.preferredTarget.toLowerCase())
      )
      if (preferred) return preferred
      return players[0]
    } catch {
      return null
    }
  }

  private async ensureBound(): Promise<boolean> {
    if (!this._autoMode && this.propsProxy) return true
    const target = await this.autoDetectPlayer()
    if (!target) return false
    if (this.playerName === target && this.propsProxy) return true
    try {
      this.playerName = target
      this.playerProxy = await withTimeout(
        this.bus!.getProxyObject(target, '/org/mpris/MediaPlayer2'),
        4000,
        null
      )
      if (!this.playerProxy) return false
      this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
      return true
    } catch {
      return false
    }
  }

  private resolvePlayer(players: string[]): string | null {
    if (!players.length) return null
    const preferred = players.find((p) =>
      p.toLowerCase().includes(this.preferredTarget.toLowerCase())
    )
    if (preferred) return preferred
    const mpv = players.find((p) => p.toLowerCase().includes('mpv'))
    if (mpv) return mpv
    return players[0]
  }

  async getStatus(): Promise<PlayerStatus> {
    try {
      if (this._autoMode) {
        const target = await this.autoDetectPlayer()
        if (!target) return { status: 'Unknown', track: '', volume: null, player: '' }
        if (target !== this.playerName || !this.propsProxy) {
          try {
            this.playerName = target
            this.playerProxy = await this.bus!.getProxyObject(target, '/org/mpris/MediaPlayer2')
            this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
          } catch {
            return { status: 'Unknown', track: '', volume: null, player: '' }
          }
        }
      } else if (!this.propsProxy) {
        log.warn('getStatus: propsProxy is null')
        return { status: 'Unknown', track: '', volume: null, player: '' }
      }
      const props = this.propsProxy as unknown as PropertiesInterface
      const statusV = await withTimeout(
        props.Get('org.mpris.MediaPlayer2.Player', 'PlaybackStatus'),
        3000,
        null
      )
      if (!statusV) return { status: 'Unknown', track: '', volume: null, player: '' }
      const status = statusV.value as string
      const metaV = await withTimeout(
        props.Get('org.mpris.MediaPlayer2.Player', 'Metadata'),
        3000,
        null
      )
      const rawMeta = (metaV?.value ?? {}) as Record<string, unknown>
      const meta: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rawMeta ?? {})) {
        meta[k] = unwrapVariant(v)
      }
      const volV = await withTimeout(
        props.Get('org.mpris.MediaPlayer2.Player', 'Volume'),
        3000,
        null
      )
      const vol = volV?.value as number
      const track = this.resolveTrackName(meta)
      log.info('getStatus ok', { status, track, player: this.playerName })
      return {
        status: status as PlayerStatus['status'],
        track,
        volume: vol ?? null,
        player: this.playerName
      }
    } catch (e) {
      log.warn('getStatus failed', { error: String(e) })
      return { status: 'Unknown', track: '', volume: null, player: '' }
    }
  }

  async getPlaybackDetail(): Promise<{
    ok: boolean
    status: PlayerStatus['status']
    track: string
    artist: string
    album: string
    positionMs: number | null
    lengthMs: number | null
    url: string
  }> {
    const unreachable = {
      ok: false,
      status: 'Unknown' as PlayerStatus['status'],
      track: '',
      artist: '',
      album: '',
      positionMs: null as number | null,
      lengthMs: null as number | null,
      url: ''
    }
    try {
      if (this._autoMode) {
        const ok = await this.ensureBound()
        if (!ok) return unreachable
      } else if (!this.propsProxy) {
        return unreachable
      }
      const props = this.propsProxy as unknown as PropertiesInterface
      const statusV = await withTimeout(
        props.Get('org.mpris.MediaPlayer2.Player', 'PlaybackStatus'),
        3000,
        null
      )
      if (!statusV) return unreachable
      const metaV = await withTimeout(
        props.Get('org.mpris.MediaPlayer2.Player', 'Metadata'),
        3000,
        null
      )
      const posV = await withTimeout(
        props.Get('org.mpris.MediaPlayer2.Player', 'Position'),
        3000,
        null
      )
      const rawMeta = (metaV?.value ?? {}) as Record<string, unknown>
      const meta: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rawMeta ?? {})) {
        meta[k] = unwrapVariant(v)
      }
      const artistRaw = meta['xesam:artist']
      const artist = Array.isArray(artistRaw)
        ? (artistRaw as unknown[]).map(String).join(' / ')
        : String(artistRaw ?? '')
      const album = String(meta['xesam:album'] ?? '')
      const length = Number(meta['mpris:length'] ?? 0)
      const position = Number(unwrapVariant(posV?.value) ?? 0)
      return {
        ok: true,
        status: statusV.value as string as PlayerStatus['status'],
        track: this.resolveTrackName(meta),
        artist,
        album,
        positionMs: position > 0 ? Math.round(position / 1000) : null,
        lengthMs: length > 0 ? Math.round(length / 1000) : null,
        url: String(meta['xesam:url'] ?? '')
      }
    } catch (e) {
      log.warn('getPlaybackDetail failed', { error: String(e) })
      return unreachable
    }
  }

  async control(command: string): Promise<boolean> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return false
      if (!this.playerProxy) return false
      const iface = this.playerProxy.getInterface(
        'org.mpris.MediaPlayer2.Player'
      ) as unknown as PlayerInterface
      const methodMap: Record<string, keyof PlayerInterface> = {
        next: 'Next',
        prev: 'Previous',
        play: 'Play',
        pause: 'Pause',
        toggle: 'PlayPause',
        stop: 'Stop'
      }
      const method = methodMap[command] as keyof PlayerInterface
      if (!method) return false
      await (iface[method] as () => Promise<void>)()
      return true
    } catch (e) {
      log.warn('control failed', { command, error: String(e) })
      return false
    }
  }

  async sendFiles(paths: string[]): Promise<boolean> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return false
      if (!this.playerProxy) return false
      if (!paths.length) return true
      const iface = this.playerProxy.getInterface(
        'org.mpris.MediaPlayer2.Player'
      ) as unknown as PlayerInterface
      if (paths.length === 1) {
        await iface.OpenUri(`file://${paths[0]}`)
        return true
      }
      try {
        const tl = this.playerProxy.getInterface(
          'org.mpris.MediaPlayer2.TrackList'
        ) as unknown as TrackListInterface
        for (let i = 0; i < paths.length; i++) {
          await tl.AddTrack(`file://${paths[i]}`, '/', i === 0)
        }
        await iface.Play()
        return true
      } catch {
        for (const p of paths) {
          await iface.OpenUri(`file://${p}`)
        }
        return true
      }
    } catch (e) {
      log.warn('sendFiles failed', { error: String(e) })
      return false
    }
  }

  async seekTo(positionMs: number): Promise<boolean> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return false
      if (!this.playerProxy) return false
      const detail = await this.getPlaybackDetail()
      if (!detail.ok || detail.positionMs == null) return false
      const iface = this.playerProxy.getInterface(
        'org.mpris.MediaPlayer2.Player'
      ) as unknown as PlayerInterface
      const offsetMicros = Math.round((positionMs - detail.positionMs) * 1000)
      await iface.Seek(offsetMicros)
      return true
    } catch (e) {
      log.warn('seekTo failed', { positionMs, error: String(e) })
      return false
    }
  }

  async setVolume(vol: number): Promise<boolean> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return false
      if (!this.propsProxy) return false
      const props = this.propsProxy as unknown as PropertiesInterface
      const { Variant } = await import('dbus-next')
      await props.Set(
        'org.mpris.MediaPlayer2.Player',
        'Volume',
        new Variant('d', Math.max(0, Math.min(1, vol)))
      )
      return true
    } catch (e) {
      log.warn('setVolume failed', { vol, error: String(e) })
      return false
    }
  }

  async getVolume(): Promise<number | null> {
    try {
      if (this._autoMode && !(await this.ensureBound())) return null
      if (!this.propsProxy) return null
      const props = this.propsProxy as unknown as PropertiesInterface
      const v = await props.Get('org.mpris.MediaPlayer2.Player', 'Volume')
      const val = unwrapVariant(v?.value)
      return typeof val === 'number' ? val : null
    } catch {
      return null
    }
  }

  disconnect(): void {
    if (this.bus) {
      try {
        this.bus.disconnect()
      } catch {
        /* noop */
      }
      this.bus = null
      this.playerProxy = null
      this.propsProxy = null
    }
  }

  getPlayerName(): string {
    return this._autoMode ? '__auto__' : this.playerName
  }

  resolveTrackName(meta: Record<string, unknown>): string {
    const title = String(meta?.['xesam:title'] ?? '').trim()
    if (title) return title
    const url = String(meta?.['xesam:url'] ?? '').trim()
    if (!url) return ''
    const clean = url.replace(/^file:\/\//, '')
    let name = clean.split('/').pop() || clean
    const noQuery = name.split('?')[0].split('#')[0]
    const ext = noQuery.lastIndexOf('.')
    name = ext > 0 ? noQuery.slice(0, ext) : noQuery
    try {
      return decodeURIComponent(name)
    } catch {
      return name
    }
  }

  get resolvedPlayerName(): string {
    return this.playerName || ''
  }

  async listPlayers(): Promise<string[]> {
    try {
      const dbus = await import('dbus-next')
      const ownBus = !this.bus
      const bus = this.bus || dbus.sessionBus()
      const obj = await withTimeout(
        bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus'),
        3000,
        null
      )
      if (!obj) {
        if (ownBus) {
          try {
            bus.disconnect()
          } catch {
            /* noop */
          }
        }
        return []
      }
      const iface = obj.getInterface('org.freedesktop.DBus') as unknown as DBusDaemon
      const names: string[] = await withTimeout(iface.ListNames(), 3000, [])
      if (ownBus) {
        try {
          bus.disconnect()
        } catch {
          /* noop */
        }
      }
      return names.filter((n: string) => n.startsWith('org.mpris.MediaPlayer2'))
    } catch (e) {
      log.warn('listPlayers failed', { error: String(e) })
      return []
    }
  }

  async switchToPlayer(playerName: string): Promise<boolean> {
    try {
      if (!playerName || playerName === '__auto__') {
        this._autoMode = true
        this.playerName = ''
        this.playerProxy = null
        this.propsProxy = null
        log.info('switched to auto mode')
        return true
      }
      this._autoMode = false
      if (this.playerName === playerName && this.propsProxy) return true
      const dbus = await import('dbus-next')
      const bus = this.bus || dbus.sessionBus()
      this.playerName = playerName
      this.playerProxy = await bus.getProxyObject(playerName, '/org/mpris/MediaPlayer2')
      this.propsProxy = this.playerProxy.getInterface('org.freedesktop.DBus.Properties')
      if (!this.bus) this.bus = bus
      log.info('switched to player', { player: playerName })
      return true
    } catch (e) {
      log.warn('switchToPlayer failed', { player: playerName, error: String(e) })
      return false
    }
  }
}

let _dbusManager: DBusManager | null = null

export function getDbusManager(): DBusManager | null {
  return _dbusManager
}

export function setDbusManager(m: DBusManager): void {
  _dbusManager = m
}

export async function initDbusManager(config: AidjConfig): Promise<DBusManager> {
  if (_dbusManager) _dbusManager.disconnect()
  const dbus = new DBusManager(config.preferences.dbus_target)
  await dbus.connect()
  setDbusManager(dbus)
  return dbus
}

export async function activateAidjDbus(): Promise<{ ok: boolean; error?: string }> {
  const config = await loadAidjConfig()
  if (!config) return { ok: false, error: 'AIDJ 配置未找到，请先在设置里配置' }
  try {
    if (!getDbusManager()) {
      await initDbusManager(config)
    }
    return { ok: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log.warn('activateAidjDbus failed', { error })
    return { ok: false, error }
  }
}

let _lyricsDbus: DBusManager | null = null

export async function getLyricsDbus(): Promise<DBusManager | null> {
  const session = getDbusManager()
  if (session) return session
  if (!_lyricsDbus) {
    const config = await loadAidjConfig()
    const dbus = new DBusManager(config?.preferences?.dbus_target ?? 'vlc')
    const ok = await withTimeout(dbus.connect(), 4000, false)
    if (!ok) return null
    _lyricsDbus = dbus
  }
  return _lyricsDbus
}

export async function getLyricPlayerBinding(): Promise<{ current: string; auto: boolean }> {
  const dbus = await getLyricsDbus()
  if (!dbus) return { current: '', auto: true }
  return { current: dbus.getPlayerName(), auto: dbus.autoMode }
}

export async function switchLyricsPlayer(playerName: string): Promise<boolean> {
  const session = getDbusManager()
  const mgr = session ?? (await getLyricsDbus())
  if (!mgr) return false
  return withTimeout(mgr.switchToPlayer(playerName), 4000, false)
}

export async function getLyricPlayback(): Promise<LyricPlaybackState> {
  const empty: LyricPlaybackState = {
    ok: false,
    status: 'Unknown',
    track: '',
    artist: '',
    album: '',
    player: '',
    positionMs: null,
    lengthMs: null,
    lyric: null
  }
  try {
    const dbus = await getLyricsDbus()
    if (!dbus) return empty
    const detail = await dbus.getPlaybackDetail()
    if (!detail.ok) return empty
    if (!detail.track) {
      return {
        ...empty,
        ok: true,
        status: detail.status,
        player: dbus.resolvedPlayerName,
        positionMs: detail.positionMs,
        lengthMs: detail.lengthMs
      }
    }
    const lib = await loadLibrary()
    const path = resolveTrackPath(detail, lib.musicPaths)
    const lyric = resolveLyricForTrackPath(path, detail.track, lib.lyrics)
    const karaokeLyric =
      resolveLyricForTrackPath(path, detail.track, lib.karaoke, { fuzzy: false }) ?? null
    return {
      ok: true,
      status: detail.status,
      track: detail.track,
      artist: detail.artist,
      album: detail.album,
      player: dbus.resolvedPlayerName,
      positionMs: detail.positionMs,
      lengthMs: detail.lengthMs,
      path,
      lyric,
      karaokeLyric
    }
  } catch (e) {
    log.warn('getLyricPlayback failed', { error: e instanceof Error ? e.message : String(e) })
    return empty
  }
}

export async function getCurrentPlayerKey(): Promise<string> {
  const dbus = getDbusManager()
  if (dbus) {
    if (dbus.resolvedPlayerName) return dbus.resolvedPlayerName
    if (dbus.autoMode) {
      await dbus.getStatus()
      if (dbus.resolvedPlayerName) return dbus.resolvedPlayerName
    }
    const name = dbus.getPlayerName()
    if (name && name !== '__auto__') return name
  }
  const config = await loadAidjConfig()
  return config?.preferences?.dbus_target || 'auto'
}

let _playersCache: { list: string[]; at: number } | null = null
const PLAYERS_TTL = 2000

export async function listAvailablePlayers(force = false): Promise<string[]> {
  if (!force && _playersCache && Date.now() - _playersCache.at < PLAYERS_TTL) {
    return _playersCache.list
  }
  let list: string[]
  if (_dbusManager) {
    list = await _dbusManager.listPlayers()
  } else {
    try {
      const dbus = await import('dbus-next')
      const bus = dbus.sessionBus()
      const obj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
      const iface = obj.getInterface('org.freedesktop.DBus') as unknown as DBusDaemon
      const names: string[] = await iface.ListNames()
      bus.disconnect()
      list = names.filter((n: string) => n.startsWith('org.mpris.MediaPlayer2'))
    } catch (e) {
      log.warn('listAvailablePlayers failed', { error: String(e) })
      list = []
    }
  }
  _playersCache = { list, at: Date.now() }
  return list
}

export function invalidatePlayersCache(): void {
  _playersCache = null
}

export async function switchPlayer(playerName: string): Promise<boolean> {
  if (!_dbusManager) return false
  return _dbusManager.switchToPlayer(playerName)
}

/**
 * Parse and resolve song information from DBus playback detail.
 * Prioritizes `xesam:url` (xurl) first (decoding file path and extracting song title/artist),
 * then falls back to `xesam:title` / `xesam:artist` / `xesam:album`.
 */
export function resolveDbusTrackInfo(detail: {
  url?: string
  track?: string
  artist?: string
  album?: string
}): { info: string; track: string; artist: string; album: string } | null {
  const url = String(detail.url ?? '').trim()
  const track = String(detail.track ?? '').trim()
  const artist = String(detail.artist ?? '').trim()
  const album = String(detail.album ?? '').trim()

  let info = ''

  if (url.startsWith('file://')) {
    let rawFile = url.replace(/^file:\/\/(localhost\/)?/, '')
    try {
      rawFile = decodeURIComponent(rawFile)
    } catch {
      /* ignore decode error */
    }
    const lastSegment = rawFile.split('/').pop()?.split('?')[0]?.split('#')[0] ?? ''
    const extIdx = lastSegment.lastIndexOf('.')
    const baseName = extIdx > 0 ? lastSegment.slice(0, extIdx).trim() : lastSegment.trim()

    if (baseName) {
      if (artist && !baseName.toLowerCase().includes(artist.toLowerCase())) {
        info = `${artist}-${baseName}`
      } else {
        info = baseName
      }
    }
  }

  if (!info) {
    if (artist && track) {
      if (track.toLowerCase().includes(artist.toLowerCase())) {
        info = track
      } else {
        info = `${artist}-${track}`
      }
    } else if (track) {
      info = track
    } else if (artist) {
      info = artist
    } else if (album) {
      info = album
    }
  }

  if (!info) return null

  return {
    info,
    track: track || info,
    artist,
    album
  }
}

export async function getCurrentDbusTrackInfo(): Promise<{
  ok: boolean
  info?: string
  track?: string
  artist?: string
  album?: string
  error?: string
}> {
  let dbus = getDbusManager()
  if (!dbus) {
    const config = await loadAidjConfig()
    if (config) dbus = await initDbusManager(config)
  }
  if (!dbus) {
    return { ok: false, error: 'DBus 未连接或未能初始化' }
  }

  const detail = await dbus.getPlaybackDetail()
  if (!detail.ok && !detail.track && !detail.url && !detail.artist) {
    return { ok: false, error: '未能获取当前播放信息，请确认播放器正在运行并播放歌曲' }
  }

  const resolved = resolveDbusTrackInfo(detail)
  if (!resolved) {
    return { ok: false, error: '未能从 DBus 解析出歌曲信息' }
  }

  return {
    ok: true,
    info: resolved.info,
    track: resolved.track,
    artist: resolved.artist,
    album: resolved.album
  }
}
