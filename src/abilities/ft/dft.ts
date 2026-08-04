import type { FtVector } from './types'

/**
 * Discrete Fourier Transform → epicycle vectors.
 *
 * Given a closed 2D path sampled at N points z_k, the DFT coefficients
 * c_n = (1/N)·Σ z_k·e^(-2πi·n·k/N) let us reconstruct the path as a sum of
 * rotating phasors: z(t) = Σ c_n·e^(2πi·n·t/T). Each c_n becomes one rotating
 * vector of length |c_n| starting at angle arg(c_n) and spinning at n/T
 * rotations per second of sim time. n=0 is the static DC offset.
 */
export interface Point2 {
  x: number
  y: number
}

/** Sample a parametric curve uniformly in t ∈ [0, 2π). */
export function sampleParametric(
  fx: (t: number) => number,
  fy: (t: number) => number,
  n: number
): Point2[] {
  const pts: Point2[] = []
  for (let k = 0; k < n; k++) {
    const t = (k / n) * 2 * Math.PI
    pts.push({ x: fx(t), y: fy(t) })
  }
  return pts
}

/** Sample a closed polyline, `perEdge` points along each segment. */
export function samplePolyline(verts: Point2[], perEdge: number): Point2[] {
  const pts: Point2[] = []
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]
    const b = verts[(i + 1) % verts.length]
    for (let k = 0; k < perEdge; k++) {
      const t = k / perEdge
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return pts
}

/**
 * Convert a sampled closed path into epicycle vectors. Harmonics run from
 * `-harmonics` to `+harmonics`; near-zero amplitudes are dropped so a smooth
 * curve (heart, cardioid) yields a surprisingly small vector list.
 */
export function dftVectors(points: Point2[], harmonics: number, basePeriod = 1): FtVector[] {
  const N = points.length
  const out: FtVector[] = []
  for (let n = -harmonics; n <= harmonics; n++) {
    let cr = 0
    let ci = 0
    for (let k = 0; k < N; k++) {
      const theta = (2 * Math.PI * n * k) / N
      const cos = Math.cos(theta)
      const sin = Math.sin(theta)
      // z_k · e^(-iθ) = (x+iy)(cosθ − i·sinθ)
      cr += points[k].x * cos + points[k].y * sin
      ci += points[k].y * cos - points[k].x * sin
    }
    cr /= N
    ci /= N
    if (n === 0) {
      out.push({ x: cr, y: ci, secperRound: 0 })
      continue
    }
    if (cr * cr + ci * ci < 1e-10) continue
    // rotating phasor: speed = n/T, initial direction = arg(c_n)
    out.push({ x: cr, y: ci, secperRound: basePeriod / n })
  }
  return out
}

/** Total chain reach — used to frame the camera to fit a preset. */
export function chainReach(vectors: FtVector[]): number {
  return vectors.reduce((s, v) => s + Math.hypot(v.x, v.y), 0)
}
