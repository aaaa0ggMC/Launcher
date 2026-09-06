<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj' })

import { ref, computed, onMounted, onActivated, onDeactivated, onBeforeUnmount, inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import maplibregl from 'maplibre-gl'
import type {
  Map as MlMap,
  Popup,
  GeoJSONSource,
  DataDrivenPropertyValueSpecification
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import PhotoSideDrawer from './components/PhotoSideDrawer.vue'
import PhotoLightboxModal from './components/PhotoLightboxModal.vue'
import RouteSideDrawer from './components/RouteSideDrawer.vue'
import RouteDetailModal from './components/RouteDetailModal.vue'
import RouteGeotagModal from './components/RouteGeotagModal.vue'
import RoutePlaybackBar from './components/RoutePlaybackBar.vue'
import RoutePlaybackPhotosDrawer from './components/RoutePlaybackPhotosDrawer.vue'
import type {
  GeocodeResult,
  ReverseGeocodeResult,
  Photo,
  Route,
  ExploredGranularity,
  TileCacheStats,
  ProviderItem,
  JourneyData,
  JourneyStage,
  JourneyLeg,
  YarjConfig,
  GuessedGps
} from './types'
import { DEFAULT_YARJ_CONFIG, resolvePhotoGps } from './types'
import type { MapFileInfo, ScanStats, LodStatusRow, HierarchyStatusRow } from './types'
import {
  generateExploredGeoJSON,
  haversineDistM,
  simplifyCoordinates,
  getZoomLodBucket,
  getRouteToleranceForBucket,
  clearExploredCache
} from './explored-area'
import {
  buildJourneyData,
  generateJourneyLinesGeoJSON,
  generateJourneyNodesGeoJSON
} from './journey'
import { wgs84ToGcj02, gcj02ToWgs84 } from './coord-transform'
import { filterPhotosByRules } from './photo-filter'
import SearchHelpDialog from './components/SearchHelpDialog.vue'
import GpsCorrectionModal from './components/GpsCorrectionModal.vue'
import YarjControls from './components/YarjControls.vue'
import YarjPickBanner from './components/YarjPickBanner.vue'
import YarjExplorationBar from './components/YarjExplorationBar.vue'
import YarjPageMenu from './components/YarjPageMenu.vue'
import { useMapPolarSampling } from './composables/useMapPolarSampling'
import {
  useMapLODLabels,
  detailFilter,
  ADM1_FILTER,
  ADM2_FILTER,
  isDetailLayer
} from './composables/useMapLODLabels'
import { useRoutePlayback } from './composables/useRoutePlayback'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const mapEl = ref<HTMLElement | null>(null)
const labelsEl = ref<HTMLElement | null>(null)
const providers = ref<ProviderItem[]>([])
const activeProviderId = ref('google-hybrid')
const maps = ref<MapFileInfo[]>([])
const photos = ref<Photo[]>([])
const initializing = ref(true)
const initLoadingStatus = ref('')

const searchHelpOpen = ref(false)

const guessedGpsMap = computed<Map<string, GuessedGps>>(() => {
  const map = new Map<string, GuessedGps>()
  for (const p of photos.value) {
    const guess = p.gps_guess || p.appendix?.gps_guess
    if (guess && p.gps_lat == null && p.gps_lon == null) {
      map.set(p.path, guess)
    }
  }
  return map
})

const mapError = ref('')
const exploredRadiusM = ref(1000)
const adm1MinZoom = ref(4)
const adm2MinZoom = ref(6)
const lodScreenFraction = ref(0.2)

const lastView = ref<{ projection: string; center: [number, number]; zoom: number } | null>(null)

let map: MlMap | null = null
let activePopup: Popup | null = null
let resizeObserver: ResizeObserver | null = null
let viewSaveTimer: number | null = null
let labelMoveRaf: number | null = null

const scanRunning = ref(false)
const stats = ref<ScanStats | null>(null)
const lodStatus = ref<LodStatusRow[]>([])
const hierarchyStatus = ref<HierarchyStatusRow[]>([])
const showPhotosLayer = ref(true)
const showExploredLayer = ref(true)
const showRoutesLayer = ref(true)
const routes = ref<Route[]>([])
const activeRouteId = ref<string>('')
const routeDrawerOpen = ref(false)
const routeDetailModalOpen = ref(false)
const selectedRouteForDetail = ref<Route | null>(null)
const routeGeotagModalOpen = ref(false)
const selectedRouteForGeotag = ref<Route | null>(null)
const selectedGeotagInitialOffset = ref<number | undefined>(undefined)
const exploredGranularity = ref<ExploredGranularity>('standard')
const yarjConfig = ref<YarjConfig>({ ...DEFAULT_YARJ_CONFIG })
const gpsCorrectionModalOpen = ref(false)

function openRoutesDrawer(): void {
  routeDrawerOpen.value = true
}

function openRouteGeotagModal(route?: Route, initialOffset?: number): void {
  selectedRouteForGeotag.value = route ?? null
  selectedGeotagInitialOffset.value = initialOffset
  routeGeotagModalOpen.value = true
}

function onSelectRouteFromDrawer(route: Route): void {
  onFocusRouteOnMap(route)
}

function onOpenRouteDetail(route: Route): void {
  selectedRouteForDetail.value = route
  routeDetailModalOpen.value = true
}

function onToggleActiveRoute(routeId: string): void {
  activeRouteId.value = routeId
  syncRouteHighlight()
}

function onFocusRouteOnMap(route: Route): void {
  activeRouteId.value = route.id
  syncRouteHighlight()
  if (map && route.bounds) {
    let [minLon, minLat, maxLon, maxLat] = route.bounds
    if (isGcj02Active.value) {
      const [g1Lon, g1Lat] = wgs84ToGcj02(minLon, minLat)
      const [g2Lon, g2Lat] = wgs84ToGcj02(maxLon, maxLat)
      minLon = g1Lon
      minLat = g1Lat
      maxLon = g2Lon
      maxLat = g2Lat
    }
    if (minLon !== maxLon && minLat !== maxLat) {
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat]
        ],
        { padding: 80, maxZoom: 16 }
      )
    }
  }
}

function onStartGeotagFromDetail(route: Route, detectedOffsetSec?: number): void {
  openRouteGeotagModal(route, detectedOffsetSec)
}

function onViewPhotoFromRoute(photo: Photo, allPhotos?: Photo[]): void {
  routeDetailModalOpen.value = false
  const resolved = resolvePhotoGps(photo, yarjConfig.value.gpsPriority)
  const coords: [number, number] | null = resolved
    ? isGcj02Active.value
      ? wgs84ToGcj02(resolved.lon, resolved.lat)
      : [resolved.lon, resolved.lat]
    : null
  openPhotoDrawer(allPhotos && allPhotos.length ? allPhotos : [photo], coords)
}

async function onDeleteRoute(route: Route): Promise<void> {
  await window.cockpit.command('yarj.delete-route', { id: route.id })
  await refreshRoutes()
  showSnack('已删除航线记录', 'info')
}

function onGeotagStarted(): void {
  showSnack('轨迹贴合后台作业已启动，进度见后台任务面板', 'info')
}

function openGpsCorrectionModal(): void {
  gpsCorrectionModalOpen.value = true
}

async function triggerRecomputeGuesses(): Promise<void> {
  try {
    const res = (await window.cockpit.command('yarj.recompute-guesses')) as {
      ok: boolean
      count?: number
    }
    if (res?.ok) {
      showSnack(`已成功静态推算 ${res.count ?? 0} 张照片的猜测位置`, 'success')
      await refreshPhotos()
    }
  } catch (err) {
    showSnack('推算失败: ' + String(err), 'error')
  }
}

// 「我的探索」状态与数据
const GRANULARITY_LIST: ExploredGranularity[] = ['fine', 'standard', 'trip', 'coarse', 'massive']
const explorationActive = ref(false)
const explorationScope = ref<'global' | 'region'>('global')
const explorationPhotos = ref<Photo[]>([])
const explorationGranularity = ref<ExploredGranularity>('standard')
const currentStageIndex = ref(0)
const journeyData = ref<JourneyData | null>(null)
const isPlaying = ref(false)
let playTimer: number | null = null

// 探索视距与自定义站点数
const journeyFocusRange = ref(5)
const customStageCount = ref<number | null>(null)

const currentGranularityIndex = computed(() => {
  return GRANULARITY_LIST.indexOf(explorationGranularity.value)
})

const currentStage = computed<JourneyStage | null>(() => {
  if (!journeyData.value?.stages.length) return null
  return journeyData.value.stages[currentStageIndex.value] || null
})

const currentLeg = computed<JourneyLeg | null>(() => {
  if (!journeyData.value?.legs.length) return null
  if (currentStageIndex.value === 0) {
    return journeyData.value.legs[0] || null
  }
  return journeyData.value.legs[currentStageIndex.value - 1] || null
})

const isGlobe = ref(true)
const pruneConfirmDialogOpen = ref(false)
const pruneRunning = ref(false)

const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('success')

function showSnack(text: string, color = 'success'): void {
  snackText.value = text
  snackColor.value = color
  snackOpen.value = true
}

async function handleSolidifyGps(): Promise<void> {
  showSnack(t('yarj.guess.solidified', '已成功固化该照片的 GPS 位置！'), 'success')
  await refreshPhotos()
}

const activeProvider = computed<ProviderItem | undefined>(() => {
  return providers.value.find((x) => x.id === activeProviderId.value)
})

const activeProviderName = computed(() => {
  const p = activeProvider.value
  return p ? p.name : activeProviderId.value
})

const isGcj02Active = computed<boolean>(() => {
  return activeProvider.value?.coordSystem === 'gcj02'
})

const displayPhotos = computed<Photo[]>(() => {
  const filtered = filterPhotosByRules(photos.value, yarjConfig.value.photoFilterRules)
  return filtered.map((p) => {
    const resolved = resolvePhotoGps(p, yarjConfig.value.gpsPriority)
    if (!resolved) {
      return {
        ...p,
        gps_lat: null,
        gps_lon: null
      }
    }
    if (isGcj02Active.value) {
      const [gLng, gLat] = wgs84ToGcj02(resolved.lon, resolved.lat)
      return {
        ...p,
        gps_lon: gLng,
        gps_lat: gLat
      }
    }
    return {
      ...p,
      gps_lon: resolved.lon,
      gps_lat: resolved.lat
    }
  })
})

// ---------------------------------------------------------------------------
// 主题色
// ---------------------------------------------------------------------------

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function themeRgba(alpha: number): string {
  const [r, g, b] = cssVar('--v-theme-primary')
    .split(',')
    .map((s) => s.trim())
  return `rgba(${r || '103'}, ${g || '80'}, ${b || '164'}, ${alpha})`
}

// ---------------------------------------------------------------------------
// 地图样式与构建
// ---------------------------------------------------------------------------

function buildMbtilesStyle(
  m: MapFileInfo,
  projection: 'globe' | 'mercator'
): maplibregl.StyleSpecification {
  const tiles = [`cockpit-tile://${m.id}/{z}/{x}/{y}`]
  const base = {
    version: 8 as const,
    projection: { type: projection } as maplibregl.StyleSpecification['projection'],
    sources: {
      tiles:
        m.format === 'png' || m.format === 'jpg' || m.format === 'jpeg' || m.format === 'webp'
          ? {
              type: 'raster' as const,
              tiles,
              tileSize: 256,
              minzoom: m.minzoom ?? 0,
              maxzoom: m.maxzoom ?? 14
            }
          : {
              type: 'vector' as const,
              tiles,
              minzoom: m.minzoom ?? 0,
              maxzoom: m.maxzoom ?? 14
            }
    },
    layers: [] as maplibregl.LayerSpecification[]
  }
  if (base.sources.tiles.type === 'vector') {
    const layerIds = m.vectorLayers?.length ? m.vectorLayers : ['default']
    for (const sl of layerIds) {
      if (isDetailLayer(sl)) {
        base.layers.push({
          id: `yarj-line-${sl}-adm1`,
          type: 'line',
          source: 'tiles',
          'source-layer': sl,
          filter: detailFilter(ADM1_FILTER, [], adm1MinZoom.value),
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': themeRgba(0.5),
            'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 6, 1.1, 10, 1.5],
            'line-blur': 0.5
          }
        })
        base.layers.push({
          id: `yarj-line-${sl}-adm2`,
          type: 'line',
          source: 'tiles',
          'source-layer': sl,
          filter: detailFilter(ADM2_FILTER, [], adm2MinZoom.value),
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': themeRgba(0.32),
            'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 10, 0.9],
            'line-blur': 0.3
          }
        })
      } else {
        base.layers.push({
          id: `yarj-fill-${sl}`,
          type: 'fill',
          source: 'tiles',
          'source-layer': sl,
          paint: {
            'fill-color': themeRgba(0.1),
            'fill-outline-color': 'rgba(0,0,0,0)'
          }
        })
        base.layers.push({
          id: `yarj-line-${sl}`,
          type: 'line',
          source: 'tiles',
          'source-layer': sl,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': themeRgba(0.85),
            'line-width': 1
          }
        })
      }
    }
  } else {
    base.layers.push({ id: 'yarj-raster', type: 'raster', source: 'tiles' })
  }
  return base
}

function buildStyleForProvider(
  providerId: string,
  projection: 'globe' | 'mercator'
): maplibregl.StyleSpecification {
  if (providerId.startsWith('local:')) {
    const mapId = providerId.slice('local:'.length)
    const m = maps.value.find((x) => x.id === mapId)
    if (m) {
      return buildMbtilesStyle(m, projection)
    }
  }

  const p = providers.value.find((x) => x.id === providerId)
  const maxz = p?.maxZoom ?? 20
  const minz = p?.minZoom ?? 0
  const tiles = [`cockpit-tile://online/${providerId}/{z}/{x}/{y}`]

  return {
    version: 8,
    projection: { type: projection },
    sources: {
      'online-tiles': {
        type: 'raster',
        tiles,
        tileSize: 256,
        minzoom: minz,
        maxzoom: maxz
      }
    },
    layers: [
      {
        id: 'online-raster-layer',
        type: 'raster',
        source: 'online-tiles',
        minzoom: minz,
        maxzoom: maxz + 2,
        paint: {
          'raster-resampling': 'linear',
          'raster-fade-duration': 100
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// 地图初始化与切换
// ---------------------------------------------------------------------------

async function initMap(targetProviderId?: string): Promise<void> {
  if (!mapEl.value) return
  if (map) {
    map.remove()
    map = null
  }
  activePopup?.remove()
  activePopup = null
  mapError.value = ''

  const cfg = (await window.cockpit.command('yarj.config')) as YarjConfig
  yarjConfig.value = { ...DEFAULT_YARJ_CONFIG, ...cfg }
  showPhotosLayer.value = yarjConfig.value.showPhotosLayer !== false
  showExploredLayer.value = yarjConfig.value.showExploredLayer !== false
  showRoutesLayer.value = yarjConfig.value.showRoutesLayer !== false
  exploredRadiusM.value =
    yarjConfig.value.exploredRadiusM != null && yarjConfig.value.exploredRadiusM < 400
      ? yarjConfig.value.exploredRadiusM
      : 60
  exploredGranularity.value = yarjConfig.value.exploredGranularity ?? 'standard'
  explorationGranularity.value =
    yarjConfig.value.explorationGranularity || yarjConfig.value.exploredGranularity || 'standard'
  adm1MinZoom.value = yarjConfig.value.adm1MinZoom ?? 4
  adm2MinZoom.value = yarjConfig.value.adm2MinZoom ?? 6
  lodScreenFraction.value = yarjConfig.value.lodScreenFraction ?? 0.2
  lastView.value = yarjConfig.value.lastView ?? null

  const pId = targetProviderId || yarjConfig.value.activeProviderId || 'google-hybrid'
  activeProviderId.value = pId

  try {
    let proj: 'globe' | 'mercator' = 'globe'
    if (yarjConfig.value.defaultProjection === 'mercator') {
      proj = 'mercator'
    } else if (yarjConfig.value.defaultProjection === 'globe') {
      proj = 'globe'
    } else {
      proj = (lastView.value?.projection as 'globe' | 'mercator') ?? 'globe'
    }
    const style = buildStyleForProvider(pId, proj)
    map = new maplibregl.Map({
      container: mapEl.value,
      style,
      center: lastView.value?.center ?? [116.4, 39.9],
      zoom: lastView.value?.zoom ?? 3,
      attributionControl: false,
      renderWorldCopies: true,
      minZoom: 0,
      maxZoom: 22,
      maxTileCacheSize: 500,
      fadeDuration: 50
    })

    if (yarjConfig.value.doubleClickAction === 'none') {
      map.doubleClickZoom.disable()
    }
  } catch (err) {
    mapError.value = String(err)
    return
  }

  isGlobe.value = map.getProjection()?.type === 'globe'

  map.on('error', (e) => {
    const msg = e?.error ? String((e.error as Error).message ?? e.error) : 'unknown'
    if (!msg.includes('Canceled')) mapError.value = msg
  })

  map.on('load', () => {
    setupPolarCapsLayer()
    setupExploredLayer()
    setupRoutesLayers()
    updateRoutesSource(true)
    updateExplored(true)
    setupPhotosLayer()
    setupJourneyLayers()
    updateJourneyLayers()
    applyLayerVisibility()
    if (pId.startsWith('local:')) {
      renderLabels()
    }
  })

  map.on('click', (e) => {
    if (relocatingPhotos.value) {
      let { lng, lat } = e.lngLat
      if (isGcj02Active.value) {
        const [wgsLng, wgsLat] = gcj02ToWgs84(lng, lat)
        lng = wgsLng
        lat = wgsLat
      }
      pendingRelocateTarget.value = { lat, lon: lng }
      confirmRelocateDialogOpen.value = true
      return
    }
    if (pickingGpsPhoto.value) {
      let { lng, lat } = e.lngLat
      if (isGcj02Active.value) {
        const [wgsLng, wgsLat] = gcj02ToWgs84(lng, lat)
        lng = wgsLng
        lat = wgsLat
      }
      pendingGpsCoords.value = { lat, lon: lng }
      pendingGpsAddress.value = null
      pendingGpsGeocoding.value = false
      confirmGpsDialogOpen.value = true
    }
  })

  // 如果是本地 MBTiles，才跑 LOD
  if (pId.startsWith('local:')) {
    const mapId = pId.slice('local:'.length)
    const m = maps.value.find((x) => x.id === mapId)
    if (m) {
      void ensureLod(m)
      void ensureHierarchy(m)
    }
  } else {
    cleanupLod()
  }

  map.on('moveend', () => {
    if (activeProviderId.value.startsWith('local:')) {
      scheduleLodFilter()
    }
    if (viewSaveTimer) window.clearTimeout(viewSaveTimer)
    viewSaveTimer = window.setTimeout(() => {
      const c = map?.getCenter()
      const z = map?.getZoom()
      if (!map || !c) return
      void window.cockpit
        .command('yarj.save-config', {
          patch: {
            lastView: {
              projection: isGlobe.value ? 'globe' : 'mercator',
              center: [c.lng, c.lat],
              zoom: z
            }
          }
        })
        .catch(() => undefined)
    }, 1500)
  })

  map.on('zoomend', () => {
    if (!map) return
    const curZ = map.getZoom()
    const bucket = getZoomLodBucket(curZ)
    if (bucket !== lastRenderedRouteLodBucket) {
      updateRoutesSource()
    }
    if (showExploredLayer.value && bucket !== lastRenderedExploredLodBucket) {
      updateExplored()
    }
  })

  map.getCanvas().addEventListener(
    'wheel',
    (e) => {
      if (routePlaybackActive.value && routePlaybackFollowCamera.value) {
        e.preventDefault()
        const zoomDelta = -e.deltaY * 0.0015
        requestPlaybackZoom(zoomDelta)
      }
    },
    { passive: false }
  )

  map.on('dragstart', () => {
    handleMapDragStart()
  })

  map.on('move', () => {
    if (activeProviderId.value.startsWith('local:')) {
      if (labelMoveRaf != null) return
      labelMoveRaf = window.requestAnimationFrame(() => {
        labelMoveRaf = null
        repositionLabels()
      })
    }
  })
}

async function switchProvider(newId: string): Promise<void> {
  activeProviderId.value = newId
  await window.cockpit.command('yarj.set-active-provider', { id: newId })
  if (!map) {
    await initMap(newId)
    return
  }
  const proj = isGlobe.value ? 'globe' : 'mercator'
  const style = buildStyleForProvider(newId, proj)
  map.setStyle(style)
  map.once('style.load', () => {
    clearExploredCache()
    setupPolarCapsLayer()
    setupExploredLayer()
    setupRoutesLayers()
    updateRoutesSource(true)
    updateExplored(true)
    setupPhotosLayer()
    setupJourneyLayers()
    applyLayerVisibility()
    if (explorationActive.value) {
      explorationPhotos.value = displayPhotos.value
      journeyData.value = buildJourneyData(
        explorationPhotos.value,
        explorationGranularity.value,
        customStageCount.value ?? undefined
      )
    }
    updateJourneyLayers()
    if (newId.startsWith('local:')) {
      const mapId = newId.slice('local:'.length)
      const m = maps.value.find((x) => x.id === mapId)
      if (m) {
        void ensureLod(m)
        void ensureHierarchy(m)
      }
      renderLabels()
    } else {
      if (labelsEl.value) labelsEl.value.innerHTML = ''
    }
  })
  showSnack(t('yarj.providers.switched', '已切换当前地图图源'))
}

// ---------------------------------------------------------------------------
// 标签与 LOD（仅本地 MBTiles 使用）及极地采样（委托给 composables）
// ---------------------------------------------------------------------------

const {
  renderLabels,
  repositionLabels,
  scheduleLodFilter,
  ensureLod,
  ensureHierarchy,
  setFontFamily,
  cleanup: cleanupLod
} = useMapLODLabels({
  getMap: () => map,
  labelsEl,
  activeProviderId,
  maps,
  lodScreenFraction,
  adm1MinZoom,
  adm2MinZoom
})

const { setupPolarCapsLayer } = useMapPolarSampling(() => map, activeProviderId)

// ---------------------------------------------------------------------------
// 探索区域
// ---------------------------------------------------------------------------

function setupExploredLayer(): void {
  if (!map) return
  if (map.getSource('yarj-explored')) return
  map.addSource('yarj-explored', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  // 1. 半透明发光探索区域填充（Fill）
  map.addLayer({
    id: 'yarj-explored-fill',
    type: 'fill',
    source: 'yarj-explored',
    paint: {
      'fill-color': themeRgba(0.25),
      'fill-opacity': yarjConfig.value.footprintOpacity ?? 0.52
    }
  })

  // 2. 探索区域发光轮廓边界（Line）
  map.addLayer({
    id: 'yarj-explored-line',
    type: 'line',
    source: 'yarj-explored',
    paint: {
      'line-color': themeRgba(0.8),
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 12, 1.5, 17, 2.2],
      'line-blur': 0.5,
      'line-opacity': 0.85
    }
  })
}

let updateExploredRaf = 0
let lastRenderedExploredLodBucket = -1

function updateExplored(force = false): void {
  if (!map) return
  const src = map.getSource('yarj-explored') as GeoJSONSource | undefined
  if (!src) return

  // 用户未开启探索图层，立即清空并直接退出，彻底避免卡顿与无谓计算
  if (!showExploredLayer.value) {
    src.setData({ type: 'FeatureCollection', features: [] })
    return
  }

  const bucket = getZoomLodBucket(map.getZoom())
  if (!force && bucket === lastRenderedExploredLodBucket) return

  // 防抖 / 合并至下一帧微任务，避免启动时或连续事件中高频重复计算
  if (updateExploredRaf) cancelAnimationFrame(updateExploredRaf)
  updateExploredRaf = requestAnimationFrame(() => {
    updateExploredRaf = 0
    if (!map || !showExploredLayer.value) return
    const s = map.getSource('yarj-explored') as GeoJSONSource | undefined
    if (!s) return
    const curBucket = getZoomLodBucket(map.getZoom())
    lastRenderedExploredLodBucket = curBucket
    const geojson = generateExploredGeoJSON(
      displayPhotos.value,
      exploredGranularity.value,
      exploredRadiusM.value,
      showRoutesLayer.value ? routes.value : undefined,
      isGcj02Active.value,
      curBucket
    )
    s.setData(geojson)
  })
}

interface RouteLineFeature {
  type: 'Feature'
  id: string
  properties: {
    id: string
    name: string
    activity_type?: string
    distance_km: string
    start_time: string | null
  }
  geometry: {
    type: 'LineString'
    coordinates: [number, number][]
  }
}

interface RoutesGeoJSON {
  type: 'FeatureCollection'
  features: RouteLineFeature[]
}

function buildRoutesGeoJSON(bucket?: number): RoutesGeoJSON {
  const b = bucket ?? (map ? getZoomLodBucket(map.getZoom()) : 2)
  const tol = getRouteToleranceForBucket(b)
  const features: RouteLineFeature[] = []
  for (const r of routes.value) {
    try {
      const parsed = JSON.parse(r.geojson) as {
        geometry?: { type?: string; coordinates?: [number, number][] }
      }
      if (parsed?.geometry?.coordinates) {
        let rawCoords = parsed.geometry.coordinates
        if (tol > 0 && rawCoords.length > 4) {
          rawCoords = simplifyCoordinates(rawCoords, tol)
        }
        const coordinates = isGcj02Active.value
          ? rawCoords.map(([lon, lat]) => wgs84ToGcj02(lon, lat))
          : rawCoords
        features.push({
          type: 'Feature',
          id: r.id,
          properties: {
            id: r.id,
            name: r.name,
            activity_type: r.activityType,
            distance_km: (r.totalDistanceM / 1000).toFixed(1),
            start_time: r.startTime
          },
          geometry: {
            type: 'LineString',
            coordinates
          }
        })
      }
    } catch {
      // ignore
    }
  }
  return {
    type: 'FeatureCollection',
    features
  }
}

function getRouteLineWidthExpression(
  activeId: string
): DataDrivenPropertyValueSpecification<number> {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    7,
    0,
    9,
    ['case', ['==', ['get', 'id'], activeId], 2.5, 1],
    12,
    ['case', ['==', ['get', 'id'], activeId], 5, 2.5],
    17,
    ['case', ['==', ['get', 'id'], activeId], 7, 4]
  ] as unknown as DataDrivenPropertyValueSpecification<number>
}

function getRouteGlowWidthExpression(
  activeId: string
): DataDrivenPropertyValueSpecification<number> {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    7,
    0,
    9,
    ['case', ['==', ['get', 'id'], activeId], 4, 1.5],
    12,
    ['case', ['==', ['get', 'id'], activeId], 10, 6],
    17,
    ['case', ['==', ['get', 'id'], activeId], 16, 10]
  ] as unknown as DataDrivenPropertyValueSpecification<number>
}

function getRouteGlowOpacityExpression(
  activeId: string
): DataDrivenPropertyValueSpecification<number> {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    7,
    0,
    8.5,
    0,
    10,
    ['case', ['==', ['literal', activeId], ''], 0.15, ['==', ['get', 'id'], activeId], 0.4, 0.01],
    12,
    ['case', ['==', ['literal', activeId], ''], 0.45, ['==', ['get', 'id'], activeId], 0.75, 0.03],
    14,
    ['case', ['==', ['literal', activeId], ''], 0.6, ['==', ['get', 'id'], activeId], 0.9, 0.05]
  ] as unknown as DataDrivenPropertyValueSpecification<number>
}

function getRouteLineOpacityExpression(
  activeId: string
): DataDrivenPropertyValueSpecification<number> {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    7,
    0,
    8.5,
    ['case', ['==', ['literal', activeId], ''], 0.1, ['==', ['get', 'id'], activeId], 0.35, 0.02],
    10,
    ['case', ['==', ['literal', activeId], ''], 0.35, ['==', ['get', 'id'], activeId], 0.7, 0.05],
    12,
    ['case', ['==', ['literal', activeId], ''], 0.75, ['==', ['get', 'id'], activeId], 0.95, 0.1],
    14,
    ['case', ['==', ['literal', activeId], ''], 0.85, ['==', ['get', 'id'], activeId], 1.0, 0.12]
  ] as unknown as DataDrivenPropertyValueSpecification<number>
}

function setupRoutesLayers(): void {
  if (!map) return
  if (map.getSource('yarj-routes')) return

  map.addSource('yarj-routes', {
    type: 'geojson',
    data: buildRoutesGeoJSON()
  })

  // 1. 底层光晕（随着拉远距离逐渐淡化并消失）
  map.addLayer({
    id: 'yarj-routes-glow',
    type: 'line',
    source: 'yarj-routes',
    minzoom: 7,
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': '#00e5ff',
      'line-width': getRouteGlowWidthExpression(activeRouteId.value || ''),
      'line-blur': ['interpolate', ['linear'], ['zoom'], 7, 1, 12, 4, 17, 6],
      'line-opacity': getRouteGlowOpacityExpression(activeRouteId.value || '')
    }
  })

  // 2. 顶层实体主轨迹线（随着拉远距离逐渐淡化并消失）
  map.addLayer({
    id: 'yarj-routes-line',
    type: 'line',
    source: 'yarj-routes',
    minzoom: 7,
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': '#00e5ff',
      'line-width': getRouteLineWidthExpression(activeRouteId.value || ''),
      'line-opacity': getRouteLineOpacityExpression(activeRouteId.value || '')
    }
  })

  const onRouteClick = (
    e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
  ): void => {
    if (map && map.getZoom() < 8) return
    const feat = e.features?.[0]
    if (feat?.properties?.id) {
      const r = routes.value.find((x) => x.id === feat.properties?.id)
      if (r) {
        onOpenRouteDetail(r)
      }
    }
  }

  map.on('click', 'yarj-routes-line', onRouteClick)
  map.on('click', 'yarj-routes-glow', onRouteClick)

  map.on('mouseenter', 'yarj-routes-line', () => {
    if (map && map.getZoom() >= 8) map.getCanvas().style.cursor = 'pointer'
  })
  map.on('mouseleave', 'yarj-routes-line', () => {
    if (map) map.getCanvas().style.cursor = ''
  })
}

let lastRenderedRouteLodBucket = -1

function updateRoutesSource(force = false): void {
  if (!map) return
  const src = map.getSource('yarj-routes') as GeoJSONSource | undefined
  if (!src) return
  const bucket = getZoomLodBucket(map.getZoom())
  if (!force && bucket === lastRenderedRouteLodBucket) return
  lastRenderedRouteLodBucket = bucket
  src.setData(buildRoutesGeoJSON(bucket))
}

function syncRouteHighlight(): void {
  if (!map) return
  const activeId = activeRouteId.value || ''

  if (map.getLayer('yarj-routes-glow')) {
    map.setPaintProperty(
      'yarj-routes-glow',
      'line-opacity',
      getRouteGlowOpacityExpression(activeId)
    )
    map.setPaintProperty('yarj-routes-glow', 'line-width', getRouteGlowWidthExpression(activeId))
  }

  if (map.getLayer('yarj-routes-line')) {
    map.setPaintProperty(
      'yarj-routes-line',
      'line-opacity',
      getRouteLineOpacityExpression(activeId)
    )
    map.setPaintProperty('yarj-routes-line', 'line-width', getRouteLineWidthExpression(activeId))
  }
}

async function setExploredGranularity(g: ExploredGranularity): Promise<void> {
  exploredGranularity.value = g
  updateExplored()
  await window.cockpit
    .command('yarj.save-config', {
      patch: { exploredGranularity: g }
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// 「我的探索」图层与交互逻辑
// ---------------------------------------------------------------------------

function setupJourneyLayers(): void {
  if (!map) return
  if (map.getSource('yarj-journey-lines')) return

  // 1. 全部大圆航线与轨迹
  map.addSource('yarj-journey-lines', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  // 2. 当前高亮航段
  map.addSource('yarj-journey-active-leg', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  // 3. 阶段节点
  map.addSource('yarj-journey-nodes', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  })

  // 底层轨迹发光光晕
  map.addLayer({
    id: 'yarj-journey-line-glow',
    type: 'line',
    source: 'yarj-journey-lines',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 4.5,
      'line-opacity': 0.38,
      'line-blur': 2
    }
  })

  // 主轨迹线
  map.addLayer({
    id: 'yarj-journey-line-main',
    type: 'line',
    source: 'yarj-journey-lines',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 2.8,
      'line-opacity': ['coalesce', ['get', 'opacity'], 0.6]
    }
  })

  // 激活航段发光
  map.addLayer({
    id: 'yarj-journey-active-glow',
    type: 'line',
    source: 'yarj-journey-active-leg',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 7,
      'line-opacity': 0.65,
      'line-blur': 3
    }
  })

  // 激活航段白亮实线
  map.addLayer({
    id: 'yarj-journey-active-line',
    type: 'line',
    source: 'yarj-journey-active-leg',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': '#ffffff',
      'line-width': 3.5,
      'line-opacity': 0.95
    }
  })

  // 节点外围脉冲光晕
  map.addLayer({
    id: 'yarj-journey-node-glow',
    type: 'circle',
    source: 'yarj-journey-nodes',
    paint: {
      'circle-radius': ['coalesce', ['get', 'glowRadius'], 14],
      'circle-color': ['case', ['get', 'isActive'], themeRgba(0.9), 'rgba(255, 255, 255, 0.5)'],
      'circle-blur': 0.5,
      'circle-opacity': ['coalesce', ['get', 'glowOpacity'], 0.8]
    }
  })

  // 节点实心底盘
  map.addLayer({
    id: 'yarj-journey-node-circle',
    type: 'circle',
    source: 'yarj-journey-nodes',
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 9],
      'circle-color': ['case', ['get', 'isActive'], '#ffffff', 'rgba(15, 23, 42, 0.9)'],
      'circle-stroke-width': 2,
      'circle-stroke-color': [
        'case',
        ['get', 'isActive'],
        themeRgba(1),
        'rgba(255, 255, 255, 0.85)'
      ],
      'circle-opacity': ['coalesce', ['get', 'opacity'], 1.0],
      'circle-stroke-opacity': ['coalesce', ['get', 'opacity'], 1.0]
    }
  })

  // 节点序号
  map.addLayer({
    id: 'yarj-journey-node-text',
    type: 'symbol',
    source: 'yarj-journey-nodes',
    layout: {
      'text-field': ['get', 'displayNumber'],
      'text-size': 11,
      'text-allow-overlap': true,
      'text-ignore-placement': true
    },
    paint: {
      'text-color': ['case', ['get', 'isActive'], '#0f172a', '#ffffff'],
      'text-opacity': ['coalesce', ['get', 'opacity'], 1.0]
    }
  })

  map.on('click', 'yarj-journey-node-circle', (e) => {
    const p = e.features?.[0]?.properties
    if (p && typeof p.index === 'number') {
      goToStage(p.index)
    }
  })
}

function updateJourneyLayers(): void {
  if (!map) return
  const linesSrc = map.getSource('yarj-journey-lines') as GeoJSONSource | undefined
  const activeLegSrc = map.getSource('yarj-journey-active-leg') as GeoJSONSource | undefined
  const nodesSrc = map.getSource('yarj-journey-nodes') as GeoJSONSource | undefined

  if (!explorationActive.value || !journeyData.value || !journeyData.value.stages.length) {
    linesSrc?.setData({ type: 'FeatureCollection', features: [] })
    activeLegSrc?.setData({ type: 'FeatureCollection', features: [] })
    nodesSrc?.setData({ type: 'FeatureCollection', features: [] })
    return
  }

  const { allLines, activeLeg } = generateJourneyLinesGeoJSON(
    journeyData.value.legs,
    currentStageIndex.value,
    journeyFocusRange.value
  )
  const nodes = generateJourneyNodesGeoJSON(
    journeyData.value.stages,
    currentStageIndex.value,
    journeyFocusRange.value
  )

  linesSrc?.setData(allLines)
  activeLegSrc?.setData(activeLeg)
  nodesSrc?.setData(nodes)
}

function setJourneyFocusRange(range: number): void {
  journeyFocusRange.value = range
  updateJourneyLayers()
}

function setTargetCount(count: number): void {
  customStageCount.value = count
  rebuildJourney()
}

function resetToGranularity(): void {
  customStageCount.value = null
  rebuildJourney()
}

// ---------------------------------------------------------------------------
// 旅途时空穿梭时间指示器
// ---------------------------------------------------------------------------
const displayedTimestamp = ref<number | null>(null)
const isTimeShuttling = ref(false)
let timeShuttleAnimId: number | null = null

const displayDatePart = computed(() => {
  if (!displayedTimestamp.value || Number.isNaN(displayedTimestamp.value)) return '----.--.--'
  const d = new Date(displayedTimestamp.value)
  if (Number.isNaN(d.getTime())) return '----.--.--'
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}.${mm}.${dd}`
})

const displayTimePart = computed(() => {
  if (!displayedTimestamp.value || Number.isNaN(displayedTimestamp.value)) return '--:--:--'
  const d = new Date(displayedTimestamp.value)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${min}:${ss}`
})

function animateTimeTo(targetMs: number | null, durationMs = 1200): void {
  if (timeShuttleAnimId != null) {
    cancelAnimationFrame(timeShuttleAnimId)
    timeShuttleAnimId = null
  }
  if (targetMs == null) {
    displayedTimestamp.value = null
    isTimeShuttling.value = false
    return
  }
  const startMs = displayedTimestamp.value ?? targetMs
  if (startMs === targetMs) {
    displayedTimestamp.value = targetMs
    isTimeShuttling.value = false
    return
  }

  isTimeShuttling.value = true
  const startTime = performance.now()

  function step(now: number): void {
    const elapsed = now - startTime
    const progress = Math.min(1, elapsed / durationMs)
    const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
    displayedTimestamp.value = Math.round(startMs + (targetMs! - startMs) * ease)

    if (progress < 1) {
      timeShuttleAnimId = requestAnimationFrame(step)
    } else {
      displayedTimestamp.value = targetMs
      timeShuttleAnimId = null
      isTimeShuttling.value = false
    }
  }

  timeShuttleAnimId = requestAnimationFrame(step)
}

function rebuildJourney(): void {
  if (!explorationActive.value || !explorationPhotos.value.length) return
  journeyData.value = buildJourneyData(
    explorationPhotos.value,
    explorationGranularity.value,
    customStageCount.value ?? undefined
  )
  const maxIdx = Math.max(0, journeyData.value.stages.length - 1)
  currentStageIndex.value = Math.min(currentStageIndex.value, maxIdx)
  const targetStage = journeyData.value.stages[currentStageIndex.value]
  if (targetStage?.startTime != null) {
    animateTimeTo(targetStage.startTime, 600)
  }
  updateJourneyLayers()
  focusStage(currentStageIndex.value)

  if (drawerOpen.value && currentStage.value) {
    drawerPhotos.value = currentStage.value.photos
    drawerCoords.value = currentStage.value.center
  }
}

function getFlightDurationMs(): number {
  switch (yarjConfig.value.flightSpeed) {
    case 'cinematic':
      return 2500
    case 'brisk':
      return 800
    case 'instant':
      return 0
    case 'smooth':
    default:
      return 1400
  }
}

function getCruiseIntervalMs(): number {
  const staySec = yarjConfig.value.cruiseStayDurationSec ?? 2.2
  return Math.max(1000, Math.round(staySec * 1000))
}

function focusStage(index: number): void {
  if (!map || !journeyData.value?.stages.length) return
  const stage = journeyData.value.stages[index]
  if (!stage) return

  const [minLon, minLat, maxLon, maxLat] = stage.bounds
  const spanLon = Math.abs(maxLon - minLon)
  const spanLat = Math.abs(maxLat - minLat)
  const duration = getFlightDurationMs()

  // 如果阶段包含多张较分散照片，fitBounds 自适应视野
  if (spanLon > 0.005 || spanLat > 0.005) {
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat]
      ],
      {
        padding: { top: 80, bottom: 200, left: 80, right: 80 },
        maxZoom: 14,
        duration
      }
    )
  } else {
    map.flyTo({
      center: stage.center,
      zoom: Math.min(Math.max(map.getZoom(), 11), 14),
      duration
    })
  }
}

function goToStage(index: number): void {
  if (!journeyData.value?.stages.length) return
  const maxIdx = journeyData.value.stages.length - 1
  currentStageIndex.value = Math.max(0, Math.min(index, maxIdx))
  const targetStage = journeyData.value.stages[currentStageIndex.value]

  if (targetStage?.startTime != null) {
    animateTimeTo(targetStage.startTime, isPlaying.value ? 2200 : 1200)
  }

  updateJourneyLayers()
  focusStage(currentStageIndex.value)

  if (
    currentStage.value &&
    (drawerOpen.value || (isPlaying.value && yarjConfig.value.autoOpenDrawerOnCruise))
  ) {
    drawerPhotos.value = currentStage.value.photos
    drawerCoords.value = currentStage.value.center
    if (!drawerOpen.value) {
      drawerOpen.value = true
    }
  }
}

function prevStage(): void {
  if (currentStageIndex.value > 0) {
    goToStage(currentStageIndex.value - 1)
  }
}

function nextStage(): void {
  if (
    journeyData.value?.stages.length &&
    currentStageIndex.value < journeyData.value.stages.length - 1
  ) {
    goToStage(currentStageIndex.value + 1)
  } else if (isPlaying.value) {
    stopPlay()
  }
}

function startExploration(subsetPhotos?: Photo[]): void {
  if (routePlaybackActive.value) {
    stopRoutePlayback()
  }
  const basePhotos = subsetPhotos && subsetPhotos.length ? subsetPhotos : displayPhotos.value
  const targetPhotos = basePhotos.map((p) => {
    const resolved = resolvePhotoGps(p)
    if (!resolved) {
      return { ...p, gps_lat: null, gps_lon: null }
    }
    if (isGcj02Active.value) {
      if (p.gps_lat != null && p.gps_lon != null) return p
      const [gLng, gLat] = wgs84ToGcj02(resolved.lon, resolved.lat)
      return { ...p, gps_lon: gLng, gps_lat: gLat }
    }
    return {
      ...p,
      gps_lon: p.gps_lon ?? resolved.lon,
      gps_lat: p.gps_lat ?? resolved.lat
    }
  })
  const valid = targetPhotos.filter((p) => p.gps_lat != null && p.gps_lon != null)
  if (!valid.length) {
    showSnack(
      t('yarj.map.noGpsPhotos', '当前范围内暂无包含 GPS 定位的照片，无法生成探索轨迹'),
      'warning'
    )
    return
  }

  explorationScope.value = subsetPhotos ? 'region' : 'global'
  explorationPhotos.value = targetPhotos
  explorationActive.value = true
  drawerOpen.value = false
  applyLayerVisibility()

  journeyData.value = buildJourneyData(
    targetPhotos,
    explorationGranularity.value,
    customStageCount.value ?? undefined
  )
  currentStageIndex.value = 0
  displayedTimestamp.value = journeyData.value.stages[0]?.startTime ?? null
  updateJourneyLayers()
  focusStage(0)

  if (yarjConfig.value.autoPlayOnExplore) {
    startPlay()
  }
}

function startExplorationFromMenu(): void {
  startExploration()
}

function exitExploration(): void {
  stopPlay()
  if (timeShuttleAnimId != null) {
    cancelAnimationFrame(timeShuttleAnimId)
    timeShuttleAnimId = null
  }
  isTimeShuttling.value = false
  displayedTimestamp.value = null
  explorationActive.value = false
  applyLayerVisibility()
  updateJourneyLayers()
}

// ---------------------------------------------------------------------------
// 航线时间轴生长动画与行程播放 (Route Journey Playback - 委托给 useRoutePlayback)
// ---------------------------------------------------------------------------

const {
  routePlaybackActive,
  routePlaybackRoute,
  routePlaybackPhotos,
  routePlaybackOffsetSec,
  routePlaybackIsLocalTime,
  routePlaybackIsPlaying,
  routePlaybackProgress,
  routePlaybackSpeed,
  routePlaybackFollowCamera,
  routePlaybackPhotosDrawerOpen,
  routePlaybackTimeWindowSec,
  routePlaybackCurrentTimeMs,
  routePlaybackCurrentPoint,
  currentWindowPhotos,
  playbackCurrentTimeStr,
  playbackElapsedDurationStr,
  playbackTotalDurationStr,
  playbackCurrentDistStr,
  playbackTotalDistStr,
  reCenterPlaybackCamera,
  requestPlaybackZoom,
  toggleRoutePlaybackPlay,
  startRoutePlayback,
  stopRoutePlayback,
  onRoutePlaybackProgressChange,
  onRoutePlaybackJumpTime,
  onRoutePlaybackJumpToSplit,
  handleMapDragStart,
  toggleRoutePlaybackPhotosDrawer
} = useRoutePlayback({
  getMap: () => map,
  themeRgba,
  isGcj02Active,
  yarjConfig,
  onBeforeStart: () => {
    exitExploration()
    closePhotoDrawer()
    routeDetailModalOpen.value = false
  }
})

function onSelectPhotoFromPlayback(payload: {
  photo: Photo
  index: number
  allPhotos: Photo[]
}): void {
  lightboxPhotos.value = payload.allPhotos
  lightboxIndex.value = payload.index
  lightboxOpen.value = true
}

function cycleExplorationGranularity(delta: -1 | 1): void {
  const idx = currentGranularityIndex.value
  const nextIdx = idx + delta
  if (nextIdx >= 0 && nextIdx < GRANULARITY_LIST.length) {
    void setExplorationGranularity(GRANULARITY_LIST[nextIdx])
  }
}

async function setExplorationGranularity(g: ExploredGranularity): Promise<void> {
  customStageCount.value = null
  explorationGranularity.value = g
  await window.cockpit
    .command('yarj.save-config', {
      patch: { explorationGranularity: g }
    })
    .catch(() => undefined)

  rebuildJourney()
}

function startPlay(): void {
  if (!journeyData.value?.stages.length) return
  isPlaying.value = true
  if (currentStageIndex.value >= journeyData.value.stages.length - 1) {
    currentStageIndex.value = 0
    updateJourneyLayers()
    focusStage(0)
  }
  if (playTimer) clearInterval(playTimer)
  const interval = getCruiseIntervalMs() + getFlightDurationMs()
  playTimer = window.setInterval(() => {
    if (!isPlaying.value) {
      stopPlay()
      return
    }
    if (currentStageIndex.value < (journeyData.value?.stages.length ?? 1) - 1) {
      nextStage()
    } else {
      stopPlay()
    }
  }, interval)
}

function stopPlay(): void {
  isPlaying.value = false
  if (playTimer) {
    clearInterval(playTimer)
    playTimer = null
  }
}

function togglePlay(): void {
  if (isPlaying.value) {
    stopPlay()
  } else {
    startPlay()
  }
}

// ---------------------------------------------------------------------------
// 照片标记与空间聚合（Supercluster / GeoJSON Cluster）
// ---------------------------------------------------------------------------

const drawerOpen = ref(false)
const drawerPhotos = ref<Photo[]>([])
const drawerCoords = ref<[number, number] | null>(null)

const DRAWER_PADDING_RIGHT = 440

function openPhotoDrawer(items: Photo[], coords: [number, number] | null): void {
  drawerPhotos.value = items
  drawerCoords.value = coords
  drawerOpen.value = true
  activePopup?.remove()
  if (coords && map) {
    map.easeTo({
      center: coords,
      zoom: Math.min(Math.max(13, map.getZoom()), 15),
      padding: isGlobe.value
        ? { top: 0, bottom: 0, left: 0, right: 0 }
        : { top: 0, bottom: 0, left: 0, right: DRAWER_PADDING_RIGHT },
      duration: 500
    })
  }
}

function closePhotoDrawer(): void {
  drawerOpen.value = false
  if (map && !isGlobe.value) {
    map.easeTo({
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      duration: 350
    })
  }
}

function locateCoords(coords: [number, number]): void {
  if (!map) return
  const center = isGcj02Active.value ? wgs84ToGcj02(coords[0], coords[1]) : coords
  const rightPad = !isGlobe.value && drawerOpen.value ? DRAWER_PADDING_RIGHT : 0
  map.easeTo({
    center,
    zoom: Math.min(Math.max(14, map.getZoom()), 15.5),
    padding: { top: 0, bottom: 0, left: 0, right: rightPad },
    duration: 500
  })
}

const lightboxOpen = ref(false)
const lightboxPhotos = ref<Photo[]>([])
const lightboxIndex = ref(0)

function openLightbox(payload: { photo: Photo; index: number }): void {
  lightboxPhotos.value = drawerPhotos.value.length ? drawerPhotos.value : photos.value
  const idx = lightboxPhotos.value.findIndex((p) => p.path === payload.photo.path)
  lightboxIndex.value = idx >= 0 ? idx : payload.index
  lightboxOpen.value = true
}

function closeLightbox(): void {
  lightboxOpen.value = false
}

const PIN_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><defs><filter id='s' x='-30%' y='-30%' width='160%' height='160%'><feDropShadow dx='0' dy='2' stdDeviation='2' flood-color='rgba(0,0,0,0.6)'/></filter></defs><path d='M16 2 C9.37 2 4 7.37 4 14 C4 21.8 16 30 16 30 C16 30 28 21.8 28 14 C28 7.37 22.63 2 16 2 Z' fill='%23ef4444' stroke='%23ffffff' stroke-width='2' filter='url(%23s)'/><circle cx='16' cy='13' r='4.5' fill='%23ffffff'/></svg>\") 16 30, crosshair"

const pickingGpsPhoto = ref<Photo | null>(null)
const confirmGpsDialogOpen = ref(false)
const pendingGpsCoords = ref<{ lat: number; lon: number } | null>(null)
const pendingGpsAddress = ref<string | null>(null)
const pendingGpsGeocoding = ref(false)

let drawerWasOpenBeforePick = false

function startPickGps(p: Photo): void {
  pickingGpsPhoto.value = p
  drawerWasOpenBeforePick = drawerOpen.value
  drawerOpen.value = false
  if (lightboxOpen.value) {
    lightboxOpen.value = false
  }
  if (map) map.getCanvas().style.cursor = PIN_CURSOR
  showSnack(t('yarj.drawer.pickHint', '请在地图上点击任意位置以设定该照片的 GPS 坐标'), 'info')
}

function cancelPickGps(): void {
  pickingGpsPhoto.value = null
  confirmGpsDialogOpen.value = false
  pendingGpsCoords.value = null
  pendingGpsAddress.value = null
  pendingGpsGeocoding.value = false
  if (map) map.getCanvas().style.cursor = ''
  if (drawerWasOpenBeforePick) {
    drawerOpen.value = true
  }
}

async function requestPendingGeocode(): Promise<void> {
  if (!pendingGpsCoords.value || pendingGpsGeocoding.value) return
  pendingGpsGeocoding.value = true
  try {
    const res = (await window.cockpit.command('yarj.reverse-geocode', {
      lat: pendingGpsCoords.value.lat,
      lon: pendingGpsCoords.value.lon,
      lang: uiLang.value
    })) as { ok?: boolean; result?: ReverseGeocodeResult } | null
    if (res?.ok && res.result) {
      pendingGpsAddress.value = res.result.formattedAddress
    }
  } catch (err) {
    console.error('Failed to reverse geocode:', err)
  } finally {
    pendingGpsGeocoding.value = false
  }
}

async function confirmSaveGps(): Promise<void> {
  if (!pickingGpsPhoto.value || !pendingGpsCoords.value) return
  const p = pickingGpsPhoto.value
  const { lat, lon } = pendingGpsCoords.value

  const patch: Record<string, unknown> = {}
  if (pendingGpsAddress.value) {
    patch.formatted_address = pendingGpsAddress.value
  }

  await window.cockpit.command('yarj.update-photo', {
    path: p.path,
    lat,
    lon,
    patch
  })

  p.gps_lat = lat
  p.gps_lon = lon
  if (pendingGpsAddress.value) {
    p.appendix = {
      ...p.appendix,
      formatted_address: pendingGpsAddress.value
    }
  }

  cancelPickGps()
  showSnack(t('yarj.drawer.gpsSaved', 'GPS 坐标已更新并在地图上重新定位！'), 'success')
  await refreshPhotos()
}

// ---------------------------------------------------------------------------
// 侧栏照片组 GPS 整体平移（保留组内各照片相对间距）
// ---------------------------------------------------------------------------

const relocatingPhotos = ref<Photo[] | null>(null)
const relocatingAnchor = ref<{ lat: number; lon: number } | null>(null)
const confirmRelocateDialogOpen = ref(false)
const pendingRelocateTarget = ref<{ lat: number; lon: number } | null>(null)
const relocatingLoading = ref(false)

function formatDistance(distM: number): string {
  if (distM < 1000) {
    return `${Math.round(distM)} m`
  }
  return `${(distM / 1000).toFixed(2)} km`
}

const relocateDistanceStr = computed(() => {
  if (!relocatingAnchor.value || !pendingRelocateTarget.value) return ''
  const m = haversineDistM(
    relocatingAnchor.value.lon,
    relocatingAnchor.value.lat,
    pendingRelocateTarget.value.lon,
    pendingRelocateTarget.value.lat
  )
  return formatDistance(m)
})

function startRelocateGroup(targetPhotos: Photo[]): void {
  if (!targetPhotos.length) return
  relocatingPhotos.value = targetPhotos

  // 计算这组照片的质心锚点
  const valid = targetPhotos.filter((p) => p.gps_lat != null && p.gps_lon != null)
  if (valid.length > 0) {
    const sumLat = valid.reduce((acc, p) => acc + p.gps_lat!, 0)
    const sumLon = valid.reduce((acc, p) => acc + p.gps_lon!, 0)
    relocatingAnchor.value = {
      lat: sumLat / valid.length,
      lon: sumLon / valid.length
    }
  } else if (drawerCoords.value) {
    relocatingAnchor.value = {
      lat: drawerCoords.value[1],
      lon: drawerCoords.value[0]
    }
  } else {
    const c = map?.getCenter() || { lat: 0, lng: 0 }
    relocatingAnchor.value = { lat: c.lat, lon: c.lng }
  }

  drawerWasOpenBeforePick = drawerOpen.value
  drawerOpen.value = false
  if (lightboxOpen.value) {
    lightboxOpen.value = false
  }
  if (map) map.getCanvas().style.cursor = PIN_CURSOR
  showSnack(
    t(
      'yarj.drawer.relocatePickHint',
      '请在地图上点击任意位置以整体平移这组照片（保留组内各照片相对间距）'
    ),
    'info'
  )
}

function cancelRelocateGroup(): void {
  relocatingPhotos.value = null
  relocatingAnchor.value = null
  confirmRelocateDialogOpen.value = false
  pendingRelocateTarget.value = null
  relocatingLoading.value = false
  if (map) map.getCanvas().style.cursor = ''
  if (drawerWasOpenBeforePick) {
    drawerOpen.value = true
  }
}

async function confirmSaveRelocate(): Promise<void> {
  if (!relocatingPhotos.value || !relocatingAnchor.value || !pendingRelocateTarget.value) return
  relocatingLoading.value = true

  const anchor = relocatingAnchor.value
  const target = pendingRelocateTarget.value
  const dLat = target.lat - anchor.lat
  const dLon = target.lon - anchor.lon

  const updates: Array<{ path: string; lat: number; lon: number }> = []

  for (const p of relocatingPhotos.value) {
    let newLat: number
    let newLon: number
    if (p.gps_lat != null && p.gps_lon != null) {
      newLat = Math.max(-90, Math.min(90, p.gps_lat + dLat))
      let wrappedLon = p.gps_lon + dLon
      while (wrappedLon > 180) wrappedLon -= 360
      while (wrappedLon < -180) wrappedLon += 360
      newLon = wrappedLon
    } else {
      newLat = target.lat
      newLon = target.lon
    }
    updates.push({ path: p.path, lat: newLat, lon: newLon })
  }

  try {
    await window.cockpit.command('yarj.batch-update-gps', { updates })

    const updateMap = new Map(updates.map((u) => [u.path, u]))
    for (const p of photos.value) {
      const u = updateMap.get(p.path)
      if (u) {
        p.gps_lat = u.lat
        p.gps_lon = u.lon
      }
    }
    for (const p of drawerPhotos.value || []) {
      const u = updateMap.get(p.path)
      if (u) {
        p.gps_lat = u.lat
        p.gps_lon = u.lon
      }
    }

    showSnack(
      t('yarj.drawer.relocateSuccess', `成功将 ${updates.length} 张照片整体平移至新位置！`),
      'success'
    )
    cancelRelocateGroup()
    await refreshPhotos()

    if (map) {
      map.easeTo({
        center: [target.lon, target.lat],
        duration: 800
      })
    }
  } catch (err) {
    showSnack(t('yarj.drawer.relocateError', `平移失败: ${String(err)}`), 'error')
  } finally {
    relocatingLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// 谷歌 Geocoding 地名飞往与照片模糊搜索联动 (由 YarjPageMenu 派发)
// ---------------------------------------------------------------------------

function flyToGeocode(r: GeocodeResult): void {
  if (!map) return
  const rightPad = !isGlobe.value && drawerOpen.value ? DRAWER_PADDING_RIGHT : 0
  map.easeTo({
    center: [r.lon, r.lat],
    zoom: 14,
    padding: { top: 0, bottom: 0, left: 0, right: rightPad },
    duration: 800
  })
}

function onShowAllSearchResultsInDrawer(results: Photo[]): void {
  if (!results.length) return
  openPhotoDrawer(results, null)
  const firstWithGps = results.find((p) => p.gps_lat != null && p.gps_lon != null)
  if (firstWithGps && map) {
    locateCoords([firstWithGps.gps_lon as number, firstWithGps.gps_lat as number])
  }
}

function onSelectSearchResultPhoto(p: Photo): void {
  const guess = guessedGpsMap.value.get(p.path)
  const coords: [number, number] | null =
    p.gps_lat != null && p.gps_lon != null
      ? [p.gps_lon, p.gps_lat]
      : guess
        ? [guess.lon, guess.lat]
        : null

  openPhotoDrawer(photos.value, coords)
  if (coords) {
    locateCoords(coords)
  }
}

function setupPhotosLayer(): void {
  if (!map) return
  const validPhotos = displayPhotos.value.filter((p) => p.gps_lat != null && p.gps_lon != null)
  const features = validPhotos.map((p) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [p.gps_lon as number, p.gps_lat as number]
    },
    properties: {
      id: p.id,
      path: p.path,
      taken_at: p.taken_at,
      camera_model: p.camera_model
    }
  }))

  const data = {
    type: 'FeatureCollection' as const,
    features
  }

  const existingSrc = map.getSource('yarj-photos-source') as GeoJSONSource | undefined
  if (existingSrc) {
    existingSrc.setData(data)
    return
  }

  map.addSource('yarj-photos-source', {
    type: 'geojson',
    data,
    cluster: true,
    clusterMaxZoom: 15,
    clusterRadius: 50
  })

  // 1. 聚合圆圈（Cluster Circles）— 随缩放级别优雅缩放，避免缩小时视觉膨胀
  map.addLayer({
    id: 'yarj-clusters',
    type: 'circle',
    source: 'yarj-photos-source',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': [
        'step',
        ['get', 'point_count'],
        themeRgba(0.85),
        10,
        themeRgba(0.92),
        50,
        themeRgba(0.98)
      ],
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        2,
        ['step', ['get', 'point_count'], 11, 10, 14, 50, 17],
        10,
        ['step', ['get', 'point_count'], 16, 10, 20, 50, 24]
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.95
    }
  })

  // 2. 聚合数量标签（Cluster Counts）
  map.addLayer({
    id: 'yarj-cluster-count',
    type: 'symbol',
    source: 'yarj-photos-source',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 10, 12],
      'text-allow-overlap': true,
      'text-ignore-placement': true
    },
    paint: {
      'text-color': '#ffffff'
    }
  })

  // 3. 单张未聚合点（Unclustered Points）
  map.addLayer({
    id: 'yarj-unclustered-point',
    type: 'circle',
    source: 'yarj-photos-source',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': themeRgba(1),
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 5, 10, 8],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff'
    }
  })

  // 点击聚合：打开右侧浮动抽屉 + 平滑下钻
  map.on('click', 'yarj-clusters', async (e) => {
    if (pickingGpsPhoto.value || relocatingPhotos.value) return
    const feats = map!.queryRenderedFeatures(e.point, { layers: ['yarj-clusters'] })
    const clusterId = feats[0]?.properties?.cluster_id
    if (clusterId == null) return
    const src = map!.getSource('yarj-photos-source') as GeoJSONSource
    const geom = feats[0].geometry as unknown as { coordinates: [number, number] }
    const coords = geom.coordinates

    // 1. 获取该聚合包含的所有照片并在右侧浮动抽屉展开（即使包含 100 张完全重叠的照片也绝不丢失）
    try {
      const clusterLeaves = await src.getClusterLeaves(clusterId, 100, 0)
      if (clusterLeaves && clusterLeaves.length) {
        const photoIds = new Set(clusterLeaves.map((f) => Number(f.properties?.id)))
        const matched = photos.value.filter((p) => photoIds.has(p.id))
        if (matched.length) {
          openPhotoDrawer(matched, coords as [number, number])
        }
      }
    } catch {
      /* ignore */
    }

    // 2. 如果还有层级可下钻，轻微平滑下钻
    try {
      const zoom = await src.getClusterExpansionZoom(clusterId)
      if (map!.getZoom() < zoom) {
        map!.easeTo({
          center: coords,
          zoom: Math.min(zoom + 0.3, 16.5),
          padding: isGlobe.value
            ? { top: 0, bottom: 0, left: 0, right: 0 }
            : { top: 0, bottom: 0, left: 0, right: DRAWER_PADDING_RIGHT },
          duration: 450
        })
      }
    } catch {
      /* ignore */
    }
  })

  // 点击单点：打开右侧浮动照片抽屉（聚合附近/同坐标所有照片，解决多张照片重叠无法分开的问题）
  map.on('click', 'yarj-unclustered-point', (e) => {
    if (pickingGpsPhoto.value || relocatingPhotos.value) return
    const feat = e.features?.[0]
    if (!feat) return
    const geom = feat.geometry as unknown as { coordinates: [number, number] }
    const coords = geom.coordinates.slice() as [number, number]
    const photoId = Number(feat.properties?.id)
    const clickedPhoto = photos.value.find((item) => item.id === photoId)
    if (!clickedPhoto) return

    // 查找完全重叠或近距离的所有照片
    const nearby = photos.value.filter(
      (p) =>
        p.gps_lat != null &&
        p.gps_lon != null &&
        Math.abs(p.gps_lat - (clickedPhoto.gps_lat ?? 0)) < 0.00015 &&
        Math.abs(p.gps_lon - (clickedPhoto.gps_lon ?? 0)) < 0.00015
    )

    openPhotoDrawer(nearby.length ? nearby : [clickedPhoto], coords)
  })

  const isPickingOrRelocating = (): boolean =>
    Boolean(pickingGpsPhoto.value || relocatingPhotos.value)

  map.on('mouseenter', 'yarj-clusters', () => {
    if (map) map.getCanvas().style.cursor = isPickingOrRelocating() ? PIN_CURSOR : 'pointer'
  })
  map.on('mouseleave', 'yarj-clusters', () => {
    if (map) map.getCanvas().style.cursor = isPickingOrRelocating() ? PIN_CURSOR : ''
  })
  map.on('mouseenter', 'yarj-unclustered-point', () => {
    if (map) map.getCanvas().style.cursor = isPickingOrRelocating() ? PIN_CURSOR : 'pointer'
  })
  map.on('mouseleave', 'yarj-unclustered-point', () => {
    if (map) map.getCanvas().style.cursor = isPickingOrRelocating() ? PIN_CURSOR : ''
  })
}

function applyLayerVisibility(): void {
  if (!map) return
  const vis = (on: boolean): 'visible' | 'none' => (on ? 'visible' : 'none')
  // 旅途漫游模式激活时，暂时隐藏探索区域图层与照片点聚合图层，专注于展示各站点与航段轨迹
  const exploredVisible = explorationActive.value ? false : showExploredLayer.value
  const photosVisible = explorationActive.value ? false : showPhotosLayer.value
  const routesVisible = showRoutesLayer.value

  if (map.getLayer('yarj-explored-fill')) {
    map.setLayoutProperty('yarj-explored-fill', 'visibility', vis(exploredVisible))
  }
  if (map.getLayer('yarj-explored-line')) {
    map.setLayoutProperty('yarj-explored-line', 'visibility', vis(exploredVisible))
  }
  if (map.getLayer('yarj-routes-glow')) {
    map.setLayoutProperty('yarj-routes-glow', 'visibility', vis(routesVisible))
  }
  if (map.getLayer('yarj-routes-line')) {
    map.setLayoutProperty('yarj-routes-line', 'visibility', vis(routesVisible))
  }
  if (map.getLayer('yarj-clusters')) {
    map.setLayoutProperty('yarj-clusters', 'visibility', vis(photosVisible))
  }
  if (map.getLayer('yarj-cluster-count')) {
    map.setLayoutProperty('yarj-cluster-count', 'visibility', vis(photosVisible))
  }
  if (map.getLayer('yarj-unclustered-point')) {
    map.setLayoutProperty('yarj-unclustered-point', 'visibility', vis(photosVisible))
  }
}

async function setPhotosLayerVisible(v: boolean): Promise<void> {
  showPhotosLayer.value = v
  applyLayerVisibility()
  await window.cockpit
    .command('yarj.save-config', {
      patch: { showPhotosLayer: v }
    })
    .catch(() => undefined)
}

async function setExploredLayerVisible(v: boolean): Promise<void> {
  showExploredLayer.value = v
  applyLayerVisibility()
  if (v) {
    updateExplored(true)
  } else {
    updateExplored()
  }
  await window.cockpit
    .command('yarj.save-config', {
      patch: { showExploredLayer: v }
    })
    .catch(() => undefined)
}

async function setRoutesLayerVisible(v: boolean): Promise<void> {
  showRoutesLayer.value = v
  applyLayerVisibility()
  clearExploredCache()
  updateExplored(true)
  await window.cockpit
    .command('yarj.save-config', {
      patch: { showRoutesLayer: v }
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function refreshPhotos(): Promise<void> {
  photos.value = ((await window.cockpit.command('yarj.photos')) as Photo[]) ?? []
  clearExploredCache()
  setupPhotosLayer()
  updateExplored(true)
}

async function refreshRoutes(): Promise<void> {
  routes.value = ((await window.cockpit.command('yarj.routes')) as Route[]) ?? []
  clearExploredCache()
  updateRoutesSource(true)
  updateExplored(true)
}

const cacheStats = ref<TileCacheStats | null>(null)

async function refreshStats(): Promise<void> {
  stats.value = (await window.cockpit.command('yarj.scan-status')) as ScanStats
  lodStatus.value = ((await window.cockpit.command('yarj.lod-status')) as LodStatusRow[]) ?? []
  hierarchyStatus.value =
    ((await window.cockpit.command('yarj.hierarchy-status')) as HierarchyStatusRow[]) ?? []
  cacheStats.value = ((await window.cockpit.command('yarj.cache-stats')) as TileCacheStats) ?? null
}

async function startScan(): Promise<void> {
  if (scanRunning.value) return
  scanRunning.value = true
  const r = (await window.cockpit.command('yarj.scan')) as { ok?: boolean; taskId?: string } | null
  if (!r?.ok) {
    scanRunning.value = false
    showSnack(t('yarj.scan.failed', '扫描失败'), 'error')
    return
  }
  showSnack(t('yarj.scan.started', '扫描已开始，进度见后台任务面板'))
  pollScanDone()
}

async function pollScanDone(): Promise<void> {
  const s = (await window.cockpit.command('yarj.scan-status')) as ScanStats
  const last = s.lastRuns?.[0]
  if (last?.status === 'running') {
    window.setTimeout(pollScanDone, 1500)
    return
  }
  scanRunning.value = false
  stats.value = s
  await refreshPhotos()
  showSnack(
    last?.status === 'done' ? t('yarj.scan.done', '扫描完成') : t('yarj.scan.cancelled', '已取消'),
    last?.status === 'done' ? 'success' : 'warning'
  )
}

function onGlobalKeyDown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  const isInput =
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

  if (e.code === 'Space' || e.key === ' ') {
    if (!isInput) {
      if (routePlaybackActive.value) {
        e.preventDefault()
        toggleRoutePlaybackPlay()
        return
      }
      if (explorationActive.value) {
        e.preventDefault()
        togglePlay()
        return
      }
    }
  }

  if (e.key === 'Escape') {
    if (routePlaybackActive.value && routePlaybackPhotosDrawerOpen.value) {
      routePlaybackPhotosDrawerOpen.value = false
      return
    }
    if (confirmRelocateDialogOpen.value) {
      confirmRelocateDialogOpen.value = false
    } else if (relocatingPhotos.value) {
      cancelRelocateGroup()
    } else if (confirmGpsDialogOpen.value) {
      confirmGpsDialogOpen.value = false
    } else if (pickingGpsPhoto.value) {
      cancelPickGps()
    }
  }
}

async function executePrune(): Promise<void> {
  pruneRunning.value = true
  try {
    const res = (await window.cockpit.command('yarj.prune')) as {
      ok?: boolean
      deletedCount?: number
    }
    pruneConfirmDialogOpen.value = false
    if (res?.ok) {
      const count = res.deletedCount ?? 0
      showSnack(
        count > 0
          ? t('yarj.prune.success', `已清理 ${count} 条失效照片记录`)
          : t('yarj.prune.none', '未发现失效照片记录，所有照片均存在于磁盘'),
        count > 0 ? 'success' : 'info'
      )
      await refreshPhotos()
      await refreshStats()
    } else {
      showSnack(t('yarj.prune.failed', '清理失败'), 'error')
    }
  } catch (err) {
    showSnack(String(err), 'error')
  } finally {
    pruneRunning.value = false
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

let btUnlisten: (() => void) | null = null

onMounted(async () => {
  initializing.value = true
  initLoadingStatus.value = t('yarj.loading.hint', '正在载入旅行足迹与地图资源…')
  window.addEventListener('keydown', onGlobalKeyDown)
  setFontFamily(getComputedStyle(document.body).fontFamily || 'sans-serif')
  try {
    const pRes = (await window.cockpit.command('yarj.providers')) as {
      activeId: string
      providers: ProviderItem[]
    }
    if (pRes?.providers) {
      providers.value = pRes.providers
      activeProviderId.value = pRes.activeId || 'google-hybrid'
    }
  } catch (e) {
    console.warn('Failed to load providers', e)
  }

  try {
    maps.value = ((await window.cockpit.command('yarj.maps')) as MapFileInfo[]) ?? []
  } catch (e) {
    console.warn('Failed to load maps', e)
  }

  try {
    await refreshStats()
  } catch (e) {
    console.warn('Failed to refresh stats', e)
  }

  initLoadingStatus.value = t('yarj.loading.map', '正在初始化地图视口与图层…')
  try {
    await initMap(activeProviderId.value)
  } catch (e) {
    console.warn('Failed to init map', e)
  }

  initLoadingStatus.value = t('yarj.loading.photos', '正在检索照片与地理足迹…')
  try {
    await refreshPhotos()
  } catch (e) {
    console.warn('Failed to refresh photos', e)
  }

  try {
    await refreshRoutes()
  } catch (e) {
    console.warn('Failed to refresh routes', e)
  }

  if (map && !map.loaded()) {
    const onMapDone = (): void => {
      initializing.value = false
    }
    map.once('load', onMapDone)
    window.setTimeout(() => {
      initializing.value = false
    }, 2500)
  } else {
    initializing.value = false
  }

  if (mapEl.value) {
    resizeObserver = new ResizeObserver(() => {
      map?.resize()
      if (activeProviderId.value.startsWith('local:')) {
        scheduleLodFilter()
      }
    })
    resizeObserver.observe(mapEl.value)
  }

  btUnlisten = window.cockpit.on('cockpit:bt', (payload) => {
    const p = payload as { type?: string; task?: { name?: string } }
    if (p && p.type === 'exit') {
      const name = p.task?.name || ''
      if (
        name.includes('yarj.correct-gps') ||
        name.includes('yarj.clear-gps-correction') ||
        name.includes('yarj.scan') ||
        name.includes('yarj.recompute-guesses') ||
        name.includes('yarj.scan-routes') ||
        name.includes('yarj.geotag-routes') ||
        name.includes('yarj.clear-route-geotag')
      ) {
        void refreshPhotos()
        void refreshRoutes()
        void refreshStats()
      }
    }
  })
})

onActivated(() => {
  map?.resize()
  void reloadPreferences()
})

onDeactivated(() => {
  stopPlay()
  if (viewSaveTimer) {
    window.clearTimeout(viewSaveTimer)
    viewSaveTimer = null
  }
})

onBeforeUnmount(() => {
  if (btUnlisten) {
    btUnlisten()
    btUnlisten = null
  }
  window.removeEventListener('keydown', onGlobalKeyDown)
  stopPlay()
  stopRoutePlayback()
  cleanupLod()
  resizeObserver?.disconnect()
  if (labelMoveRaf != null) {
    window.cancelAnimationFrame(labelMoveRaf)
    labelMoveRaf = null
  }
  if (viewSaveTimer) window.clearTimeout(viewSaveTimer)
  if (map) {
    map.remove()
    map = null
  }
})

// ---------------------------------------------------------------------------
// 右下按钮阵列
// ---------------------------------------------------------------------------

function zoomIn(): void {
  if (routePlaybackActive.value && routePlaybackFollowCamera.value) {
    requestPlaybackZoom(1)
    return
  }
  map?.zoomIn()
}

function zoomOut(): void {
  if (routePlaybackActive.value && routePlaybackFollowCamera.value) {
    requestPlaybackZoom(-1)
    return
  }
  map?.zoomOut()
}

function toggleProjection(): void {
  if (!map) return
  const cur = map.getProjection().type
  const next = cur === 'globe' ? 'mercator' : 'globe'
  map.setProjection({ type: next })
  isGlobe.value = next === 'globe'
  const c = map.getCenter()
  const z = map.getZoom()
  void window.cockpit
    .command('yarj.save-config', {
      patch: {
        lastView: {
          projection: next,
          center: [c.lng, c.lat],
          zoom: z
        }
      }
    })
    .catch(() => undefined)
  if (activeProviderId.value.startsWith('local:')) {
    renderLabels()
  }
}

function resetView(): void {
  if (!map) return
  if (activeProviderId.value.startsWith('local:')) {
    const mapId = activeProviderId.value.slice('local:'.length)
    const m = maps.value.find((x) => x.id === mapId)
    if (m?.bounds) {
      map.fitBounds(
        [
          [m.bounds[0], m.bounds[1]],
          [m.bounds[2], m.bounds[3]]
        ],
        { padding: 24, duration: 600 }
      )
      return
    }
  }
  const validPhotos = displayPhotos.value.filter((p) => p.gps_lat != null && p.gps_lon != null)
  if (validPhotos.length > 0) {
    let minLon = 180
    let minLat = 90
    let maxLon = -180
    let maxLat = -90
    for (const p of validPhotos) {
      if (p.gps_lon! < minLon) minLon = p.gps_lon!
      if (p.gps_lat! < minLat) minLat = p.gps_lat!
      if (p.gps_lon! > maxLon) maxLon = p.gps_lon!
      if (p.gps_lat! > maxLat) maxLat = p.gps_lat!
    }
    if (minLon < maxLon && minLat < maxLat) {
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat]
        ],
        { padding: 80, maxZoom: 14, duration: 800 }
      )
      return
    }
  }
  map.easeTo({ center: [116.4, 39.9], zoom: 3, duration: 600 })
}

async function reloadPreferences(): Promise<void> {
  try {
    const cfg = (await window.cockpit.command('yarj.config')) as YarjConfig
    yarjConfig.value = { ...DEFAULT_YARJ_CONFIG, ...cfg }
    if (cfg.showRoutesLayer !== undefined) {
      showRoutesLayer.value = cfg.showRoutesLayer
    }
    if (map) {
      if (map.getLayer('yarj-explored-fill')) {
        map.setPaintProperty(
          'yarj-explored-fill',
          'fill-opacity',
          yarjConfig.value.footprintOpacity ?? 0.52
        )
      }
      if (yarjConfig.value.doubleClickAction === 'none') {
        map.doubleClickZoom.disable()
      } else {
        map.doubleClickZoom.enable()
      }
      setupPhotosLayer()
      setupExploredLayer()
      setupRoutesLayers()
      applyLayerVisibility()
    }
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="yarj-shell">
    <!-- 页面进入初始化加载动画（避免黑屏/卡住） -->
    <Transition name="fade">
      <div v-if="initializing" class="yarj-loading-overlay">
        <div class="yarj-loading-card">
          <div class="yarj-radar-wrapper mb-5">
            <div class="radar-ping" />
            <div class="radar-circle">
              <v-icon size="44" color="primary" class="radar-icon">mdi-compass-outline</v-icon>
            </div>
          </div>

          <div class="text-h6 font-weight-bold mb-1 tracking-wide">
            {{ t('ability.yarj.name', '旅行记录') }}
          </div>
          <div class="text-body-2 on-surface-variant mb-5">
            {{ initLoadingStatus || t('yarj.loading.hint', '正在载入旅行足迹与地图资源…') }}
          </div>

          <v-progress-linear
            indeterminate
            color="primary"
            rounded
            height="4"
            style="width: 220px; max-width: 80%"
          />
        </div>
      </div>
    </Transition>

    <div ref="mapEl" class="yarj-map">
      <!-- 区域名称标签（仅本地 MBTiles 模式下生效） -->
      <div ref="labelsEl" class="yarj-labels" />
    </div>

    <!-- 地图拾取坐标 / 批量平移顶栏与浮动预览及确认对话框 -->
    <YarjPickBanner
      v-model:confirm-gps-dialog-open="confirmGpsDialogOpen"
      v-model:confirm-relocate-dialog-open="confirmRelocateDialogOpen"
      :picking-gps-photo="pickingGpsPhoto"
      :relocating-photos="relocatingPhotos"
      :is-gcj02-active="isGcj02Active"
      :pending-gps-coords="pendingGpsCoords"
      :pending-gps-address="pendingGpsAddress"
      :pending-gps-geocoding="pendingGpsGeocoding"
      :relocating-anchor="relocatingAnchor"
      :pending-relocate-target="pendingRelocateTarget"
      :relocate-distance-str="relocateDistanceStr"
      :relocating-loading="relocatingLoading"
      @cancel-pick-gps="cancelPickGps"
      @cancel-relocate-group="cancelRelocateGroup"
      @request-pending-geocode="requestPendingGeocode"
      @confirm-save-gps="confirmSaveGps"
      @confirm-save-relocate="confirmSaveRelocate"
    />

    <!-- 地图错误提示条 -->
    <Transition name="fade">
      <div v-if="mapError" class="yarj-map-error">
        <v-icon size="16" color="error">mdi-alert-circle-outline</v-icon>
        <span class="ml-1">{{ mapError }}</span>
      </div>
    </Transition>

    <!-- 无照片提示 -->
    <div v-if="!photos.length && !mapError" class="yarj-no-photos">
      <template v-if="(stats?.photoCount ?? 0) > 0">
        {{
          t(
            'yarj.map.noGpsPhotos',
            `已索引 ${stats?.photoCount} 张照片，但均未包含 GPS 拍摄位置 — 只有带地理定位的照片才会标记在地图上`
          ).replace('{count}', String(stats?.photoCount ?? 0))
        }}
      </template>
      <template v-else>
        {{
          t(
            'yarj.map.noPhotos',
            '暂无照片 — 在图库目录中添加照片文件夹并执行扫描，带定位的照片会标记在地图上'
          )
        }}
      </template>
    </div>

    <!-- 右下角竖排按钮阵列 -->
    <YarjControls
      :exploration-active="explorationActive"
      :route-playback-active="routePlaybackActive"
      :is-globe="isGlobe"
      @toggle-exploration="explorationActive ? exitExploration() : startExploration()"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @toggle-projection="toggleProjection"
      @reset-view="resetView"
    />

    <!-- 顶部下拉菜单（仿 AIDJ） -->
    <YarjPageMenu
      :photos="photos"
      :routes="routes"
      :providers="providers"
      :active-provider-id="activeProviderId"
      :active-provider-name="activeProviderName"
      :scan-running="scanRunning"
      :stats="stats"
      :cache-stats="cacheStats"
      :guessed-gps-map="guessedGpsMap"
      :show-explored-layer="showExploredLayer"
      :show-photos-layer="showPhotosLayer"
      :show-routes-layer="showRoutesLayer"
      :explored-granularity="exploredGranularity"
      @start-exploration="startExplorationFromMenu"
      @open-routes-drawer="openRoutesDrawer"
      @switch-provider="switchProvider"
      @start-scan="startScan"
      @refresh-stats="refreshStats"
      @open-prune-dialog="pruneConfirmDialogOpen = true"
      @open-route-geotag="openRouteGeotagModal"
      @open-gps-correction="openGpsCorrectionModal"
      @recompute-guesses="triggerRecomputeGuesses"
      @update:show-explored-layer="setExploredLayerVisible"
      @update:show-photos-layer="setPhotosLayerVisible"
      @update:show-routes-layer="setRoutesLayerVisible"
      @update:explored-granularity="setExploredGranularity"
      @fly-to-geocode="flyToGeocode"
      @open-search-help="searchHelpOpen = true"
      @show-all-search-results="onShowAllSearchResultsInDrawer"
      @select-search-photo="onSelectSearchResultPhoto"
    />

    <!-- 「我的探索」沉浸式浮动控制面板与顶部 HUD 胶囊 -->
    <YarjExplorationBar
      :exploration-active="explorationActive"
      :journey-data="journeyData"
      :current-stage-index="currentStageIndex"
      :current-stage="currentStage"
      :current-leg="currentLeg"
      :drawer-open="drawerOpen"
      :is-time-shuttling="isTimeShuttling"
      :is-playing="isPlaying"
      :display-date-part="displayDatePart"
      :display-time-part="displayTimePart"
      :exploration-granularity="explorationGranularity"
      :custom-stage-count="customStageCount"
      :current-granularity-index="currentGranularityIndex"
      :journey-focus-range="journeyFocusRange"
      :exploration-photos="explorationPhotos"
      @exit="exitExploration"
      @jump-stage="goToStage"
      @cycle-granularity="cycleExplorationGranularity"
      @set-granularity="setExplorationGranularity"
      @set-custom-stage-count="setTargetCount"
      @reset-granularity="resetToGranularity"
      @set-focus-range="setJourneyFocusRange"
      @open-photo-drawer="openPhotoDrawer"
      @prev-stage="prevStage"
      @next-stage="nextStage"
      @toggle-play="togglePlay"
    />

    <!-- 右侧浮动多照片检视/编辑抽屉（解决同一地点连拍重叠无法展开的问题） -->
    <PhotoSideDrawer
      :open="drawerOpen"
      :photos="drawerPhotos"
      :coords="drawerCoords"
      :page-size="yarjConfig.drawerPageSize || 30"
      :guessed-gps-map="guessedGpsMap"
      @close="closePhotoDrawer"
      @locate="locateCoords"
      @preview="openLightbox"
      @pick-gps="startPickGps"
      @explore="startExploration"
      @relocate-group="startRelocateGroup"
      @solidify-gps="handleSolidifyGps"
      @updated="refreshPhotos"
    />

    <!-- 全屏照片画廊 / 详情与自由缩放拖拽查看器 -->
    <PhotoLightboxModal
      :open="lightboxOpen"
      :photos="lightboxPhotos"
      :initial-index="lightboxIndex"
      :guessed-gps-map="guessedGpsMap"
      @close="closeLightbox"
      @updated="refreshPhotos"
      @locate="locateCoords"
      @pick-gps="startPickGps"
      @solidify-gps="handleSolidifyGps"
    />

    <!-- 确认清理失效照片记录对话框 -->
    <v-dialog v-model="pruneConfirmDialogOpen" max-width="480" persistent>
      <v-card
        class="pa-5 rounded-2xl"
        style="background: rgba(var(--v-theme-surface), 0.95); backdrop-filter: blur(24px)"
      >
        <div class="d-flex align-center ga-3 mb-4">
          <v-avatar color="warning" variant="tonal" size="44">
            <v-icon size="24">mdi-alert-outline</v-icon>
          </v-avatar>
          <div>
            <div class="text-h6 font-weight-bold">
              {{ t('yarj.prune.dialogTitle', '清理失效照片记录') }}
            </div>
            <div class="text-caption on-surface-variant">
              {{ t('yarj.prune.dialogSubtitle', '比对图库目录并移除已从磁盘删除的照片') }}
            </div>
          </div>
        </div>

        <div class="text-body-2 on-surface-variant mb-5">
          {{
            t(
              'yarj.prune.dialogContent',
              '此操作将检查所有已配置的图库目录，若发现数据库中记录的照片文件在磁盘上已不存在，将永久注销其元数据（包括该照片上手动添加的 GPS 坐标、标签与日记备注）。'
            )
          }}
        </div>

        <v-card-actions class="px-0 pb-0 pt-3 ga-3 justify-end d-flex border-t">
          <v-btn variant="text" :disabled="pruneRunning" @click="pruneConfirmDialogOpen = false">
            {{ t('yarj.drawer.cancel', '取消') }}
          </v-btn>
          <v-btn color="error" variant="flat" :loading="pruneRunning" @click="executePrune">
            {{ t('yarj.prune.confirmBtn', '确认清理') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackOpen" :color="snackColor" location="top" timeout="3000">
      {{ snackText }}
    </v-snackbar>

    <!-- 高级搜索语法帮助对话框 -->
    <SearchHelpDialog v-model="searchHelpOpen" />

    <!-- GPS 漂移时空速度纠正配置对话框 -->
    <GpsCorrectionModal
      v-model="gpsCorrectionModalOpen"
      :config="yarjConfig"
      @started="refreshPhotos"
      @cleared="refreshPhotos"
    />

    <!-- 运动航线侧边检视抽屉 -->
    <RouteSideDrawer
      v-model="routeDrawerOpen"
      :routes="routes"
      :active-route-id="activeRouteId"
      @select-route="onSelectRouteFromDrawer"
      @open-detail="onOpenRouteDetail"
      @toggle-active="onToggleActiveRoute"
      @delete-route="onDeleteRoute"
    />

    <!-- 运动航线详情看板模态框（对标 Mi Fitness） -->
    <RouteDetailModal
      v-model="routeDetailModalOpen"
      :route="selectedRouteForDetail"
      :exploration-active="explorationActive"
      @play-route="startRoutePlayback"
      @start-geotag="onStartGeotagFromDetail"
      @view-photo="onViewPhotoFromRoute"
      @focus-route="onFocusRouteOnMap"
    />

    <!-- 基于运动航线匹配照片贴合 GPS 模态框 -->
    <RouteGeotagModal
      v-model="routeGeotagModalOpen"
      :routes="routes"
      :initial-route="selectedRouteForGeotag"
      :initial-offset="selectedGeotagInitialOffset"
      @started="onGeotagStarted"
    />

    <!-- 航线行程播放浮动控制栏 -->
    <RoutePlaybackBar
      v-if="routePlaybackActive && routePlaybackRoute"
      :route="routePlaybackRoute"
      :is-playing="routePlaybackIsPlaying"
      :progress="routePlaybackProgress"
      :current-time-str="playbackCurrentTimeStr"
      :elapsed-duration-str="playbackElapsedDurationStr"
      :total-duration-str="playbackTotalDurationStr"
      :current-dist-km-str="playbackCurrentDistStr"
      :total-dist-km-str="playbackTotalDistStr"
      :current-speed-kmh="routePlaybackCurrentPoint?.speedKmh ?? null"
      :current-ele-m="routePlaybackCurrentPoint?.ele ?? null"
      :current-hr="routePlaybackCurrentPoint?.hr ?? null"
      :speed="routePlaybackSpeed"
      :follow-camera="routePlaybackFollowCamera"
      :photos-drawer-open="routePlaybackPhotosDrawerOpen"
      :current-photos-count="currentWindowPhotos.length"
      :splits="routePlaybackRoute.splits"
      @toggle-play="toggleRoutePlaybackPlay"
      @update:progress="onRoutePlaybackProgressChange"
      @update:speed="routePlaybackSpeed = $event"
      @update:follow-camera="routePlaybackFollowCamera = $event"
      @re-center="reCenterPlaybackCamera(true)"
      @toggle-photos-drawer="toggleRoutePlaybackPhotosDrawer"
      @jump-time="onRoutePlaybackJumpTime"
      @jump-to-split="onRoutePlaybackJumpToSplit"
      @close="stopRoutePlayback"
    />

    <!-- 周围时刻照片侧边抽屉 -->
    <RoutePlaybackPhotosDrawer
      :open="routePlaybackActive && routePlaybackPhotosDrawerOpen"
      :photos="currentWindowPhotos"
      :total-photos-count="routePlaybackPhotos.length"
      :current-time-ms="routePlaybackCurrentTimeMs"
      :current-head-coord="routePlaybackCurrentPoint?.coord ?? null"
      :time-window-sec="routePlaybackTimeWindowSec"
      :detected-offset-sec="routePlaybackOffsetSec"
      :is-local-time="routePlaybackIsLocalTime"
      @close="routePlaybackPhotosDrawerOpen = false"
      @update:time-window-sec="routePlaybackTimeWindowSec = $event"
      @select-photo="onSelectPhotoFromPlayback"
    />
  </div>
</template>

<style scoped>
.yarj-shell {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.yarj-map {
  flex-grow: 1;
  min-height: 0;
  position: relative;
  border-radius: 0;
  overflow: hidden;
  contain: strict;
  transform: translateZ(0);
}

.yarj-map :deep(.maplibregl-canvas) {
  outline: none;
  transform: translateZ(0);
}

.yarj-labels {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  overflow: hidden;
}

.yarj-labels :deep(.yarj-label) {
  position: absolute;
  text-align: center;
  white-space: nowrap;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: rgb(var(--v-theme-on-surface));
  text-shadow:
    0 1px 2px rgb(var(--v-theme-surface)),
    0 0 6px rgb(var(--v-theme-surface)),
    0 0 12px rgb(var(--v-theme-surface));
  user-select: none;
  will-change: transform;
  backface-visibility: hidden;
}

.yarj-labels :deep(.yarj-label.wrap) {
  white-space: normal;
  line-height: 1.25;
}

.yarj-map-error {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 20;
  display: flex;
  align-items: center;
  max-width: 60%;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 0.85rem;
  color: rgb(var(--v-theme-error));
  background: rgba(var(--v-theme-surface), 0.85);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(var(--v-theme-error), 0.4);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}

.yarj-no-photos {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  padding: 8px 16px;
  border-radius: 999px;
  font-size: 0.82rem;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgba(var(--v-theme-surface), 0.7);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.25);
  pointer-events: none;
}

:deep(.yarj-popup) {
  font-size: 0.85rem;
}

:deep(.yarj-popup-thumb) {
  width: 100%;
  max-height: 160px;
  object-fit: cover;
  border-radius: 6px;
  margin-bottom: 8px;
}

:deep(.yarj-popup-body) {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

:deep(.yarj-popup-row) {
  display: flex;
  gap: 8px;
}

:deep(.yarj-popup-label) {
  min-width: 64px;
  color: rgb(var(--v-theme-on-surface-variant));
}

:deep(.yarj-popup-tags) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

:deep(.yarj-popup-tag) {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
}

:deep(.yarj-popup-muted) {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8rem;
}

:deep(.yarj-popup-edit) {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

:deep(.yarj-popup-input) {
  flex-grow: 1;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.4);
  background: rgba(var(--v-theme-surface), 0.6);
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.8rem;
}

:deep(.yarj-popup-save) {
  padding: 4px 12px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  color: rgb(var(--v-theme-on-primary));
  background: rgb(var(--v-theme-primary));
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 页面初始化全屏加载蒙层 */
.yarj-loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--v-theme-surface), 0.94);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 999;
  user-select: none;
}

.yarj-loading-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 40px;
  border-radius: 20px;
  background: rgba(var(--v-theme-surface-bright), 0.35);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
}

.yarj-radar-wrapper {
  position: relative;
  width: 76px;
  height: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.radar-circle {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--v-theme-primary), 0.12);
  border: 1.5px solid rgba(var(--v-theme-primary), 0.35);
  box-shadow: 0 0 20px rgba(var(--v-theme-primary), 0.2);
}

.radar-ping {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(var(--v-theme-primary), 0.6);
  animation: radar-pulse 2s cubic-bezier(0.2, 0.8, 0.4, 1) infinite;
}

.radar-icon {
  animation: compass-sway 3s ease-in-out infinite alternate;
}

@keyframes radar-pulse {
  0% {
    transform: scale(0.85);
    opacity: 0.9;
  }
  100% {
    transform: scale(1.45);
    opacity: 0;
  }
}

@keyframes compass-sway {
  0% {
    transform: rotate(-18deg);
  }
  100% {
    transform: rotate(24deg);
  }
}

:deep(.yarj-playback-head-marker) {
  position: relative;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 10;
}

:deep(.yarj-playback-head-marker .head-marker-halo) {
  position: absolute;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(var(--v-theme-primary), 0.35);
  filter: blur(2px);
  animation: head-halo-pulse 2s infinite ease-out;
}

:deep(.yarj-playback-head-marker .head-marker-dot) {
  position: relative;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ffffff;
  border: 3px solid rgb(var(--v-theme-primary));
  box-shadow: 0 0 10px rgba(var(--v-theme-primary), 0.85);
}

@keyframes head-halo-pulse {
  0% {
    transform: scale(0.85);
    opacity: 0.85;
  }
  50% {
    transform: scale(1.3);
    opacity: 0.35;
  }
  100% {
    transform: scale(0.85);
    opacity: 0.85;
  }
}
</style>
