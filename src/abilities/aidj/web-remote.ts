/**
 * LAN web-remote endpoint for the built-in player (player-backend-plan.md M4).
 *
 * A tiny HTTP server in the MAIN process that lets any device on the LAN (a
 * phone browser, a future PWA) see the current song / cover / progress and
 * control the built-in player — a cross-platform replacement for MPRIS-based
 * KDE Connect, working identically on Windows / macOS / Linux.
 *
 * It runs as a background task (`aidj.web-remote`) so the user starts/stops it
 * from the player page-menu or the background panel, and the port is
 * configurable in settings (`preferences.web_remote_port`).
 *
 * Endpoints:
 *   GET  /         → the remote-control web page
 *   GET  /state    → JSON playback snapshot (polls every ~500ms)
 *   POST /control  → { action: play|pause|toggle|next|prev|stop|seek|volume|rate, value? }
 *   POST /list     → { player } queue the built-in player's queue snapshot
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { makeLogger } from '../../main/process/logger'
import { getActiveBackend, type PlayerBackend } from './player-backend'
import { getCoverArt } from './service'

const log = makeLogger('aidj-web-remote')

/** Resolve the cover (base64 data URL) for the given backend detail. */
async function resolveCover(path: string | undefined): Promise<string> {
  if (!path) return ''
  try {
    const url = await getCoverArt(path)
    return url ?? ''
  } catch {
    return ''
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Human-readable URL for each active LAN interface, for the console hint. */
function lanUrls(port: number): string[] {
  const urls: string[] = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`)
      }
    }
  }
  return urls
}

async function handleRequest(
  backend: PlayerBackend,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && url === '/state') {
    const detail = await backend.getPlaybackDetail()
    json(res, 200, {
      ok: true,
      status: detail.status,
      track: detail.track,
      artist: detail.artist,
      album: detail.album,
      positionMs: detail.positionMs,
      lengthMs: detail.lengthMs,
      volume: detail.volume,
      queueIndex: detail.queueIndex,
      queueTotal: detail.queueTotal,
      playbackRate: detail.playbackRate,
      cover: await resolveCover(
        detail.url.startsWith('file://') ? decodeURIComponent(detail.url.slice(7)) : undefined
      )
    })
    return
  }

  if (req.method === 'POST' && url === '/control') {
    let body: Record<string, unknown>
    try {
      body = await readBody(req)
    } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON' })
    }
    const action = String(body.action ?? '')
    const value = body.value
    let ok = false
    switch (action) {
      case 'play':
        ok = await backend.control('play')
        break
      case 'pause':
        ok = await backend.control('pause')
        break
      case 'toggle':
        ok = await backend.control('toggle')
        break
      case 'next':
        ok = await backend.control('next')
        break
      case 'prev':
        ok = await backend.control('prev')
        break
      case 'stop':
        ok = await backend.control('stop')
        break
      case 'seek':
        if (typeof value === 'number') ok = await backend.seek(value)
        break
      case 'volume':
        if (typeof value === 'number') ok = await backend.setVolume(Math.max(0, Math.min(1, value)))
        break
      default:
        return json(res, 400, { ok: false, error: `unknown action: ${action}` })
    }
    return json(res, ok ? 200 : 500, { ok, action })
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(REMOTE_PAGE)
    return
  }

  json(res, 404, { ok: false, error: 'not found' })
}

/** A single shared server instance (started/stopped by the BT job). */
let _server: Server | null = null
let _serverPort = 0

export function isWebRemoteRunning(): boolean {
  return _server !== null
}

export function getWebRemotePort(): number {
  return _serverPort
}

/** Start the LAN web-remote server on `port`. Returns LAN URLs for the hint. */
export async function startWebRemoteServer(port: number): Promise<{ urls: string[] }> {
  await stopWebRemoteServer()
  const backend = await getActiveBackend()
  if (!backend) throw new Error('播放后端未连接')

  const server = createServer((req, res) => {
    handleRequest(backend, req, res).catch((e) => {
      log.warn('web-remote request failed', { error: String(e) })
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e) })
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve())
  })
  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : port
  _server = server
  _serverPort = boundPort
  log.info('web-remote listening', { port: boundPort })
  return { urls: lanUrls(boundPort) }
}

export async function stopWebRemoteServer(): Promise<void> {
  const s = _server
  _server = null
  _serverPort = 0
  if (s) {
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
}

const REMOTE_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIDJ Remote</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; font-family: -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif;
    background: #0e1116; color: #e6e9ef; display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .card { width: 100%; max-width: 420px; background: #161b24; border: 1px solid #2a3242; border-radius: 16px; padding: 20px; }
  .head { display: flex; align-items: center; gap: 14px; }
  .cover { width: 88px; height: 88px; border-radius: 12px; object-fit: cover; background: #232b3a; flex-shrink: 0; display:flex; align-items:center; justify-content:center; font-size: 34px; }
  .title { font-size: 17px; font-weight: 600; line-height: 1.3; }
  .meta { font-size: 13px; color: #9aa5b5; margin-top: 4px; }
  .status { font-size: 12px; margin-top: 6px; color: #6fbe8a; }
  .status.paused { color: #d9a74a; }
  .status.stopped { color: #8b93a3; }
  .bar { margin: 18px 0 4px; }
  .bar-time { display: flex; justify-content: space-between; font-size: 12px; color: #9aa5b5; margin-top: 6px; }
  input[type=range] { width: 100%; accent-color: #4f7cff; }
  .controls { display: flex; align-items: center; justify-content: center; gap: 18px; margin: 18px 0 6px; }
  button {
    border: none; cursor: pointer; border-radius: 12px; color: #e6e9ef;
    background: #232b3a; width: 52px; height: 52px; font-size: 20px; transition: background .15s;
  }
  button:hover { background: #2e3849; }
  button.primary { width: 64px; height: 64px; background: #4f7cff; font-size: 26px; }
  button.primary:hover { background: #3f66d8; }
  .vol { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #9aa5b5; }
  .vol input { flex: 1; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <img id="cover" class="cover" alt="" />
      <div style="min-width:0">
        <div class="title" id="track">—</div>
        <div class="meta" id="meta">AIDJ built-in player</div>
        <div class="status" id="status">—</div>
      </div>
    </div>
    <div class="bar">
      <input id="seek" type="range" min="0" max="0" value="0">
      <div class="bar-time"><span id="pos">0:00</span><span id="len">0:00</span></div>
    </div>
    <div class="controls">
      <button onclick="send('prev')">⏮</button>
      <button class="primary" onclick="send('toggle')">▶</button>
      <button onclick="send('next')">⏭</button>
      <button onclick="send('stop')">⏹</button>
    </div>
    <div class="vol">
      <span>🔊</span>
      <input id="vol" type="range" min="0" max="1" step="0.01" value="0.8">
      <span id="volv">80%</span>
    </div>
  </div>
<script>
let seeking = false;
let last = null;
function fmt(ms){ if(ms==null) return '0:00'; const t=Math.round(ms/1000); return Math.floor(t/60)+':'+String(t%60).padStart(2,'0'); }
async function poll(){
  try {
    const r = await fetch('/state');
    const s = await r.json();
    document.getElementById('track').textContent = s.track || '—';
    document.getElementById('cover').src = s.cover || '';
    const st = document.getElementById('status');
    st.textContent = s.status || 'Unknown';
    st.className = 'status ' + String(s.status||'').toLowerCase();
    document.getElementById('meta').textContent = (s.artist||'') + (s.album ? ' · ' + s.album : '');
    const len = s.lengthMs||0, pos = s.positionMs||0;
    document.getElementById('seek').max = len;
    if (!seeking) document.getElementById('seek').value = pos;
    document.getElementById('pos').textContent = fmt(pos);
    document.getElementById('len').textContent = fmt(len);
    if (s.volume!=null) { document.getElementById('vol').value = s.volume; document.getElementById('volv').textContent = Math.round(s.volume*100)+'%'; }
    last = s;
  } catch(e) { /* server restarting */ }
}
async function send(action, value){
  await fetch('/control', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action, value}) });
}
const seek = document.getElementById('seek');
seek.addEventListener('input', ()=>{ seeking=true; });
seek.addEventListener('change', ()=>{ seeking=false; send('seek', Number(seek.value)); });
const vol = document.getElementById('vol');
vol.addEventListener('input', ()=>{ document.getElementById('volv').textContent = Math.round(vol.value*100)+'%'; });
vol.addEventListener('change', ()=>{ send('volume', Number(vol.value)); });
setInterval(poll, 500); poll();
</script>
</body>
</html>`
