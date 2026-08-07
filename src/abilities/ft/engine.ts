import type { FtVector } from './types'

export interface FtPoint {
  x: number
  y: number
  z: number
}

/** One animation frame's chain geometry: every pivot + every vector tip. */
export interface FtChain {
  pivots: FtPoint[]
  tips: FtPoint[]
  tip: FtPoint
}

/**
 * Rotate a vector to its orientation at sim-time `t` (double-period, nested):
 *
 *   v(t) = R_z(2π·t/T_φ + orot) · R_x(2π·t/T_θ + orotX) · v0
 *
 *   - T_θ = `secperRoundX`, θ₀ = `orotX` — polar rotation about X (changes the
 *     spherical polar angle); 0 period = no polar rotation.
 *   - T_φ = `secperRound`, φ₀ = `orot` — azimuth rotation about Z (classic
 *     epicycle); 0 period = no azimuth rotation.
 *
 * Default `T_θ = 0` makes `R_x` the identity, so a vector reduces to the
 * classic 2D epicycle `(x cosα − y sinα, x sinα + y cosα, z)` with
 * `α = 2π·t/T_φ + orot` — fully backward compatible.
 */
export function rotateVector(v: FtVector, t: number): FtPoint {
  const x0 = v.x
  const y0 = v.y
  const z0 = v.z ?? 0
  let x = x0
  let y = y0
  let z = z0

  // polar: rotate about X by 2π·t/T_θ + orotX
  if (v.secperRoundX) {
    const a = (2 * Math.PI * t) / v.secperRoundX + ((v.orotX ?? 0) * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    const ny = y * c - z * s
    z = y * s + z * c
    y = ny
  }

  // azimuth: rotate about Z by 2π·t/T_φ + orot
  if (v.secperRound) {
    const a = (2 * Math.PI * t) / v.secperRound + ((v.orot ?? 0) * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    const nx = x * c - y * s
    y = x * s + y * c
    x = nx
  }

  return { x, y, z }
}

/**
 * Deterministic epicycle simulation, faithful to SimpleVectors:
 * each vector rotates by 2π·t/secperRound (signed period; 0 = static offset),
 * and the track accumulates the tip of the final vector over time.
 */
export class FtEngine {
  vectors: FtVector[] = []
  track: FtPoint[] = []
  time = 0
  running = true
  runSpeed = 1
  verticesLimit = 4096

  setVectors(vectors: FtVector[]): void {
    this.vectors = vectors
    this.time = 0
    this.track.length = 0
  }

  /** Rotate one vector to its orientation at sim-time `t`. */
  private rotated(v: FtVector, t: number): FtPoint {
    return rotateVector(v, t)
  }

  /** Compute pivot + tip positions for the current time without advancing. */
  computeChain(): FtChain {
    const pivots: FtPoint[] = []
    const tips: FtPoint[] = []
    let px = 0
    let py = 0
    let pz = 0
    for (const v of this.vectors) {
      const r = this.rotated(v, this.time)
      pivots.push({ x: px, y: py, z: pz })
      px += r.x
      py += r.y
      pz += r.z
      tips.push({ x: px, y: py, z: pz })
    }
    return { pivots, tips, tip: { x: px, y: py, z: pz } }
  }

  /**
   * Advance by `dt` real seconds (scaled by runSpeed) and append the new tip
   * to the track. Returns the frame when running, null while paused.
   */
  step(dt: number): FtChain | null {
    if (!this.running) return null
    this.time += dt * this.runSpeed
    const chain = this.computeChain()
    this.track.push(chain.tip)
    if (this.track.length > this.verticesLimit) {
      this.track.splice(0, this.track.length - this.verticesLimit)
    }
    return chain
  }

  clearTrack(): void {
    this.track.length = 0
  }
}
