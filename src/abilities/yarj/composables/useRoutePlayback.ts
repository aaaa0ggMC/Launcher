import { ref, computed, watch, onUnmounted } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import maplibregl from 'maplibre-gl'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Route, RoutePoint, RouteSplit, Photo, YarjConfig } from '../types'
import { smoothRoutePoints, smoothFollowCamera, smoothFollowMarker } from '../route-smoothing'
import { wgs84ToGcj02 } from '../coord-transform'

export interface UseRoutePlaybackOptions {
  getMap: () => maplibregl.Map | null
  themeRgba: (alpha: number) => string
  isGcj02Active: Ref<boolean>
  yarjConfig: Ref<YarjConfig>
  onBeforeStart?: (route: Route) => void
}

export interface UseRoutePlaybackReturn {
  routePlaybackActive: Ref<boolean>
  routePlaybackRoute: Ref<Route | null>
  routePlaybackPoints: Ref<RoutePoint[]>
  routePlaybackPhotos: Ref<Photo[]>
  routePlaybackOffsetSec: Ref<number>
  routePlaybackIsLocalTime: Ref<boolean>
  routePlaybackIsPlaying: Ref<boolean>
  routePlaybackProgress: Ref<number>
  routePlaybackSpeed: Ref<number>
  routePlaybackFollowCamera: Ref<boolean>
  routePlaybackPhotosDrawerOpen: Ref<boolean>
  routePlaybackTimeWindowSec: Ref<number>
  routePlaybackCurrentTimeMs: ComputedRef<number | null>
  routePlaybackCurrentPoint: ComputedRef<{
    coord: [number, number]
    renderCoord: [number, number]
    idx: number
    ratio: number
    speedKmh: number | null
    ele: number | null
    hr: number | null
    distM: number
  } | null>
  currentWindowPhotos: ComputedRef<Photo[]>
  playbackCurrentTimeStr: ComputedRef<string>
  playbackElapsedDurationStr: ComputedRef<string>
  playbackTotalDurationStr: ComputedRef<string>
  playbackCurrentDistStr: ComputedRef<string>
  playbackTotalDistStr: ComputedRef<string>
  applyRouteSmoothing: () => void
  setupRoutePlaybackLayers: () => void
  getPlaybackPadding: () => { top: number; bottom: number; left: number; right: number }
  updatePlaybackHeadMarker: (coord: [number, number]) => void
  updatePlaybackMapFrame: (point: { coord: [number, number]; speedKmh?: number | null }) => void
  reCenterPlaybackCamera: (forceHeadingNorth?: boolean) => void
  requestPlaybackZoom: (delta: number) => void
  playbackLoop: (timestamp: number) => void
  toggleRoutePlaybackPlay: () => void
  startRoutePlayback: (route: Route) => Promise<void>
  stopRoutePlayback: () => void
  onRoutePlaybackProgressChange: (ratio: number) => void
  onRoutePlaybackJumpTime: (targetTimeMs: number) => void
  onRoutePlaybackJumpToSplit: (split: RouteSplit) => void
  routePlaybackShowFullRoute: Ref<boolean>
  toggleRoutePlaybackShowFullRoute: () => void
  handleMapDragStart: () => void
  toggleRoutePlaybackPhotosDrawer: () => void
}

export function useRoutePlayback(options: UseRoutePlaybackOptions): UseRoutePlaybackReturn {
  const { getMap, themeRgba, isGcj02Active, yarjConfig, onBeforeStart } = options

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
  const routePlaybackShowFullRoute = ref(yarjConfig.value.routePlaybackShowFullRoute !== false)

  function toggleRoutePlaybackShowFullRoute(): void {
    routePlaybackShowFullRoute.value = !routePlaybackShowFullRoute.value
  }

  function applyFullRouteVisibility(): void {
    const map = getMap()
    if (!map) return
    const vis = routePlaybackShowFullRoute.value ? 'visible' : 'none'
    if (map.getLayer('yarj-playback-full-line')) {
      map.setLayoutProperty('yarj-playback-full-line', 'visibility', vis)
    }
    if (map.getLayer('yarj-playback-full-glow')) {
      map.setLayoutProperty('yarj-playback-full-glow', 'visibility', vis)
    }
  }

  watch(routePlaybackShowFullRoute, (val) => {
    applyFullRouteVisibility()
    void window.cockpit
      .command('yarj.save-config', {
        patch: { routePlaybackShowFullRoute: val }
      })
      .catch(() => undefined)
  })

  let playbackAnimId: number | null = null
  let playbackLastFrameTime = 0
  let playbackAllProjectedCoords: [number, number][] = []
  let lastTrailUpdateMs = 0
  let playbackTargetZoom: number | null = null
  let playbackZoomRafId: number | null = null
  let playbackTimestampsMs: number[] = []
  let playbackHeadMarker: maplibregl.Marker | null = null
  let rawPlaybackPoints: RoutePoint[] = []
  let playbackMarkerPos: [number, number] | null = null
  let playbackCameraPos: [number, number] | null = null
  let playbackLastMapFrameMs = 0

  function applyRouteSmoothing(): void {
    const map = getMap()
    if (!rawPlaybackPoints.length) {
      routePlaybackPoints.value = []
      playbackAllProjectedCoords = []
      playbackTimestampsMs = []
      return
    }

    const isSmooth = yarjConfig.value.routeSmoothing !== false
    const win = yarjConfig.value.routeSmoothingWindow ?? 5
    const pts =
      isSmooth && rawPlaybackPoints.length > 2
        ? smoothRoutePoints(rawPlaybackPoints, win)
        : rawPlaybackPoints

    routePlaybackPoints.value = pts
    playbackAllProjectedCoords = pts.map((p) =>
      isGcj02Active.value ? wgs84ToGcj02(p.lon, p.lat) : [p.lon, p.lat]
    )
    let lastT = 0
    playbackTimestampsMs = pts.map((p) => {
      const t = p.time ? new Date(p.time).getTime() : lastT
      lastT = Math.max(lastT, t)
      return lastT
    })
    lastTrailUpdateMs = 0

    if (map && routePlaybackActive.value) {
      const fullSrc = map.getSource('yarj-playback-full') as GeoJSONSource | undefined
      if (fullSrc) {
        fullSrc.setData({
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: playbackAllProjectedCoords
          }
        })
      }
    }
  }

  const routePlaybackCurrentTimeMs = computed<number | null>(() => {
    if (!routePlaybackPoints.value.length || !playbackTimestampsMs.length) return null
    const times = playbackTimestampsMs
    const tStart = times[0] ?? 0
    const tEnd = times[times.length - 1] ?? 0
    if (!tStart || !tEnd || tEnd <= tStart) {
      const durMs = (routePlaybackRoute.value?.durationSec || 3600) * 1000
      return (tStart || Date.now()) + routePlaybackProgress.value * durMs
    }
    return tStart + routePlaybackProgress.value * (tEnd - tStart)
  })

  const routePlaybackCurrentPoint = computed<{
    coord: [number, number]
    renderCoord: [number, number]
    idx: number
    ratio: number
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
        idx: 0,
        ratio: 0,
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
        idx: pts.length - 1,
        ratio: 1,
        speedKmh: p.speedKmh ?? null,
        ele: p.ele ?? null,
        hr: p.hr ?? null,
        distM: p.distFromStartM
      }
    }

    const times = playbackTimestampsMs
    const targetTimeMs = routePlaybackCurrentTimeMs.value
    const tStart = times[0] ?? 0
    const tEnd = times[times.length - 1] ?? 0

    let idx = 0
    let ratio = 0

    if (times.length > 1 && tStart && tEnd && tEnd > tStart && targetTimeMs) {
      let low = 0
      let high = times.length - 1
      while (low < high) {
        const mid = (low + high) >> 1
        if (times[mid] <= targetTimeMs) {
          low = mid + 1
        } else {
          high = mid
        }
      }
      idx = Math.max(0, Math.min(times.length - 2, low - 1))
      const tMid = times[idx]
      const tNext = times[idx + 1]
      const span = tNext - tMid
      ratio = span > 0 ? Math.max(0, Math.min(1, (targetTimeMs - tMid) / span)) : 0
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
      idx,
      ratio,
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
      return d.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
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
    const map = getMap()
    if (!map) return

    if (!map.getSource('yarj-playback-full')) {
      map.addSource('yarj-playback-full', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: 'yarj-playback-full-glow',
        type: 'line',
        source: 'yarj-playback-full',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': themeRgba(0.4),
          'line-width': 8,
          'line-blur': 3,
          'line-opacity': 0.35
        }
      })
      map.addLayer({
        id: 'yarj-playback-full-line',
        type: 'line',
        source: 'yarj-playback-full',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': themeRgba(0.85),
          'line-width': 4.5,
          'line-opacity': 0.65
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
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
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
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': themeRgba(1),
          'line-width': 5.5,
          'line-opacity': 0.95
        }
      })
    }
    applyFullRouteVisibility()
  }

  function getPlaybackPadding(): { top: number; bottom: number; left: number; right: number } {
    return {
      top: 0,
      bottom: 0,
      left: 0,
      right: routePlaybackPhotosDrawerOpen.value ? 380 : 0
    }
  }

  function updatePlaybackHeadMarker(coord: [number, number]): void {
    const map = getMap()
    if (!map) return
    if (!playbackHeadMarker) {
      const el = document.createElement('div')
      el.className = 'yarj-playback-head-marker'
      el.innerHTML = `
        <div class="head-marker-halo"></div>
        <div class="head-marker-dot"></div>
      `
      playbackHeadMarker = new maplibregl.Marker({
        element: el,
        anchor: 'center'
      })
        .setLngLat(coord)
        .addTo(map)
      return
    }
    playbackHeadMarker.setLngLat(coord)
  }

  function updatePlaybackMapFrame(): void {
    const map = getMap()
    if (!map || !routePlaybackActive.value) return
    const cur = routePlaybackCurrentPoint.value
    if (!cur) return

    const pts = routePlaybackPoints.value
    const cutIdx = cur.idx

    const nowMs = performance.now()
    const dtSec =
      playbackLastMapFrameMs > 0 ? Math.min(0.1, (nowMs - playbackLastMapFrameMs) / 1000) : 0.016
    playbackLastMapFrameMs = nowMs

    // 点本身平滑插值 (Marker Position Smoothing)，消除离散插值带来的锯齿横跳
    let markerCoord = cur.renderCoord
    if (
      yarjConfig.value.routeSmoothing !== false &&
      playbackMarkerPos &&
      routePlaybackIsPlaying.value
    ) {
      markerCoord = smoothFollowMarker(playbackMarkerPos, cur.renderCoord, dtSec, 15)
    }
    playbackMarkerPos = markerCoord

    if (nowMs - lastTrailUpdateMs >= 50 || cur.idx === pts.length - 1) {
      lastTrailUpdateMs = nowMs

      const trailCoords = (
        playbackAllProjectedCoords.length > 0
          ? playbackAllProjectedCoords.slice(0, cutIdx + 1)
          : pts
              .slice(0, cutIdx + 1)
              .map((p) => (isGcj02Active.value ? wgs84ToGcj02(p.lon, p.lat) : [p.lon, p.lat]))
      ) as [number, number][]
      trailCoords.push(markerCoord)
      if (trailCoords.length < 2) {
        trailCoords.push(markerCoord)
      }

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

    updatePlaybackHeadMarker(markerCoord)

    if (routePlaybackFollowCamera.value) {
      let finalCenter = markerCoord
      if (
        yarjConfig.value.routeCameraSmoothing !== false &&
        playbackCameraPos &&
        routePlaybackIsPlaying.value
      ) {
        finalCenter = smoothFollowCamera(playbackCameraPos, markerCoord, dtSec, 15)
      }
      playbackCameraPos = finalCenter

      let nextZ: number | undefined
      if (playbackTargetZoom != null) {
        const curZ = map.getZoom()
        const diff = playbackTargetZoom - curZ
        if (Math.abs(diff) < 0.005) {
          nextZ = playbackTargetZoom
          playbackTargetZoom = null
        } else {
          nextZ = curZ + diff * 0.28
        }
      }

      map.jumpTo({
        center: finalCenter,
        ...(nextZ !== undefined ? { zoom: nextZ } : {}),
        padding: getPlaybackPadding()
      })
    } else {
      playbackCameraPos = null
    }
  }

  function reCenterPlaybackCamera(forceFollow = true): void {
    const map = getMap()
    if (forceFollow) {
      routePlaybackFollowCamera.value = true
    }
    playbackTargetZoom = null
    playbackCameraPos = null
    playbackMarkerPos = null
    if (!map || !routePlaybackCurrentPoint.value) return
    map.easeTo({
      center: routePlaybackCurrentPoint.value.renderCoord,
      padding: getPlaybackPadding(),
      duration: 250
    })
  }

  function requestPlaybackZoom(deltaZoom: number): void {
    const map = getMap()
    if (!map) return
    const curZ = playbackTargetZoom ?? map.getZoom()
    const minZ = map.getMinZoom?.() ?? 2
    const maxZ = map.getMaxZoom?.() ?? 20
    playbackTargetZoom = Math.max(minZ, Math.min(maxZ, curZ + deltaZoom))

    if (!routePlaybackIsPlaying.value) {
      if (playbackZoomRafId == null) {
        playbackZoomRafId = requestAnimationFrame(runPausedZoomLoop)
      }
    }
  }

  function runPausedZoomLoop(): void {
    playbackZoomRafId = null
    const map = getMap()
    if (!map || playbackTargetZoom == null) return

    const curZ = map.getZoom()
    const diff = playbackTargetZoom - curZ
    let nextZ: number | undefined
    let active = true

    if (Math.abs(diff) < 0.005) {
      nextZ = playbackTargetZoom
      playbackTargetZoom = null
      active = false
    } else {
      nextZ = curZ + diff * 0.28
    }

    const mapCenter = map.getCenter()
    const centerCoord: [number, number] = routePlaybackFollowCamera.value
      ? (playbackMarkerPos ??
        routePlaybackCurrentPoint.value?.renderCoord ?? [mapCenter.lng, mapCenter.lat])
      : [mapCenter.lng, mapCenter.lat]
    playbackCameraPos = centerCoord

    map.jumpTo({
      center: centerCoord,
      zoom: nextZ,
      padding: getPlaybackPadding()
    })

    if (active) {
      playbackZoomRafId = requestAnimationFrame(runPausedZoomLoop)
    }
  }

  function playbackLoop(now: number): void {
    if (!routePlaybackIsPlaying.value || !routePlaybackActive.value) return
    const rawDtSec = (now - playbackLastFrameTime) / 1000
    // 限制单帧最大时间增量（最多 80ms），防止缩放或切后台瞬时卡顿/掉帧造成进度突进与画面跳跃
    const dtSec = Math.min(0.08, Math.max(0, rawDtSec))
    playbackLastFrameTime = now

    const totalDurationSec =
      routePlaybackRoute.value?.durationSec && routePlaybackRoute.value.durationSec > 0
        ? routePlaybackRoute.value.durationSec
        : playbackTimestampsMs.length > 1 &&
            playbackTimestampsMs[playbackTimestampsMs.length - 1] > playbackTimestampsMs[0]
          ? (playbackTimestampsMs[playbackTimestampsMs.length - 1] - playbackTimestampsMs[0]) / 1000
          : (routePlaybackRoute.value?.totalDistanceM ?? 1000) / 4 || 600

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
      if (playbackTargetZoom != null && playbackZoomRafId == null) {
        playbackZoomRafId = requestAnimationFrame(runPausedZoomLoop)
      }
    } else {
      if (playbackZoomRafId != null) {
        cancelAnimationFrame(playbackZoomRafId)
        playbackZoomRafId = null
      }
      if (routePlaybackProgress.value >= 1) {
        routePlaybackProgress.value = 0
      }
      if (routePlaybackCurrentPoint.value) {
        playbackMarkerPos = routePlaybackCurrentPoint.value.renderCoord
        playbackCameraPos = routePlaybackCurrentPoint.value.renderCoord
      }
      routePlaybackIsPlaying.value = true
      playbackLastFrameTime = performance.now()
      playbackAnimId = requestAnimationFrame(playbackLoop)
    }
  }

  async function startRoutePlayback(route: Route): Promise<void> {
    onBeforeStart?.(route)

    routePlaybackRoute.value = route
    routePlaybackProgress.value = 0
    routePlaybackActive.value = true
    routePlaybackIsPlaying.value = false
    routePlaybackPhotosDrawerOpen.value = false

    setupRoutePlaybackLayers()

    const map = getMap()
    if (map) {
      map.scrollZoom.disable()
      // 立即从 route.geojson 注入全貌坐标，确保首帧路线全貌立即可见，避免任何黑屏/路线消失现象
      try {
        const geo = JSON.parse(route.geojson)
        const coords = geo.geometry?.coordinates
        if (Array.isArray(coords) && coords.length >= 2) {
          const initCoords = coords.map((c: [number, number]) =>
            isGcj02Active.value ? wgs84ToGcj02(c[0], c[1]) : c
          )
          const fullSrc = map.getSource('yarj-playback-full') as GeoJSONSource | undefined
          if (fullSrc) {
            fullSrc.setData({
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: initCoords
              }
            })
          }
        }
      } catch {
        // 容错：若预存的 geojson 解析异常则等待后续 get-route-points 补充
      }
    }

    try {
      const res = (await window.cockpit.command('yarj.get-route-points', { id: route.id })) as {
        ok: boolean
        points?: RoutePoint[]
      }
      if (res?.ok && res.points) {
        rawPlaybackPoints = res.points
        playbackCameraPos = null
        applyRouteSmoothing()
      } else {
        rawPlaybackPoints = []
        playbackCameraPos = null
        routePlaybackPoints.value = []
        playbackAllProjectedCoords = []
        playbackTimestampsMs = []
      }
    } catch {
      rawPlaybackPoints = []
      playbackCameraPos = null
      routePlaybackPoints.value = []
      playbackAllProjectedCoords = []
      playbackTimestampsMs = []
    }

    try {
      const res = (await window.cockpit.command('yarj.get-route-photos', {
        routeId: route.id
      })) as {
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
          { padding: 100, maxZoom: 15, animate: false }
        )
      }

      if (map.getLayer('yarj-playback-full-glow')) {
        map.setPaintProperty('yarj-playback-full-glow', 'line-color', themeRgba(0.4))
      }
      if (map.getLayer('yarj-playback-full-line')) {
        map.setPaintProperty('yarj-playback-full-line', 'line-color', themeRgba(0.85))
      }
      if (map.getLayer('yarj-playback-trail-glow')) {
        map.setPaintProperty('yarj-playback-trail-glow', 'line-color', themeRgba(0.85))
      }
      if (map.getLayer('yarj-playback-trail-line')) {
        map.setPaintProperty('yarj-playback-trail-line', 'line-color', themeRgba(1))
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
    if (playbackZoomRafId != null) {
      cancelAnimationFrame(playbackZoomRafId)
      playbackZoomRafId = null
    }
    playbackTargetZoom = null
    playbackCameraPos = null
    playbackMarkerPos = null
    rawPlaybackPoints = []
    if (playbackHeadMarker) {
      playbackHeadMarker.remove()
      playbackHeadMarker = null
    }
    routePlaybackActive.value = false
    routePlaybackRoute.value = null
    routePlaybackPoints.value = []
    routePlaybackPhotos.value = []
    routePlaybackPhotosDrawerOpen.value = false
    playbackAllProjectedCoords = []
    playbackTimestampsMs = []
    lastTrailUpdateMs = 0

    const map = getMap()
    if (map) {
      map.scrollZoom.disable()
      map.scrollZoom.enable()
      const fullSrc = map.getSource('yarj-playback-full') as GeoJSONSource | undefined
      fullSrc?.setData({ type: 'FeatureCollection', features: [] })
      const trailSrc = map.getSource('yarj-playback-trail') as GeoJSONSource | undefined
      trailSrc?.setData({ type: 'FeatureCollection', features: [] })
      map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 300 })
    }
  }

  watch(routePlaybackFollowCamera, (following) => {
    const map = getMap()
    if (!map || !routePlaybackActive.value) return
    if (following) {
      map.scrollZoom.disable()
      if (!routePlaybackIsPlaying.value && routePlaybackCurrentPoint.value) {
        reCenterPlaybackCamera(false)
      }
    } else {
      map.scrollZoom.enable()
    }
  })

  watch(
    [() => yarjConfig.value.routeSmoothing, () => yarjConfig.value.routeSmoothingWindow],
    () => {
      if (routePlaybackActive.value && rawPlaybackPoints.length > 0) {
        applyRouteSmoothing()
        playbackCameraPos = null
        playbackMarkerPos = null
        updatePlaybackMapFrame()
      }
    }
  )

  watch(isGcj02Active, () => {
    if (routePlaybackActive.value && routePlaybackPoints.value.length > 0) {
      playbackAllProjectedCoords = routePlaybackPoints.value.map((p) =>
        isGcj02Active.value ? wgs84ToGcj02(p.lon, p.lat) : [p.lon, p.lat]
      )
      lastTrailUpdateMs = 0
      updatePlaybackMapFrame()
    }
  })

  function onRoutePlaybackProgressChange(v: number): void {
    routePlaybackProgress.value = Math.max(0, Math.min(1, v))
    playbackCameraPos = null
    playbackMarkerPos = null
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

  function handleMapDragStart(): void {
    if (routePlaybackActive.value) {
      if (routePlaybackFollowCamera.value) {
        routePlaybackFollowCamera.value = false
      }
      playbackTargetZoom = null
      if (playbackZoomRafId != null) {
        cancelAnimationFrame(playbackZoomRafId)
        playbackZoomRafId = null
      }
    }
  }

  function toggleRoutePlaybackPhotosDrawer(): void {
    routePlaybackPhotosDrawerOpen.value = !routePlaybackPhotosDrawerOpen.value
    const map = getMap()
    if (map) {
      const rightPad = routePlaybackPhotosDrawerOpen.value ? 380 : 0
      map.easeTo({
        padding: { top: 0, bottom: 0, left: 0, right: rightPad },
        duration: 300
      })
    }
  }

  onUnmounted(() => {
    stopRoutePlayback()
  })

  return {
    routePlaybackActive,
    routePlaybackRoute,
    routePlaybackPoints,
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
    applyRouteSmoothing,
    setupRoutePlaybackLayers,
    getPlaybackPadding,
    updatePlaybackHeadMarker,
    updatePlaybackMapFrame,
    reCenterPlaybackCamera,
    requestPlaybackZoom,
    playbackLoop,
    toggleRoutePlaybackPlay,
    startRoutePlayback,
    stopRoutePlayback,
    onRoutePlaybackProgressChange,
    onRoutePlaybackJumpTime,
    onRoutePlaybackJumpToSplit,
    routePlaybackShowFullRoute,
    toggleRoutePlaybackShowFullRoute,
    handleMapDragStart,
    toggleRoutePlaybackPhotosDrawer
  }
}
