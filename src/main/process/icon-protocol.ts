import { protocol, net } from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { THUMBNAIL_CACHE_DIR } from './paths'
import { makeLogger } from './logger'

const execFileAsync = promisify(execFile)
const log = makeLogger('icon-protocol')

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp'
}

const VIDEO_EXTS = new Set(Object.keys(VIDEO_MIME))
const inFlightThumbs = new Map<string, Promise<string>>()

function toWebStream(node: import('stream').Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>
}

async function ensureVideoThumbnail(videoPath: string): Promise<string> {
  const hash = createHash('md5').update(videoPath).digest('hex')
  const thumbPath = join(THUMBNAIL_CACHE_DIR, `${hash}.jpg`)

  if (existsSync(thumbPath)) {
    try {
      const st = statSync(thumbPath)
      if (st.size > 0) return thumbPath
    } catch {
      /* ignore */
    }
  }

  const inFlight = inFlightThumbs.get(thumbPath)
  if (inFlight) return inFlight

  const genPromise = (async (): Promise<string> => {
    try {
      await mkdir(THUMBNAIL_CACHE_DIR, { recursive: true })
      // 优先在 0.5s 处抽取一帧（避免开场黑屏），缩放宽最大 640px，保持宽高比
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        '00:00:00.500',
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-update',
        '1',
        '-vf',
        "scale='min(640,iw)':-2",
        '-q:v',
        '3',
        thumbPath
      ])
    } catch {
      // 0.5s 失败（如极短视频或单帧视频），回退从第 0 秒抽取
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-ss',
          '00:00:00.000',
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-update',
          '1',
          '-vf',
          "scale='min(640,iw)':-2",
          '-q:v',
          '3',
          thumbPath
        ])
      } catch (err) {
        log.warn(`Failed to generate video thumbnail for ${videoPath}`, err)
        throw err
      }
    }
    return thumbPath
  })()

  inFlightThumbs.set(thumbPath, genPromise)
  try {
    return await genPromise
  } finally {
    inFlightThumbs.delete(thumbPath)
  }
}

/**
 * `cockpit-icon://<abs-path>` — serves local image files & streams video files to the sandboxed
 * renderer (file:// is blocked in <img> and <video>). Path must be encodeURIComponent'd.
 * - If requesting video with `?thumb=1` or in an <img> context, generates & serves a cached JPEG thumbnail.
 * - If requesting video in a <video> context, handles HTTP Range requests (206 Partial Content) for smooth streaming & seeking.
 */
export function registerIconProtocol(): void {
  protocol.handle('cockpit-icon', async (request) => {
    try {
      const urlWithoutScheme = request.url.slice('cockpit-icon://'.length)
      const [rawPath, rawQuery] = urlWithoutScheme.split('?')
      const filePath = decodeURIComponent(rawPath)

      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      const isVideo = VIDEO_EXTS.has(ext)
      const isThumbParam = rawQuery ? new URLSearchParams(rawQuery).get('thumb') === '1' : false
      const secFetchDest = request.headers.get('sec-fetch-dest')
      const isImageRequest = isThumbParam || (isVideo && secFetchDest === 'image')

      if (isVideo && isImageRequest) {
        try {
          const thumbPath = await ensureVideoThumbnail(filePath)
          return await net.fetch('file://' + thumbPath)
        } catch {
          // If ffmpeg fails, fallback to direct fetch
          return await net.fetch('file://' + filePath)
        }
      }

      if (isVideo) {
        const st = await stat(filePath)
        if (!st.isFile()) return new Response(null, { status: 404 })
        const mime = VIDEO_MIME[ext] ?? 'video/mp4'
        const total = st.size

        const range = request.headers.get('Range')
        const rangeMatch = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null
        if (rangeMatch) {
          const start = Number(rangeMatch[1])
          const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), total - 1) : total - 1
          if (start > end || start >= total) return new Response(null, { status: 416 })
          return new Response(toWebStream(createReadStream(filePath, { start, end })), {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Access-Control-Allow-Origin': '*',
              'Accept-Ranges': 'bytes',
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Content-Length': String(end - start + 1)
            }
          })
        }

        return new Response(toWebStream(createReadStream(filePath)), {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Content-Length': String(total)
          }
        })
      }

      return await net.fetch('file://' + filePath)
    } catch {
      return new Response(null, { status: 400 })
    }
  })
}

/** Build a cockpit-icon:// URL from an absolute path. */
export function iconUrl(absPath: string): string {
  return `cockpit-icon://${encodeURIComponent(absPath)}`
}
