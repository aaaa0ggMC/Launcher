import { appendFile, mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import { loadAidjConfig } from './service'

const log = makeLogger('aidj-song-timeline')

export const SONG_TIMELINE_CSV = join(USER_CONFIG_DIR, 'aidj', 'songs_timeline.csv')

const CSV_HEADER = 'Song Name, TimeStamp , LocalTime\n'

let lastRecordedSong = ''
let lastRecordedTime = 0

/**
 * 格式化本地时间为 yymmddhhmmss 风格字符串。
 * 遵循 4 位年份以防跨年歧义，即 YYYYMMDDHHmmss (如 20260902173651)。
 */
export function formatLocalTime(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const YYYY = d.getFullYear()
  const MM = pad(d.getMonth() + 1)
  const DD = pad(d.getDate())
  const HH = pad(d.getHours())
  const mm = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  return `${YYYY}${MM}${DD}${HH}${mm}${ss}`
}

/**
 * 记录单次听歌事件到 songs_timeline.csv。
 *
 * 格式规范：
 * "Song Name", TimeStamp , LocalTime
 * 规则：
 * 1. 检查配置 preferences.song_timeline 是否开启（未配置或 true 时默认开启）；
 * 2. 对 Song Name 进行双引号包裹与内部双引号转义（replace(/"/g, '""')）；
 * 3. TimeStamp 为秒级 Unix 时间戳，LocalTime 为格式化后的本地时间；
 * 4. 包含防抖去重：若在 5 秒内重复收到同一首歌曲的播放通知，忽略该重复写入。
 */
export async function recordSongTimeline(songName: string): Promise<void> {
  const cleanName = songName.trim()
  if (!cleanName) return

  const now = Date.now()
  // 5秒内同名歌曲防抖（处理播放器状态频繁上报）
  if (cleanName === lastRecordedSong && now - lastRecordedTime < 5000) {
    return
  }

  try {
    const config = await loadAidjConfig()
    if (config?.preferences?.song_timeline === false) {
      return
    }

    lastRecordedSong = cleanName
    lastRecordedTime = now

    const escapedName = `"${cleanName.replace(/"/g, '""')}"`
    const timestampSec = Math.floor(now / 1000)
    const localTime = formatLocalTime(new Date(now))
    const line = `${escapedName}, ${timestampSec} , ${localTime}\n`

    await mkdir(join(USER_CONFIG_DIR, 'aidj'), { recursive: true })

    // 如果文件不存在或为空，先写入表头
    let needsHeader = false
    try {
      const s = await stat(SONG_TIMELINE_CSV)
      if (s.size === 0) needsHeader = true
    } catch {
      needsHeader = true
    }

    const payload = needsHeader ? CSV_HEADER + line : line
    await appendFile(SONG_TIMELINE_CSV, payload, 'utf-8')
    log.info('song timeline recorded', { song: cleanName, timestamp: timestampSec, localTime })
  } catch (e) {
    log.warn('recordSongTimeline failed', { song: songName, error: String(e) })
  }
}
