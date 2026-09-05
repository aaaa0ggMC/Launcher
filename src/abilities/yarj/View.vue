<script setup lang="ts">
defineOptions({ name: 'cockpit-yarj' })

import {
  ref,
  computed,
  watch,
  onMounted,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  inject
} from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import maplibregl from 'maplibre-gl'
import type {
  Map as MlMap,
  Popup,
  GeoJSONSource,
  FilterSpecification,
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
  RoutePoint,
  RouteSplit,
  ExploredGranularity,
  TileCacheStats,
  ProviderItem,
  JourneyData,
  JourneyStage,
  JourneyLeg,
  YarjConfig,
  GuessedGps
} from './types'
import { DEFAULT_YARJ_CONFIG, GRANULARITY_PRESETS, photoThumbUrl, resolvePhotoGps } from './types'
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
import { filterPhotosWithQuery } from './search-parser'
import SearchHelpDialog from './components/SearchHelpDialog.vue'
import GpsCorrectionModal from './components/GpsCorrectionModal.vue'

interface LodFeature {
  lvl: 'ADM1' | 'ADM2'
  w: number
  h: number
  name?: string
  label?: [number, number]
}

interface LodCountry {
  name: string
  w: number
  h: number
  label: [number, number]
}

interface LodData {
  generatedAt: string
  count: number
  features: Record<string, LodFeature>
  countries: Record<string, LodCountry>
}

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

interface MapFileInfo {
  id: string
  path: string
  defaultZoom: number
  enabled: boolean
  minzoom?: number
  maxzoom?: number
  format?: string
  bounds?: [number, number, number, number]
  center?: [number, number]
  tileCount?: number
  vectorLayers?: string[]
  error?: string
}

interface ScanStats {
  photoCount: number
  withGps: number
  byRoot: { root: string; total: number; withGps: number }[]
  lastRuns: {
    id: number
    root: string
    started_at: string
    finished_at: string | null
    status: string
    total: number
    with_gps: number
    failed: number
    error: string | null
  }[]
}

interface LodStatusRow {
  mapId: string
  ready: boolean
  count: number
  running: boolean
}

interface HierarchyStatusRow {
  mapId: string
  ready: boolean
  count: number
  running: boolean
}

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

let lodData: LodData | null = null
let lodAllIds: string[] = []
let lodFilterTimer: number | null = null
let lodPollTimer: number | null = null
const lastView = ref<{ projection: string; center: [number, number]; zoom: number } | null>(null)

let map: MlMap | null = null
let activePopup: Popup | null = null
let resizeObserver: ResizeObserver | null = null
let viewSaveTimer: number | null = null
let labelMoveRaf: number | null = null
let labelFontFamily = 'sans-serif'

// page-menu
const menuOpen = ref(false)
const menuStep = ref<
  'main' | 'search' | 'stats' | 'layers' | 'providers' | 'photo-search' | 'explored' | 'build'
>('main')
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
  menuOpen.value = false
}

function openRouteGeotagModal(route?: Route, initialOffset?: number): void {
  selectedRouteForGeotag.value = route ?? null
  selectedGeotagInitialOffset.value = initialOffset
  routeGeotagModalOpen.value = true
  menuOpen.value = false
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
  menuOpen.value = false
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
const customTargetCountInput = ref('')
const jumpStageInput = ref('')
const jumpMenuOpen = ref(false)
const targetCountMenuOpen = ref(false)
const focusRangeMenuOpen = ref(false)

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

function isDetailLayer(layerId: string): boolean {
  return !/(adm0|admin[-_]?0|country|countries|continent)/i.test(layerId)
}

const ADM1_FILTER: FilterSpecification = ['in', ['get', 'shapeType'], ['literal', ['ADM1', 'DISP']]]
const ADM2_FILTER: FilterSpecification = ['==', ['get', 'shapeType'], 'ADM2']
const LOD_FILTER_MAX_IDS = 1000

function detailFilter(
  typeFilter: FilterSpecification,
  ids: string[],
  fallbackZoom: number
): FilterSpecification {
  if (!lodData) {
    return ['all', typeFilter, ['>=', ['zoom'], fallbackZoom]] as unknown as FilterSpecification
  }
  if (ids.length > LOD_FILTER_MAX_IDS) {
    return ['all', typeFilter] as unknown as FilterSpecification
  }
  const branches: FilterSpecification[] = []
  if (ids.length > 0) {
    branches.push(['in', ['get', 'shapeID'], ['literal', ids]] as unknown as FilterSpecification)
  }
  if (lodAllIds.length > 0) {
    branches.push([
      'all',
      ['!', ['in', ['get', 'shapeID'], ['literal', lodAllIds]]] as unknown as FilterSpecification,
      ['>=', ['zoom'], fallbackZoom]
    ] as unknown as FilterSpecification)
  }
  if (branches.length === 0) {
    return ['all', typeFilter, ['>=', ['zoom'], fallbackZoom]] as unknown as FilterSpecification
  }
  return ['all', typeFilter, ['any', ...branches]] as unknown as FilterSpecification
}

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
      lodData = null
      lodAllIds = []
      void ensureLod(m)
      void ensureHierarchy(m)
    }
  } else {
    lodData = null
    lodAllIds = []
    if (labelsEl.value) labelsEl.value.innerHTML = ''
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

  map.on('zoomstart', () => {
    isMapZooming = true
  })

  map.on('zoomend', () => {
    if (!map) return
    if (zoomEndTimeout) clearTimeout(zoomEndTimeout)
    zoomEndTimeout = setTimeout(() => {
      isMapZooming = false
    }, 200)

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
    () => {
      isMapZooming = true
      if (zoomEndTimeout) clearTimeout(zoomEndTimeout)
      zoomEndTimeout = setTimeout(() => {
        isMapZooming = false
      }, 300)
    },
    { passive: true }
  )

  map.on('dragstart', () => {
    if (routePlaybackActive.value && routePlaybackFollowCamera.value) {
      routePlaybackFollowCamera.value = false
    }
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
// 标签与 LOD（仅本地 MBTiles 使用）
// ---------------------------------------------------------------------------

let placedLabels: {
  el: HTMLDivElement
  lngLat: [number, number]
  boxW: number
  boxH: number
}[] = []

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
    const p = map!.project(lngLat)
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
      if (x < r.x + r.w + 4 && x + boxW + 4 > r.x && y < r.y + r.h + 2 && y + boxH + 2 > r.y) return
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
      map.setFilter(id1, detailFilter(ADM1_FILTER, visibleAdm1, adm1MinZoom.value))
    }
    if (map.getLayer(id2)) {
      map.setFilter(id2, detailFilter(ADM2_FILTER, visibleAdm2, adm2MinZoom.value))
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

// ---------------------------------------------------------------------------
// 极地环形采样与平滑差值（Stage 1: 沿纬线采样真实像素 -> Stage 2: 大核高斯平滑 + 极核融合）
// ---------------------------------------------------------------------------

const POLAR_SECTORS = 180
const POLAR_LAT = 83.0
const POLAR_CORE_LAT = 87.5

async function samplePolarCapColors(
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

interface PolarFeature {
  type: 'Feature'
  geometry: {
    type: 'Polygon'
    coordinates: [number, number][][]
  }
  properties: {
    color: string
  }
}

function buildPolarGeoJSON(
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

async function setupPolarCapsLayer(): Promise<void> {
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
    if (!map) return
    const sampledData = buildPolarGeoJSON(north, south)
    const src = map.getSource('yarj-polar-caps') as GeoJSONSource | undefined
    src?.setData(sampledData)
  } catch {
    /* fallback to defaults */
  }
}

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
    4,
    ['case', ['==', ['get', 'id'], activeId], 3, 1.5],
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
    4,
    ['case', ['==', ['get', 'id'], activeId], 5, 3],
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
    'case',
    ['==', ['literal', activeId], ''],
    0.6,
    ['==', ['get', 'id'], activeId],
    0.9,
    0.05
  ] as unknown as DataDrivenPropertyValueSpecification<number>
}

function getRouteLineOpacityExpression(
  activeId: string
): DataDrivenPropertyValueSpecification<number> {
  return [
    'case',
    ['==', ['literal', activeId], ''],
    0.85,
    ['==', ['get', 'id'], activeId],
    1.0,
    0.12
  ] as unknown as DataDrivenPropertyValueSpecification<number>
}

function setupRoutesLayers(): void {
  if (!map) return
  if (map.getSource('yarj-routes')) return

  map.addSource('yarj-routes', {
    type: 'geojson',
    data: buildRoutesGeoJSON()
  })

  // 1. 底层光晕
  map.addLayer({
    id: 'yarj-routes-glow',
    type: 'line',
    source: 'yarj-routes',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': '#00e5ff',
      'line-width': getRouteGlowWidthExpression(activeRouteId.value || ''),
      'line-blur': ['interpolate', ['linear'], ['zoom'], 4, 2, 12, 4, 17, 6],
      'line-opacity': getRouteGlowOpacityExpression(activeRouteId.value || '')
    }
  })

  // 2. 顶层实体主轨迹线
  map.addLayer({
    id: 'yarj-routes-line',
    type: 'line',
    source: 'yarj-routes',
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
    if (map) map.getCanvas().style.cursor = 'pointer'
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

function jumpToStageNum(num: number): void {
  if (journeyData.value?.stages.length) {
    const targetIdx = Math.max(0, Math.min(num - 1, journeyData.value.stages.length - 1))
    goToStage(targetIdx)
  }
  jumpMenuOpen.value = false
}

function handleJumpStage(): void {
  const num = parseInt(jumpStageInput.value, 10)
  if (!Number.isNaN(num)) {
    jumpToStageNum(num)
  } else {
    jumpMenuOpen.value = false
  }
}

function setTargetCount(count: number): void {
  customStageCount.value = count
  customTargetCountInput.value = String(count)
  targetCountMenuOpen.value = false
  rebuildJourney()
}

function applyCustomTargetCount(): void {
  const count = parseInt(customTargetCountInput.value, 10)
  if (!Number.isNaN(count) && count >= 2) {
    customStageCount.value = count
    targetCountMenuOpen.value = false
    rebuildJourney()
  }
}

function resetToGranularity(): void {
  customStageCount.value = null
  customTargetCountInput.value = ''
  targetCountMenuOpen.value = false
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
  menuOpen.value = false
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
// 航线时间轴生长动画与行程播放 (Route Journey Playback)
// ---------------------------------------------------------------------------

const routePlaybackActive = ref(false)
const routePlaybackRoute = ref<Route | null>(null)
const routePlaybackPoints = ref<RoutePoint[]>([])
const routePlaybackPhotos = ref<Photo[]>([])
const routePlaybackOffsetSec = ref(0)
const routePlaybackIsLocalTime = ref(false)
const routePlaybackIsPlaying = ref(false)
const routePlaybackProgress = ref(0) // 0 to 1
const routePlaybackSpeed = ref(15) // 默认 15x 倍速
const routePlaybackFollowCamera = ref(true)
const routePlaybackPhotosDrawerOpen = ref(false)
const routePlaybackTimeWindowSec = ref(180) // 默认 ±3 分钟

let playbackAnimId: number | null = null
let playbackLastFrameTime = 0
let playbackAllProjectedCoords: [number, number][] = []
let lastTrailCutIdx = -1
let lastTrailUpdateMs = 0
let isMapZooming = false
let zoomEndTimeout: ReturnType<typeof setTimeout> | null = null

const routePlaybackCurrentTimeMs = computed<number | null>(() => {
  if (!routePlaybackPoints.value.length) return null
  const pts = routePlaybackPoints.value
  const tStart = pts[0].time ? new Date(pts[0].time).getTime() : 0
  const lastTime = pts[pts.length - 1]?.time
  const tEnd = lastTime ? new Date(lastTime).getTime() : 0
  if (!tStart || !tEnd || tEnd <= tStart) {
    const durMs = (routePlaybackRoute.value?.durationSec || 3600) * 1000
    return (tStart || Date.now()) + routePlaybackProgress.value * durMs
  }
  return tStart + routePlaybackProgress.value * (tEnd - tStart)
})

const routePlaybackCurrentPoint = computed<{
  coord: [number, number]
  renderCoord: [number, number]
  speedKmh: number | null
  ele: number | null
  hr: number | null
  distM: number
} | null>(() => {
  const pts = routePlaybackPoints.value
  if (!pts.length) return null
  if (pts.length === 1 || routePlaybackProgress.value <= 0) {
    const p = pts[0]
    const renderCoord: [number, number] = isGcj02Active.value
      ? wgs84ToGcj02(p.lon, p.lat)
      : [p.lon, p.lat]
    return {
      coord: [p.lon, p.lat],
      renderCoord,
      speedKmh: p.speedKmh ?? null,
      ele: p.ele ?? null,
      hr: p.hr ?? null,
      distM: 0
    }
  }
  if (routePlaybackProgress.value >= 1) {
    const p = pts[pts.length - 1]
    const renderCoord: [number, number] = isGcj02Active.value
      ? wgs84ToGcj02(p.lon, p.lat)
      : [p.lon, p.lat]
    return {
      coord: [p.lon, p.lat],
      renderCoord,
      speedKmh: p.speedKmh ?? null,
      ele: p.ele ?? null,
      hr: p.hr ?? null,
      distM: p.distFromStartM
    }
  }

  const targetTimeMs = routePlaybackCurrentTimeMs.value
  const tStart = pts[0].time ? new Date(pts[0].time).getTime() : 0
  const lastTime = pts[pts.length - 1]?.time
  const tEnd = lastTime ? new Date(lastTime).getTime() : 0

  let idx = 0
  let ratio = 0

  if (targetTimeMs && tStart && tEnd && tEnd > tStart) {
    let low = 0
    let high = pts.length - 2
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const tMid = pts[mid].time ? new Date(pts[mid].time!).getTime() : 0
      const tNext = pts[mid + 1].time ? new Date(pts[mid + 1].time!).getTime() : 0
      if (targetTimeMs >= tMid && targetTimeMs <= tNext) {
        idx = mid
        const span = tNext - tMid
        ratio = span > 0 ? (targetTimeMs - tMid) / span : 0
        break
      } else if (targetTimeMs < tMid) {
        high = mid - 1
      } else {
        low = mid + 1
      }
    }
    if (low > high) {
      idx = Math.max(0, Math.min(pts.length - 2, high))
      ratio = 0
    }
  } else {
    const exact = routePlaybackProgress.value * (pts.length - 1)
    idx = Math.floor(exact)
    ratio = exact - idx
  }

  const p1 = pts[idx]
  const p2 = pts[idx + 1] || p1
  const lon = p1.lon + (p2.lon - p1.lon) * ratio
  const lat = p1.lat + (p2.lat - p1.lat) * ratio
  const ele =
    p1.ele != null && p2.ele != null ? p1.ele + (p2.ele - p1.ele) * ratio : (p1.ele ?? null)
  const speedKmh =
    p1.speedKmh != null && p2.speedKmh != null
      ? p1.speedKmh + (p2.speedKmh - p1.speedKmh) * ratio
      : (p1.speedKmh ?? null)
  const hr = p1.hr ?? p2.hr ?? null
  const distM = p1.distFromStartM + (p2.distFromStartM - p1.distFromStartM) * ratio

  const renderCoord: [number, number] = isGcj02Active.value ? wgs84ToGcj02(lon, lat) : [lon, lat]

  return {
    coord: [lon, lat],
    renderCoord,
    speedKmh,
    ele,
    hr,
    distM
  }
})

const currentWindowPhotos = computed(() => {
  if (!routePlaybackPhotos.value.length) return []
  const curTimeMs = routePlaybackCurrentTimeMs.value
  if (!curTimeMs) return routePlaybackPhotos.value

  const winSec = routePlaybackTimeWindowSec.value
  if (winSec === -1) {
    return routePlaybackPhotos.value
  }

  const offsetMs = routePlaybackOffsetSec.value * 1000

  return routePlaybackPhotos.value.filter((p) => {
    if (!p.taken_at) return false
    const pTimeMs = new Date(p.taken_at).getTime() + offsetMs
    const diffSec = Math.abs(pTimeMs - curTimeMs) / 1000
    return diffSec <= winSec
  })
})

const playbackCurrentTimeStr = computed(() => {
  if (!routePlaybackCurrentTimeMs.value) return ''
  try {
    const d = new Date(routePlaybackCurrentTimeMs.value)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
})

const playbackElapsedDurationStr = computed(() => {
  if (!routePlaybackRoute.value) return '+00:00'
  const totalSec = routePlaybackRoute.value.durationSec || 3600
  const curSec = Math.round(routePlaybackProgress.value * totalSec)
  const h = Math.floor(curSec / 3600)
  const m = Math.floor((curSec % 3600) / 60)
  const s = curSec % 60
  if (h > 0) {
    return `+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

const playbackTotalDurationStr = computed(() => {
  if (!routePlaybackRoute.value) return '00:00'
  const totalSec = routePlaybackRoute.value.durationSec || 3600
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

const playbackCurrentDistStr = computed(() => {
  const distM = routePlaybackCurrentPoint.value?.distM ?? 0
  return `${(distM / 1000).toFixed(2)} km`
})

const playbackTotalDistStr = computed(() => {
  const totalM = routePlaybackRoute.value?.totalDistanceM ?? 0
  return `${(totalM / 1000).toFixed(2)} km`
})

function setupRoutePlaybackLayers(): void {
  if (!map) return

  if (!map.getSource('yarj-playback-full')) {
    map.addSource('yarj-playback-full', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: 'yarj-playback-full-line',
      type: 'line',
      source: 'yarj-playback-full',
      paint: {
        'line-color': themeRgba(0.35),
        'line-width': 4,
        'line-opacity': 0.35,
        'line-dasharray': [2, 2]
      }
    })
  }

  if (!map.getSource('yarj-playback-trail')) {
    map.addSource('yarj-playback-trail', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: 'yarj-playback-trail-glow',
      type: 'line',
      source: 'yarj-playback-trail',
      paint: {
        'line-color': themeRgba(0.85),
        'line-width': 10,
        'line-blur': 4,
        'line-opacity': 0.65
      }
    })
    map.addLayer({
      id: 'yarj-playback-trail-line',
      type: 'line',
      source: 'yarj-playback-trail',
      paint: {
        'line-color': themeRgba(1),
        'line-width': 5,
        'line-opacity': 0.95
      }
    })
  }

  if (!map.getSource('yarj-playback-head')) {
    map.addSource('yarj-playback-head', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    })
    map.addLayer({
      id: 'yarj-playback-head-halo',
      type: 'circle',
      source: 'yarj-playback-head',
      paint: {
        'circle-color': themeRgba(0.35),
        'circle-radius': 16,
        'circle-blur': 0.4
      }
    })
    map.addLayer({
      id: 'yarj-playback-head-dot',
      type: 'circle',
      source: 'yarj-playback-head',
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': 7,
        'circle-stroke-width': 3,
        'circle-stroke-color': themeRgba(1)
      }
    })
  }
}

function updatePlaybackMapFrame(): void {
  if (!map || !routePlaybackActive.value) return
  const cur = routePlaybackCurrentPoint.value
  if (!cur) return

  const pts = routePlaybackPoints.value
  const targetTimeMs = routePlaybackCurrentTimeMs.value
  const firstTime = pts[0]?.time
  const tStart = firstTime ? new Date(firstTime).getTime() : 0
  const lastTime = pts[pts.length - 1]?.time
  const tEnd = lastTime ? new Date(lastTime).getTime() : 0

  let cutIdx = 0
  if (targetTimeMs && tStart && tEnd && tEnd > tStart) {
    for (let i = 0; i < pts.length; i++) {
      const ptTime = pts[i].time ? new Date(pts[i].time!).getTime() : 0
      if (ptTime <= targetTimeMs) {
        cutIdx = i
      } else {
        break
      }
    }
  } else {
    cutIdx = Math.floor(routePlaybackProgress.value * (pts.length - 1))
  }

  const nowMs = performance.now()
  if (cutIdx !== lastTrailCutIdx || nowMs - lastTrailUpdateMs > 80) {
    lastTrailCutIdx = cutIdx
    lastTrailUpdateMs = nowMs

    const trailCoords = (
      playbackAllProjectedCoords.length > 0
        ? playbackAllProjectedCoords.slice(0, cutIdx + 1)
        : pts
            .slice(0, cutIdx + 1)
            .map((p) => (isGcj02Active.value ? wgs84ToGcj02(p.lon, p.lat) : [p.lon, p.lat]))
    ) as [number, number][]
    trailCoords.push(cur.renderCoord)

    const trailSrc = map.getSource('yarj-playback-trail') as GeoJSONSource | undefined
    if (trailSrc) {
      trailSrc.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: trailCoords
        }
      })
    }
  }

  const headSrc = map.getSource('yarj-playback-head') as GeoJSONSource | undefined
  if (headSrc) {
    headSrc.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Point',
        coordinates: cur.renderCoord
      }
    })
  }

  if (routePlaybackFollowCamera.value && !isMapZooming) {
    map.easeTo({
      center: cur.renderCoord,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      duration: 120
    })
  }
}

function reCenterPlaybackCamera(forceFollow = true): void {
  if (forceFollow) {
    routePlaybackFollowCamera.value = true
  }
  if (!map || !routePlaybackCurrentPoint.value) return
  map.easeTo({
    center: routePlaybackCurrentPoint.value.renderCoord,
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
    duration: 300
  })
}

function playbackLoop(now: number): void {
  if (!routePlaybackIsPlaying.value || !routePlaybackActive.value) return
  const dtSec = (now - playbackLastFrameTime) / 1000
  playbackLastFrameTime = now

  const totalDurationSec = routePlaybackRoute.value?.durationSec || 3600
  const progressDelta = (dtSec * routePlaybackSpeed.value) / Math.max(1, totalDurationSec)
  let nextProgress = routePlaybackProgress.value + progressDelta

  if (nextProgress >= 1) {
    nextProgress = 1
    routePlaybackProgress.value = 1
    routePlaybackIsPlaying.value = false
    updatePlaybackMapFrame()
    return
  }

  routePlaybackProgress.value = nextProgress
  updatePlaybackMapFrame()
  playbackAnimId = requestAnimationFrame(playbackLoop)
}

function toggleRoutePlaybackPlay(): void {
  if (routePlaybackIsPlaying.value) {
    routePlaybackIsPlaying.value = false
    if (playbackAnimId != null) {
      cancelAnimationFrame(playbackAnimId)
      playbackAnimId = null
    }
  } else {
    if (routePlaybackProgress.value >= 1) {
      routePlaybackProgress.value = 0
    }
    routePlaybackIsPlaying.value = true
    playbackLastFrameTime = performance.now()
    playbackAnimId = requestAnimationFrame(playbackLoop)
  }
}

async function startRoutePlayback(route: Route): Promise<void> {
  exitExploration()
  closePhotoDrawer()
  routeDetailModalOpen.value = false

  routePlaybackRoute.value = route
  routePlaybackProgress.value = 0
  routePlaybackActive.value = true
  routePlaybackIsPlaying.value = false
  routePlaybackPhotosDrawerOpen.value = false

  setupRoutePlaybackLayers()

  if (map) {
    map.scrollZoom.disable()
    map.scrollZoom.enable({ around: 'center' })
  }

  try {
    const res = (await window.cockpit.command('yarj.get-route-points', { id: route.id })) as {
      ok: boolean
      points?: RoutePoint[]
    }
    if (res?.ok && res.points) {
      routePlaybackPoints.value = res.points
      playbackAllProjectedCoords = res.points.map((p) =>
        isGcj02Active.value ? wgs84ToGcj02(p.lon, p.lat) : [p.lon, p.lat]
      )
      lastTrailCutIdx = -1
      lastTrailUpdateMs = 0
    } else {
      routePlaybackPoints.value = []
      playbackAllProjectedCoords = []
    }
  } catch {
    routePlaybackPoints.value = []
    playbackAllProjectedCoords = []
  }

  try {
    const res = (await window.cockpit.command('yarj.get-route-photos', { routeId: route.id })) as {
      ok: boolean
      photos?: Photo[]
      detectedOffsetSec?: number
      isLocalTime?: boolean
    }
    if (res?.ok && res.photos) {
      routePlaybackPhotos.value = res.photos
      routePlaybackOffsetSec.value = res.detectedOffsetSec ?? 0
      routePlaybackIsLocalTime.value = res.isLocalTime ?? false
    } else {
      routePlaybackPhotos.value = []
    }
  } catch {
    routePlaybackPhotos.value = []
  }

  if (map) {
    const fullCoords = playbackAllProjectedCoords
    const fullSrc = map.getSource('yarj-playback-full') as GeoJSONSource | undefined
    if (fullSrc) {
      fullSrc.setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: fullCoords
        }
      })
    }

    if (route.bounds) {
      map.fitBounds(
        [
          [route.bounds[0], route.bounds[1]],
          [route.bounds[2], route.bounds[3]]
        ],
        { padding: 100, maxZoom: 15 }
      )
    }
  }

  updatePlaybackMapFrame()
  toggleRoutePlaybackPlay()
}

function stopRoutePlayback(): void {
  routePlaybackIsPlaying.value = false
  if (playbackAnimId != null) {
    cancelAnimationFrame(playbackAnimId)
    playbackAnimId = null
  }
  routePlaybackActive.value = false
  routePlaybackRoute.value = null
  routePlaybackPoints.value = []
  routePlaybackPhotos.value = []
  routePlaybackPhotosDrawerOpen.value = false
  playbackAllProjectedCoords = []
  lastTrailCutIdx = -1
  lastTrailUpdateMs = 0

  if (map) {
    map.scrollZoom.disable()
    map.scrollZoom.enable()
    const fullSrc = map.getSource('yarj-playback-full') as GeoJSONSource | undefined
    fullSrc?.setData({ type: 'FeatureCollection', features: [] })
    const trailSrc = map.getSource('yarj-playback-trail') as GeoJSONSource | undefined
    trailSrc?.setData({ type: 'FeatureCollection', features: [] })
    const headSrc = map.getSource('yarj-playback-head') as GeoJSONSource | undefined
    headSrc?.setData({ type: 'FeatureCollection', features: [] })
    map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 300 })
  }
}

watch(isGcj02Active, () => {
  if (routePlaybackActive.value && routePlaybackPoints.value.length > 0) {
    playbackAllProjectedCoords = routePlaybackPoints.value.map((p) =>
      isGcj02Active.value ? wgs84ToGcj02(p.lon, p.lat) : [p.lon, p.lat]
    )
    lastTrailCutIdx = -1
    lastTrailUpdateMs = 0
    updatePlaybackMapFrame()
  }
})

function onRoutePlaybackProgressChange(v: number): void {
  routePlaybackProgress.value = Math.max(0, Math.min(1, v))
  updatePlaybackMapFrame()
  if (routePlaybackFollowCamera.value && !routePlaybackIsPlaying.value) {
    reCenterPlaybackCamera(false)
  }
}

function onRoutePlaybackJumpTime(deltaSec: number): void {
  const totalSec = routePlaybackRoute.value?.durationSec || 3600
  const deltaProgress = deltaSec / Math.max(1, totalSec)
  onRoutePlaybackProgressChange(routePlaybackProgress.value + deltaProgress)
}

function onRoutePlaybackJumpToSplit(split: RouteSplit): void {
  const targetDistM = split.km * 1000
  const totalM = routePlaybackRoute.value?.totalDistanceM || 1
  onRoutePlaybackProgressChange(targetDistM / totalM)
}

function toggleRoutePlaybackPhotosDrawer(): void {
  routePlaybackPhotosDrawerOpen.value = !routePlaybackPhotosDrawerOpen.value
  if (map) {
    const rightPad = routePlaybackPhotosDrawerOpen.value ? 380 : 0
    map.easeTo({
      padding: { top: 0, bottom: 0, left: 0, right: rightPad },
      duration: 300
    })
  }
}

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
// 谷歌 Geocoding 地名搜索与定位
// ---------------------------------------------------------------------------

const geocodeQuery = ref('')
const geocodeLoading = ref(false)
const geocodeResults = ref<GeocodeResult[]>([])

async function searchLocation(): Promise<void> {
  const q = geocodeQuery.value.trim()
  if (!q) return
  geocodeLoading.value = true
  try {
    const res = (await window.cockpit.command('yarj.geocode', {
      query: q,
      lang: uiLang.value
    })) as { ok?: boolean; results?: GeocodeResult[] } | null
    if (res?.ok && Array.isArray(res.results)) {
      geocodeResults.value = res.results
      if (!res.results.length) {
        showSnack(t('yarj.geocode.noResults', '未找到匹配的地理位置'), 'warning')
      }
    }
  } catch (err) {
    console.error('Geocode search failed:', err)
  } finally {
    geocodeLoading.value = false
  }
}

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

// ---------------------------------------------------------------------------
// 照片模糊搜索 (Page-Menu -> 右侧抽屉联动)
// ---------------------------------------------------------------------------

const photoSearchQuery = ref('')

const photoSearchResults = computed(() => {
  const q = photoSearchQuery.value.trim()
  if (!q) return photos.value
  return filterPhotosWithQuery(photos.value, q)
})

function showAllSearchResultsInDrawer(): void {
  if (!photoSearchResults.value.length) return
  openPhotoDrawer(photoSearchResults.value, null)
  menuOpen.value = false
  const firstWithGps = photoSearchResults.value.find((p) => p.gps_lat != null && p.gps_lon != null)
  if (firstWithGps && map) {
    locateCoords([firstWithGps.gps_lon as number, firstWithGps.gps_lat as number])
  }
}

function selectSearchResultPhoto(p: Photo): void {
  const guess = guessedGpsMap.value.get(p.path)
  const coords: [number, number] | null =
    p.gps_lat != null && p.gps_lon != null
      ? [p.gps_lon, p.gps_lat]
      : guess
        ? [guess.lon, guess.lat]
        : null

  openPhotoDrawer(photoSearchResults.value, coords)
  if (coords) {
    locateCoords(coords)
  }
  menuOpen.value = false
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

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

async function refreshStats(): Promise<void> {
  stats.value = (await window.cockpit.command('yarj.scan-status')) as ScanStats
  lodStatus.value = ((await window.cockpit.command('yarj.lod-status')) as LodStatusRow[]) ?? []
  hierarchyStatus.value =
    ((await window.cockpit.command('yarj.hierarchy-status')) as HierarchyStatusRow[]) ?? []
  cacheStats.value = ((await window.cockpit.command('yarj.cache-stats')) as TileCacheStats) ?? null
}

const pageMenuRef = ref<HTMLElement | null>(null)
let menuCleanup: (() => void) | null = null

function menuClose(): void {
  menuOpen.value = false
  menuStep.value = 'main'
}

function onMenuDocClick(e: MouseEvent): void {
  const el = pageMenuRef.value
  const t = e.target as Node | null
  if (!el || !t || !t.isConnected) return
  if (el.contains(t)) return
  // 如果点击的是弹出对话框、下拉菜单、覆盖层等（如 Vuetify 传送到 body 的元素），不触发菜单关闭
  const elTarget = t instanceof Element ? t : t.parentElement
  if (
    elTarget?.closest('.v-overlay') ||
    elTarget?.closest('.v-dialog') ||
    elTarget?.closest('.v-menu') ||
    elTarget?.closest('.v-snackbar')
  ) {
    return
  }
  menuClose()
}

function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuClose()
}

watch(menuOpen, (open) => {
  menuCleanup?.()
  menuCleanup = null
  if (open) {
    document.addEventListener('click', onMenuDocClick)
    document.addEventListener('contextmenu', onMenuDocClick)
    document.addEventListener('keydown', onMenuKey)
    menuCleanup = (): void => {
      document.removeEventListener('click', onMenuDocClick)
      document.removeEventListener('contextmenu', onMenuDocClick)
      document.removeEventListener('keydown', onMenuKey)
    }
  }
})

function toggleMenu(): void {
  if (menuOpen.value) {
    menuClose()
  } else {
    menuOpen.value = true
    menuStep.value = 'main'
  }
}

function openProviders(): void {
  menuStep.value = 'providers'
}

function openStats(): void {
  menuStep.value = 'stats'
  void refreshStats()
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

function formatRunStatus(s: string): string {
  if (s === 'running') return t('yarj.scan.running', '扫描中')
  if (s === 'done') return t('yarj.scan.done', '扫描完成')
  if (s === 'cancelled') return t('yarj.scan.cancelled', '已取消')
  return t('yarj.scan.failed', '扫描失败')
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
    menuOpen.value = false
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
  labelFontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif'
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
  menuCleanup?.()
  menuCleanup = null
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
  menuCleanup?.()
  menuCleanup = null
  resizeObserver?.disconnect()
  if (labelMoveRaf != null) {
    window.cancelAnimationFrame(labelMoveRaf)
    labelMoveRaf = null
  }
  if (viewSaveTimer) window.clearTimeout(viewSaveTimer)
  if (lodFilterTimer) window.clearTimeout(lodFilterTimer)
  if (lodPollTimer) window.clearTimeout(lodPollTimer)
  if (map) {
    map.remove()
    map = null
  }
})

// ---------------------------------------------------------------------------
// 右下按钮阵列
// ---------------------------------------------------------------------------

function zoomIn(): void {
  map?.zoomIn()
}

function zoomOut(): void {
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

    <!-- 地图拾取坐标顶栏提示 -->
    <Transition name="fade">
      <div v-if="pickingGpsPhoto" class="yarj-pick-banner">
        <div class="d-flex align-center ga-3 min-w-0">
          <v-icon size="20" color="primary" class="spin">mdi-crosshairs-gps</v-icon>
          <span class="text-body-2 font-weight-medium text-truncate">
            {{ t('yarj.pick.banner', '正在拾取位置：请点击地图选择目标坐标') }} —
            <b>{{ pickingGpsPhoto.path.split('/').pop() }}</b>
          </span>
          <v-chip
            v-if="isGcj02Active"
            size="x-small"
            color="warning"
            variant="flat"
            class="flex-shrink-0"
            :title="
              t(
                'yarj.providers.gcj02Hint',
                '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
              )
            "
          >
            {{ t('yarj.providers.gcj02Badge', 'GCJ-02 火星坐标系') }}
          </v-chip>
        </div>
        <v-btn variant="tonal" color="error" class="ml-4 flex-shrink-0" @click="cancelPickGps">
          {{ t('yarj.drawer.cancel', '取消') }}
        </v-btn>
      </div>
    </Transition>

    <!-- 地图批量平移坐标顶栏提示 -->
    <Transition name="fade">
      <div v-if="relocatingPhotos" class="yarj-pick-banner">
        <div class="d-flex align-center ga-3 min-w-0">
          <v-icon size="20" color="primary" class="spin">mdi-map-marker-distance</v-icon>
          <span class="text-body-2 font-weight-medium text-truncate">
            {{
              t(
                'yarj.drawer.relocatingBanner',
                '正在批量平移位置：请点击地图选择新中心（保留各照片间距）'
              )
            }}
            —
            <b>{{ relocatingPhotos.length }} 张照片</b>
          </span>
          <v-chip
            v-if="isGcj02Active"
            size="x-small"
            color="warning"
            variant="flat"
            class="flex-shrink-0"
            :title="
              t(
                'yarj.providers.gcj02Hint',
                '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
              )
            "
          >
            {{ t('yarj.providers.gcj02Badge', 'GCJ-02 火星坐标系') }}
          </v-chip>
        </div>
        <v-btn
          variant="tonal"
          color="error"
          class="ml-4 flex-shrink-0"
          @click="cancelRelocateGroup"
        >
          {{ t('yarj.drawer.cancel', '取消') }}
        </v-btn>
      </div>
    </Transition>

    <!-- 右上角悬浮待定位缩略图（悬浮自动放大） -->
    <Transition name="fade">
      <div v-if="pickingGpsPhoto" class="yarj-pick-floating-preview">
        <div class="preview-inner">
          <v-img
            :src="photoThumbUrl(pickingGpsPhoto.path)"
            :alt="pickingGpsPhoto.path"
            class="preview-img"
            cover
          >
            <template #placeholder>
              <div class="d-flex align-center justify-center fill-height bg-surface-variant-subtle">
                <v-progress-circular indeterminate color="primary" size="20" width="2" />
              </div>
            </template>
          </v-img>
          <div class="preview-badge">
            <v-icon size="14" color="white" class="mr-1">mdi-map-marker</v-icon>
            <span>{{ t('yarj.pick.targetBadge', '待定位') }}</span>
          </div>
          <div class="preview-expanded-info">
            <div class="text-caption font-weight-bold text-truncate">
              {{ pickingGpsPhoto.path.split('/').pop() }}
            </div>
            <div class="text-caption on-surface-variant text-truncate">
              {{ pickingGpsPhoto.camera_model || pickingGpsPhoto.camera_make || 'Photo' }}
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 地图错误提示条 -->
    <Transition name="fade">
      <div v-if="mapError" class="yarj-map-error">
        <v-icon size="16" color="error">mdi-alert-circle-outline</v-icon>
        <span class="ml-1">{{ mapError }}</span>
      </div>
    </Transition>

    <!-- 探索模式顶部「时空穿梭 / 当前时间」醒目 HUD 胶囊栏 -->
    <Transition name="fade">
      <div
        v-if="explorationActive && journeyData?.stages.length"
        class="yarj-journey-time-badge"
        :class="{ 'has-drawer-open': drawerOpen }"
      >
        <div class="time-badge-inner">
          <v-icon
            size="24"
            color="primary"
            class="time-shuttle-icon mr-1"
            :class="{ 'is-shuttling': isTimeShuttling || isPlaying }"
          >
            {{ isPlaying ? 'mdi-timelapse' : 'mdi-clock-time-four-outline' }}
          </v-icon>
          <div class="d-flex align-center ga-2 font-mono time-display">
            <span class="time-date-text">{{ displayDatePart }}</span>
            <span class="time-clock-text">{{ displayTimePart }}</span>
          </div>
        </div>
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
    <div class="yarj-controls">
      <v-btn
        icon
        variant="flat"
        class="yarj-ctrl-btn"
        :class="{ active: explorationActive }"
        :disabled="routePlaybackActive"
        :title="
          routePlaybackActive
            ? '行程播放中，无法开启探索'
            : explorationActive
              ? '退出探索'
              : t('yarj.exploration.title', '我的探索')
        "
        @click="explorationActive ? exitExploration() : startExploration()"
      >
        <v-icon :color="explorationActive ? 'primary' : undefined">mdi-compass</v-icon>
      </v-btn>
      <v-btn
        icon
        variant="flat"
        class="yarj-ctrl-btn"
        :title="t('yarj.map.zoomIn', '放大')"
        @click="zoomIn"
      >
        <v-icon>mdi-plus</v-icon>
      </v-btn>
      <v-btn
        icon
        variant="flat"
        class="yarj-ctrl-btn"
        :title="t('yarj.map.zoomOut', '缩小')"
        @click="zoomOut"
      >
        <v-icon>mdi-minus</v-icon>
      </v-btn>
      <v-btn
        icon
        variant="flat"
        class="yarj-ctrl-btn"
        :title="t('yarj.map.projection', '切换地球/平面')"
        @click="toggleProjection"
      >
        <v-icon v-if="isGlobe">mdi-earth</v-icon>
        <v-icon v-else>mdi-map-outline</v-icon>
      </v-btn>
      <v-btn
        icon
        variant="flat"
        class="yarj-ctrl-btn"
        :title="t('yarj.map.reset', '复位视图')"
        @click="resetView"
      >
        <v-icon>mdi-crosshairs-gps</v-icon>
      </v-btn>
    </div>

    <!-- page-menu（仿 AIDJ） -->
    <div ref="pageMenuRef" class="page-menu" :class="{ 'is-open': menuOpen }" @click.stop>
      <button class="page-menu-handle" @click="toggleMenu">
        <v-icon size="16">{{ menuOpen ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
      </button>

      <Transition name="menu-pop">
        <div v-if="menuOpen" class="page-menu-pop">
          <!-- 主菜单 -->
          <template v-if="menuStep === 'main'">
            <div class="menu-item" @click="startExplorationFromMenu">
              <v-icon size="18" color="primary">mdi-compass-outline</v-icon>
              <span>{{ t('yarj.exploration.title', '我的探索') }}</span>
              <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
                {{ t('yarj.exploration.badge', '旅途漫游') }}
              </v-chip>
              <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'photo-search'">
              <v-icon size="18">mdi-image-search-outline</v-icon>
              <span>{{ t('yarj.menu.photoSearch', '照片搜索') }}</span>
              <v-chip
                v-if="photos.length"
                size="x-small"
                variant="tonal"
                color="primary"
                class="ml-auto"
              >
                {{ photos.length }}
              </v-chip>
              <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="openRoutesDrawer">
              <v-icon size="18" color="cyan">mdi-map-marker-path</v-icon>
              <span>{{ t('yarj.menu.routes', '运动航线') }}</span>
              <v-chip
                v-if="routes.length"
                size="x-small"
                variant="tonal"
                color="cyan"
                class="ml-auto"
              >
                {{ routes.length }}
              </v-chip>
              <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'search'">
              <v-icon size="18">mdi-map-search-outline</v-icon>
              <span>{{ t('yarj.menu.search', '地名搜索与跳转') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="openProviders">
              <v-icon size="18">mdi-map-legend</v-icon>
              <span>{{ t('yarj.menu.providers', '图源切换') }}</span>
              <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
                {{ activeProviderName }}
              </v-chip>
              <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="startScan">
              <v-icon size="18" :class="{ spin: scanRunning }">mdi-sync</v-icon>
              <span>{{ t('yarj.menu.scan', '扫描') }}</span>
              <v-icon v-if="scanRunning" size="14" class="ml-auto spin">mdi-loading</v-icon>
            </div>
            <div class="menu-item" @click="openStats">
              <v-icon size="18">mdi-chart-box-outline</v-icon>
              <span>{{ t('yarj.menu.stats', '数据统计') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'explored'">
              <v-icon size="18">mdi-map-marker-distance</v-icon>
              <span>{{ t('yarj.menu.explored', '探索区域与粒度') }}</span>
              <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
                {{
                  t(
                    GRANULARITY_PRESETS[exploredGranularity]?.nameKey,
                    GRANULARITY_PRESETS[exploredGranularity]?.defaultName
                  )
                }}
              </v-chip>
              <v-icon size="16" class="ml-1">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'layers'">
              <v-icon size="18">mdi-layers-outline</v-icon>
              <span>{{ t('yarj.menu.layers', '图层') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'build'">
              <v-icon size="18">mdi-map-marker-path</v-icon>
              <span>{{ t('yarj.menu.footprintBuild', '足迹构建') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item text-error" @click="pruneConfirmDialogOpen = true">
              <v-icon size="18" color="error">mdi-broom</v-icon>
              <span>{{ t('yarj.menu.prune', '清理失效记录') }}</span>
            </div>
          </template>

          <!-- 足迹构建菜单 -->
          <template v-else-if="menuStep === 'build'">
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('yarj.menu.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('yarj.menu.footprintBuild', '足迹构建')
              }}</span>
            </div>

            <div class="px-2 pt-1 pb-2 d-flex flex-column ga-1">
              <div class="menu-item" @click="openRouteGeotagModal()">
                <v-icon size="18" color="cyan">mdi-crosshairs-gps</v-icon>
                <div class="d-flex flex-column flex-grow-1 mr-2 text-left">
                  <span>{{ t('yarj.build.geotagFromRoute', '基于运动轨迹贴合照片') }}</span>
                  <span
                    class="text-caption on-surface-variant text-truncate"
                    style="max-width: 200px"
                  >
                    {{
                      t('yarj.build.geotagFromRouteDesc', '通过 GPX 时间戳对齐与插值纠正拍摄位置')
                    }}
                  </span>
                </div>
                <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
              </div>

              <div class="menu-item" @click="openGpsCorrectionModal">
                <v-icon size="18" color="primary">mdi-auto-fix</v-icon>
                <div class="d-flex flex-column flex-grow-1 mr-2 text-left">
                  <span>{{ t('yarj.build.gpsCorrection', 'GPS 漂移时空纠正') }}</span>
                  <span
                    class="text-caption on-surface-variant text-truncate"
                    style="max-width: 200px"
                  >
                    {{
                      t(
                        'yarj.build.gpsCorrectionMenuDesc',
                        '按时序与速度合理性修复跨国/跨区离群漂移'
                      )
                    }}
                  </span>
                </div>
                <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
              </div>

              <div class="menu-item" @click="triggerRecomputeGuesses">
                <v-icon size="18" color="warning">mdi-map-marker-question-outline</v-icon>
                <div class="d-flex flex-column flex-grow-1 mr-2 text-left">
                  <span>{{ t('yarj.build.recomputeGuesses', '重算未定位照片中点猜测') }}</span>
                  <span
                    class="text-caption on-surface-variant text-truncate"
                    style="max-width: 200px"
                  >
                    {{ t('yarj.build.recomputeGuessesDesc', '在相邻有坐标照片之间静态推算定位') }}
                  </span>
                </div>
                <v-icon size="16" class="ml-auto">mdi-refresh</v-icon>
              </div>
            </div>
          </template>

          <!-- 探索区域与粒度设置 -->
          <template v-else-if="menuStep === 'explored'">
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('yarj.menu.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('yarj.menu.explored', '探索区域与粒度')
              }}</span>
            </div>

            <div class="px-2 py-2">
              <div
                class="d-flex align-center justify-space-between px-3 py-2 rounded-lg mb-2"
                style="background: rgba(var(--v-theme-surface-bright), 0.15)"
              >
                <div class="d-flex align-center ga-2">
                  <v-icon size="18">mdi-map-clock-outline</v-icon>
                  <span class="text-body-2">{{
                    t('yarj.explored.showLayer', '显示探索区域图层')
                  }}</span>
                </div>
                <v-switch
                  :model-value="showExploredLayer"
                  color="primary"
                  density="compact"
                  hide-details
                  @update:model-value="(v: boolean | null) => setExploredLayerVisible(v ?? true)"
                />
              </div>

              <div class="text-caption on-surface-variant px-2 pt-1 pb-2">
                {{
                  t(
                    'yarj.explored.granularityHint',
                    '粒度越大，对时间与空间距离变化越不敏感，能将整趟行程/多日活动平滑聚合成连贯探索领地。'
                  )
                }}
              </div>

              <div class="d-flex flex-column ga-1">
                <div
                  v-for="preset in Object.values(GRANULARITY_PRESETS)"
                  :key="preset.id"
                  class="menu-item d-flex align-center justify-space-between py-2"
                  :class="{ active: exploredGranularity === preset.id }"
                  @click="setExploredGranularity(preset.id)"
                >
                  <div class="d-flex flex-column min-w-0 pr-2">
                    <span class="text-body-2 font-weight-medium">{{
                      t(preset.nameKey, preset.defaultName)
                    }}</span>
                    <span class="text-caption on-surface-variant">
                      {{
                        t(
                          'yarj.explored.presetDetail',
                          `时差 ≤ ${preset.timeWindowHours}h · 距离 ≤ ${(preset.maxLinkDistM / 1000).toFixed(1)}km`
                        )
                      }}
                    </span>
                  </div>
                  <v-icon v-if="exploredGranularity === preset.id" size="18" color="primary">
                    mdi-check
                  </v-icon>
                </div>
              </div>
            </div>
          </template>

          <!-- 地名搜索与跳转菜单（谷歌 Geocoding） -->
          <template v-else-if="menuStep === 'search'">
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('yarj.menu.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('yarj.menu.search', '地名搜索与跳转')
              }}</span>
            </div>
            <div class="px-2 pt-1 pb-2">
              <v-text-field
                v-model="geocodeQuery"
                :placeholder="
                  t('yarj.geocode.placeholder', '输入城市、景点或地名（如：东京铁塔、故宫）')
                "
                density="compact"
                variant="outlined"
                hide-details
                autofocus
                clearable
                append-inner-icon="mdi-magnify"
                :loading="geocodeLoading"
                @keydown.enter="searchLocation"
                @click:append-inner="searchLocation"
              />
            </div>
            <div class="sessions-scroll px-1 pb-1">
              <div
                v-if="!geocodeResults.length && !geocodeLoading"
                class="text-caption on-surface-variant pt-2 px-2"
              >
                {{ t('yarj.geocode.hint', '输入地名后按 Enter 搜索，点击结果将快速飞往目标位置') }}
              </div>
              <div
                v-for="(res, idx) in geocodeResults"
                :key="idx"
                class="menu-item d-flex align-start ga-2"
                @click="flyToGeocode(res)"
              >
                <v-icon size="18" color="primary" class="mt-1 flex-shrink-0">mdi-map-marker</v-icon>
                <div class="min-w-0 flex-grow-1">
                  <div class="text-caption font-weight-bold text-truncate">
                    {{ res.formattedAddress }}
                  </div>
                  <div class="text-caption on-surface-variant font-mono">
                    {{ res.lat.toFixed(4) }}°, {{ res.lon.toFixed(4) }}°
                  </div>
                </div>
                <v-chip size="x-small" variant="tonal" color="primary" class="flex-shrink-0 mt-1">
                  {{ res.provider.toUpperCase() }}
                </v-chip>
              </div>
            </div>
          </template>

          <!-- 照片模糊搜索菜单 -->
          <template v-else-if="menuStep === 'photo-search'">
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('yarj.menu.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('yarj.menu.photoSearch', '照片搜索')
              }}</span>
              <v-btn
                icon
                size="x-small"
                variant="text"
                :title="t('yarj.search.helpBtn', '高级搜索语法指南 (SEARCH.md)')"
                @click="searchHelpOpen = true"
              >
                <v-icon size="16">mdi-help-circle-outline</v-icon>
              </v-btn>
              <v-chip size="x-small" variant="tonal" color="primary" class="ml-auto">
                {{ photoSearchResults.length }}
              </v-chip>
            </div>

            <div class="px-2 pt-1 pb-2">
              <v-text-field
                v-model="photoSearchQuery"
                :placeholder="
                  t('yarj.photoSearch.placeholder', '输入文件名、标签、地名、相机或备注…')
                "
                density="compact"
                variant="outlined"
                hide-details
                autofocus
                clearable
                prepend-inner-icon="mdi-magnify"
                @keydown.enter="showAllSearchResultsInDrawer"
              />
            </div>

            <div v-if="photoSearchResults.length" class="px-2 pb-2">
              <v-btn
                variant="tonal"
                color="primary"
                block
                prepend-icon="mdi-page-layout-sidebar-right"
                @click="showAllSearchResultsInDrawer"
              >
                {{ t('yarj.photoSearch.showInDrawer', '在右侧抽屉展示全部匹配照片') }} ({{
                  photoSearchResults.length
                }})
              </v-btn>
            </div>

            <div class="sessions-scroll px-1 pb-1">
              <div
                v-if="!photoSearchResults.length"
                class="text-caption on-surface-variant pt-2 px-2 text-center"
              >
                {{
                  photoSearchQuery
                    ? t('yarj.photoSearch.noResults', '未找到匹配的照片')
                    : t('yarj.photoSearch.hint', '支持按文件名、标签、地址、拍摄机型或备注模糊搜索')
                }}
              </div>
              <div
                v-for="(p, idx) in photoSearchResults.slice(0, 40)"
                :key="p.id || idx"
                class="menu-item d-flex align-center ga-2"
                @click="selectSearchResultPhoto(p)"
              >
                <v-img
                  :src="photoThumbUrl(p.path)"
                  width="36"
                  height="36"
                  cover
                  class="rounded-md flex-shrink-0"
                >
                  <template #placeholder>
                    <div
                      class="d-flex align-center justify-center fill-height bg-surface-variant-subtle"
                    >
                      <v-progress-circular indeterminate color="primary" size="14" width="1.5" />
                    </div>
                  </template>
                </v-img>
                <div class="min-w-0 flex-grow-1">
                  <div class="text-caption font-weight-bold text-truncate">
                    {{ p.path.split('/').pop() }}
                  </div>
                  <div class="text-caption on-surface-variant text-truncate">
                    {{
                      (p.appendix?.formatted_address as string) ||
                      (p.appendix?.tags as string[])?.join(', ') ||
                      p.camera_model ||
                      (p.gps_lat != null
                        ? `${p.gps_lat.toFixed(4)}°, ${p.gps_lon?.toFixed(4)}°`
                        : guessedGpsMap.get(p.path)
                          ? `[${t('yarj.guess.badge', '大致 GPS 猜测')}] ${guessedGpsMap.get(p.path)!.lat.toFixed(4)}°, ${guessedGpsMap.get(p.path)!.lon.toFixed(4)}°`
                          : '无 GPS')
                    }}
                  </div>
                </div>
                <v-icon size="16" color="primary" class="flex-shrink-0">mdi-chevron-right</v-icon>
              </div>
            </div>
          </template>

          <!-- 图源切换菜单 -->
          <template v-else-if="menuStep === 'providers'">
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('yarj.menu.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('yarj.menu.providers', '图源切换')
              }}</span>
            </div>
            <div class="sessions-scroll px-1 pb-1">
              <div
                v-for="p in providers"
                :key="p.id"
                class="menu-item provider-item"
                :class="{ 'is-active': p.id === activeProviderId }"
                @click="switchProvider(p.id)"
              >
                <v-icon size="18" :color="p.id === activeProviderId ? 'primary' : 'default'">
                  {{ p.id === activeProviderId ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank' }}
                </v-icon>
                <span class="text-caption font-weight-medium text-truncate flex-grow-1">{{
                  p.name
                }}</span>
                <div class="d-flex align-center ga-1 flex-shrink-0">
                  <v-chip
                    v-if="p.coordSystem === 'gcj02'"
                    size="x-small"
                    variant="flat"
                    color="warning"
                  >
                    GCJ-02
                  </v-chip>
                  <v-chip
                    size="x-small"
                    variant="tonal"
                    :color="
                      p.category === 'google'
                        ? 'primary'
                        : p.category === 'google-official'
                          ? 'warning'
                          : p.category === 'amap' || p.category === 'tencent'
                            ? 'warning'
                            : p.isLocal
                              ? 'secondary'
                              : 'default'
                    "
                  >
                    {{ p.category === 'google-official' ? 'TILES API' : p.category.toUpperCase() }}
                  </v-chip>
                </div>
              </div>
            </div>
          </template>

          <!-- 数据统计菜单 -->
          <template v-else-if="menuStep === 'stats'">
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('yarj.menu.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('yarj.menu.stats', '数据统计')
              }}</span>
            </div>
            <div class="px-1 pt-1 stats-grid">
              <div class="stat-card">
                <div class="stat-value">{{ stats?.photoCount ?? 0 }}</div>
                <div class="stat-label">{{ t('yarj.stats.photos', '照片总数') }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-value" :class="{ 'text-primary': (stats?.withGps ?? 0) > 0 }">
                  {{ stats?.withGps ?? 0 }}
                </div>
                <div class="stat-label">{{ t('yarj.stats.withGps', '含 GPS 定位') }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{{ (stats?.photoCount ?? 0) - (stats?.withGps ?? 0) }}</div>
                <div class="stat-label">{{ t('yarj.stats.noGps', '无定位照片') }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-value">{{ Object.keys(stats?.byRoot ?? {}).length }}</div>
                <div class="stat-label">{{ t('yarj.stats.rootsCount', '已接入目录') }}</div>
              </div>
            </div>

            <div
              class="text-caption font-weight-medium px-2 pt-3 pb-1 on-surface-variant d-flex align-center"
            >
              <span>{{ t('yarj.stats.recentScans', '最近扫描历史') }}</span>
              <span v-if="stats?.lastRuns?.length" class="ml-auto text-caption font-weight-regular">
                {{ stats.lastRuns.length }} 次
              </span>
            </div>
            <div class="sessions-scroll px-1 pb-1">
              <div
                v-if="!stats?.lastRuns?.length"
                class="text-caption on-surface-variant pt-2 px-1"
              >
                {{ t('yarj.scan.none', '还没有扫描记录') }}
              </div>
              <div
                v-for="r in stats?.lastRuns ?? []"
                :key="r.id"
                class="scan-run-row d-flex align-center ga-2"
              >
                <v-chip
                  size="x-small"
                  variant="tonal"
                  :color="
                    r.status === 'done' ? 'success' : r.status === 'error' ? 'error' : 'warning'
                  "
                  class="status-chip"
                >
                  {{ formatRunStatus(r.status) }}
                </v-chip>
                <span class="text-caption text-truncate min-w-0 flex-grow-1" :title="r.root">
                  {{ r.root.split('/').filter(Boolean).pop() || r.root }}
                </span>
                <span class="text-caption on-surface-variant">
                  共 {{ r.total }} · 含定位 {{ r.with_gps }}
                </span>
              </div>
            </div>

            <!-- 瓦片本地缓存配额占用 -->
            <div class="px-2 pt-2 pb-1 border-t mt-1">
              <div class="d-flex align-center justify-space-between mb-1">
                <span class="text-caption font-weight-medium on-surface-variant">
                  {{ t('yarj.settings.cacheTitle', '瓦片本地磁盘缓存') }}
                </span>
                <span class="text-caption on-surface-variant">
                  {{ formatBytes(cacheStats?.totalBytes ?? 0) }} /
                  {{
                    (cacheStats?.maxMb ?? 1024) > 0
                      ? formatBytes((cacheStats?.maxMb ?? 1024) * 1024 * 1024)
                      : t('yarj.cache.unlimited', '无限制')
                  }}
                </span>
              </div>
              <v-progress-linear
                v-if="(cacheStats?.maxMb ?? 1024) > 0"
                :model-value="
                  Math.min(
                    100,
                    Math.round(
                      ((cacheStats?.totalBytes ?? 0) /
                        ((cacheStats?.maxMb ?? 1024) * 1024 * 1024)) *
                        100
                    )
                  )
                "
                :color="
                  (cacheStats?.totalBytes ?? 0) / ((cacheStats?.maxMb ?? 1024) * 1024 * 1024) > 0.9
                    ? 'warning'
                    : 'primary'
                "
                height="4"
                rounded
                class="mb-1"
              />
            </div>
          </template>

          <!-- 图层开关菜单 -->
          <template v-else-if="menuStep === 'layers'">
            <div class="sessions-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('yarj.menu.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('yarj.menu.layers', '图层')
              }}</span>
            </div>
            <div class="px-1 pt-1 d-flex flex-column ga-1">
              <v-switch
                :model-value="showPhotosLayer"
                color="primary"
                hide-details
                density="compact"
                :label="t('yarj.layers.photos', '照片点')"
                @update:model-value="(v: boolean | null) => setPhotosLayerVisible(v ?? true)"
              />
              <v-switch
                :model-value="showExploredLayer"
                color="primary"
                hide-details
                density="compact"
                :label="t('yarj.layers.explored', '探索区域')"
                @update:model-value="(v: boolean | null) => setExploredLayerVisible(v ?? true)"
              />
              <v-switch
                :model-value="showRoutesLayer"
                color="cyan"
                hide-details
                density="compact"
                :label="t('yarj.layers.routes', '运动航线')"
                @update:model-value="(v: boolean | null) => setRoutesLayerVisible(v ?? true)"
              />
            </div>
          </template>
        </div>
      </Transition>
    </div>

    <!-- 「我的探索」沉浸式浮动控制面板 -->
    <Transition name="fade">
      <div
        v-if="explorationActive && journeyData?.stages.length"
        class="yarj-exploration-bar"
        :class="{ 'has-drawer-open': drawerOpen }"
      >
        <div class="exploration-card">
          <!-- 第一行：阶段信息、时空跃迁与退出按钮 -->
          <div class="d-flex align-center justify-space-between ga-3 mb-3">
            <div class="d-flex align-center ga-2 min-w-0 flex-grow-1">
              <!-- 支持点击键入站点编号快速精准跳转 -->
              <v-menu
                v-model="jumpMenuOpen"
                :close-on-content-click="false"
                location="bottom start"
              >
                <template #activator="{ props: jumpProps }">
                  <v-chip
                    v-bind="jumpProps"
                    color="primary"
                    variant="flat"
                    class="font-weight-bold px-3 cursor-pointer flex-shrink-0"
                    :title="
                      t('yarj.exploration.jumpHint', '输入站点编号直接跳转 (1 ~ {total})').replace(
                        '{total}',
                        String(journeyData.stages.length)
                      )
                    "
                  >
                    {{
                      t('yarj.exploration.stageCount', '第 {curr} / {total} 站')
                        .replace('{curr}', String(currentStageIndex + 1))
                        .replace('{total}', String(journeyData.stages.length))
                    }}
                    <v-icon end size="14" class="ml-1 opacity-80">mdi-menu-swap</v-icon>
                  </v-chip>
                </template>
                <v-card
                  class="pa-4 rounded-xl elevation-6"
                  min-width="300"
                  style="
                    background: rgba(var(--v-theme-surface), 0.95);
                    backdrop-filter: blur(24px);
                  "
                >
                  <div class="text-subtitle-2 font-weight-bold mb-1">
                    {{
                      t('yarj.exploration.jumpTitle', '跳转至指定站点 (1 ~ {total})').replace(
                        '{total}',
                        String(journeyData.stages.length)
                      )
                    }}
                  </div>
                  <div class="text-caption on-surface-variant mb-3">
                    {{
                      t(
                        'yarj.exploration.jumpDesc',
                        '直接键入目标站点编号，一键快速飞往并穿梭到该时间点。'
                      )
                    }}
                  </div>
                  <div class="d-flex align-center ga-2 mb-3">
                    <v-text-field
                      v-model="jumpStageInput"
                      type="number"
                      :min="1"
                      :max="journeyData.stages.length"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :placeholder="String(currentStageIndex + 1)"
                      @keyup.enter="handleJumpStage"
                    />
                    <v-btn
                      color="primary"
                      variant="flat"
                      density="comfortable"
                      @click="handleJumpStage"
                    >
                      {{ t('yarj.exploration.jumpBtn', '前往') }}
                    </v-btn>
                  </div>
                  <!-- 快捷节点跳转 -->
                  <div class="d-flex flex-wrap ga-1">
                    <v-chip
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(1)"
                    >
                      {{ t('yarj.exploration.firstStage', '首站 (1)') }}
                    </v-chip>
                    <v-chip
                      v-if="journeyData.stages.length >= 4"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(Math.round(journeyData.stages.length * 0.25))"
                    >
                      25%
                    </v-chip>
                    <v-chip
                      v-if="journeyData.stages.length >= 2"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(Math.round(journeyData.stages.length * 0.5))"
                    >
                      50%
                    </v-chip>
                    <v-chip
                      v-if="journeyData.stages.length >= 4"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(Math.round(journeyData.stages.length * 0.75))"
                    >
                      75%
                    </v-chip>
                    <v-chip
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="jumpToStageNum(journeyData.stages.length)"
                    >
                      {{
                        t('yarj.exploration.lastStage', '末站 ({total})').replace(
                          '{total}',
                          String(journeyData.stages.length)
                        )
                      }}
                    </v-chip>
                  </div>
                </v-card>
              </v-menu>

              <div class="min-w-0 flex-grow-1">
                <div class="text-subtitle-2 font-weight-bold text-truncate">
                  {{ currentStage?.title || '旅途节点' }}
                </div>
                <div
                  v-if="currentStage?.formattedTimeRange"
                  class="text-caption on-surface-variant font-mono text-truncate"
                >
                  {{ currentStage.formattedTimeRange }}
                </div>
              </div>
            </div>

            <!-- 右侧：交通推测 Chip 与 退出按钮 -->
            <div class="d-flex align-center ga-2 flex-shrink-0">
              <v-chip
                v-if="currentLeg"
                variant="tonal"
                :style="{
                  color: currentLeg.modeMeta.color,
                  borderColor: currentLeg.modeMeta.color
                }"
                class="px-3"
              >
                <v-icon start size="16">{{ currentLeg.modeMeta.icon }}</v-icon>
                <span class="font-weight-medium">{{
                  t(currentLeg.modeMeta.nameKey, currentLeg.modeMeta.defaultName)
                }}</span>
                <span class="ml-1 opacity-80 font-mono">
                  ·
                  {{ (currentLeg.distanceM / 1000).toFixed(currentLeg.distanceM > 10000 ? 0 : 1) }}
                  km
                  <template v-if="currentLeg.speedKmH">
                    ({{ currentLeg.speedKmH.toFixed(0) }} km/h)
                  </template>
                </span>
              </v-chip>

              <v-btn
                icon
                size="small"
                variant="text"
                color="error"
                :title="t('yarj.exploration.exit', '退出探索')"
                @click="exitExploration"
              >
                <v-icon size="20">mdi-close</v-icon>
              </v-btn>
            </div>
          </div>

          <v-divider class="mb-3 opacity-20" />

          <!-- 第二行：操作控制工具栏（左侧粒度/设置 + 右侧播放与照片动作，自然两端对齐） -->
          <div class="d-flex align-center justify-space-between ga-3 flex-wrap">
            <!-- 左侧：粒度选择器、自定义目标站数与视距聚焦 -->
            <div class="d-flex align-center ga-2 flex-wrap">
              <div class="d-flex align-center ga-1 granularity-stepper">
                <span class="text-caption on-surface-variant mr-1"
                  >{{ t('yarj.exploration.granularity', '粒度') }}:</span
                >
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :disabled="currentGranularityIndex <= 0"
                  @click="cycleExplorationGranularity(-1)"
                >
                  <v-icon size="16">mdi-chevron-left</v-icon>
                </v-btn>
                <v-menu location="top">
                  <template #activator="{ props: menuProps }">
                    <v-btn
                      v-bind="menuProps"
                      variant="tonal"
                      density="comfortable"
                      class="text-caption font-weight-medium px-2"
                    >
                      {{
                        customStageCount != null
                          ? `${customStageCount} 站 (自定义)`
                          : t(
                              GRANULARITY_PRESETS[explorationGranularity]?.nameKey,
                              GRANULARITY_PRESETS[explorationGranularity]?.defaultName
                            ).split(' ')[0] || '标准'
                      }}
                      <v-icon end size="14">mdi-menu-down</v-icon>
                    </v-btn>
                  </template>
                  <v-list density="compact">
                    <v-list-item
                      v-for="preset in Object.values(GRANULARITY_PRESETS)"
                      :key="preset.id"
                      :active="customStageCount == null && explorationGranularity === preset.id"
                      @click="setExplorationGranularity(preset.id)"
                    >
                      <v-list-item-title class="text-caption">
                        {{ t(preset.nameKey, preset.defaultName) }}
                      </v-list-item-title>
                    </v-list-item>
                    <v-divider class="my-1 opacity-20" />
                    <v-list-item @click="targetCountMenuOpen = true">
                      <template #prepend>
                        <v-icon size="16">mdi-map-marker-distance</v-icon>
                      </template>
                      <v-list-item-title class="text-caption">
                        {{ t('yarj.exploration.customCountBtn', '自定义总站数...') }}
                      </v-list-item-title>
                    </v-list-item>
                  </v-list>
                </v-menu>
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :disabled="currentGranularityIndex >= GRANULARITY_LIST.length - 1"
                  @click="cycleExplorationGranularity(1)"
                >
                  <v-icon size="16">mdi-chevron-right</v-icon>
                </v-btn>
              </div>

              <!-- 跳转至指定站点按钮 -->
              <v-btn
                variant="tonal"
                density="comfortable"
                class="text-caption font-weight-medium px-2"
                prepend-icon="mdi-ray-start-arrow"
                :title="
                  t('yarj.exploration.jumpHint', '输入站点编号直接跳转 (1 ~ {total})').replace(
                    '{total}',
                    String(journeyData.stages.length)
                  )
                "
                @click="jumpMenuOpen = true"
              >
                {{ t('yarj.exploration.jumpBtnTitle', '跳转站点') }}
              </v-btn>

              <!-- 自定义目标站点数量弹窗 -->
              <v-dialog v-model="targetCountMenuOpen" max-width="360">
                <v-card
                  class="pa-4 rounded-xl elevation-6"
                  style="
                    background: rgba(var(--v-theme-surface), 0.95);
                    backdrop-filter: blur(24px);
                  "
                >
                  <div class="text-subtitle-2 font-weight-bold mb-1">
                    {{ t('yarj.exploration.customCountTitle', '键入目标站点数量') }}
                  </div>
                  <div class="text-caption on-surface-variant mb-3">
                    {{
                      t(
                        'yarj.exploration.customCountDesc',
                        '设定目标站数，自动将海量照片智能聚类为指定数量的代表站点，省去过多琐碎跳转。'
                      )
                    }}
                  </div>
                  <div class="d-flex align-center ga-2 mb-3">
                    <v-text-field
                      v-model="customTargetCountInput"
                      type="number"
                      :min="2"
                      :max="Math.min(100, explorationPhotos.length)"
                      density="compact"
                      variant="outlined"
                      hide-details
                      :placeholder="String(journeyData.stages.length)"
                      @keyup.enter="applyCustomTargetCount"
                    />
                    <v-btn
                      color="primary"
                      variant="flat"
                      density="comfortable"
                      @click="applyCustomTargetCount"
                    >
                      {{ t('yarj.exploration.apply', '生成') }}
                    </v-btn>
                  </div>
                  <div class="d-flex flex-wrap ga-1">
                    <v-chip
                      v-for="presetCount in [5, 8, 12, 20].filter(
                        (c) => c < explorationPhotos.length
                      )"
                      :key="presetCount"
                      size="small"
                      variant="tonal"
                      class="cursor-pointer"
                      @click="setTargetCount(presetCount)"
                    >
                      {{ presetCount }} 站
                    </v-chip>
                    <v-chip
                      v-if="customStageCount != null"
                      size="small"
                      variant="tonal"
                      color="secondary"
                      class="cursor-pointer"
                      @click="resetToGranularity"
                    >
                      {{ t('yarj.exploration.resetGranularity', '恢复预设') }}
                    </v-chip>
                  </div>
                </v-card>
              </v-dialog>

              <!-- 视距聚焦与远距离淡化控制 -->
              <v-menu v-model="focusRangeMenuOpen" location="top">
                <template #activator="{ props: focusProps }">
                  <v-btn
                    v-bind="focusProps"
                    icon
                    size="small"
                    variant="tonal"
                    :color="journeyFocusRange > 0 ? 'primary' : undefined"
                    :title="
                      t('yarj.exploration.focusHint', '聚焦视距：远距离站点与航线自动淡化/隐藏')
                    "
                  >
                    <v-icon size="18">mdi-eye-circle-outline</v-icon>
                  </v-btn>
                </template>
                <v-list density="compact" min-width="160">
                  <v-list-item
                    v-for="item in [
                      { value: 3, label: t('yarj.exploration.focus3', '前后 3 站 (紧凑聚焦)') },
                      { value: 5, label: t('yarj.exploration.focus5', '前后 5 站 (推荐标准)') },
                      { value: 8, label: t('yarj.exploration.focus8', '前后 8 站 (开阔视野)') },
                      { value: 0, label: t('yarj.exploration.focusAll', '全部显示 (全局透视)') }
                    ]"
                    :key="item.value"
                    :active="journeyFocusRange === item.value"
                    @click="setJourneyFocusRange(item.value)"
                  >
                    <v-list-item-title class="text-caption">
                      {{ item.label }}
                    </v-list-item-title>
                  </v-list-item>
                </v-list>
              </v-menu>
            </div>

            <!-- 右侧：本站照片 + 巡航播放控制 -->
            <div class="d-flex align-center ga-2 flex-wrap">
              <v-btn
                v-if="currentStage?.photos.length"
                variant="tonal"
                density="comfortable"
                prepend-icon="mdi-image-multiple-outline"
                @click="openPhotoDrawer(currentStage.photos, currentStage.center)"
              >
                {{ t('yarj.exploration.viewPhotos', '本站照片') }} ({{
                  currentStage.photos.length
                }})
              </v-btn>

              <v-btn
                icon
                size="small"
                variant="tonal"
                :disabled="currentStageIndex <= 0"
                @click="prevStage"
              >
                <v-icon size="20">mdi-skip-previous</v-icon>
              </v-btn>

              <v-btn
                :color="isPlaying ? 'secondary' : 'primary'"
                variant="flat"
                density="comfortable"
                :prepend-icon="isPlaying ? 'mdi-pause' : 'mdi-play'"
                @click="togglePlay"
              >
                {{
                  isPlaying
                    ? t('yarj.exploration.pause', '暂停')
                    : t('yarj.exploration.play', '自动巡航')
                }}
              </v-btn>

              <v-btn
                icon
                size="small"
                variant="tonal"
                :disabled="currentStageIndex >= journeyData.stages.length - 1"
                @click="nextStage"
              >
                <v-icon size="20">mdi-skip-next</v-icon>
              </v-btn>
            </div>
          </div>
        </div>
      </div>
    </Transition>

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

    <!-- 确认更新照片定位对话框 -->
    <v-dialog v-model="confirmGpsDialogOpen" max-width="480" persistent>
      <v-card
        class="pa-5 rounded-2xl"
        style="background: rgba(var(--v-theme-surface), 0.95); backdrop-filter: blur(24px)"
      >
        <div class="d-flex align-center ga-3 mb-4">
          <v-icon size="26" color="primary">mdi-map-marker-check</v-icon>
          <span class="text-h6 font-weight-bold">{{
            t('yarj.pick.confirmTitle', '确认更新照片定位')
          }}</span>
        </div>

        <div
          v-if="pickingGpsPhoto"
          class="d-flex align-center ga-3 pa-3 rounded-xl mb-4"
          style="background: rgba(var(--v-theme-surface-bright), 0.18)"
        >
          <v-img
            :src="photoThumbUrl(pickingGpsPhoto.path)"
            width="60"
            height="60"
            cover
            class="rounded-lg flex-shrink-0"
          >
            <template #placeholder>
              <div class="d-flex align-center justify-center fill-height bg-surface-variant-subtle">
                <v-progress-circular indeterminate color="primary" size="20" width="2" />
              </div>
            </template>
          </v-img>
          <div class="min-w-0 flex-grow-1">
            <div class="text-body-1 font-weight-bold text-truncate">
              {{ pickingGpsPhoto.path.split('/').pop() }}
            </div>
            <div class="text-caption on-surface-variant mt-1">
              {{ pickingGpsPhoto.camera_model || 'Photo' }}
            </div>
          </div>
        </div>

        <v-alert
          v-if="isGcj02Active"
          type="warning"
          variant="tonal"
          density="compact"
          icon="mdi-alert-circle-outline"
          class="mb-4 text-caption"
        >
          {{
            t(
              'yarj.providers.gcj02Hint',
              '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
            )
          }}
        </v-alert>

        <div class="mb-4 text-body-2 d-flex flex-column ga-2">
          <div class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.pick.newCoords', '拾取的新经纬度') }}:</span
            >
            <span class="font-weight-bold font-mono text-primary">
              {{ pendingGpsCoords?.lat.toFixed(5) }}°N, {{ pendingGpsCoords?.lon.toFixed(5) }}°E
            </span>
          </div>
          <div
            v-if="pickingGpsPhoto?.gps_lat != null"
            class="d-flex justify-space-between align-center"
          >
            <span class="on-surface-variant">{{ t('yarj.pick.oldCoords', '原经纬度') }}:</span>
            <span class="on-surface-variant font-mono">
              {{ pickingGpsPhoto.gps_lat?.toFixed(5) }}°N,
              {{ pickingGpsPhoto.gps_lon?.toFixed(5) }}°E
            </span>
          </div>
          <div
            v-if="pendingGpsAddress"
            class="d-flex align-start ga-2 mt-2 pa-3 rounded-lg"
            style="
              background: rgba(var(--v-theme-primary), 0.08);
              border: 1px solid rgba(var(--v-theme-primary), 0.18);
            "
          >
            <v-icon size="16" color="primary" class="mt-1 flex-shrink-0">mdi-map-marker</v-icon>
            <span class="text-caption font-weight-medium">{{ pendingGpsAddress }}</span>
          </div>
          <div v-else class="mt-2">
            <v-btn
              variant="tonal"
              color="primary"
              block
              prepend-icon="mdi-map-marker-radius"
              :loading="pendingGpsGeocoding"
              @click="requestPendingGeocode"
            >
              {{ t('yarj.pick.manualGeocode', '解析地名地址 (可选)') }}
            </v-btn>
          </div>
        </div>

        <v-card-actions class="px-0 pb-0 pt-3 ga-3 justify-end d-flex border-t">
          <v-btn variant="text" @click="cancelPickGps">
            {{ t('yarj.drawer.cancel', '取消') }}
          </v-btn>
          <v-btn color="primary" variant="flat" @click="confirmSaveGps">
            {{ t('yarj.pick.confirmBtn', '确认更新') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 确认批量平移照片 GPS 定位对话框 -->
    <v-dialog v-model="confirmRelocateDialogOpen" max-width="480" persistent>
      <v-card
        class="pa-5 rounded-2xl"
        style="background: rgba(var(--v-theme-surface), 0.95); backdrop-filter: blur(24px)"
      >
        <div class="d-flex align-center ga-3 mb-4">
          <v-icon size="26" color="primary">mdi-map-marker-distance</v-icon>
          <span class="text-h6 font-weight-bold">{{
            t('yarj.drawer.relocateConfirmTitle', '确认批量平移照片 GPS 定位')
          }}</span>
        </div>

        <div
          class="d-flex align-center ga-3 pa-3 rounded-xl mb-4"
          style="background: rgba(var(--v-theme-surface-bright), 0.18)"
        >
          <v-avatar color="primary" variant="tonal" size="44">
            <v-icon size="24">mdi-image-multiple</v-icon>
          </v-avatar>
          <div class="min-w-0 flex-grow-1">
            <div class="text-body-1 font-weight-bold text-truncate">
              {{
                t(
                  'yarj.drawer.relocateCountDesc',
                  `共 ${relocatingPhotos?.length ?? 0} 张照片`
                ).replace('{n}', String(relocatingPhotos?.length ?? 0))
              }}
            </div>
            <div class="text-caption on-surface-variant mt-1">
              {{
                t(
                  'yarj.drawer.relocateKeepOffsetTip',
                  '系统将以新位置为锚点，保留组内各照片相对间距'
                )
              }}
            </div>
          </div>
        </div>

        <v-alert
          v-if="isGcj02Active"
          type="warning"
          variant="tonal"
          density="compact"
          icon="mdi-alert-circle-outline"
          class="mb-4 text-caption"
        >
          {{
            t(
              'yarj.providers.gcj02Hint',
              '提示：当前底图为高德/腾讯火星坐标系 (GCJ-02)，带有国内非线性加密偏移（约数百米）。调整后的 GPS 坐标适用于当前国内底图对齐。'
            )
          }}
        </v-alert>

        <div class="mb-4 text-body-2 d-flex flex-column ga-2">
          <div class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.drawer.relocateOldCenter', '原位置中心') }}:</span
            >
            <span class="on-surface-variant font-mono">
              {{ relocatingAnchor?.lat.toFixed(5) }}°N, {{ relocatingAnchor?.lon.toFixed(5) }}°E
            </span>
          </div>
          <div class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.drawer.relocateNewCenter', '平移后新中心') }}:</span
            >
            <span class="font-weight-bold font-mono text-primary">
              {{ pendingRelocateTarget?.lat.toFixed(5) }}°N,
              {{ pendingRelocateTarget?.lon.toFixed(5) }}°E
            </span>
          </div>
          <div v-if="relocateDistanceStr" class="d-flex justify-space-between align-center">
            <span class="on-surface-variant"
              >{{ t('yarj.drawer.relocateDistance', '平移位移距离') }}:</span
            >
            <span class="font-weight-bold font-mono text-success">
              ≈ {{ relocateDistanceStr }}
            </span>
          </div>
        </div>

        <v-card-actions class="px-0 pb-0 pt-3 ga-3 justify-end d-flex border-t">
          <v-btn variant="text" :disabled="relocatingLoading" @click="cancelRelocateGroup">
            {{ t('yarj.drawer.cancel', '取消') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :loading="relocatingLoading"
            @click="confirmSaveRelocate"
          >
            {{ t('yarj.drawer.confirmRelocate', '确认平移') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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

.yarj-pick-banner {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-radius: 24px;
  background: rgba(var(--v-theme-surface), 0.9);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1.5px solid rgb(var(--v-theme-primary));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-width: 90%;
}

.yarj-pick-floating-preview {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 35;
  border-radius: 16px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  background: rgba(var(--v-theme-surface), 0.85);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  border: 2px solid rgb(var(--v-theme-primary));
  overflow: hidden;
  transition:
    transform 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    width 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    height 0.25s cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 0.25s ease;
  width: 76px;
  height: 76px;
  cursor: pointer;
}

.yarj-pick-floating-preview:hover {
  width: 240px;
  height: 240px;
  transform: scale(1.03);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}

.preview-inner {
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
}

.preview-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.preview-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  display: flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(6px);
  color: #ffffff;
  font-size: 0.7rem;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.preview-expanded-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 8px 10px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0) 100%);
  color: #ffffff;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
  pointer-events: none;
}

.yarj-pick-floating-preview:hover .preview-badge {
  opacity: 0;
}

.yarj-pick-floating-preview:hover .preview-expanded-info {
  opacity: 1;
  transform: translateY(0);
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

.yarj-controls {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.yarj-ctrl-btn {
  width: 42px !important;
  height: 42px !important;
  border-radius: 12px !important;
  background: rgba(var(--v-theme-surface), 0.65) !important;
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  color: rgb(var(--v-theme-on-surface)) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  transition:
    transform 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.yarj-ctrl-btn:hover {
  color: rgb(var(--v-theme-primary)) !important;
  transform: translateY(-2px);
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

.page-menu {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.page-menu-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 24px;
  border: none;
  cursor: pointer;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-top: none;
  border-radius: 0 0 24px 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transition: color 0.15s ease;
}

.page-menu-handle:hover {
  color: rgb(var(--v-theme-primary));
}

.page-menu.is-open .page-menu-handle {
  color: rgb(var(--v-theme-primary));
}

.page-menu-pop {
  margin-top: 4px;
  width: 360px;
  background: rgba(var(--v-theme-surface), 0.75);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 8px;
  overflow: hidden;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.menu-item:hover {
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}

.provider-item.is-active {
  background: rgba(var(--v-theme-primary), 0.15);
  color: rgb(var(--v-theme-primary));
}

.sessions-head {
  padding: 2px 4px 6px;
}

.sessions-scroll {
  max-height: 320px;
  overflow-y: auto;
  min-height: 0;
}

.sessions-scroll::-webkit-scrollbar {
  width: 6px;
}

.sessions-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.45);
  border-radius: 3px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding-bottom: 8px;
}

.stat-card {
  padding: 12px;
  border-radius: 8px;
  text-align: center;
  background: rgba(var(--v-theme-primary), 0.1);
  border: 1px solid rgba(var(--v-theme-primary), 0.25);
}

.stat-value {
  font-size: 1.4rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  font-variant-numeric: tabular-nums;
}

.stat-label {
  margin-top: 2px;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
}

.scan-run-row {
  padding: 6px 2px;
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.15);
}

.status-chip {
  padding-block: 4px;
  min-height: 24px;
}

.spin {
  animation: yarj-spin 1.1s linear infinite;
}

@keyframes yarj-spin {
  to {
    transform: rotate(360deg);
  }
}

.menu-pop-enter-active,
.menu-pop-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 「我的探索」沉浸式浮动控制面板 */
.yarj-exploration-bar {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  width: calc(100% - 48px);
  max-width: 860px;
  z-index: 20;
  pointer-events: none;
  transition:
    left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.yarj-exploration-bar.has-drawer-open {
  left: 24px;
  transform: none;
  width: calc(100% - 420px - 56px);
  max-width: calc(100% - 420px - 56px);
}

.exploration-card {
  pointer-events: auto;
  background: rgba(var(--v-theme-surface), 0.88);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.25);
  border-radius: 16px;
  padding: 16px 20px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
}

.granularity-stepper {
  background: rgba(var(--v-theme-surface-bright), 0.12);
  border-radius: 8px;
  padding: 2px 6px;
}

/* 顶部时空穿梭时间指示栏 */
.yarj-journey-time-badge {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  pointer-events: none;
  transition:
    left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.yarj-journey-time-badge.has-drawer-open {
  left: calc((100% - 420px - 16px) / 2);
  transform: translateX(-50%);
}

.time-badge-inner {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  background: rgba(var(--v-theme-surface), 0.94);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  border: 1.5px solid rgba(var(--v-theme-primary), 0.55);
  border-radius: 36px;
  box-shadow:
    0 12px 36px rgba(0, 0, 0, 0.55),
    0 0 28px rgba(var(--v-theme-primary), 0.22);
  user-select: none;
}

.time-display {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.8px;
}

.time-date-text {
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.95;
}

.time-clock-text {
  color: rgb(var(--v-theme-primary));
  text-shadow: 0 0 14px rgba(var(--v-theme-primary), 0.45);
}

.time-shuttle-icon {
  filter: drop-shadow(0 0 8px rgba(var(--v-theme-primary), 0.6));
}

.time-shuttle-icon.is-shuttling {
  animation: yarj-spin 1.2s linear infinite;
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
</style>
