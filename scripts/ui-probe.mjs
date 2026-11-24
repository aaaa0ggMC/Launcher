#!/usr/bin/env node
/**
 * ui-probe.mjs —— UI 自驱验证回路（CDP 零依赖探针）。
 *
 * 为什么存在：截断揭示这类 bug 不能靠读代码猜——「胶囊被祖先裁、sw==cw、title=null、
 * 点按没反应」每一条都要真实 DOM 度量才能钉死。这个探针把「启动 Chrome → 进设置 →
 * UI 库画廊 → 量 DOM → 点按 → 判定 → 截图」整条回路固化成一条命令，谁跑都一样。
 *
 * 零新依赖：只用 Node 内置（node:child_process / node:fs / node:util）+ Node 26 全局
 * WebSocket 裸连 Chrome DevTools Protocol。不装 playwright / puppeteer（根 package.json
 * 只允许框架依赖）。
 *
 * 用法：
 *   node scripts/ui-probe.mjs --assert-truncation        # 门禁：四档全量实测，退出码 0/1
 *   node scripts/ui-probe.mjs --widths 320               # 只跑一档（调查模式）
 *   node scripts/ui-probe.mjs --dump ".kit-chip" --widths 480,320
 *   node scripts/ui-probe.mjs --shots out/probe --json out/probe/report.json
 *
 * 参数：
 *   --url <url>          被测站点（默认 http://127.0.0.1:4444/，launcher-headless.service）
 *                        没带 token 时自动读 ~/.config/LinuxCockpit/headless-token 拼上
 *   --widths <列表>      视口宽度档，默认 480,320,232,390（480/320/232 三档 + 390 手机档）
 *   --stage-widths <列表>  画廊宽度模拟器（KitWidthStage）档，如 390,340,240——
 *                        行内容（胶囊等）要靠模拟器压窄才现形；固定在宽视口下逐档跑
 *   --height <px>        视口高度，默认 820
 *   --dump <选择器>      逗号分隔，额外 dump 这些选择器的度量
 *   --assert-truncation  门禁模式：真截断必有揭示入口（title + 点按浮层），否则退出码 1
 *   --allow-build-mismatch  构建号与「最后触碰 src/ 的 commit」不一致时只警告不判失败
 *   --shots <目录>       截图目录（默认 out/probe；--no-shots 关闭）
 *   --json <文件>        把机器可读报告写到文件
 *   --keep-chrome        结束后不关 Chrome（本地调试用）
 *   --chrome <路径>      Chrome 可执行文件（默认 google-chrome / google-chrome-stable）
 *
 * 度量口径（与 useTruncatable.ts 的判定同口径，两边不一致就是 bug）：
 *   selfTrunc = scrollWidth > clientWidth + 1（自己这个盒子在裁）
 *   ancTrunc  = 右缘 > 祖先链第一个 overflow 非 visible 盒子的 padding 右缘 + 1（被祖先裁）
 *   trulyTruncated = selfTrunc || ancTrunc
 *   揭示入口 = 自己 / 祖先 / 后代里有「armed」的 .kit-truncated（挂了 title 或 role=button）
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:4444/' },
    widths: { type: 'string', default: '480,320,232,390' },
    'stage-widths': { type: 'string', default: '' },
    height: { type: 'string', default: '820' },
    dump: { type: 'string', default: '' },
    'assert-truncation': { type: 'boolean', default: false },
    'allow-build-mismatch': { type: 'boolean', default: false },
    shots: { type: 'string', default: 'out/probe' },
    'no-shots': { type: 'boolean', default: false },
    json: { type: 'string', default: '' },
    'keep-chrome': { type: 'boolean', default: false },
    chrome: { type: 'string', default: '' }
  }
})

const WIDTHS = opts.widths
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const STAGE_WIDTHS = opts['stage-widths']
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const HEIGHT = Number(opts.height) || 820
const ASSERT = opts['assert-truncation']
const SHOTS_DIR = opts['no-shots'] ? null : resolve(opts.shots)
const ROOT_SEL = '.settings-content'

const log = (...a) => console.log('[probe]', ...a)
const fail = (...a) => console.error('[probe][FAIL]', ...a)

// ─────────────────────────────────────────────────────────────────────────────
// 起 headless Chrome，从 stderr 抓 CDP WebSocket 端点
// ─────────────────────────────────────────────────────────────────────────────

function chromeBin() {
  if (opts.chrome) return opts.chrome
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' })
      return bin
    } catch {
      /* try next */
    }
  }
  throw new Error('找不到 Chrome（google-chrome / chromium）；用 --chrome 指定')
}

function launchChrome() {
  const userData = mkdtempSync(join(tmpdir(), 'ui-probe-chrome-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=0',
    `--user-data-dir=${userData}`,
    'about:blank'
  ]
  const child = spawn(chromeBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
  return new Promise((res, rej) => {
    let buf = ''
    const timer = setTimeout(() => rej(new Error('Chrome 10s 内没吐出 DevTools 端点')), 10000)
    child.stderr.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) {
        clearTimeout(timer)
        res({ child, userData, wsUrl: m[1] })
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rej(new Error(`Chrome 提前退出 code=${code}\n${buf}`))
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 最小 CDP 客户端（裸 WebSocket：发 {id,method,params} 等 {id,result}）
// ─────────────────────────────────────────────────────────────────────────────

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
  }

  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.wsUrl)
      this.ws.addEventListener('open', () => res())
      this.ws.addEventListener('error', (e) => rej(new Error(`CDP WebSocket 错误: ${e.message ?? e}`)))
      this.ws.addEventListener('message', (ev) => {
        let msg
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        } catch {
          return
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { res: r, rej: j } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) j(new Error(`CDP ${msg.error.message ?? JSON.stringify(msg.error)}`))
          else r(msg.result ?? {})
        }
      })
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(`CDP ${method} 超时 15s`))
        }
      }, 15000)
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 页面内 JS（度量内核与 useTruncatable 同口径，两边不一致就是产品 bug）
// ─────────────────────────────────────────────────────────────────────────────

/** 单个元素的完整度量（含祖先裁剪链与揭示入口） */
const MEASURE_FN = `function measure(el) {
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  // 祖先链上第一个会裁的盒子。CSS overflow 裁剪发生在 **padding 边缘**（不是内容边缘）：
  // 内容铺进 padding 区不会被切，用内容右缘会大量误判「被祖先裁」（232 档实测踩过）。
  let p = el.parentElement
  let clipRight = null
  let clipper = null
  while (p && p !== document.body && p !== document.documentElement) {
    const pcs = getComputedStyle(p)
    if (pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') {
      const pr = p.getBoundingClientRect()
      const border = Number.parseFloat(pcs.borderRightWidth || '0') || 0
      clipRight = pr.right - border
      const cls = typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''
      clipper = p.tagName.toLowerCase() + cls
      break
    }
    p = p.parentElement
  }
  const armed = (n) =>
    !!n && (n.hasAttribute('title') || n.getAttribute('role') === 'button' || n.hasAttribute('tabindex'))
  const revealOwner = el.classList.contains('kit-truncated')
    ? el
    : el.closest('.kit-truncated') ||
      (armed(el) ? el : null) ||
      el.querySelector('.kit-truncated')
  const selfTrunc = el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1
  const ancTrunc = clipRight !== null && r.right > clipRight + 1
  return {
    tag: el.tagName.toLowerCase(),
    cls: typeof el.className === 'string' ? el.className : '',
    text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
    ow: el.offsetWidth,
    cw: el.clientWidth,
    sw: el.scrollWidth,
    right: Math.round(r.right * 10) / 10,
    clipRight: clipRight === null ? null : Math.round(clipRight * 10) / 10,
    clipper,
    selfTrunc,
    ancTrunc,
    trulyTruncated: selfTrunc || ancTrunc,
    textOverflow: cs.textOverflow,
    whiteSpace: cs.whiteSpace,
    overflowX: cs.overflowX,
    minWidth: cs.minWidth,
    maxWidth: cs.maxWidth,
    title: el.getAttribute('title'),
    role: el.getAttribute('role'),
    tabindex: el.getAttribute('tabindex'),
    isKitTruncated: el.classList.contains('kit-truncated'),
    cutClass: el.classList.contains('kit-truncated--cut'),
    reveal: revealOwner
      ? {
          cls: typeof revealOwner.className === 'string' ? revealOwner.className : '',
          title: revealOwner.getAttribute('title'),
          role: revealOwner.getAttribute('role'),
          tabindex: revealOwner.getAttribute('tabindex'),
          armed: armed(revealOwner)
        }
      : null,
    kitOwned: !!el.closest('[class*="kit-"]'),
    hasText: (el.textContent || '').trim().length > 0
  }
}`

/** 扫描：画廊里所有「ellipsis 元素 / .kit-truncated / 真截断元素」 */
function scanExpr(rootSel) {
  return `(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)}) || document.body
    const seen = new Set()
    const els = []
    const push = (el) => { if (el && !seen.has(el)) { seen.add(el); els.push(el) } }
    root.querySelectorAll('.kit-truncated').forEach(push)
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.textOverflow === 'ellipsis') push(el)
    }
    // 祖先裁剪受害者：可能自己没有 ellipsis 样式（如胶囊根被行边切掉）
    for (const el of root.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      let p = el.parentElement
      while (p && p !== root && p !== document.body && p !== document.documentElement) {
        const pcs = getComputedStyle(p)
        if (pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') {
          const pr = p.getBoundingClientRect()
          const border = Number.parseFloat(pcs.borderRightWidth || '0') || 0
          const clipRight = pr.right - border
          if (r.right > clipRight + 1) push(el)
          break
        }
        p = p.parentElement
      }
    }
    const measure = ${MEASURE_FN}
    return { count: els.length, items: els.map(measure) }
  })()`
}

/** 全文 / title 等少量定点读取 */
function pickExpr(sel) {
  return `(() => {
    const measure = ${MEASURE_FN}
    return [...document.querySelectorAll(${JSON.stringify(sel)})].map(measure)
  })()`
}

/** 按文本找元素的解析式（返回元素本身，只嵌在 clickElemExpr 里用） */
function elemByTextExpr(text) {
  return `(() => {
    const t = ${JSON.stringify(text)}
    const cands = [...document.querySelectorAll('.v-list-item, button, a, [role="button"], [tabindex]')]
      .filter((e) => e.getClientRects().length > 0 && (e.textContent || '').includes(t))
    if (!cands.length) return null
    // 文本最短的那个 = 最贴近目标的复合项（避免匹配到整段描述）
    cands.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)
    return cands[0]
  })()`
}

/**
 * 元素滚动进视野后返回可点击点（含命中测试，避免点到遮挡物上）。
 * resolverExpr 求值后返回目标元素。
 */
function clickElemExpr(resolverExpr) {
  return `(() => {
    const el = (${resolverExpr})
    if (!el) return { error: 'not-found' }
    el.scrollIntoView({ block: 'center', inline: 'nearest' })
    const r = el.getBoundingClientRect()
    const pts = []
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2
    pts.push([cx, cy])
    for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.3, 0.5, 0.7]) pts.push([r.left + r.width * fx, r.top + r.height * fy])
    for (const [x, y] of pts) {
      const hit = document.elementFromPoint(x, y)
      if (hit && (el.contains(hit) || hit.contains(el))) {
        return { x: Math.round(x), y: Math.round(y), hit: hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\\s+/)[0] : '') }
      }
    }
    return { error: 'obstructed', rect: { left: r.left, top: r.top, w: r.width, h: r.height } }
  })()`
}

/** 按选择器找元素的点击点 */
function clickPointExpr(sel) {
  return clickElemExpr(`document.querySelector(${JSON.stringify(sel)})`)
}

/** 当前可见的揭示浮层（KitTruncated 的点按浮层，v-show 控制 display） */
const TIP_EXPR = `(() => {
  return [...document.querySelectorAll('.kit-truncate-tip')]
    .filter((el) => {
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden'
    })
    .map((el) => (el.textContent || '').trim())
})()`

const READY_EXPR = `(() => {
  const root = document.querySelector('.settings-view')
  const stamp = document.querySelector('.kit-build-stamp')
  return {
    readyAttr: document.querySelector('[data-ability-ready]')?.getAttribute('data-ability-ready') ?? '',
    settingsView: !!root,
    buildStamp: stamp ? (stamp.textContent || '').trim() : null,
    demoCards: document.querySelectorAll('.kit-demo').length
  }
})()`

// ─────────────────────────────────────────────────────────────────────────────
// 驱动层：导航 / 视口 / 点击 / 截图
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Probe {
  constructor(cdp, sessionId) {
    this.cdp = cdp
    this.sessionId = sessionId
  }

  async eval(expr) {
    const r = await this.cdp.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      this.sessionId
    )
    if (r.exceptionDetails) {
      throw new Error(`页面内异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result?.value
  }

  async setViewport(w, h) {
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: false },
      this.sessionId
    )
    // 让 RO / resize / Vue 更新跑几拍（产品自身的重判也在这几拍里完成）
    await sleep(60)
    await this.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await sleep(320)
  }

  async goto(url) {
    await this.cdp.send('Page.navigate', { url }, this.sessionId)
    for (let i = 0; i < 100; i++) {
      await sleep(150)
      const st = await this.eval('document.readyState').catch(() => null)
      if (st === 'complete') return
    }
    throw new Error('页面 15s 内没加载完')
  }

  async waitReady(predExpr, what, timeoutMs = 15000) {
    const t0 = Date.now()
    for (;;) {
      const v = await this.eval(predExpr).catch(() => null)
      if (v) return v
      if (Date.now() - t0 > timeoutMs) throw new Error(`等「${what}」超时 ${timeoutMs}ms`)
      await sleep(200)
    }
  }

  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base }, this.sessionId)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, this.sessionId)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, this.sessionId)
    await sleep(80)
  }

  /** 按选择器点击（滚动进视野 + 命中测试） */
  async clickSel(sel) {
    return this.clickWithRetry(clickPointExpr(sel), sel)
  }

  /** 命中测试点击；点不中 / 元素没出现就重试几次（导航点击用） */
  async clickWithRetry(expr, what, tries = 4) {
    let last = null
    let lastErr = null
    for (let i = 0; i < tries; i++) {
      const pt = await this.eval(expr).catch((e) => {
        lastErr = String(e.message ?? e)
        return null
      })
      last = pt
      if (pt && pt.x) {
        log(`点击「${what}」`, pt.x, pt.y, pt.hit ? `(命中 ${pt.hit})` : '')
        await this.clickAt(pt.x, pt.y)
        return pt
      }
      await sleep(300)
    }
    throw new Error(`点不到「${what}」：${JSON.stringify(last)}${lastErr ? ` | 异常: ${lastErr}` : ''}`)
  }

  async keyEscape() {
    const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sessionId)
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId)
    await sleep(80)
  }

  /** 单键按下抬起（方向键驱动宽度模拟器手柄用） */
  async keyPress(key, code, vk) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sessionId)
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId)
    await sleep(30)
  }

  /**
   * 把 KitWidthStage（画廊宽度模拟器）的盒子设到目标宽度。
   * 手柄支持键盘（Home=最小、→/←=±8），比拖拽坐标稳定：先聚焦手柄 →
   * Home 归到 240 → 步进到目标。多实例时只驱动第一个（画廊当前只有一个）。
   */
  async setStageWidth(target) {
    const focused = await this.eval(
      `(() => {
        const h = document.querySelector('.kit-stage__handle')
        if (!h) return false
        h.focus()
        h.scrollIntoView({ block: 'center', inline: 'nearest' })
        return document.activeElement === h
      })()`
    )
    if (!focused) throw new Error('找不到 .kit-stage__handle（画廊宽度模拟器）或聚焦失败')
    await this.keyPress('Home', 'Home', 36)
    const min = 240
    const steps = Math.max(0, Math.round((target - min) / 8))
    for (let i = 0; i < steps; i++) await this.keyPress('ArrowRight', 'ArrowRight', 39)
    await sleep(200)
    await this.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await sleep(150)
    return this.eval(
      `(() => {
        const box = document.querySelector('.kit-stage__box')
        const num = document.querySelector('.kit-stage__num')
        return { box: box ? box.getBoundingClientRect().width : null, label: num ? (num.textContent || '').trim() : null }
      })()`
    )
  }

  async screenshot(file) {
    if (!SHOTS_DIR) return null
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }

  async tips() {
    return this.eval(TIP_EXPR)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

/** 构建号核对：页面 KitBuildStamp 显示的 git 短 hash 应 == 正在测的 commit */
/**
 * 构建号核对基准 = 最后一个改动 `src/` 的 commit（不是裸 HEAD）。
 * 页面 KitBuildStamp 显示的是**构建时**的 git 短 hash；只改 scripts/、docs/ 的 commit
 * 不影响 UI 产物，拿裸 HEAD 比会误报「测的不是这套代码」（main 实测踩过）。
 * 用「最后触碰 src/ 的 commit」比：相等 ⇒ 页面 UI 就是当前这套源码构建出来的。
 */
function expectedBuild() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%h', '--', 'src'], {
      cwd: import.meta.dirname
    })
      .toString()
      .trim()
  } catch {
    return null
  }
}

/** 给 URL 补 token（无头宿主的 API 要 token；静态页本身免） */
function withToken(url) {
  if (/token=/.test(url)) return url
  const tokenFile = join(process.env.HOME ?? '', '.config/LinuxCockpit/headless-token')
  if (!existsSync(tokenFile)) return url
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (!token) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}

function fmtRow(m) {
  const reveal = m.reveal ? (m.reveal.armed ? 'armed' : 'plain') : '—'
  const tap = m.reveal && m.reveal.armed ? (m.title === null && m.reveal.title === null ? 'title缺' : 'ok') : '—'
  return {
    元素: (m.cls || m.tag).split(/\s+/).slice(0, 2).join('.'),
    文本: m.text.slice(0, 18),
    sw: m.sw,
    cw: m.cw,
    自裁: m.selfTrunc ? 'Y' : '',
    祖裁: m.ancTrunc ? 'Y' : '',
    clipper: m.clipper ?? '—',
    title: m.title !== null || (m.reveal && m.reveal.title !== null) ? 'Y' : '—',
    揭示: reveal,
    点按: tap
  }
}

async function main() {
  log('目标站点:', opts.url)
  const url = withToken(opts.url)
  const expect = expectedBuild()
  const report = {
    url: opts.url,
    widths: WIDTHS,
    expectBuild: expect,
    stamp: null,
    stampMatch: null,
    perWidth: {},
    demoLabelPresence: {},
    gate: { failures: [], truncatedSamples: 0, revealClicks: 0 }
  }

  const { child, userData, wsUrl } = await launchChrome()
  log('Chrome CDP:', wsUrl)
  const cdp = new Cdp(wsUrl)
  let probe
  try {
    await cdp.connect()
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    probe = new Probe(cdp, sessionId)

    // 导航阶段用宽视口（设置页宽模式有分类导航，点得准）
    await probe.setViewport(960, HEIGHT)
    await probe.goto(url)
    await probe.waitReady(
      `document.querySelector('[data-ability-ready]')?.getAttribute('data-ability-ready') ? true : null`,
      'App 就绪'
    )

    // 设置 → UI 库分类。侧栏条目有稳定的 data-ability-id（App.vue 注入），
    // 优先用它；文本匹配只当兜底（rail 折叠态没有文字，只有 aria-label）。
    // 点击一律走命中测试（elementFromPoint），点不中就换采样点 / 重试——
    // 侧栏 rail 很长，条目中心可能被页脚按钮盖住，盲点坐标会点错东西。
    await probe.clickWithRetry(
      clickElemExpr(
        `document.querySelector('[data-ability-id="settings"]') || ${elemByTextExpr('设置')}`
      ),
      '侧栏「设置」'
    )
    await probe.waitReady(
      `document.querySelector('[data-ability-ready]')?.getAttribute('data-ability-ready') === 'settings' ? true : null`,
      '设置页就绪'
    )
    await probe.clickWithRetry(clickElemExpr(elemByTextExpr('UI 库')), '分类「UI 库」')
    await probe.waitReady(
      `document.querySelectorAll('.kit-demo').length > 0 ? true : null`,
      'UI 库画廊渲染'
    )

    const ready = await probe.eval(READY_EXPR)
    report.stamp = ready.buildStamp
    const stampHash = ready.buildStamp ? ready.buildStamp.replace(/^构建\s*/, '').trim() : null
    report.stampMatch = !expect || !stampHash ? null : stampHash === expect
    log('KitBuildStamp:', ready.buildStamp, '| src 基准:', expect, '| 一致:', report.stampMatch)
    if (ASSERT && report.stampMatch === false && !opts['allow-build-mismatch']) {
      report.gate.failures.push(
        `构建号不一致：页面是「${stampHash}」，正在测的 commit 是「${expect}」——测的不是这套代码`
      )
    }

    // ── 多档实测：视口四档 + 画廊宽度模拟器档（胶囊这类行内容要靠模拟器压窄才现形）──
    const phases = [
      ...WIDTHS.map((w) => ({ kind: 'viewport', w })),
      ...STAGE_WIDTHS.map((w) => ({ kind: 'stage', w }))
    ]
    for (const ph of phases) {
      const w = ph.w
      const tag = ph.kind === 'viewport' ? `vw${w}` : `stage${w}`
      const wlabel = ph.kind === 'viewport' ? `视口 ${w}` : `模拟器 ${w}`
      log(`── ${wlabel} ──`)
      if (ph.kind === 'viewport') {
        await probe.setViewport(w, HEIGHT)
      } else {
        // 模拟器档固定宽视口（盒子宽度由模拟器定，视口只要放得下）
        await probe.setViewport(Math.max(560, w + 96), HEIGHT)
        const got = await probe.setStageWidth(w)
        log('模拟器盒子宽度', got)
      }
      const state = await probe.eval(READY_EXPR)
      if (state.demoCards === 0) {
        report.gate.failures.push(`${wlabel}: 画廊不可见（.kit-demo=0），无法实测`)
        continue
      }
      if (SHOTS_DIR) {
        const f = await probe.screenshot(join(SHOTS_DIR, `${tag}-gallery.png`))
        log('截图', f)
      }

      const scan = await probe.eval(scanExpr(ROOT_SEL))
      const extra = {}
      for (const sel of opts.dump.split(',').map((s) => s.trim()).filter(Boolean)) {
        extra[sel] = await probe.eval(pickExpr(sel))
      }
      // 消歧检查：.kit-demo-label 是「死 slot 还是活截断点」只能看真实 DOM
      const demoLabel = await probe.eval(pickExpr('.kit-demo-label'))
      report.demoLabelPresence[tag] = demoLabel.length

      const rows = scan.items.map(fmtRow)
      console.table(rows)
      if (Object.keys(extra).length) {
        for (const [sel, items] of Object.entries(extra)) {
          console.log(`额外 dump ${sel}:`)
          console.table(items.map(fmtRow))
        }
      }
      report.perWidth[tag] = { scan, extra, demoLabelCount: demoLabel.length }

      // ── 点按揭示实测：真截断 + 有揭示入口的元素逐个点 ──────────────────────
      const clickTargets = scan.items.filter(
        (m) => m.trulyTruncated && m.hasText && m.reveal && m.reveal.armed
      )
      let shotTaken = false
      for (const m of clickTargets) {
        const sel = m.isKitTruncated
          ? `.kit-truncated--cut`
          : null
        // 优先点揭示件自身；否则点该元素
        const targetSel = sel
        let clicked
        if (targetSel) {
          // 同一页可能多个 .kit-truncated--cut，按文本精确定位
          clicked = await probe.eval(`(() => {
            const measure = ${MEASURE_FN}
            const cands = [...document.querySelectorAll('.kit-truncated--cut')].filter(
              (e) => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) === ${JSON.stringify(m.text)}
            )
            if (!cands.length) return null
            const el = cands[0]
            el.scrollIntoView({ block: 'center', inline: 'nearest' })
            const r = el.getBoundingClientRect()
            return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) }
          })()`)
          if (clicked) await probe.clickAt(clicked.x, clicked.y)
        }
        if (!clicked) {
          // 兜底：按文本找任何 armed .kit-truncated
          clicked = await probe.eval(`(() => {
            const cands = [...document.querySelectorAll('.kit-truncated[title], .kit-truncated[role="button"]')].filter(
              (e) => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) === ${JSON.stringify(m.text)}
            )
            if (!cands.length) return { error: 'no-armed-match' }
            const el = cands[0]
            el.scrollIntoView({ block: 'center', inline: 'nearest' })
            const r = el.getBoundingClientRect()
            return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) }
          })()`)
          if (clicked && clicked.x) await probe.clickAt(clicked.x, clicked.y)
        }

        // 浮层是否弹出 + 全文是否正确
        let tips = []
        for (let i = 0; i < 8 && tips.length === 0; i++) {
          await sleep(120)
          tips = await probe.tips()
        }
        const full = m.reveal.title ?? m.text
        const ok = tips.some((t) => t && (t === full || full.includes(t) || t.includes(m.text.slice(0, 10))))
        m.tapTest = { clicked: !!(clicked && clicked.x), tips, ok }
        if (m.isKitTruncated && !shotTaken && SHOTS_DIR && tips.length) {
          const f = await probe.screenshot(join(SHOTS_DIR, `${tag}-reveal.png`))
          log('揭示态截图', f)
          shotTaken = true
        }
        report.gate.revealClicks++
        if (!ok) {
          report.gate.failures.push(
            `${wlabel}: 点按「${m.text}」没弹出全文浮层（tips=${JSON.stringify(tips)}，clicked=${JSON.stringify(clicked)}）`
          )
        }
        await probe.keyEscape()
        await sleep(100)
      }

      // ── 门禁规则：真截断必有揭示入口 ──────────────────────────────────────
      if (ASSERT) {
        for (const m of scan.items) {
          const inScope =
            m.trulyTruncated && m.hasText && m.kitOwned && m.textOverflow === 'ellipsis'
          if (!inScope) continue
          report.gate.truncatedSamples++
          if (!(m.reveal && m.reveal.armed)) {
            report.gate.failures.push(
              `${wlabel}: 真截断无揭示入口 — ${m.tag}.${(m.cls || '').split(/\s+/)[0]}「${m.text}」` +
                ` sw=${m.sw} cw=${m.cw} 自裁=${m.selfTrunc} 祖裁=${m.ancTrunc} clipper=${m.clipper}`
            )
          }
        }
        if (report.demoLabelPresence[tag] > 0) {
          const dl = await probe.eval(pickExpr('.kit-demo-label'))
          for (const m of dl) {
            if (m.trulyTruncated && !(m.reveal && m.reveal.armed)) {
              report.gate.failures.push(
                `${wlabel}: .kit-demo-label 在 DOM 里且真截断无揭示（判 B：活截断点）—「${m.text}」`
              )
            }
          }
        }
      }
    }

    // ── 门禁汇总 ──────────────────────────────────────────────────────────
    if (ASSERT) {
      if (report.gate.truncatedSamples === 0) {
        report.gate.failures.push('门禁无效：各档里没找到任何真截断样本（无法证明揭示机制被测到）')
      }
    }
  } finally {
    if (opts['keep-chrome']) {
      log('keep-chrome：Chrome 保留运行（临时目录', userData, '）')
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        /* noop */
      }
      cdp.close()
      await sleep(200)
      try {
        rmSync(userData, { recursive: true, force: true })
      } catch {
        /* noop */
      }
    }
  }

  // ── 报告 ────────────────────────────────────────────────────────────────
  console.log('\n════════════ 报告 ════════════')
  console.log('构建号：页面', report.stamp, '| HEAD', report.expectBuild, '| 一致:', report.stampMatch)
  for (const [tag, pw] of Object.entries(report.perWidth)) {
    if (!pw) continue
    console.log(
      `${tag}: 扫描 ${pw.scan.count} 个候选，.kit-demo-label 出现 ${pw.demoLabelCount} 次`
    )
  }
  if (opts.json) {
    mkdirSync(dirname(resolve(opts.json)), { recursive: true })
    writeFileSync(resolve(opts.json), JSON.stringify(report, null, 2))
    console.log('JSON 报告:', opts.json)
  }

  if (ASSERT) {
    if (report.gate.failures.length) {
      console.error(`\n✗ 门禁失败 ${report.gate.failures.length} 条（真截断样本 ${report.gate.truncatedSamples}，点按实测 ${report.gate.revealClicks} 次）：`)
      for (const f of report.gate.failures) console.error('  ·', f)
      process.exitCode = 1
    } else {
      console.log(
        `\n✓ 门禁通过：${report.gate.truncatedSamples} 个真截断样本全部有揭示入口，${report.gate.revealClicks} 次点按全部弹出全文`
      )
    }
  }
}

main().catch((e) => {
  fail(e.stack ?? String(e))
  process.exitCode = 1
})
