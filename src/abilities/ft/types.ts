// Ft ability domain types — SimpleVectors-style epicycle visualizer.

/**
 * One rotating vector (epicycle). `(x, y, z)` is the vector's initial position
 * relative to its pivot — any point on the sphere of radius |v|; the editor
 * expresses it via the spherical angles θ₀ (polar from +Z) and φ₀ (azimuth).
 * At sim-time `t` it is rotated by two nested rotations with independent
 * periods: a rotation about X by `2π·t/T_θ` (`secperRoundX`), then a rotation
 * about Z by `2π·t/T_φ` (`secperRound`). Default `T_θ = 0` (no polar rotation)
 * reproduces the classic 2D XY-plane epicycle exactly. `0` period = no
 * rotation for that axis; a vector with both zero is a static DC offset.
 */
export interface FtVector {
  x: number
  y: number
  z?: number
  /** azimuth period (rotation about Z), seconds per full 2π; 0 = static */
  secperRound: number
  /** polar period (rotation about X), seconds per full 2π; 0 = no polar rotation */
  secperRoundX?: number
}

/** One loadable preset returned by the `ft.load` command. */
export interface FtPreset {
  name: string
  vectors: FtVector[]
  /** sim-time seconds for one full traversal of the shape (default 1) */
  basePeriod?: number
  /** animation speed multiplier (default 1) */
  runSpeed?: number
  /** max track points (default 4096) */
  verticesLimit?: number
}

/** Live display toggles, mirroring SimpleVectors' 显示 menu. */
export interface FtShowOptions {
  coords: boolean
  /** swept region of the vector tips (a surface in 3D, circles in 2D) */
  cover: boolean
  vectors: boolean
  track: boolean
  final: boolean
}

export type FtMode = '2d' | '3d'

/** Shared reactive UI state between View.vue and the floating panels. */
export interface FtUiState {
  running: boolean
  mode: FtMode
  follow: boolean
  neon: boolean
  show: FtShowOptions
  runSpeed: number
  verticesLimit: number
  // throttled live stats
  fps: number
  maxFps: number
  time: number
  vectorCount: number
  trackCount: number
  tip: { x: number; y: number; z: number }
  zoom: number
  currentPreset: string
  vectors: FtVector[]
}
