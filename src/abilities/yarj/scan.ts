/**
 * yarj 扫描器 — 遍历图库根目录，对图片解析 EXIF（含 GPS）并 upsert 进元数据库。
 * 增量：photos 表里 file_size + mtime 未变则跳过解析（EXIF 解析是最大开销）。
 * 单文件失败不中断整体；支持 AbortSignal 中止。
 */
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import exifr from 'exifr'
import { getPhotoRow, upsertPhoto } from './db'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('yarj-scan')

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.tif', '.tiff', '.png', '.webp'])

export interface RootScanSummary {
  total: number
  scanned: number
  skipped: number
  withGps: number
  failed: number
  error?: string
}

export interface ScanProgress {
  done: number
  total: number
  scanned: number
  skipped: number
  withGps: number
  failed: number
}

export interface ScanCallbacks {
  signal?: AbortSignal
  onLine?: (line: string) => void
  onProgress?: (p: ScanProgress) => void
}

/** 递归收集目录下所有支持扩展名的图片文件（迭代式栈遍历，跳过符号链接防环）。 */
async function collectImages(root: string): Promise<string[]> {
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
        IMAGE_EXTS.has(e.name.slice(e.name.lastIndexOf('.')).toLowerCase())
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

/** 解析单张照片的 EXIF 并 upsert；返回 { withGps, ok }。 */
async function processOne(
  filePath: string,
  root: string,
  st: { size: number; mtimeMs: number }
): Promise<{ ok: boolean; withGps: boolean }> {
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

  // 十进制 GPS 坐标：exifr 的 `gps: true` 只带回原始 GPSLatitude 数组，
  // 十进制对象需走独立的 exifr.gps()（轻量，只读 GPS 段）。
  let lat: number | null = null
  let lon: number | null = null
  let alt: number | null = null
  try {
    const gps = (await exifr.gps(filePath)) as {
      latitude?: number
      longitude?: number
      altitude?: number
    } | null
    if (gps) {
      lat = typeof gps.latitude === 'number' && Number.isFinite(gps.latitude) ? gps.latitude : null
      lon =
        typeof gps.longitude === 'number' && Number.isFinite(gps.longitude) ? gps.longitude : null
      alt = typeof gps.altitude === 'number' && Number.isFinite(gps.altitude) ? gps.altitude : null
    }
  } catch (err) {
    log.debug('gps parse failed', { path: filePath, error: String(err) })
  }

  upsertPhoto({
    path: filePath,
    root,
    file_size: st.size,
    mtime: st.mtimeMs,
    width: toNumber(exif.PixelXDimension ?? exif.ImageWidth),
    height: toNumber(exif.PixelYDimension ?? exif.ImageHeight),
    orientation: toNumber(exif.Orientation),
    taken_at: normalizeDate(exif.DateTimeOriginal),
    camera_make: typeof exif.Make === 'string' ? exif.Make : null,
    camera_model: typeof exif.Model === 'string' ? exif.Model : null,
    lens_model: typeof exif.LensModel === 'string' ? exif.LensModel : null,
    focal_length: toNumber(exif.FocalLength),
    f_number: toNumber(exif.FNumber),
    exposure_time: typeof exif.ExposureTime === 'string' ? exif.ExposureTime : null,
    iso: toNumber(exif.ISO),
    gps_lat: lat,
    gps_lon: lon,
    gps_alt: alt
  })
  return { ok: true, withGps: lat !== null && lon !== null }
}

/** 扫描一个图库根目录。 */
export async function scanGalleryRoot(
  root: string,
  cb: ScanCallbacks = {}
): Promise<RootScanSummary> {
  const { signal, onLine, onProgress } = cb
  const summary: RootScanSummary = { total: 0, scanned: 0, skipped: 0, withGps: 0, failed: 0 }

  let files: string[]
  try {
    await stat(root)
    files = await collectImages(root)
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
    if (row && row.file_size === st.size && row.mtime === st.mtimeMs) {
      summary.skipped++
    } else {
      const r = await processOne(filePath, root, { size: st.size, mtimeMs: st.mtimeMs })
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
