import type { FtPreset, FtVector } from './types'
import { dftVectors, sampleParametric, samplePolyline, type Point2 } from './dft'

export interface FtPresetMeta {
  name: string
  description: string
}

const CIRCLE: FtPreset = {
  name: 'circle',
  vectors: [
    { x: 0, y: 0, secperRound: 0 },
    { x: 120, y: 0, secperRound: 1 }
  ],
  runSpeed: 1
}

const LIMACON: FtPreset = {
  name: 'limacon',
  // r1·e^{iωt} + r2·e^{i2ωt} traces a cardioid-like limacon
  vectors: [
    { x: 70, y: 0, secperRound: 1 },
    { x: 45, y: 0, secperRound: 2 }
  ],
  runSpeed: 1
}

const CARDIOID: FtPreset = {
  name: 'cardioid',
  vectors: dftVectors(
    sampleParametric(
      (t) => 90 * (1 - Math.cos(t)) * Math.cos(t),
      (t) => 90 * (1 - Math.cos(t)) * Math.sin(t),
      400
    ),
    24
  ),
  runSpeed: 1
}

const SQUARE: FtPreset = {
  name: 'square',
  vectors: dftVectors(
    samplePolyline(
      [
        { x: -120, y: -120 },
        { x: 120, y: -120 },
        { x: 120, y: 120 },
        { x: -120, y: 120 }
      ],
      96
    ),
    50
  ),
  runSpeed: 1
}

const STAR: FtPreset = {
  name: 'star',
  vectors: dftVectors(samplePolyline(starPolygon(130, 55, 10), 50), 45),
  runSpeed: 1
}

const HEART: FtPreset = {
  name: 'heart',
  vectors: dftVectors(
    sampleParametric(
      (t) => 16 * Math.pow(Math.sin(t), 3),
      (t) => 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      400
    ),
    30
  ),
  runSpeed: 1
}

function starPolygon(outer: number, inner: number, points: number): Point2[] {
  const verts: Point2[] = []
  for (let i = 0; i < points * 2; i++) {
    const angle = (i * Math.PI) / points - Math.PI / 2
    const r = i % 2 === 0 ? outer : inner
    verts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) })
  }
  return verts
}

/** A random scribble — fresh every load, like opening a random .math file. */
function randomVectors(): FtVector[] {
  const v: FtVector[] = []
  const n = 10 + Math.floor(Math.random() * 6)
  for (let i = 0; i < n; i++) {
    const len = 24 + Math.random() * 90
    const phase = Math.random() * 2 * Math.PI
    const period = (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 2.6)
    v.push({ x: len * Math.cos(phase), y: len * Math.sin(phase), secperRound: period })
  }
  return v
}

const PRESETS: Record<string, FtPreset> = {
  circle: CIRCLE,
  limacon: LIMACON,
  cardioid: CARDIOID,
  square: SQUARE,
  star: STAR,
  heart: HEART,
  random: { name: 'random', vectors: randomVectors(), runSpeed: 1 }
}

const DESCRIPTIONS: Record<string, string> = {
  circle: '单矢量 · 经典圆周',
  limacon: '两矢量 · 利马曲线',
  cardioid: '心形线 · DFT',
  square: '方形 · 角点吉布斯振铃',
  star: '五角星 · DFT',
  heart: '爱心 · 极小矢量数',
  random: '随机矢量 · 手写涂鸦'
}

export function listFtPresets(): FtPresetMeta[] {
  return Object.keys(PRESETS).map((name) => ({
    name,
    description: DESCRIPTIONS[name] ?? ''
  }))
}

export function loadFtPreset(name: string): FtPreset | null {
  if (name === 'random') return { name: 'random', vectors: randomVectors(), runSpeed: 1 }
  return PRESETS[name] ?? null
}
