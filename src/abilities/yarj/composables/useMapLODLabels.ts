import type { Ref } from 'vue'
import type maplibregl from 'maplibre-gl'
import type { FilterSpecification } from 'maplibre-gl'
import type { LodFeature, LodData, MapFileInfo } from '../types'

export const ADM1_FILTER: FilterSpecification = [
  'in',
  ['get', 'shapeType'],
  ['literal', ['ADM1', 'DISP']]
]
export const ADM2_FILTER: FilterSpecification = ['==', ['get', 'shapeType'], 'ADM2']
export const LOD_FILTER_MAX_IDS = 1000

export function isDetailLayer(layerId: string): boolean {
  return !/(adm0|admin[-_]?0|country|countries|continent)/i.test(layerId)
}

export function detailFilter(
  typeFilter: FilterSpecification,
  ids: string[],
  fallbackZoom: number,
  hasLodData = false,
  allLodIds: string[] = []
): FilterSpecification {
  if (!hasLodData) {
    return ['all', typeFilter, ['>=', ['zoom'], fallbackZoom]] as unknown as FilterSpecification
  }
  if (ids.length > LOD_FILTER_MAX_IDS) {
    return ['all', typeFilter] as unknown as FilterSpecification
  }
  const branches: FilterSpecification[] = []
  if (ids.length > 0) {
    branches.push(['in', ['get', 'shapeID'], ['literal', ids]] as unknown as FilterSpecification)
  }
  if (allLodIds.length > 0) {
    branches.push([
      'all',
      ['!', ['in', ['get', 'shapeID'], ['literal', allLodIds]]],
      ['>=', ['zoom'], fallbackZoom]
    ] as unknown as FilterSpecification)
  } else {
    branches.push(['>=', ['zoom'], fallbackZoom] as unknown as FilterSpecification)
  }
  return ['all', typeFilter, ['any', ...branches]] as unknown as FilterSpecification
}

export interface UseMapLODLabelsReturn {
  repositionLabels: () => void
  renderLabels: () => void
  applyLodFilters: () => void
  scheduleLodFilter: () => void
  ensureLod: (m: MapFileInfo) => Promise<void>
  ensureHierarchy: (m: MapFileInfo) => Promise<void>
  setFontFamily: (family: string) => void
  cleanup: () => void
  getLodData: () => LodData | null
  getLodAllIds: () => string[]
}

export function useMapLODLabels(options: {
  getMap: () => maplibregl.Map | null
  labelsEl: Ref<HTMLElement | null>
  activeProviderId: Ref<string>
  maps: Ref<MapFileInfo[]>
  lodScreenFraction: Ref<number>
  adm1MinZoom: Ref<number>
  adm2MinZoom: Ref<number>
}): UseMapLODLabelsReturn {
  const { getMap, labelsEl, activeProviderId, maps, lodScreenFraction, adm1MinZoom, adm2MinZoom } =
    options

  let labelFontFamily = 'sans-serif'
  let lodData: LodData | null = null
  let lodAllIds: string[] = []
  let lodFilterTimer: number | null = null
  let lodPollTimer: number | null = null

  let placedLabels: {
    el: HTMLDivElement
    lngLat: [number, number]
    boxW: number
    boxH: number
  }[] = []

  function setFontFamily(font: string): void {
    labelFontFamily = font || 'sans-serif'
  }

  function measureLabelWidth(text: string, size: number): number {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return text.length * size * 0.6
    ctx.font = `500 ${size}px ${labelFontFamily}`
    return ctx.measureText(text).width + 8
  }

  function lodMinZoom(feat: LodFeature, f: number, W: number, H: number): number {
    const targetW = W * f
    const targetH = H * f
    const zW = Math.log2((targetW * 360) / (Math.max(0.001, feat.w) * 256))
    const zH = Math.log2((targetH * 180) / (Math.max(0.001, feat.h) * 256))
    const z = Math.max(zW, zH)
    const fallback = feat.lvl === 'ADM1' ? adm1MinZoom.value : adm2MinZoom.value
    return Math.max(fallback, Math.ceil(z))
  }

  function angularDistanceDeg(a: [number, number], b: [number, number]): number {
    const toRad = Math.PI / 180
    const lat1 = a[1] * toRad
    const lat2 = b[1] * toRad
    const dLat = (b[1] - a[1]) * toRad
    const dLon = (b[0] - a[0]) * toRad
    const sinLat = Math.sin(dLat / 2)
    const sinLon = Math.sin(dLon / 2)
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
    return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * (180 / Math.PI)
  }

  function repositionLabels(): void {
    const map = getMap()
    if (!map || !placedLabels.length) return
    const globe = map.getProjection().type === 'globe'
    const center = map.getCenter()
    const W = map.getCanvas().clientWidth || 1280
    const H = map.getCanvas().clientHeight || 800

    for (const pl of placedLabels) {
      if (globe && angularDistanceDeg(pl.lngLat, [center.lng, center.lat]) > 75) {
        if (pl.el.style.display !== 'none') pl.el.style.display = 'none'
        continue
      }
      const p = map.project(pl.lngLat)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        if (pl.el.style.display !== 'none') pl.el.style.display = 'none'
        continue
      }
      const visible = p.x >= -100 && p.y >= -60 && p.x <= W + 100 && p.y <= H + 60
      if (pl.el.style.display === 'none' && visible) pl.el.style.display = ''
      if (visible) {
        pl.el.style.transform = `translate3d(${p.x - pl.boxW / 2}px, ${p.y - pl.boxH / 2}px, 0)`
      }
    }
  }

  function renderLabels(): void {
    const host = labelsEl.value
    if (host) host.innerHTML = ''
    placedLabels = []
    const map = getMap()
    if (!map || !lodData || !activeProviderId.value.startsWith('local:')) return
    const z = map.getZoom()
    const W = map.getCanvas().clientWidth || 1280
    const H = map.getCanvas().clientHeight || 800
    if (Math.abs(((map.getBearing() % 360) + 360) % 360) > 5 || map.getPitch() > 0.5) return
    const globe = map.getProjection().type === 'globe'
    const center = map.getCenter()
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const f = lodScreenFraction.value

    const tryPlace = (
      name: string,
      lngLat: [number, number],
      wDeg: number,
      hDeg: number,
      baseSize: number,
      minZoom: number,
      maxZoom: number
    ): void => {
      if (!name || !host) return
      if (z < minZoom || z > maxZoom) return
      if (globe && angularDistanceDeg(lngLat, [center.lng, center.lat]) > 75) return
      const p = map.project(lngLat)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
      if (p.x < -100 || p.y < -60 || p.x > W + 100 || p.y > H + 60) return
      const regionW = Math.min(W * 1.6, (wDeg / 360) * 2 ** z * 256)
      const regionH = Math.min(H * 1.6, (hDeg / 180) * 2 ** z * 256)
      if (regionW < 16 || regionH < 12) return

      let size = baseSize
      let textW = measureLabelWidth(name, size)
      while (size > 7 && textW > regionW) {
        size -= 1.5
        textW = measureLabelWidth(name, size)
      }
      if (textW > regionW) return
      const lineH = size * 1.25
      const wrap = textW > regionW * 0.9 && regionH > lineH * 2.2
      const boxW = wrap ? Math.min(textW, regionW) : textW
      const boxH = wrap ? lineH * 2 : lineH
      const x = p.x - boxW / 2
      const y = p.y - boxH / 2
      for (const r of placed) {
        if (x < r.x + r.w + 4 && x + boxW + 4 > r.x && y < r.y + r.h + 2 && y + boxH + 2 > r.y)
          return
      }
      placed.push({ x, y, w: boxW, h: boxH })
      const el = document.createElement('div')
      el.className = 'yarj-label'
      el.textContent = name
      el.style.left = '0'
      el.style.top = '0'
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
      el.style.fontSize = `${size}px`
      el.style.lineHeight = `${lineH}px`
      if (wrap) {
        el.style.width = `${boxW}px`
        el.classList.add('wrap')
      }
      host.appendChild(el)
      placedLabels.push({ el, lngLat, boxW, boxH })
    }

    for (const c of Object.values(lodData.countries)) {
      if (!c.label) continue
      tryPlace(c.name, c.label, c.w, c.h, 13, 0, 6)
    }
    for (const feat of Object.values(lodData.features)) {
      if (!feat.label) continue
      const minZ = lodMinZoom(feat, f, W, H)
      const base = feat.lvl === 'ADM1' ? 11 : 9
      tryPlace(feat.name ?? '', feat.label, feat.w, feat.h, base, minZ, 99)
    }
  }

  function applyLodFilters(): void {
    const map = getMap()
    if (!map || !lodData || !activeProviderId.value.startsWith('local:')) return
    const z = map.getZoom()
    const W = map.getCanvas().clientWidth || 1280
    const H = map.getCanvas().clientHeight || 800
    const f = lodScreenFraction.value
    const visibleAdm1: string[] = []
    const visibleAdm2: string[] = []

    for (const [id, feat] of Object.entries(lodData.features)) {
      const minZ = lodMinZoom(feat, f, W, H)
      if (z >= minZ) {
        if (feat.lvl === 'ADM1') visibleAdm1.push(id)
        else visibleAdm2.push(id)
      }
    }

    const mapId = activeProviderId.value.slice('local:'.length)
    const m = maps.value.find((x) => x.id === mapId)
    if (!m) return
    const layerIds = m.vectorLayers?.length ? m.vectorLayers : ['default']
    for (const sl of layerIds) {
      if (!isDetailLayer(sl)) continue
      const id1 = `yarj-line-${sl}-adm1`
      const id2 = `yarj-line-${sl}-adm2`
      if (map.getLayer(id1)) {
        map.setFilter(
          id1,
          detailFilter(ADM1_FILTER, visibleAdm1, adm1MinZoom.value, true, lodAllIds)
        )
      }
      if (map.getLayer(id2)) {
        map.setFilter(
          id2,
          detailFilter(ADM2_FILTER, visibleAdm2, adm2MinZoom.value, true, lodAllIds)
        )
      }
    }
  }

  function scheduleLodFilter(): void {
    if (!activeProviderId.value.startsWith('local:')) return
    if (lodFilterTimer) window.clearTimeout(lodFilterTimer)
    lodFilterTimer = window.setTimeout(() => {
      applyLodFilters()
      renderLabels()
    }, 120)
  }

  async function ensureLod(m: MapFileInfo): Promise<void> {
    const isVector =
      m.format !== 'png' && m.format !== 'jpg' && m.format !== 'jpeg' && m.format !== 'webp'
    const map = getMap()
    if (!isVector || !map) return

    const data = (await window.cockpit.command('yarj.lod-data', { id: m.id })) as LodData | null
    if (data?.features) {
      lodData = data
      lodAllIds = Object.keys(data.features)
      applyLodFilters()
      renderLabels()
      return
    }

    const status = (await window.cockpit.command('yarj.lod-status')) as
      { mapId: string; ready: boolean; running: boolean }[] | null
    const mine = status?.find((s) => s.mapId === m.id)
    if (!mine?.running) {
      void window.cockpit.command('yarj.lod', { id: m.id }).catch(() => undefined)
    }

    if (lodPollTimer) window.clearTimeout(lodPollTimer)
    const poll = async (): Promise<void> => {
      const st = (await window.cockpit.command('yarj.lod-status')) as
        { mapId: string; ready: boolean; running: boolean }[] | null
      const cur = st?.find((s) => s.mapId === m.id)
      if (cur?.ready) {
        const d = (await window.cockpit.command('yarj.lod-data', { id: m.id })) as LodData | null
        if (d?.features) {
          lodData = d
          lodAllIds = Object.keys(d.features)
          applyLodFilters()
          renderLabels()
        }
        return
      }
      if (cur?.running) {
        lodPollTimer = window.setTimeout(poll, 2000)
      }
    }
    void poll()
  }

  async function ensureHierarchy(m: MapFileInfo): Promise<void> {
    const isVector =
      m.format !== 'png' && m.format !== 'jpg' && m.format !== 'jpeg' && m.format !== 'webp'
    if (!isVector) return
    const data = (await window.cockpit.command('yarj.hierarchy-data', { id: m.id })) as {
      adm2?: Record<string, unknown>
    } | null
    if (data?.adm2) return

    const status = (await window.cockpit.command('yarj.hierarchy-status')) as
      { mapId: string; ready: boolean; running: boolean }[] | null
    const mine = status?.find((s) => s.mapId === m.id)
    if (!mine?.running) {
      void window.cockpit.command('yarj.hierarchy', { id: m.id }).catch(() => undefined)
    }
  }

  function cleanup(): void {
    if (lodFilterTimer) window.clearTimeout(lodFilterTimer)
    if (lodPollTimer) window.clearTimeout(lodPollTimer)
    const host = labelsEl.value
    if (host) host.innerHTML = ''
    placedLabels = []
  }

  return {
    repositionLabels,
    renderLabels,
    applyLodFilters,
    scheduleLodFilter,
    ensureLod,
    ensureHierarchy,
    setFontFamily,
    cleanup,
    getLodData: () => lodData,
    getLodAllIds: () => lodAllIds
  }
}
