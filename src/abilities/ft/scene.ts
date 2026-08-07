import type { FtVector } from './types'
import type { FtChain, FtPoint } from './engine'
import { rotateVector } from './engine'

export type FtMode = '2d' | '3d'

export interface FtDisplayOptions {
  showCoords: boolean
  showCover: boolean
  showVectors: boolean
  showTrack: boolean
  showFinal: boolean
  neon: boolean
}

const DEFAULT_OPTIONS: FtDisplayOptions = {
  showCoords: true,
  showCover: false,
  showVectors: true,
  showTrack: true,
  showFinal: true,
  neon: false
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180
}

const FOV = 45
const NEAR = 0.5
const WORLD_UP = { x: 0, y: 1, z: 0 }

interface Vec3 {
  x: number
  y: number
  z: number
}

/** Point in camera space; z = depth along the view direction (positive in front). */
interface CamPoint {
  x: number
  y: number
  z: number
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  if (len === 0) return { x: 0, y: 0, z: 0 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/**
 * Canvas palette — theme-driven. The scene draws with these colors; the host
 * (`View.vue`) reads the active color scheme's CSS variables (`--v-theme-*`)
 * and pushes them here via `setPalette`, so the FT drawing follows whichever
 * scheme is active instead of hardcoding its own hex.
 */
export interface FtPalette {
  axisX: string
  axisY: string
  axisZ: string
  gridMinor: string
  gridCenter: string
  cover: string
  arm: string
  track: string
  final: string
  tip: string
}

/** Fallback palette (the historical hardcoded dark-toned values). */
const DEFAULT_PALETTE: FtPalette = {
  axisX: '#ff5c5c',
  axisY: '#5cff5c',
  axisZ: '#6b99ff',
  gridMinor: '#1c242f',
  gridCenter: '#2c3640',
  cover: '#8b97a5',
  arm: '#ffe066',
  track: '#ffffff',
  final: '#9adcff',
  tip: '#4cc4d6'
}

/**
 * Build an FtPalette from the active Vuetify scheme colors (hex values as
 * exposed by `theme.global.current.value.colors`). The scheme only provides
 * GENERIC tokens (the `accent-N` family + semantic/neutral ramps) — the
 * ability decides which role maps to which token, never the other way round.
 */
export function paletteFromTheme(colors: Record<string, string>): FtPalette {
  const pick = (token: string, fallback: string): string => colors[token] || fallback
  return {
    axisX: pick('accent-1', DEFAULT_PALETTE.axisX),
    axisY: pick('accent-2', DEFAULT_PALETTE.axisY),
    axisZ: pick('accent-3', DEFAULT_PALETTE.axisZ),
    gridMinor: pick('surface-variant', DEFAULT_PALETTE.gridMinor),
    gridCenter: pick('secondary-container', DEFAULT_PALETTE.gridCenter),
    cover: pick('on-surface-variant', DEFAULT_PALETTE.cover),
    arm: pick('accent-4', DEFAULT_PALETTE.arm),
    track: pick('on-surface', DEFAULT_PALETTE.track),
    final: pick('accent-5', DEFAULT_PALETTE.final),
    tip: pick('primary', DEFAULT_PALETTE.tip)
  }
}

/**
 * Max distance of the chain tip from origin over one full cycle — the true
 * visual extent of the figure. Framing + axis length are based on this (the
 * raw sum of vector magnitudes would overestimate complex presets and make
 * the axes look like they run to infinity).
 */
function computeChainReach(vectors: FtVector[]): number {
  if (vectors.length === 0) return 10
  let max = 0
  const N = 256
  for (let i = 0; i < N; i++) {
    const t = i / N
    let x = 0
    let y = 0
    let z = 0
    for (const v of vectors) {
      const r = rotateVector(v, t)
      x += r.x
      y += r.y
      z += r.z
    }
    max = Math.max(max, Math.hypot(x, y, z))
  }
  return Math.max(10, max)
}

/**
 * Sample the swept region of EVERY vector on its own — each vector alone, its
 * own pivot as origin, over one representative cycle of its two periods. The
 * regions are NOT accumulated; the renderer later translates each shape onto
 * the vector's current pivot. Returns one point set per vector.
 */
function computeCoverShapes(vectors: FtVector[]): Vec3[][] {
  if (vectors.length === 0) return []
  const perVector = Math.max(24, Math.min(256, Math.round(8192 / vectors.length)))
  return vectors.map((v) => {
    let maxPeriod = 1
    if (v.secperRound) maxPeriod = Math.max(maxPeriod, Math.abs(v.secperRound))
    if (v.secperRoundX) maxPeriod = Math.max(maxPeriod, Math.abs(v.secperRoundX))
    const window = Math.min(16, Math.max(1, maxPeriod))
    const shape: Vec3[] = []
    for (let i = 0; i < perVector; i++) {
      const r = rotateVector(v, (i / perVector) * window)
      shape.push({ x: r.x, y: r.y, z: r.z })
    }
    return shape
  })
}

/**
 * Canvas2D renderer for the epicycle scene. No WebGL: the geometry here is
 * only lines/circles/dots, so we draw them with a manual perspective
 * projection on a plain 2D canvas. This deliberately avoids the GPU entirely
 * — the previous three.js/WebGL implementation crashed the AMD iGPU driver
 * (radeonsi page-fault hang) on hybrid systems, taking the whole Wayland
 * session down with it.
 */
export class FtScene {
  private container: HTMLElement
  private canvasEl: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private disposed = false

  private dpr = 1
  private width = 1
  private height = 1

  options: FtDisplayOptions = { ...DEFAULT_OPTIONS }
  palette: FtPalette = { ...DEFAULT_PALETTE }

  // camera state
  private reach = 100
  private viewDistance = 500
  private orbitRadius = 700
  private azimuth = Math.PI / 4
  private elevation = 0.55
  private target: Vec3 = { x: 0, y: 0, z: 0 }
  private camera: Vec3 = { x: 0, y: 0, z: 0 }
  private mode: FtMode = '2d'
  private follow = false
  private currentTip: FtPoint | null = null

  // frame geometry
  private coverShapes: Vec3[][] = []
  private coverPoints: Vec3[] = []
  private armPoints: Vec3[] = []
  private finalPoints: Vec3[] = []
  private trackPoints: FtPoint[] = []
  private trackTime = 0
  private trackCap = 4096

  // per-frame camera basis
  private camRight: Vec3 = { x: 1, y: 0, z: 0 }
  private camUp: Vec3 = { x: 0, y: 1, z: 0 }
  private camForward: Vec3 = { x: 0, y: 0, z: -1 }
  private aspect = 1

  constructor(container: HTMLElement) {
    this.container = container
    this.canvasEl = document.createElement('canvas')
    this.canvasEl.style.display = 'block'
    const ctx = this.canvasEl.getContext('2d')
    if (!ctx) throw new Error('Canvas2D is unavailable')
    this.ctx = ctx
    container.appendChild(this.canvasEl)
    this.resize()
  }

  get canvas(): HTMLCanvasElement {
    return this.canvasEl
  }

  setOptions(patch: Partial<FtDisplayOptions>): void {
    this.options = { ...this.options, ...patch }
  }

  /** Replace the drawing palette (the host pushes the active scheme's colors). */
  setPalette(palette: Partial<FtPalette>): void {
    this.palette = { ...this.palette, ...palette }
  }

  /** Reset for a new vector set. */
  setVectors(vectors: FtVector[], verticesLimit?: number): void {
    this.reach = computeChainReach(vectors)
    this.viewDistance = this.defaultViewDistance()
    this.orbitRadius = this.viewDistance * 1.3
    this.target = { x: 0, y: 0, z: 0 }

    this.coverShapes = computeCoverShapes(vectors)
    const total = this.coverShapes.reduce((n, s) => n + s.length, 0)
    this.coverPoints = new Array(total)
    for (let i = 0; i < total; i++) this.coverPoints[i] = { x: 0, y: 0, z: 0 }
    this.armPoints = []
    this.finalPoints = []
    this.trackPoints = []
    this.trackCap = Math.max(500, verticesLimit ?? 500)

    this.updateCamera()
  }

  setVerticesLimit(limit: number): void {
    this.trackCap = Math.max(500, limit)
  }

  private defaultViewDistance(): number {
    return (this.reach * 1.9) / Math.tan(rad(FOV / 2))
  }

  setMode(mode: FtMode): void {
    this.mode = mode
    if (mode === '3d') {
      this.orbitRadius = this.viewDistance
      this.azimuth = Math.PI / 4
      this.elevation = 0.55
    } else {
      this.viewDistance = this.orbitRadius
    }
    this.updateCamera()
  }

  setFollow(on: boolean): void {
    this.follow = on
  }

  /** Frame the whole chain in view. */
  resetView(): void {
    this.target = { x: 0, y: 0, z: 0 }
    this.viewDistance = this.defaultViewDistance()
    this.orbitRadius = this.defaultViewDistance() * 1.3
    this.azimuth = Math.PI / 4
    this.elevation = 0.55
    this.updateCamera()
  }

  getMode(): FtMode {
    return this.mode
  }

  /** Normalized zoom factor relative to the default framing. */
  getZoom(): number {
    const base = this.defaultViewDistance()
    return this.mode === '3d' ? this.orbitRadius / (base * 1.3) : this.viewDistance / base
  }

  zoomBy(factor: number): void {
    if (this.mode === '3d') {
      this.orbitRadius = clamp(this.orbitRadius * factor, this.reach * 0.3, this.reach * 40)
    } else {
      this.viewDistance = clamp(this.viewDistance * factor, this.reach * 0.3, this.reach * 40)
    }
    this.updateCamera()
  }

  /**
   * Pan along the camera's view (screen) plane in world units — both 2D and 3D.
   * Positive dx/dy follows the cursor: content moves right/down with the drag.
   * In 3D the drag is mapped onto the camera's right/up axes, so the scene
   * moves exactly as if it were glued to the screen under the cursor.
   */
  panBy(dx: number, dy: number): void {
    if (this.follow) return
    this.updateBasis()
    const dist = this.mode === '3d' ? this.orbitRadius : this.viewDistance
    const units = (dist * Math.tan(rad(FOV / 2)) * 2) / (this.container.clientHeight || 1)
    this.target.x += this.camRight.x * -dx * units
    this.target.y += this.camRight.y * -dx * units
    this.target.z += this.camRight.z * -dx * units
    this.target.x += this.camUp.x * dy * units
    this.target.y += this.camUp.y * dy * units
    this.target.z += this.camUp.z * dy * units
    this.updateCamera()
  }

  /** 3D orbit drag in pixels — rotates the view direction (azimuth/elevation). */
  orbitBy(dx: number, dy: number): void {
    if (this.mode !== '3d') return
    const rate = this.orbitRate()
    this.azimuth -= dx * rate
    this.elevation = clamp(this.elevation - dy * rate, -1.45, 1.45)
    this.updateCamera()
  }

  /**
   * Orbit sensitivity. Calibrated to the viewport (a full-height drag sweeps
   * the vertical FOV) and scaled by the current zoom, so zooming in rotates
   * more slowly for precise inspection — the old fixed 0.006 rad/px felt far
   * too sensitive once zoomed in.
   */
  private orbitRate(): number {
    const base = rad(FOV) / (this.container.clientHeight || 1)
    return base * clamp(this.getZoom(), 0.3, 2.5)
  }

  resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const pw = Math.max(1, Math.round(w * this.dpr))
    const ph = Math.max(1, Math.round(h * this.dpr))
    if (this.canvasEl.width !== pw) this.canvasEl.width = pw
    if (this.canvasEl.height !== ph) this.canvasEl.height = ph
    this.canvasEl.style.width = `${w}px`
    this.canvasEl.style.height = `${h}px`
    this.width = w
    this.height = h
  }

  private updateCamera(): void {
    if (this.follow && this.currentTip) {
      this.target.x = this.currentTip.x
      this.target.y = this.currentTip.y
      this.target.z = this.currentTip.z
    }
    if (this.mode === '3d') {
      const r = this.orbitRadius
      const cp = Math.cos(this.elevation)
      this.camera.x = this.target.x + r * cp * Math.cos(this.azimuth)
      this.camera.y = this.target.y + r * Math.sin(this.elevation)
      this.camera.z = this.target.z + r * cp * Math.sin(this.azimuth)
    } else {
      this.camera.x = this.target.x
      this.camera.y = this.target.y
      this.camera.z = this.target.z + this.viewDistance
    }
  }

  /** Refresh all moving geometry from the latest simulation frame. */
  update(chain: FtChain): void {
    this.currentTip = chain.tip
    this.rebuildCover(chain)

    this.armPoints = [{ x: 0, y: 0, z: 0 }]
    for (const p of chain.pivots) this.armPoints.push(p)
    this.armPoints.push(chain.tip)

    this.finalPoints = [
      { x: 0, y: 0, z: 0 },
      { x: chain.tip.x, y: chain.tip.y, z: chain.tip.z }
    ]
  }

  /**
   * Place every vector's own swept region at that vector's CURRENT pivot
   * (`chain.pivots[i]`) — the pivot moves with the simulation, so the cover
   * follows the chain as it animates instead of being stuck at the origin.
   * Points are preallocated and mutated in place to avoid per-frame GC.
   */
  private rebuildCover(chain: FtChain): void {
    const shapes = this.coverShapes
    const pivots = chain.pivots
    const n = Math.min(shapes.length, pivots.length)
    let k = 0
    for (let i = 0; i < n; i++) {
      const p = pivots[i]
      const shape = shapes[i]
      for (const s of shape) {
        const pt = this.coverPoints[k++]
        pt.x = p.x + s.x
        pt.y = p.y + s.y
        pt.z = p.z + s.z
      }
    }
  }

  /** Stream track points (already capped by the engine). */
  updateTrack(track: FtPoint[], time: number): void {
    this.trackTime = time
    this.trackPoints = track
  }

  // ---------------------------------------------------------------------------
  // Projection
  // ---------------------------------------------------------------------------

  /** Look-at camera basis from the current position/target. */
  private updateBasis(): void {
    const fwd = normalize({
      x: this.target.x - this.camera.x,
      y: this.target.y - this.camera.y,
      z: this.target.z - this.camera.z
    })
    let right = cross(fwd, WORLD_UP)
    const rl = Math.hypot(right.x, right.y, right.z)
    if (rl < 1e-6) {
      right = { x: 1, y: 0, z: 0 }
    } else {
      right = { x: right.x / rl, y: right.y / rl, z: right.z / rl }
    }
    this.camForward = fwd
    this.camRight = right
    this.camUp = cross(right, fwd)
  }

  private toCam(p: Vec3): CamPoint {
    const dx = p.x - this.camera.x
    const dy = p.y - this.camera.y
    const dz = p.z - this.camera.z
    return {
      x: dx * this.camRight.x + dy * this.camRight.y + dz * this.camRight.z,
      y: dx * this.camUp.x + dy * this.camUp.y + dz * this.camUp.z,
      z: dx * this.camForward.x + dy * this.camForward.y + dz * this.camForward.z
    }
  }

  private project(c: CamPoint): { x: number; y: number } | null {
    // Near-plane boundary points (z === NEAR, produced by near-plane clipping)
    // are valid and must project — only strictly-behind points are rejected.
    if (c.z < NEAR) return null
    const t = this.projT
    const nx = c.x / (c.z * t * this.aspect)
    const ny = c.y / (c.z * t)
    return { x: ((nx + 1) / 2) * this.width, y: (1 - (ny + 1) / 2) * this.height }
  }

  private get projT(): number {
    return Math.tan(rad(FOV / 2))
  }

  /**
   * Stroke world-space segments, clipping each against the near plane (a
   * segment crossing behind the camera is cut, so the path stays intact).
   *
   * - `discrete: false` — treat the points as one continuous polyline (track /
   *   arms / circles): consecutive points that project to the same screen
   *   position extend the current subpath (keeps round joins), anything else
   *   starts a fresh subpath.
   * - `discrete: true` — treat the points as a batch of independent segments
   *   (`[a0,b0, a1,b1, …]`), each drawn as its own moveTo/lineTo. Without this,
   *   the bridges between consecutive segments would get drawn as spurious
   *   diagonal connectors (the grid lines looked like a tangled crosshatch).
   */
  private strokePath(points: Vec3[], style: string, discrete = false): void {
    const ctx = this.ctx
    ctx.strokeStyle = style
    ctx.lineWidth = 1
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let penX: number | null = null
    let penY: number | null = null
    const stride = discrete ? 2 : 1
    for (let i = 0; i + 1 < points.length; i += stride) {
      const seg = this.clipSegment(points[i], points[i + 1])
      if (!seg) {
        penX = penY = null
        continue
      }
      const pa = this.project(seg[0])
      const pb = this.project(seg[1])
      if (!pa || !pb) {
        penX = penY = null
        continue
      }
      if (discrete) {
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
      } else if (penX === pa.x && penY === pa.y) {
        ctx.lineTo(pb.x, pb.y)
      } else {
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
      }
      penX = pb.x
      penY = pb.y
    }
    ctx.stroke()
  }

  /** Clip a world-space segment against the near plane; null if fully behind. */
  private clipSegment(a: Vec3, b: Vec3): [CamPoint, CamPoint] | null {
    const ca = this.toCam(a)
    const cb = this.toCam(b)
    if (ca.z > NEAR && cb.z > NEAR) return [ca, cb]
    if (ca.z <= NEAR && cb.z <= NEAR) return null
    const t = (NEAR - ca.z) / (cb.z - ca.z)
    const c = { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t, z: NEAR }
    return ca.z > NEAR ? [ca, c] : [c, cb]
  }

  /**
   * Fill a dot at `center` with a FIXED screen-space radius (CSS px) — it must
   * not grow with zoom nor shrink with figure depth, otherwise the tip marker
   * changes size as you zoom or switch presets.
   */
  private fillDot(center: Vec3, radiusPx: number, style: string): void {
    const c = this.toCam(center)
    if (c.z <= NEAR) return
    const p = this.project(c)
    if (!p) return
    const ctx = this.ctx
    ctx.fillStyle = style
    ctx.beginPath()
    ctx.arc(p.x, p.y, radiusPx, 0, Math.PI * 2)
    ctx.fill()
  }

  /** Tip-dot radius, proportional to the viewport but zoom/depth independent. */
  private tipDotRadius(): number {
    return Math.max(2.5, Math.min(6, this.height * 0.0045))
  }

  // ---------------------------------------------------------------------------
  // Frame draw
  // ---------------------------------------------------------------------------

  render(): void {
    if (this.disposed) return
    this.updateCamera()
    this.updateBasis()
    this.aspect = this.width / this.height

    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)

    if (this.mode === '3d') this.drawGrid()
    if (this.options.showCoords) this.drawAxes()
    if (this.options.showCover) this.drawCover()
    if (this.options.showTrack) this.drawTrack()
    if (this.options.showVectors) this.strokePath(this.armPoints, this.palette.arm)
    if (this.options.showFinal) {
      this.strokePath(this.finalPoints, this.palette.final)
      if (this.currentTip) this.fillDot(this.currentTip, this.tipDotRadius(), this.palette.tip)
    }
  }

  private drawTrack(): void {
    const n = Math.min(this.trackPoints.length, this.trackCap)
    if (n < 2) return
    const pts: Vec3[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const p = this.trackPoints[i]
      pts[i] = { x: p.x, y: p.y, z: p.z }
    }
    const style = this.options.neon
      ? `hsl(${Math.round(((((this.trackTime * 0.4) % 1) + 1) % 1) * 360)}, 85%, 62%)`
      : this.palette.track
    this.strokePath(pts, style)
  }

  private drawAxes(): void {
    const L = 1e6
    const xAxis = [
      { x: -L, y: 0, z: 0 },
      { x: L, y: 0, z: 0 }
    ]
    const yAxis = [
      { x: 0, y: -L, z: 0 },
      { x: 0, y: L, z: 0 }
    ]
    this.strokePath(xAxis, this.palette.axisX)
    this.strokePath(yAxis, this.palette.axisY)
    if (this.mode === '3d') {
      const zAxis = [
        { x: 0, y: 0, z: -L },
        { x: 0, y: 0, z: L }
      ]
      this.strokePath(zAxis, this.palette.axisZ)
    }
  }

  private drawCover(): void {
    if (this.coverPoints.length === 0) return
    const ctx = this.ctx
    const focal = this.height / 2 / this.projT
    ctx.fillStyle = this.palette.cover
    ctx.beginPath()
    for (const p of this.coverPoints) {
      const c = this.toCam(p)
      if (c.z <= NEAR) continue
      const sp = this.project(c)
      if (!sp) continue
      const r = Math.max(0.5, Math.min(2, (1.2 * focal) / c.z))
      ctx.moveTo(sp.x + r, sp.y)
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2)
    }
    ctx.fill()
  }

  private drawGrid(): void {
    const reach = this.reach
    const step = reach * 0.2
    const minor: Vec3[] = []
    const center: Vec3[] = []
    for (let i = 0; i <= 10; i++) {
      const p = -reach + i * step
      const isCenter = i === 5
      if (isCenter) {
        center.push({ x: p, y: -reach, z: 0 }, { x: p, y: reach, z: 0 })
        center.push({ x: -reach, y: p, z: 0 }, { x: reach, y: p, z: 0 })
      } else {
        minor.push({ x: p, y: -reach, z: 0 }, { x: p, y: reach, z: 0 })
        minor.push({ x: -reach, y: p, z: 0 }, { x: reach, y: p, z: 0 })
      }
    }
    this.strokePath(minor, this.palette.gridMinor, true)
    this.strokePath(center, this.palette.gridCenter, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvasEl.remove()
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}
