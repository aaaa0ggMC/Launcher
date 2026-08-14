import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname } from 'path'
import { Readable } from 'stream'

/**
 * `cockpit-audio://<abs-path>` — streams local audio files to the renderer's
 * `<audio>` element. The renderer is sandboxed (file:// is blocked in media),
 * so the built-in web player feeds this scheme instead.
 *
 * The handler is fully explicit: Content-Type from the extension, and proper
 * HTTP Range responses (the media stack probes with `Range: bytes=0-` and needs
 * 206 + `Content-Range` to seek). `net.fetch('file://…')` was too opaque about
 * both, which showed up as "no supported source" on `<audio>`.
 */
const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm'
}

export function registerAudioProtocol(): void {
  protocol.handle('cockpit-audio', async (request) => {
    try {
      const raw = request.url.slice('cockpit-audio://'.length)
      const path = decodeURIComponent(raw)
      const st = await stat(path)
      if (!st.isFile()) return new Response(null, { status: 404 })
      const mime = AUDIO_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
      const total = st.size

      const range = request.headers.get('Range')
      const rangeMatch = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null
      if (rangeMatch) {
        const start = Number(rangeMatch[1])
        const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), total - 1) : total - 1
        if (start > end || start >= total) return new Response(null, { status: 416 })
        return new Response(toWebStream(createReadStream(path, { start, end })), {
          status: 206,
          headers: {
            'Content-Type': mime,
            // CORS-opt-in: the renderer routes this media through a Web Audio
            // MediaElementAudioSourceNode, which outputs SILENCE unless the
            // element is origin-clean. A wildcard ACAO keeps the media usable
            // by the graph while this is a local file read anyway.
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1)
          }
        })
      }

      return new Response(toWebStream(createReadStream(path)), {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total)
        }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

/** Node Readable → web ReadableStream (Node ≥ 18); typed via a cast because the
 *  Node `stream/web` generic and the DOM `ReadableStream` lib types clash. */
function toWebStream(node: import('stream').Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>
}

/** Build a cockpit-audio:// URL from an absolute path. */
export function audioUrl(absPath: string): string {
  return `cockpit-audio://${encodeURIComponent(absPath)}`
}
