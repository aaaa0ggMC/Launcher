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
    if (v.secperRound === 0) return { x: v.x, y: v.y, z: v.z ?? 0 }
    const angle = (2 * Math.PI * t) / v.secperRound + ((v.orot ?? 0) * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos, z: v.z ?? 0 }
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
