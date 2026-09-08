import { readFile, readdir, appendFile } from 'fs/promises'
import { join, extname } from 'path'
import { makeLogger } from '../../../main/process/logger'
import type { SongMeta } from '../types'
import { ensureAidjDir, getMetadataPath, getLyricsPath, loadAidjConfig } from './config'
import { localYrcToInlineLrc, yrcToInlineLrc, localYrcToLrc } from './lyrics'
import {
  loadAllActiveMetadata,
  getActiveWriteSlotPath,
  invalidateSlotCache
} from './metadata-slots'

const log = makeLogger('aidj-library')
const MUSIC_EXTS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus', '.mp4'])
const LRC_EXT = '.lrc'
const YRC_EXT = '.yrc'

export async function scanMusicFiles(folders: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const folder of folders) {
    try {
      await walkDir(folder, map)
    } catch (e) {
      log.warn('scan folder failed', { folder, error: String(e) })
    }
  }
  return map
}

async function walkDir(dir: string, map: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(full, map)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (MUSIC_EXTS.has(ext)) {
        const name = entry.name.slice(0, -ext.length)
        if (!map.has(name)) {
          map.set(name, full)
        }
      }
    }
  }
}

export async function loadMetadata(): Promise<Map<string, SongMeta>> {
  try {
    const active = await loadAllActiveMetadata()
    if (active.size > 0) return active
  } catch (e) {
    log.warn('loadAllActiveMetadata failed, falling back to default', { error: String(e) })
  }

  const map = new Map<string, SongMeta>()
  try {
    const raw = await readFile(getMetadataPath(), 'utf-8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line)
        if (entry.name && entry.metadata) {
          map.set(entry.name, entry.metadata as SongMeta)
        }
      } catch {
        /* noop */
      }
    }
  } catch {
    /* noop */
  }
  return map
}

async function readTextAuto(filepath: string): Promise<string> {
  const buf = await readFile(filepath)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('utf-8')
    }
  }
}

async function walkKaraokeDir(dir: string, map: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkKaraokeDir(full, map)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(YRC_EXT)) {
      const name = entry.name.slice(0, -YRC_EXT.length).trim()
      if (!name) continue
      let content = ''
      try {
        content = await readTextAuto(full)
      } catch {
        continue
      }
      const prev = map.get(name)
      if (prev === undefined || content.length > prev.length) map.set(name, content)
    }
  }
}

async function walkLyricDir(dir: string, map: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkLyricDir(full, map)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(LRC_EXT)) {
      const name = entry.name.slice(0, -LRC_EXT.length).trim()
      if (!name) continue
      let content = ''
      try {
        content = await readTextAuto(full)
      } catch {
        continue
      }
      const prev = map.get(name)
      if (prev === undefined || content.length > prev.length) map.set(name, content)
    }
  }
}

export async function scanLyricFiles(folders: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const folder of folders) {
    try {
      await walkLyricDir(folder, map)
    } catch (e) {
      log.warn('scan lyric folder failed', { folder, error: String(e) })
    }
  }
  return map
}

export async function scanKaraokeFiles(folders: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const folder of folders) {
    try {
      await walkKaraokeDir(folder, map)
    } catch (e) {
      log.warn('scan karaoke folder failed', { folder, error: String(e) })
    }
  }
  return map
}

export async function loadLyrics(): Promise<{
  lyrics: Map<string, string>
  karaoke: Map<string, string>
}> {
  const lyrics = new Map<string, string>()
  const karaoke = new Map<string, string>()

  try {
    const raw = await readFile(getLyricsPath(), 'utf-8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line)
        if (entry.name && typeof entry.lyric === 'string') lyrics.set(entry.name, entry.lyric)
        if (entry.name && typeof entry.karaoke === 'string' && entry.karaoke) {
          karaoke.set(entry.name, entry.karaoke)
        }
      } catch {
        /* noop */
      }
    }
  } catch {
    /* noop */
  }

  const config = await loadAidjConfig()
  const folders = config?.lyrics_folders ?? []
  const files = await scanLyricFiles(folders)
  for (const [name, content] of files) {
    if (content) {
      lyrics.set(name, content)
      karaoke.delete(name)
    }
  }

  for (const [name, yrc] of await scanKaraokeFiles(folders)) {
    if (!yrc) continue
    const inline = localYrcToInlineLrc(yrc) || yrcToInlineLrc(yrc)
    if (inline) karaoke.set(name, inline)
    if (!lyrics.has(name)) {
      const plain = localYrcToLrc(yrc)
      if (plain) lyrics.set(name, plain)
    }
  }
  return { lyrics, karaoke }
}

let _libraryCache: {
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  lyrics: Map<string, string>
  karaoke: Map<string, string>
} | null = null

let _libraryLoading: Promise<{
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  lyrics: Map<string, string>
  karaoke: Map<string, string>
}> | null = null

export function loadLibrary(): Promise<{
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  lyrics: Map<string, string>
  karaoke: Map<string, string>
}> {
  if (_libraryCache) return Promise.resolve(_libraryCache)
  if (!_libraryLoading) {
    _libraryLoading = (async () => {
      const config = await loadAidjConfig()
      const folders = config?.music_folders ?? []
      const musicPaths = await scanMusicFiles(folders)
      const metadata = await loadMetadata()
      const { lyrics, karaoke } = await loadLyrics()
      _libraryCache = { metadata, musicPaths, lyrics, karaoke }
      return _libraryCache
    })().finally(() => {
      _libraryLoading = null
    })
  }
  return _libraryLoading
}

export function invalidateLibrary(): void {
  _libraryCache = null
}

export function isLibraryLoading(): boolean {
  return !_libraryCache && _libraryLoading !== null
}

export function setLibraryCacheMetadata(metadata: Map<string, SongMeta>): void {
  if (_libraryCache) {
    _libraryCache.metadata = metadata
  }
}

export async function recomputeActiveLibraryMetadata(): Promise<Map<string, SongMeta>> {
  const metadata = await loadAllActiveMetadata()
  if (_libraryCache) {
    _libraryCache.metadata = metadata
  }
  return metadata
}

export async function appendMetadata(
  name: string,
  meta: SongMeta,
  targetSlotOrPath?: string
): Promise<void> {
  await ensureAidjDir()
  const filePath = targetSlotOrPath?.includes('/')
    ? targetSlotOrPath
    : await getActiveWriteSlotPath(targetSlotOrPath)
  const line = JSON.stringify({ name, metadata: meta }) + '\n'
  await appendFile(filePath, line, 'utf-8')
  invalidateSlotCache(filePath)
}

export async function findMissingSongs(
  musicPaths: Map<string, string>,
  metadata: Map<string, SongMeta>
): Promise<Map<string, string>> {
  const missing = new Map<string, string>()
  for (const [name, path] of musicPaths) {
    if (!metadata.has(name)) {
      missing.set(name, path)
    }
  }
  return missing
}
