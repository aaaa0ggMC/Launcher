// Ft ability domain types — SimpleVectors-style epicycle visualizer.

/**
 * One rotating vector (epicycle). Semantics mirror SimpleVectors' `Vector`:
 * at sim-time `t` the vector is rotated by `2π * t / secperRound` plus `orot`.
 * `secperRound === 0` marks a static offset (DFT's DC term). `z` is reserved
 * for future 3D extension.
 */
export interface FtVector {
  x: number
  y: number
  z?: number
  /** initial rotation in degrees */
  orot?: number
  /** seconds (of sim time) per full 2π rotation; 0 = static */
  secperRound: number
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
  circles: boolean
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
