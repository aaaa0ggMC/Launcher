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
 *   GET  /         → the remote-control web page (responsive, lyrics + controls)
 *   GET  /state    → JSON playback snapshot incl. lyrics (polls every ~500ms)
 *   POST /control  → { action: play|pause|toggle|next|prev|stop|seek|volume|rate, value? }
 *   POST /list     → { player } queue the built-in player's queue snapshot
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { makeLogger } from '../../main/process/logger'
import { getActiveBackend, type PlayerBackend, WebPlayerBackend } from './player-backend'
import { getCoverArt, loadLibrary, resolveLyricForTrackPath } from './service'

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

/** Resolve on-disk LRC / karaoke lyrics for the current track path. */
async function resolveLyrics(
  path: string | undefined,
  track: string
): Promise<{ lyric: string | null; karaokeLyric: string | null }> {
  if (!path || !track) return { lyric: null, karaokeLyric: null }
  try {
    const lib = await loadLibrary()
    return {
      lyric: resolveLyricForTrackPath(path, track, lib.lyrics),
      karaokeLyric: resolveLyricForTrackPath(path, track, lib.karaoke, { fuzzy: false })
    }
  } catch {
    return { lyric: null, karaokeLyric: null }
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
    const filePath = detail.url.startsWith('file://')
      ? decodeURIComponent(detail.url.slice(7))
      : undefined
    const [cover, lyrics] = await Promise.all([
      resolveCover(filePath),
      resolveLyrics(filePath, detail.track)
    ])
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
      cover,
      lyric: lyrics.lyric,
      karaokeLyric: lyrics.karaokeLyric
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
      case 'rate':
        if (typeof value === 'number' && value > 0 && backend instanceof WebPlayerBackend) {
          await backend.setRate(value)
          ok = true
        }
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<title>AIDJ Remote</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif;
    background: #0d1117; color: #e6e9ef; display: flex; align-items: center; justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }
  .bg { position: fixed; inset: -40px; z-index: 0; background-size: cover; background-position: center;
    filter: blur(44px) saturate(1.2); transform: scale(1.05); opacity: .7; pointer-events: none; }
  .bg::after { content: ''; position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(13,17,23,.5), rgba(13,17,23,.85)); }
  .card { position: relative; z-index: 1; width: 100%; height: 100vh; height: 100dvh;
    display: flex; flex-direction: column; max-width: 560px;
    padding: max(18px, env(safe-area-inset-top)) 20px max(14px, env(safe-area-inset-bottom)); }
  @media (min-width: 600px) {
    body { padding: 32px; }
    .card { height: calc(100dvh - 64px); border-radius: 24px;
      background: rgba(15,18,25,.72); backdrop-filter: blur(28px);
      border: 1px solid rgba(255,255,255,.08); box-shadow: 0 24px 60px rgba(0,0,0,.5);
      padding: 26px 28px; }
  }
  .head { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
  .cover { width: 88px; height: 88px; border-radius: 16px; overflow: hidden; flex-shrink: 0;
    background: rgba(255,255,255,.06); display: flex; align-items: center; justify-content: center; }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: none; }
  .cover .ph { display: flex; align-items: center; justify-content: center; color: #7b8698; font-size: 38px; }
  .meta { min-width: 0; flex: 1; }
  .title { font-size: 19px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 13px; color: #9aa5b5; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status { display: inline-flex; align-items: center; margin-top: 8px; padding: 3px 10px;
    border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .5px; }
  .status.playing { background: rgba(111,190,138,.15); color: #6fbe8a; }
  .status.paused { background: rgba(217,167,74,.15); color: #d9a74a; }
  .status.stopped { background: rgba(255,255,255,.08); color: #8b93a3; }

  .rates { display: flex; gap: 8px; margin-top: 14px; overflow-x: auto; flex-shrink: 0;
    scrollbar-width: none; padding-bottom: 2px; }
  .rates::-webkit-scrollbar { display: none; }
  .rates button, .rates input { flex-shrink: 0; border: none; cursor: pointer; border-radius: 999px;
    padding: 8px 14px; font-size: 13px; font-weight: 600; background: rgba(255,255,255,.07); color: #e6e9ef;
    transition: background .15s; }
  .rates button.on { background: #4f7cff; color: #fff; }
  .rates button:active { transform: scale(.94); }
  .rates input { width: 72px; text-align: center; }

  .lyrics { position: relative; flex: 1; min-height: 0; margin: 12px 0 8px; overflow: hidden; }
  .lyric-scroll { position: absolute; inset: 0; overflow-y: auto; display: flex; flex-direction: column;
    align-items: center; scrollbar-width: none; }
  .lyric-scroll::-webkit-scrollbar { display: none; }
  .lyric-line { font-size: 19px; font-weight: 500; line-height: 1.5; color: rgba(230,233,239,.5);
    text-align: center; padding: 7px 18px; max-width: 100%; transition: color .2s, font-size .2s, opacity .2s; }
  .lyric-line.is-current { font-size: 24px; font-weight: 700; color: #e6e9ef; }
  .lyric-line.is-current .kr { background-image: linear-gradient(90deg, #4f7cff var(--kfill),
    rgba(230,233,239,.92) var(--kfill)); -webkit-background-clip: text; background-clip: text;
    color: transparent; -webkit-text-fill-color: transparent; }
  .lyric-line.is-dim { opacity: .45; }
  .lyric-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #7b8698; font-size: 15px; text-align: center; padding: 20px; }

  .foot { flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; }
  .bar input[type=range] { width: 100%; accent-color: #4f7cff; height: 28px; margin: 0; cursor: pointer; }
  .bar-time { display: flex; justify-content: space-between; font-size: 12px; color: #9aa5b5;
    margin-top: -6px; font-variant-numeric: tabular-nums; }
  .controls { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 8px 0; }
  .controls button { border: none; cursor: pointer; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; width: 54px; height: 54px; background: rgba(255,255,255,.08); color: #e6e9ef;
    transition: background .15s, transform .1s; }
  .controls button:hover { background: rgba(255,255,255,.16); }
  .controls button:active { transform: scale(.92); }
  .controls button.primary { width: 68px; height: 68px; background: #4f7cff; color: #fff; }
  .controls button.primary:hover { background: #3f66d8; }
  .controls svg { width: 26px; height: 26px; }
  .controls button.primary svg { width: 34px; height: 34px; }
  .vol { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #9aa5b5; }
  .vol svg { width: 18px; height: 18px; flex-shrink: 0; }
  .vol input { flex: 1; accent-color: #4f7cff; height: 26px; cursor: pointer; }
</style>
</head>
<body>
  <div class="bg" id="bg"></div>
  <div class="card">
    <div class="head">
      <div class="cover">
        <img id="cover" alt="">
        <span class="ph" id="coverPh">&#9834;</span>
      </div>
      <div class="meta">
        <div class="title" id="track">&mdash;</div>
        <div class="sub" id="meta">AIDJ built-in player</div>
        <span class="status stopped" id="status">&#8212;</span>
      </div>
    </div>

    <div class="rates" id="rates"></div>

    <section class="lyrics">
      <div class="lyric-scroll" id="scroll"></div>
      <div class="lyric-empty" id="empty">等待播放&#8230;</div>
    </section>

    <div class="foot">
      <div class="bar">
        <input id="seek" type="range" min="0" max="0" value="0">
        <div class="bar-time"><span id="pos">0:00</span><span id="len">0:00</span></div>
      </div>
      <div class="controls">
        <button id="btnPrev" title="上一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6L18 18V6z"/></svg></button>
        <button id="btnToggle" class="primary" title="播放/暂停"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
        <button id="btnNext" title="下一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>
      </div>
      <div class="vol">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02z"/></svg>
        <input id="vol" type="range" min="0" max="1" step="0.01" value="0.8">
        <span id="volv">80%</span>
      </div>
    </div>
  </div>
<script>
(function(){
  var seeking = false;
  var state = null;
  var rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
  var svgPause = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>';
  var svgPlay = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  function fmt(ms){ if(ms==null || ms<0) return '0:00'; var t=Math.round(ms/1000); return Math.floor(t/60)+':'+String(t%60).padStart(2,'0'); }

  // --- LRC parser (ported from LyricsView) ---
  function parseTimeTag(m){ var frac=Number(m[3]||'0'); return Number(m[1])*60000+Number(m[2])*1000+(frac<100?frac*10:frac); }
  function parseLyrics(lrc){
    var lines=[]; var offset=0;
    var rawLines=lrc.split('\\n');
    for(var i=0;i<rawLines.length;i++){
      var line=rawLines[i].trim(); if(!line) continue;
      var off=line.match(/\\[offset:([+-]?\\d+)\\]/);
      if(off){ offset=Number(off[1]); continue; }
      if(!line.match(/\\[\\d{1,2}:\\d{2}(?:[.:]\\d{1,3})?\\]/)) continue;
      var parts=line.split(/(\\[\\d{1,2}:\\d{2}(?:[.:]\\d{1,3})?\\])/g);
      var chunks=[]; var pendingTime=0; var pendingText='';
      for(var j=0;j<parts.length;j++){
        var mm=parts[j].match(/^\\[(\\d{1,2}):(\\d{2})(?:[.:](\\d{1,3}))?\\]$/);
        if(mm){ if(pendingText.trim()) chunks.push({text:pendingText.trim(),time:pendingTime+offset});
          pendingTime=parseTimeTag(mm); pendingText=''; }
        else pendingText+=parts[j];
      }
      if(pendingText.trim()) chunks.push({text:pendingText.trim(),time:pendingTime+offset});
      if(chunks.length) lines.push({time:chunks[0].time,text:chunks.map(function(c){return c.text}).join(''),chunks:chunks});
    }
    lines.sort(function(a,b){return a.time-b.time});
    return lines;
  }

  // --- smooth playback position (forward-only, ported from LyricsView) ---
  var smoothPos=0, lastRawAt=0, lastRawPos=0, playing=false, currentIdx=-1;
  var BACK_SEEK_MS=500;
  function anchorPosition(pos){
    var now=performance.now();
    if(pos==null){ lastRawPos=0; lastRawAt=0; smoothPos=0; return; }
    if(!lastRawAt){ lastRawPos=pos; lastRawAt=now; smoothPos=pos; return; }
    var delta=pos-lastRawPos;
    if(delta < -BACK_SEEK_MS){ lastRawPos=pos; lastRawAt=now; smoothPos=pos; return; }
    lastRawPos=pos; lastRawAt=now;
    if(pos>smoothPos) smoothPos=pos;
  }
  function smoothLoop(){
    if(playing && lastRawAt){ var p=lastRawPos+(performance.now()-lastRawAt); if(p>smoothPos) smoothPos=p; }
    else smoothPos=lastRawPos;
    updateLyrics();
    document.getElementById('pos').textContent=fmt(smoothPos);
    requestAnimationFrame(smoothLoop);
  }

  // --- lyrics DOM ---
  var lines=[], lineEls=[], lastLyricText='';
  function rebuildLyrics(){
    var lyric = (state && (state.karaokeLyric||state.lyric)) || '';
    var scrollEl=document.getElementById('scroll');
    var emptyEl=document.getElementById('empty');
    if(lyric!==lastLyricText){
      lastLyricText=lyric;
      lines = lyric ? parseLyrics(lyric) : [];
      lineEls=[];
      scrollEl.textContent='';
      for(var i=0;i<lines.length;i++){
        var d=document.createElement('div'); d.className='lyric-line';
        var k=document.createElement('span'); k.className='kr'; k.textContent=lines[i].text;
        d.appendChild(k); scrollEl.appendChild(d); lineEls.push(d);
      }
      repad();
    }
    if(!state || !state.track){ emptyEl.style.display='flex'; emptyEl.textContent='等待播放…'; }
    else if(!lines.length){ emptyEl.style.display='flex'; emptyEl.textContent='暂无歌词'; }
    else emptyEl.style.display='none';
  }
  function repad(){
    var scrollEl=document.getElementById('scroll');
    var h=scrollEl.clientHeight||window.innerHeight;
    var p=Math.max(60,Math.round(h/2));
    scrollEl.style.paddingTop=p+'px'; scrollEl.style.paddingBottom=p+'px';
  }
  function refreshLineClasses(){
    for(var j=0;j<lineEls.length;j++){
      lineEls[j].className = (j===currentIdx) ? 'lyric-line is-current' : 'lyric-line'+(playing?'':' is-dim');
    }
  }
  function updateLyrics(){
    if(!lines.length || !state || !state.track) return;
    var pos=smoothPos, idx=-1;
    for(var i=0;i<lines.length;i++){ if(lines[i].time<=pos) idx=i; else break; }
    var prev=currentIdx; currentIdx=idx;
    var scrollEl=document.getElementById('scroll'); var h=scrollEl.clientHeight;
    if(idx!==prev){
      if(prev>=0 && lineEls[prev]) lineEls[prev].className='lyric-line'+(playing?'':' is-dim');
      if(idx>=0 && lineEls[idx]) lineEls[idx].className='lyric-line is-current';
    } else if(idx<0) return;
    if(idx>=0){
      var line=lines[idx], el=lineEls[idx];
      var end = line.chunks.length>1 ? line.chunks[line.chunks.length-1].time
        : (idx+1<lines.length ? lines[idx+1].time : ((state&&state.lengthMs)||line.time+5000));
      var span=Math.max(1,end-line.time);
      var pct=Math.min(100,Math.max(0,((pos-line.time)/span)*100));
      el.style.setProperty('--kfill',pct.toFixed(2)+'%');
      var top=Math.max(0, el.offsetTop - h/2 + el.offsetHeight/2);
      if(Math.abs(scrollEl.scrollTop-top)>2) scrollEl.scrollTop=top;
    }
  }

  // --- state + header ---
  function applyState(s){
    document.getElementById('track').textContent = s.track||'—';
    document.getElementById('meta').textContent = (s.artist||'')+(s.album?' · '+s.album:'');
    var st=document.getElementById('status');
    var map={Playing:'播放中',Paused:'已暂停',Stopped:'已停止',Unknown:'未知'};
    st.textContent = map[s.status]||s.status||'—';
    st.className='status '+(s.status==='Playing'?'playing':s.status==='Paused'?'paused':'stopped');
    var cover=document.getElementById('cover');
    var ph=document.getElementById('coverPh');
    var bg=document.getElementById('bg');
    if(s.cover){ cover.style.display='block'; cover.src=s.cover; ph.style.display='none';
      bg.style.backgroundImage="url('"+s.cover+"')"; }
    else { cover.style.display='none'; ph.style.display='flex'; bg.style.backgroundImage=''; }
    var len=s.lengthMs||0;
    var seek=document.getElementById('seek'); seek.max=len;
    if(!seeking) seek.value=Math.min(s.positionMs||0,len);
    document.getElementById('len').textContent=fmt(len);
    if(s.volume!=null){ document.getElementById('vol').value=s.volume;
      document.getElementById('volv').textContent=Math.round(s.volume*100)+'%'; }
    var rate=s.playbackRate||1;
    var rb=document.querySelectorAll('#rates button[data-rate]');
    for(var i=0;i<rb.length;i++){
      rb[i].className = Math.abs(rate-Number(rb[i].dataset.rate))<0.001 ? 'on' : '';
    }
    document.getElementById('btnToggle').innerHTML = (s.status==='Playing') ? svgPause : svgPlay;
  }

  async function poll(){
    try{
      var r=await fetch('/state'); var s=await r.json();
      if(!s || s.ok!==true){ state=null; return; }
      var trackChanged = !state || state.track!==s.track;
      var wasPlaying=playing;
      state=s; playing=(s.status==='Playing');
      if(trackChanged){ currentIdx=-1; lastLyricText=''; }
      if(trackChanged || playing!==wasPlaying) refreshLineClasses();
      rebuildLyrics();
      applyState(s);
      anchorPosition(s.positionMs);
      updateLyrics();
    }catch(e){ /* server restarting */ }
  }

  function send(action,value){
    fetch('/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,value:value})});
  }

  // --- init ---
  var ratesEl=document.getElementById('rates');
  for(var i=0;i<rates.length;i++){
    (function(r){
      var b=document.createElement('button'); b.dataset.rate=String(r); b.textContent=r+'x';
      b.onclick=function(){ send('rate',r); };
      ratesEl.appendChild(b);
    })(rates[i]);
  }
  var custom=document.createElement('input');
  custom.type='number'; custom.min='0.1'; custom.step='0.1'; custom.placeholder='自定义';
  custom.onchange=function(){ var v=parseFloat(custom.value); if(v>0) send('rate',v); };
  ratesEl.appendChild(custom);

  document.getElementById('btnPrev').onclick=function(){ send('prev'); };
  document.getElementById('btnNext').onclick=function(){ send('next'); };
  document.getElementById('btnToggle').onclick=function(){ send('toggle'); };
  var seek=document.getElementById('seek');
  seek.addEventListener('input',function(){ seeking=true; });
  seek.addEventListener('change',function(){ seeking=false; send('seek',Number(seek.value)); });
  var vol=document.getElementById('vol');
  vol.addEventListener('input',function(){ document.getElementById('volv').textContent=Math.round(vol.value*100)+'%'; });
  vol.addEventListener('change',function(){ send('volume',Number(vol.value)); });
  window.addEventListener('resize',function(){ repad(); rebuildLyrics(); updateLyrics(); });

  setInterval(poll,500); poll();
  requestAnimationFrame(smoothLoop);
})();
</script>
</body>
</html>`
