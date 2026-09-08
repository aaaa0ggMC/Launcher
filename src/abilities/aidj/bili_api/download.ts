import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import type { BiliPlayUrlResult } from './video'
import type { BiliClient } from './client'
import { makeLogger } from '../../../main/process/logger'

const log = makeLogger('bili-download')

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
  percent: number
}

/**
 * Download Bilibili video stream to destination file.
 */
export async function downloadBiliMedia(
  client: BiliClient,
  playUrl: BiliPlayUrlResult,
  outputPath: string,
  options: {
    audioOnly?: boolean
    onProgress?: (p: DownloadProgress) => void
    abortSignal?: AbortSignal
  } = {}
): Promise<void> {
  const { onProgress, abortSignal, audioOnly } = options

  // Case 1: DASH separate video & audio streams, or audio-only request
  if (playUrl.isDash && playUrl.videoUrl && playUrl.audioUrl) {
    return downloadDashWithFfmpeg(
      client,
      playUrl,
      outputPath,
      audioOnly ?? false,
      abortSignal,
      onProgress
    )
  }

  // Case 2: Single stream (durl)
  if (playUrl.url) {
    if (audioOnly) {
      // Extract audio only using ffmpeg
      return downloadExtractAudioFfmpeg(client, playUrl.url, outputPath, abortSignal)
    }
    return downloadDirectHttp(client, playUrl.url, outputPath, abortSignal, onProgress)
  }

  throw new Error('无效的视频下载链接')
}

/**
 * Direct HTTP stream download for single stream (durl).
 */
async function downloadDirectHttp(
  client: BiliClient,
  streamUrl: string,
  outputPath: string,
  abortSignal?: AbortSignal,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  const headers: Record<string, string> = {
    'User-Agent': client.userAgent,
    Referer: 'https://www.bilibili.com'
  }
  const cookieStr = client.credential.toCookieString()
  if (cookieStr) headers['Cookie'] = cookieStr

  const res = await fetch(streamUrl, {
    method: 'GET',
    headers,
    signal: abortSignal
  })

  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}: ${res.statusText}`)
  }

  const totalBytes = Number(res.headers.get('content-length')) || 0
  let downloadedBytes = 0

  const fileStream = createWriteStream(outputPath)

  if (!res.body) throw new Error('空响应体')
  const reader = res.body.getReader()

  try {
    while (true) {
      if (abortSignal?.aborted) {
        fileStream.destroy()
        throw new Error('下载已取消')
      }

      const { done, value } = await reader.read()
      if (done) break

      if (value) {
        fileStream.write(Buffer.from(value))
        downloadedBytes += value.length
        if (totalBytes > 0 && onProgress) {
          const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
          onProgress({ downloadedBytes, totalBytes, percent })
        }
      }
    }
  } finally {
    fileStream.end()
  }
}

/**
 * Download and mux DASH streams using ffmpeg.
 */
function downloadDashWithFfmpeg(
  client: BiliClient,
  playUrl: BiliPlayUrlResult,
  outputPath: string,
  audioOnly: boolean,
  abortSignal?: AbortSignal,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cookieStr = client.credential.toCookieString()
    const headerStr = `Referer: https://www.bilibili.com\r\nUser-Agent: ${client.userAgent}\r\n${
      cookieStr ? `Cookie: ${cookieStr}\r\n` : ''
    }`

    const args: string[] = ['-y']

    if (audioOnly) {
      args.push('-headers', headerStr, '-i', playUrl.audioUrl!)
      args.push('-c:a', 'copy', outputPath)
    } else {
      args.push('-headers', headerStr, '-i', playUrl.videoUrl!)
      args.push('-headers', headerStr, '-i', playUrl.audioUrl!)
      args.push('-c', 'copy', outputPath)
    }

    const proc = spawn('ffmpeg', args)

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        proc.kill('SIGKILL')
        reject(new Error('下载已取消'))
      })
    }

    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
      // Estimate progress
      if (onProgress) {
        onProgress({ downloadedBytes: 0, totalBytes: 0, percent: 50 })
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        if (onProgress) onProgress({ downloadedBytes: 100, totalBytes: 100, percent: 100 })
        resolve()
      } else {
        log.warn('ffmpeg dash mux failed', { code, stderr: stderr.slice(-300) })
        reject(new Error(`ffmpeg 合成失败，退出码: ${code}`))
      }
    })

    proc.on('error', (err) => reject(err))
  })
}

/**
 * Extract audio stream from video URL using ffmpeg.
 */
function downloadExtractAudioFfmpeg(
  client: BiliClient,
  streamUrl: string,
  outputPath: string,
  abortSignal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cookieStr = client.credential.toCookieString()
    const headerStr = `Referer: https://www.bilibili.com\r\nUser-Agent: ${client.userAgent}\r\n${
      cookieStr ? `Cookie: ${cookieStr}\r\n` : ''
    }`

    const args = ['-y', '-headers', headerStr, '-i', streamUrl, '-vn', '-c:a', 'copy', outputPath]
    const proc = spawn('ffmpeg', args)

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        proc.kill('SIGKILL')
        reject(new Error('下载已取消'))
      })
    }

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 音频抽取失败，退出码: ${code}`))
    })
    proc.on('error', (err) => reject(err))
  })
}
