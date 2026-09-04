/**
 * yarj 扫描器 — 遍历图库根目录，对图片解析 EXIF（含 GPS）、计算 SHA-256 哈希并 upsert 进元数据库。
 * 增量与移动追踪：
 * 1. photos 表里 file_size + mtime + hash 未变则极速跳过（零 IO / EXIF 开销）。
 * 2. 发现新路径时通过 SHA-256 匹配已有记录：若旧路径已失效则无缝迁移路径，保留用户的 appendix 标签/备注数据。
 * 单文件失败不中断整体；支持 AbortSignal 中止。
 */
import { readdir, stat } from 'fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import exifr from 'exifr'
import { getPhotoByHash, getPhotoRow, updatePhotoHash, updatePhotoPath, upsertPhoto } from './db'
import { isVideoFile } from './types'
import { makeLogger } from '../../main/process/logger'

const execFileAsync = promisify(execFile)
const log = makeLogger('yarj-scan')

export const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.png',
  '.webp',
  '.heic',
  '.avif'
])
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.3gp'])
export const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS])

export interface RootScanSummary {
  total: number
  scanned: number
  skipped: number
  moved: number
  withGps: number
  failed: number
  error?: string
}

export interface ScanProgress {
  done: number
  total: number
  scanned: number
  skipped: number
  moved: number
  withGps: number
  failed: number
}

export interface ScanCallbacks {
  signal?: AbortSignal
  onLine?: (line: string) => void
  onProgress?: (p: ScanProgress) => void
}

/** 流式计算文件 SHA-256 哈希。 */
export async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', (err) => reject(err))
  })
}

/** 递归收集目录下所有支持扩展名的媒体文件（图片与视频，迭代式栈遍历，跳过符号链接防环）。 */
async function collectMediaFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 无权限/已删除的目录跳过
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
      } else if (
        e.isFile() &&
        MEDIA_EXTS.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())
      ) {
        out.push(full)
      }
      // 符号链接不跟随（防循环）；其他类型忽略
    }
  }
  return out
}

function normalizeDate(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  const s = String(v)
  // EXIF 惯用 "2021:08:01 12:00:00" → ISO
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  return s
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    // "1/500" → 0.002；"f/1.8" → 1.8
    const frac = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(v.trim())
    if (frac) {
      const d = Number(frac[2])
      return d !== 0 ? Number(frac[1]) / d : null
    }
    const n = Number(v.replace(/^f\//i, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 解析 ISO 6709 地理坐标字符串（如 QuickTime / MP4 中 `+31.2304+121.4737+12.000/` 或 `+37.7749-122.4194/`）。
 */
export function parseIso6709(str: string): { lat: number; lon: number; alt: number | null } | null {
  if (!str || typeof str !== 'string') return null
  const trimmed = str.trim()
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?))?/.exec(trimmed)
  if (!match) return null

  const lat = parseFloat(match[1])
  const lon = parseFloat(match[2])
  const alt = match[3] ? parseFloat(match[3]) : null

  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  ) {
    return { lat, lon, alt: Number.isFinite(alt) ? alt : null }
  }
  return null
}

interface VideoMetadata {
  taken_at: string | null
  camera_make: string | null
  camera_model: string | null
  lens_model: string | null
  width: number | null
  height: number | null
  orientation: number | null
  lat: number | null
  lon: number | null
  alt: number | null
  duration: number | null
}

/** 通过 ffprobe 解析视频元数据与内置 GPS 定位。 */
export async function parseVideoMetadata(filePath: string): Promise<VideoMetadata | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 9000 }
    )

    const data = JSON.parse(stdout) as {
      format?: {
        duration?: string
        tags?: Record<string, string>
      }
      streams?: Array<{
        codec_type?: string
        width?: number
        height?: number
        duration?: string
        tags?: Record<string, string>
        side_data_list?: Array<{ rotation?: number }>
      }>
    }

    const formatTags = data.format?.tags || {}
    let streamTags: Record<string, string> = {}
    let videoWidth: number | null = null
    let videoHeight: number | null = null
    let rotation = 0

    const videoStream = data.streams?.find((s) => s.codec_type === 'video')
    if (videoStream) {
      videoWidth = videoStream.width ?? null
      videoHeight = videoStream.height ?? null
      streamTags = videoStream.tags || {}

      if (videoStream.side_data_list?.length) {
        const sideRot = videoStream.side_data_list.find((sd) => typeof sd.rotation === 'number')
        if (sideRot?.rotation) rotation = sideRot.rotation
      }
      if (!rotation && streamTags['rotate']) {
        rotation = parseInt(streamTags['rotate'], 10) || 0
      }
      if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
        if (videoWidth && videoHeight) {
          const tmp = videoWidth
          videoWidth = videoHeight
          videoHeight = tmp
        }
      }
    }

    // 合并 tags（format 级优先，stream 级补充）
    const allTags: Record<string, string> = { ...streamTags, ...formatTags }

    // 寻找 GPS 定位标签
    let lat: number | null = null
    let lon: number | null = null
    let alt: number | null = null

    const locCandidate =
      allTags['location'] ||
      allTags['location-eng'] ||
      allTags['com.apple.quicktime.location.ISO6709'] ||
      allTags['©xyz'] ||
      allTags['GPSCoordinates']

    if (locCandidate) {
      const parsedGps = parseIso6709(locCandidate)
      if (parsedGps) {
        lat = parsedGps.lat
        lon = parsedGps.lon
        alt = parsedGps.alt
      }
    }

    // 拍摄时间
    const rawTime =
      allTags['creation_time'] ||
      allTags['date'] ||
      allTags['com.apple.quicktime.creationdate'] ||
      allTags['DateTimeOriginal']
    const taken_at = rawTime ? normalizeDate(rawTime) : null

    // 相机型号
    const camera_make = allTags['make'] || allTags['com.apple.quicktime.make'] || null
    const camera_model = allTags['model'] || allTags['com.apple.quicktime.model'] || null
    const lens_model = allTags['lens'] || allTags['com.apple.quicktime.lens'] || null

    const durationStr = data.format?.duration || videoStream?.duration
    const duration = durationStr ? parseFloat(durationStr) : null

    return {
      taken_at,
      camera_make,
      camera_model,
      lens_model,
      width: videoWidth,
      height: videoHeight,
      orientation: rotation
        ? rotation === 90
          ? 6
          : rotation === 180
            ? 3
            : rotation === 270
              ? 8
              : 1
        : 1,
      lat,
      lon,
      alt,
      duration: Number.isFinite(duration) ? duration : null
    }
  } catch (err) {
    log.debug('video metadata parse failed via ffprobe', { path: filePath, error: String(err) })
    return null
  }
}

const PICK_FIELDS = [
  'Make',
  'Model',
  'LensModel',
  'FNumber',
  'ExposureTime',
  'ISO',
  'FocalLength',
  'DateTimeOriginal',
  'Orientation',
  'PixelXDimension',
  'PixelYDimension',
  'ImageWidth',
  'ImageHeight'
] as const

/** 解析单张照片或视频的 EXIF/元数据并 upsert；返回 { withGps, ok }。 */
async function processOne(
  filePath: string,
  root: string,
  st: { size: number; mtimeMs: number },
  fileHash?: string | null
): Promise<{ ok: boolean; withGps: boolean }> {
  let hashVal = fileHash
  if (hashVal === undefined) {
    try {
      hashVal = await computeFileHash(filePath)
    } catch {
      hashVal = null
    }
  }

  const isVideo = isVideoFile(filePath)
  let width: number | null = null
  let height: number | null = null
  let orientation: number | null = null
  let taken_at: string | null = null
  let camera_make: string | null = null
  let camera_model: string | null = null
  let lens_model: string | null = null
  let focal_length: number | null = null
  let f_number: number | null = null
  let exposure_time: string | null = null
  let iso: number | null = null
  let lat: number | null = null
  let lon: number | null = null
  let alt: number | null = null

  if (isVideo) {
    const vMeta = await parseVideoMetadata(filePath)
    if (vMeta) {
      width = vMeta.width
      height = vMeta.height
      orientation = vMeta.orientation
      taken_at = vMeta.taken_at
      camera_make = vMeta.camera_make
      camera_model = vMeta.camera_model
      lens_model = vMeta.lens_model
      lat = vMeta.lat
      lon = vMeta.lon
      alt = vMeta.alt
    }
  } else {
    let exif: Record<string, unknown> = {}
    try {
      const parsed = await exifr.parse(filePath, {
        pick: [...PICK_FIELDS]
      })
      if (parsed) exif = parsed as Record<string, unknown>
    } catch (err) {
      log.debug('exif parse failed', { path: filePath, error: String(err) })
      return { ok: false, withGps: false }
    }

    try {
      const gps = (await exifr.gps(filePath)) as {
        latitude?: number
        longitude?: number
        altitude?: number
      } | null
      if (gps) {
        lat =
          typeof gps.latitude === 'number' && Number.isFinite(gps.latitude) ? gps.latitude : null
        lon =
          typeof gps.longitude === 'number' && Number.isFinite(gps.longitude) ? gps.longitude : null
        alt =
          typeof gps.altitude === 'number' && Number.isFinite(gps.altitude) ? gps.altitude : null
      }
    } catch (err) {
      log.debug('gps parse failed', { path: filePath, error: String(err) })
    }

    width = toNumber(exif.PixelXDimension ?? exif.ImageWidth)
    height = toNumber(exif.PixelYDimension ?? exif.ImageHeight)
    orientation = toNumber(exif.Orientation)
    taken_at = normalizeDate(exif.DateTimeOriginal)
    camera_make = typeof exif.Make === 'string' ? exif.Make : null
    camera_model = typeof exif.Model === 'string' ? exif.Model : null
    lens_model = typeof exif.LensModel === 'string' ? exif.LensModel : null
    focal_length = toNumber(exif.FocalLength)
    f_number = toNumber(exif.FNumber)
    exposure_time = typeof exif.ExposureTime === 'string' ? exif.ExposureTime : null
    iso = toNumber(exif.ISO)
  }

  upsertPhoto({
    path: filePath,
    root,
    file_size: st.size,
    mtime: st.mtimeMs,
    width,
    height,
    orientation,
    taken_at,
    camera_make,
    camera_model,
    lens_model,
    focal_length,
    f_number,
    exposure_time,
    iso,
    gps_lat: lat,
    gps_lon: lon,
    gps_alt: alt,
    hash: hashVal
  })
  return { ok: true, withGps: lat !== null && lon !== null }
}

/** 扫描一个图库根目录。 */
export async function scanGalleryRoot(
  root: string,
  cb: ScanCallbacks = {}
): Promise<RootScanSummary> {
  const { signal, onLine, onProgress } = cb
  const summary: RootScanSummary = {
    total: 0,
    scanned: 0,
    skipped: 0,
    moved: 0,
    withGps: 0,
    failed: 0
  }

  let files: string[]
  try {
    await stat(root)
    files = await collectMediaFiles(root)
  } catch (err) {
    summary.error = `目录不可用: ${String(err)}`
    return summary
  }
  summary.total = files.length

  const failReasons: string[] = []
  let progressAcc = 0

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break
    const filePath = files[i]
    let st
    try {
      st = await stat(filePath)
    } catch {
      continue // 文件已被删除等
    }

    const row = getPhotoRow(filePath)

    // 情况 1：路径匹配且文件大小与修改时间均未发生变化
    if (row && row.file_size === st.size && row.mtime === st.mtimeMs) {
      if (row.hash) {
        summary.skipped++
      } else {
        // 旧版本数据平滑迁移：补全 hash 字段，无需重新解析 EXIF
        try {
          const h = await computeFileHash(filePath)
          updatePhotoHash(filePath, h)
        } catch {
          // 忽略
        }
        summary.skipped++
      }
    } else if (!row) {
      // 情况 2：新发现的路径（可能是新照片，或从别处移动/重命名来的照片）
      let fileHash: string | null = null
      try {
        fileHash = await computeFileHash(filePath)
      } catch (err) {
        log.debug('hash compute failed', { path: filePath, error: String(err) })
      }

      let isMoved = false
      if (fileHash) {
        const existingByHash = getPhotoByHash(fileHash)
        if (existingByHash && existingByHash.path !== filePath) {
          let oldPathExists = false
          try {
            await stat(existingByHash.path)
            oldPathExists = true
          } catch {
            oldPathExists = false
          }

          // 如果旧路径在磁盘上已不存在，说明该照片被移动/重命名了！
          if (!oldPathExists) {
            updatePhotoPath(existingByHash.path, filePath, root, st.size, st.mtimeMs, fileHash)
            summary.moved++
            if (existingByHash.gps_lat != null && existingByHash.gps_lon != null) {
              summary.withGps++
            }
            onLine?.(`追踪到移动/重命名: ${existingByHash.path} -> ${filePath}`)
            isMoved = true
          }
        }
      }

      if (!isMoved) {
        const r = await processOne(filePath, root, { size: st.size, mtimeMs: st.mtimeMs }, fileHash)
        if (r.ok) {
          summary.scanned++
          if (r.withGps) summary.withGps++
        } else {
          summary.failed++
          if (failReasons.length < 10) failReasons.push(filePath)
        }
      }
    } else {
      // 情况 3：已有记录但文件内容/修改时间发生变化
      let fileHash: string | null = null
      try {
        fileHash = await computeFileHash(filePath)
      } catch (err) {
        log.debug('hash compute failed', { path: filePath, error: String(err) })
      }
      const r = await processOne(filePath, root, { size: st.size, mtimeMs: st.mtimeMs }, fileHash)
      if (r.ok) {
        summary.scanned++
        if (r.withGps) summary.withGps++
      } else {
        summary.failed++
        if (failReasons.length < 10) failReasons.push(filePath)
      }
    }

    // 节流进度回调（每 20 个文件或最后 1 个）
    progressAcc++
    if (progressAcc >= 20 || i === files.length - 1) {
      progressAcc = 0
      onProgress?.({
        done: i + 1,
        total: files.length,
        scanned: summary.scanned,
        skipped: summary.skipped,
        moved: summary.moved,
        withGps: summary.withGps,
        failed: summary.failed
      })
    }
  }

  if (failReasons.length) {
    onLine?.(`解析失败 ${summary.failed} 个（示例）: ${failReasons.join('、')}`)
  }
  if (summary.error) onLine?.(summary.error)
  log.info('scan root done', { root, ...summary })
  return summary
}
