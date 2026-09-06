import type { Ref } from 'vue'
import type maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'

export const POLAR_SECTORS = 180
export const POLAR_LAT = 83.0
export const POLAR_CORE_LAT = 87.5

export interface PolarFeature {
  type: 'Feature'
  geometry: {
    type: 'Polygon'
    coordinates: [number, number][][]
  }
  properties: {
    color: string
  }
}

export async function samplePolarCapColors(
  providerId: string,
  isNorth: boolean,
  sectorsCount: number = POLAR_SECTORS
): Promise<{ sectors: string[]; coreColor: string }> {
  const z = 2
  const numTiles = 1 << z
  const y = isNorth ? 0 : numTiles - 1
  // 在 Web Mercator 中，y=0 最顶部 py=1 对应 85.05°N，y=3 最底部 py=254 对应 -85.05°S
  const sampleY = isNorth ? 1 : 254

  const canvas = document.createElement('canvas')
  canvas.width = numTiles * 256
  canvas.height = 256
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const fallback = isNorth ? '#0c1b2a' : '#f8fafc'
  if (!ctx) return { sectors: Array(sectorsCount).fill(fallback), coreColor: fallback }

  const bitmaps = await Promise.all(
    Array.from({ length: numTiles }, async (_, x) => {
      try {
        const res = await fetch(`cockpit-tile://online/${providerId}/${z}/${x}/${y}`)
        if (!res.ok) return null
        const blob = await res.blob()
        return await createImageBitmap(blob)
      } catch {
        return null
      }
    })
  )

  let loadedCount = 0
  for (let x = 0; x < numTiles; x++) {
    const bmp = bitmaps[x]
    if (bmp) {
      ctx.drawImage(bmp, x * 256, 0, 256, 256)
      bmp.close?.()
      loadedCount++
    }
  }

  if (loadedCount === 0) {
    return { sectors: Array(sectorsCount).fill(fallback), coreColor: fallback }
  }

  // Stage 1: 提取 1024 像素环线各经度区段的真实切片色彩
  const imgData = ctx.getImageData(0, sampleY, canvas.width, 1).data
  const rawColors: [number, number, number][] = []
  let totalR = 0
  let totalG = 0
  let totalB = 0
  let totalCount = 0

  for (let i = 0; i < sectorsCount; i++) {
    const pxStart = Math.floor((i / sectorsCount) * canvas.width)
    const pxEnd = Math.floor(((i + 1) / sectorsCount) * canvas.width)
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    for (let px = pxStart; px < pxEnd; px++) {
      const idx = px * 4
      const a = imgData[idx + 3]
      if (a > 0) {
        r += imgData[idx]
        g += imgData[idx + 1]
        b += imgData[idx + 2]
        count++
        totalR += imgData[idx]
        totalG += imgData[idx + 1]
        totalB += imgData[idx + 2]
        totalCount++
      }
    }
    if (count > 0) {
      rawColors.push([Math.round(r / count), Math.round(g / count), Math.round(b / count)])
    } else {
      rawColors.push(isNorth ? [12, 27, 42] : [248, 250, 252])
    }
  }

  // Stage 2: 环向大核平滑（跨越 ±24° 经度高斯卷积），彻底抹除任何射线感
  const smoothed: string[] = []
  const radius = 12
  for (let i = 0; i < sectorsCount; i++) {
    let r = 0
    let g = 0
    let b = 0
    let weight = 0
    for (let d = -radius; d <= radius; d++) {
      const idx = (i + d + sectorsCount) % sectorsCount
      const w = radius + 1 - Math.abs(d)
      r += rawColors[idx][0] * w
      g += rawColors[idx][1] * w
      b += rawColors[idx][2] * w
      weight += w
    }
    smoothed.push(
      `rgb(${Math.round(r / weight)}, ${Math.round(g / weight)}, ${Math.round(b / weight)})`
    )
  }

  const coreR = totalCount > 0 ? Math.round(totalR / totalCount) : isNorth ? 12 : 248
  const coreG = totalCount > 0 ? Math.round(totalG / totalCount) : isNorth ? 27 : 250
  const coreB = totalCount > 0 ? Math.round(totalB / totalCount) : isNorth ? 42 : 252
  const coreColor = `rgb(${coreR}, ${coreG}, ${coreB})`

  return { sectors: smoothed, coreColor }
}

export function buildPolarGeoJSON(
  north: { sectors: string[]; coreColor: string },
  south: { sectors: string[]; coreColor: string }
): { type: 'FeatureCollection'; features: PolarFeature[] } {
  const step = 360 / POLAR_SECTORS
  const features: PolarFeature[] = []

  // 1. 北极环向过渡扇区 (83.0° -> 87.5°)
  for (let i = 0; i < POLAR_SECTORS; i++) {
    const lon1 = -180 + i * step
    const lon2 = lon1 + step
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [lon1, POLAR_LAT],
            [lon2, POLAR_LAT],
            [lon2, POLAR_CORE_LAT],
            [lon1, POLAR_CORE_LAT],
            [lon1, POLAR_LAT]
          ]
        ]
      },
      properties: {
        color: north.sectors[i] ?? '#0c1b2a'
      }
    })
  }

  // 2. 北极中心平滑极核 (87.5° -> 90° 全局均值融合，无放射点)
  const northCoreCoords: [number, number][] = []
  for (let lon = -180; lon <= 180; lon += 4) {
    northCoreCoords.push([lon, POLAR_CORE_LAT])
  }
  northCoreCoords.push([180, 90], [-180, 90], [-180, POLAR_CORE_LAT])
  features.push({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [northCoreCoords]
    },
    properties: {
      color: north.coreColor
    }
  })

  // 3. 南极环向过渡扇区 (-83.0° -> -87.5°)
  for (let i = 0; i < POLAR_SECTORS; i++) {
    const lon1 = -180 + i * step
    const lon2 = lon1 + step
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [lon1, -POLAR_LAT],
            [lon2, -POLAR_LAT],
            [lon2, -POLAR_CORE_LAT],
            [lon1, -POLAR_CORE_LAT],
            [lon1, -POLAR_LAT]
          ]
        ]
      },
      properties: {
        color: south.sectors[i] ?? '#f8fafc'
      }
    })
  }

  // 4. 南极中心平滑极核 (-87.5° -> -90°)
  const southCoreCoords: [number, number][] = []
  for (let lon = -180; lon <= 180; lon += 4) {
    southCoreCoords.push([lon, -POLAR_CORE_LAT])
  }
  southCoreCoords.push([180, -90], [-180, -90], [-180, -POLAR_CORE_LAT])
  features.push({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [southCoreCoords]
    },
    properties: {
      color: south.coreColor
    }
  })

  return {
    type: 'FeatureCollection' as const,
    features
  }
}

export interface PolarCapResult {
  sectors: string[]
  coreColor: string
}

export interface UseMapPolarSamplingReturn {
  setupPolarCapsLayer: () => Promise<void>
  samplePolarCapColors: (
    providerId: string,
    isNorth: boolean,
    sectorsCount?: number
  ) => Promise<PolarCapResult>
  buildPolarGeoJSON: (
    north: PolarCapResult,
    south: PolarCapResult
  ) => { type: 'FeatureCollection'; features: PolarFeature[] }
}

export function useMapPolarSampling(
  getMap: () => maplibregl.Map | null,
  activeProviderId: Ref<string>
): UseMapPolarSamplingReturn {
  async function setupPolarCapsLayer(): Promise<void> {
    const map = getMap()
    if (!map) return
    const pId = activeProviderId.value

    const defaultNorth = {
      sectors: Array(POLAR_SECTORS).fill(pId.includes('dark') ? '#09090b' : '#0c1b2a'),
      coreColor: pId.includes('dark') ? '#09090b' : '#0c1b2a'
    }
    const defaultSouth = {
      sectors: Array(POLAR_SECTORS).fill(pId.includes('dark') ? '#09090b' : '#f8fafc'),
      coreColor: pId.includes('dark') ? '#09090b' : '#f8fafc'
    }
    const initialData = buildPolarGeoJSON(defaultNorth, defaultSouth)

    const existingSrc = map.getSource('yarj-polar-caps') as GeoJSONSource | undefined
    if (!existingSrc) {
      map.addSource('yarj-polar-caps', {
        type: 'geojson',
        data: initialData
      })

      map.addLayer({
        id: 'yarj-polar-caps-fill',
        type: 'fill',
        source: 'yarj-polar-caps',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 1.0
        }
      })
    }

    // 异步执行 Stage 1 采样 + Stage 2 环形平滑插值
    try {
      const [north, south] = await Promise.all([
        samplePolarCapColors(pId, true),
        samplePolarCapColors(pId, false)
      ])
      const curMap = getMap()
      if (!curMap) return
      const sampledData = buildPolarGeoJSON(north, south)
      const src = curMap.getSource('yarj-polar-caps') as GeoJSONSource | undefined
      src?.setData(sampledData)
    } catch {
      /* fallback to defaults */
    }
  }

  return {
    setupPolarCapsLayer,
    samplePolarCapColors,
    buildPolarGeoJSON
  }
}
