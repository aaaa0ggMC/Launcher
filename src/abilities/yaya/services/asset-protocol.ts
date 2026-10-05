/**
 * `yaya-asset://<会话 id>/<文件名>` 协议：界面直接用 `<img src>` 显示会话资产（附件 / 工具截图），
 * 不再经 `yaya.asset-preview` 把整张图转成 data URL 走 IPC —— 长会话里的图片可以懒加载。
 *
 * - 路径解析复用 `resolveAssetLocalPath`（只认两段普通文件名，防 `../` 越界）；
 * - 只提供图片 / 音视频（界面只需要这些）；其它类型 403，避免把任意附件当网页渲染；
 * - 保留地址 `yaya-asset://.widget/frame` 是 HTML 小部件的沙箱外壳页（`plugins/widget/frame.ts`）；
 * - 支持 Range（视频 / 大图）；无头宿主经 `/_p/yaya-asset/…` 路由转到同一个处理器。
 * 特权（secure / fetch / stream / CORS）在 `src/main/index.ts` 的 registerSchemesAsPrivileged 里声明。
 */
import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { resolveAssetLocalPath } from './assets'
import { WIDGET_FRAME_URI, widgetFrameResponse } from '../plugins/widget/frame'

export const ASSET_SCHEME = 'yaya-asset'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function assetMime(file: string): string | null {
  return MIME[extname(file).toLowerCase()] ?? null
}

function toWeb(s: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(s as Readable) as unknown as ReadableStream
}

/** 处理一次请求（与 Electron 解耦，单测直接调） */
export async function handleAssetRequest(request: Request): Promise<Response> {
  // 去掉查询串 / 片段（界面可能加 ?v= 破缓存）
  const uri = request.url.split(/[?#]/)[0]
  // 保留地址：HTML 小部件的沙箱外壳页（见 plugins/widget/frame.ts）
  if (uri === WIDGET_FRAME_URI) return widgetFrameResponse()
  const local = resolveAssetLocalPath(decodeURIComponent(uri))
  if (!local) return new Response(null, { status: 400 })
  const mime = assetMime(local)
  if (!mime) return new Response(null, { status: 403 })
  let total: number
  try {
    const st = await stat(local)
    if (!st.isFile()) return new Response(null, { status: 404 })
    total = st.size
  } catch {
    return new Response(null, { status: 404 })
  }
  const base: Record<string, string> = {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    // SVG 只当图片用：即使被直接打开也不执行脚本
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes'
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') ?? '')
  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
    if (start > end || start >= total) return new Response(null, { status: 416 })
    return new Response(toWeb(createReadStream(local, { start, end })), {
      status: 206,
      headers: {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1)
      }
    })
  }
  return new Response(toWeb(createReadStream(local)), {
    status: 200,
    headers: { ...base, 'Content-Length': String(total) }
  })
}

let registered = false
export function registerYayaAssetProtocol(): void {
  if (registered) return
  registered = true
  protocol.handle(ASSET_SCHEME, (request) =>
    handleAssetRequest(request).catch(() => new Response(null, { status: 500 }))
  )
}
