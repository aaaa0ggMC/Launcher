import * as THREE from 'three'
import type { FtVector } from './types'
import type { FtChain, FtPoint } from './engine'

export type FtMode = '2d' | '3d'

export interface FtDisplayOptions {
  showCoords: boolean
  showCircles: boolean
  showVectors: boolean
  showTrack: boolean
  showFinal: boolean
  neon: boolean
}

const DEFAULT_OPTIONS: FtDisplayOptions = {
  showCoords: true,
  showCircles: false,
  showVectors: true,
  showTrack: true,
  showFinal: true,
  neon: false
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180
}

const WORLD_UP = new THREE.Vector3(0, 1, 0)

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
      if (v.secperRound === 0) {
        x += v.x
        y += v.y
        z += v.z ?? 0
        continue
      }
      const angle = (2 * Math.PI * t) / v.secperRound + ((v.orot ?? 0) * Math.PI) / 180
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      x += v.x * cos - v.y * sin
      y += v.x * sin + v.y * cos
      z += v.z ?? 0
    }
    max = Math.max(max, Math.hypot(x, y, z))
  }
  return Math.max(10, max)
}

/**
 * three.js renderer for the epicycle scene. The canvas is fully transparent
 * (alpha:true, clear alpha 0) so the app's Background/Fuse layers show through
 * — the ft ability automatically follows the window background settings.
 */
/**
 * Build a circle outline geometry from perimeter points only. `CircleGeometry`
 * puts the center vertex first, so a `Line` primitive renders it as a radial
 * tail from the center — this keeps a clean loop with no center vertex.
 */
function makeCircleOutline(radius: number, segments = 64): THREE.BufferGeometry {
  const pts = new Float32Array(segments * 3)
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2
    pts[s * 3] = radius * Math.cos(a)
    pts[s * 3 + 1] = radius * Math.sin(a)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3))
  return geo
}

export class FtScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private container: HTMLElement
  private disposed = false

  private coordsGroup = new THREE.Group()
  private grid: THREE.GridHelper
  private circleGroup = new THREE.Group()
  private armLine: THREE.Line
  private trackLine: THREE.Line
  private finalLine: THREE.Line
  private tipDot: THREE.Mesh
  /** Each vector's orbit circle, keyed by its vector index (a zero/DC vector
   *  gets no circle, so indices must be tracked explicitly — a flat array would
   *  misalign pivots). */
  private circleMeshes: { index: number; mesh: THREE.Line }[] = []

  private armPositions = new Float32Array(3)
  private trackPositions = new Float32Array(0)
  private finalPositions = new Float32Array(6)

  private reach = 100
  private viewDistance = 500
  private orbitRadius = 700
  private azimuth = Math.PI / 4
  private elevation = 0.55
  private target = new THREE.Vector3(0, 0, 0)
  private mode: FtMode = '2d'
  private follow = false

  options: FtDisplayOptions = { ...DEFAULT_OPTIONS }

  constructor(container: HTMLElement) {
    this.container = container
    const w = container.clientWidth || 1
    const h = container.clientHeight || 1
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 200000)

    // coordinate axes
    const axisGeo = new THREE.BufferGeometry()
    axisGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3))
    const axisMat = new THREE.LineBasicMaterial({ vertexColors: true })
    this.coordsGroup.add(new THREE.LineSegments(axisGeo, axisMat))
    this.scene.add(this.coordsGroup)

    this.scene.add(this.circleGroup)

    this.armLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffe066 })
    )
    this.armLine.frustumCulled = false
    this.scene.add(this.armLine)

    this.trackLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff })
    )
    this.trackLine.frustumCulled = false
    this.scene.add(this.trackLine)

    this.finalLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x9adcff })
    )
    this.finalLine.frustumCulled = false
    this.scene.add(this.finalLine)

    this.tipDot = new THREE.Mesh(
      new THREE.SphereGeometry(4, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x4cc4d6 })
    )
    this.scene.add(this.tipDot)

    this.grid = new THREE.GridHelper(1, 10, 0x2c3640, 0x1c242f)
    this.grid.visible = false
    this.scene.add(this.grid)

    this.updateAxes()
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  setOptions(patch: Partial<FtDisplayOptions>): void {
    this.options = { ...this.options, ...patch }
    this.coordsGroup.visible = this.options.showCoords
    this.circleGroup.visible = this.options.showCircles
    this.armLine.visible = this.options.showVectors
    this.trackLine.visible = this.options.showTrack
    this.finalLine.visible = this.options.showFinal
    this.tipDot.visible = this.options.showFinal
  }

  /** Rebuild meshes for a new vector set. */
  setVectors(vectors: FtVector[], verticesLimit?: number): void {
    this.reach = computeChainReach(vectors)
    this.viewDistance = this.defaultViewDistance()
    this.orbitRadius = this.viewDistance * 1.3
    this.target.set(0, 0, 0)

    // circles: one static outline per vector, radius = vector length
    for (const c of this.circleMeshes) {
      this.circleGroup.remove(c.mesh)
      c.mesh.geometry.dispose()
      ;(c.mesh.material as THREE.Material).dispose()
    }
    this.circleMeshes = []
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i]
      const r = Math.hypot(v.x, v.y)
      if (r < 0.01) continue
      const mesh = new THREE.LineLoop(
        makeCircleOutline(r),
        new THREE.LineBasicMaterial({ color: 0x8b97a5 })
      )
      this.circleGroup.add(mesh)
      this.circleMeshes.push({ index: i, mesh })
    }

    // arms: continuous polyline origin → p0 → p1 → … → tip
    const count = vectors.length + 2
    this.armPositions = new Float32Array(count * 3)
    this.armLine.geometry.setAttribute('position', new THREE.BufferAttribute(this.armPositions, 3))
    this.armLine.geometry.setDrawRange(0, 0)

    // track buffer
    const limit = Math.max(500, verticesLimit ?? 500)
    this.trackPositions = new Float32Array(limit * 3)
    this.trackLine.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.trackPositions, 3)
    )
    this.trackLine.geometry.setDrawRange(0, 0)

    // final vector origin→tip
    this.finalPositions = new Float32Array(6)
    this.finalLine.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.finalPositions, 3)
    )
    this.finalLine.geometry.setDrawRange(0, 0)

    this.grid.scale.set(this.reach * 2, this.reach * 2, 1)
    this.grid.position.z = 0

    this.updateAxes()
    this.updateCamera()
  }

  setVerticesLimit(limit: number): void {
    if (this.trackPositions.length >= limit * 3) return
    this.trackPositions = new Float32Array(limit * 3)
    this.trackLine.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.trackPositions, 3)
    )
  }

  private defaultViewDistance(): number {
    return (this.reach * 1.9) / Math.tan(rad(this.camera.fov / 2))
  }

  private updateAxes(): void {
    const geo = this.coordsGroup.children[0] as THREE.LineSegments
    // Effectively infinite axes (span far beyond the view at any zoom): X red,
    // Y green. Z is only drawn in 3D — in 2D the camera looks down -Z so a Z
    // axis would be meaningless.
    const L = 1e6
    const pts = [-L, 0, 0, L, 0, 0, 0, -L, 0, 0, L, 0]
    const colors = [1, 0.36, 0.36, 1, 0.36, 0.36, 0.36, 1, 0.36, 0.36, 1, 0.36]
    if (this.mode === '3d') {
      pts.push(0, 0, -L, 0, 0, L)
      colors.push(0.42, 0.6, 1, 0.42, 0.6, 1)
    }
    geo.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
    geo.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
  }

  setMode(mode: FtMode): void {
    this.mode = mode
    if (mode === '3d') {
      this.orbitRadius = this.viewDistance
      this.azimuth = Math.PI / 4
      this.elevation = 0.55
      if (this.grid) this.grid.visible = true
    } else {
      this.viewDistance = this.orbitRadius
      if (this.grid) this.grid.visible = false
    }
    this.updateAxes()
    this.updateCamera()
  }

  setFollow(on: boolean): void {
    this.follow = on
  }

  /** Frame the whole chain in view. */
  resetView(): void {
    this.target.set(0, 0, 0)
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
    const dist = this.mode === '3d' ? this.orbitRadius : this.viewDistance
    const units = (dist * Math.tan(rad(this.camera.fov / 2)) * 2) / this.container.clientHeight

    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    if (this.mode === '3d') {
      const forward = new THREE.Vector3().subVectors(this.target, this.camera.position).normalize()
      right.crossVectors(forward, WORLD_UP).normalize()
      up.crossVectors(right, forward)
    } else {
      right.set(1, 0, 0)
      up.set(0, 1, 0)
    }
    this.target.addScaledVector(right, -dx * units)
    this.target.addScaledVector(up, dy * units)
    this.updateCamera()
  }

  /** 3D orbit drag in pixels — rotates the view direction (azimuth/elevation). */
  orbitBy(dx: number, dy: number): void {
    if (this.mode !== '3d') return
    this.azimuth -= dx * 0.006
    this.elevation = clamp(this.elevation - dy * 0.006, -1.45, 1.45)
    this.updateCamera()
  }

  resize(): void {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private updateCamera(): void {
    if (this.follow) {
      const p = this.currentTip ?? this.target
      this.target.set(p.x, p.y, p.z)
    }
    if (this.mode === '3d') {
      const r = this.orbitRadius
      const cp = Math.cos(this.elevation)
      this.camera.position.set(
        this.target.x + r * cp * Math.cos(this.azimuth),
        this.target.y + r * Math.sin(this.elevation),
        this.target.z + r * cp * Math.sin(this.azimuth)
      )
    } else {
      this.camera.position.set(this.target.x, this.target.y, this.target.z + this.viewDistance)
    }
    this.camera.lookAt(this.target)
  }

  private currentTip: FtPoint | null = null

  /** Refresh all moving geometry from the latest simulation frame. */
  update(chain: FtChain): void {
    this.currentTip = chain.tip
    const armAttr = this.armLine.geometry.getAttribute('position') as
      THREE.BufferAttribute | undefined
    if (!armAttr) return // no vectors loaded yet

    // circles → move each to its own vector's pivot (indices tracked because
    // zero-length vectors get no circle and would desync a flat array)
    for (const c of this.circleMeshes) {
      const p = chain.pivots[c.index]
      if (p) c.mesh.position.set(p.x, p.y, p.z)
    }

    // arms: origin → pivots → tip
    const aa = armAttr.array as Float32Array
    aa[0] = 0
    aa[1] = 0
    aa[2] = 0
    for (let i = 0; i < chain.pivots.length; i++) {
      aa[(i + 1) * 3] = chain.pivots[i].x
      aa[(i + 1) * 3 + 1] = chain.pivots[i].y
      aa[(i + 1) * 3 + 2] = chain.pivots[i].z
    }
    const last = chain.tips.length
    aa[(last + 1) * 3] = chain.tip.x
    aa[(last + 1) * 3 + 1] = chain.tip.y
    aa[(last + 1) * 3 + 2] = chain.tip.z
    armAttr.needsUpdate = true
    this.armLine.geometry.setDrawRange(0, last + 2)

    // tip dot
    this.tipDot.position.set(chain.tip.x, chain.tip.y, chain.tip.z)

    // final vector
    const fa = this.finalLine.geometry.getAttribute('position') as THREE.BufferAttribute
    const farr = fa.array as Float32Array
    farr[0] = 0
    farr[1] = 0
    farr[2] = 0
    farr[3] = chain.tip.x
    farr[4] = chain.tip.y
    farr[5] = chain.tip.z
    fa.needsUpdate = true
    this.finalLine.geometry.setDrawRange(0, 2)
  }

  /** Stream track points (already capped by the engine). */
  updateTrack(track: FtPoint[], time: number): void {
    const attr = this.trackLine.geometry.getAttribute('position') as
      THREE.BufferAttribute | undefined
    if (!attr) return // no vectors loaded yet
    const arr = attr.array as Float32Array
    const cap = Math.floor(arr.length / 3)
    const n = Math.min(track.length, cap)
    for (let i = 0; i < n; i++) {
      arr[i * 3] = track[i].x
      arr[i * 3 + 1] = track[i].y
      arr[i * 3 + 2] = track[i].z
    }
    attr.needsUpdate = true
    this.trackLine.geometry.setDrawRange(0, n)

    if (this.options.neon) {
      const mat = this.trackLine.material as THREE.LineBasicMaterial
      mat.color.setHSL((((time * 0.4) % 1) + 1) % 1, 0.85, 0.62)
    } else {
      const mat = this.trackLine.material as THREE.LineBasicMaterial
      if (mat.color.getHex() !== 0xffffff) mat.color.setHex(0xffffff)
    }
  }

  render(): void {
    this.updateCamera()
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.scene.traverse((o) => {
      const obj = o as THREE.Mesh
      if (obj.geometry) obj.geometry.dispose()
      const mat = obj.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}
