/**
 * yarj 元数据库封装 — 唯一的 node:sqlite 访问点之一（另一个是 mbtiles.ts）。
 *
 * 选择 `node:sqlite`（Node 22.22 / Electron 39 内置，零原生依赖）而非
 * better-sqlite3 / @mapbox/mbtiles：zip 分发不需要 electron-rebuild。
 * 若未来 Node API 变动，替换 better-sqlite3 只改本文件与 mbtiles.ts。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { USER_CONFIG_DIR } from '../../main/process/paths'
import { makeLogger } from '../../main/process/logger'
import type {
  CorrectedGps,
  GuessedGps,
  Photo,
  PhotoAppendix,
  PhotoRow,
  Route,
  RouteExtraMetrics,
  RouteSplit,
  ScanRun,
  TrackMatchedGps
} from './types'

const log = makeLogger('yarj-db')

let db: DatabaseSync | null = null

export function metadataDbPath(): string {
  return join(USER_CONFIG_DIR, 'yarj', 'metadata.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,
  root        TEXT NOT NULL,
  file_size   INTEGER,
  mtime       REAL,
  width       INTEGER,
  height      INTEGER,
  orientation INTEGER,
  taken_at    TEXT,
  camera_make TEXT,
  camera_model TEXT,
  lens_model  TEXT,
  focal_length REAL,
  f_number    REAL,
  exposure_time TEXT,
  iso         INTEGER,
  gps_lat     REAL,
  gps_lon     REAL,
  gps_alt     REAL,
  hash        TEXT,
  appendix    TEXT NOT NULL DEFAULT '{}',
  gps_guess   TEXT,
  gps_corrected TEXT,
  gps_track   TEXT,
  scanned_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_photos_gps  ON photos (gps_lat, gps_lon);
CREATE INDEX IF NOT EXISTS idx_photos_root ON photos (root);
CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos (taken_at);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  total INTEGER DEFAULT 0,
  with_gps INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS routes (
  id                  TEXT PRIMARY KEY,
  path                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  desc                TEXT,
  activity_type       TEXT,
  start_time          TEXT,
  end_time            TEXT,
  duration_sec        INTEGER,
  moving_duration_sec INTEGER,
  total_distance_m    REAL,
  avg_speed_kmh       REAL,
  max_speed_kmh       REAL,
  calories            REAL,
  elevation_gain_m    REAL,
  elevation_loss_m    REAL,
  min_ele             REAL,
  max_ele             REAL,
  avg_hr              REAL,
  max_hr              REAL,
  bounds              TEXT,
  point_count         INTEGER,
  geojson             TEXT NOT NULL,
  splits              TEXT,
  extra_metrics       TEXT,
  created_at          TEXT,
  updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_routes_start_time ON routes (start_time);
CREATE INDEX IF NOT EXISTS idx_routes_activity ON routes (activity_type);
`

/** 惰性打开元数据库（WAL 模式 + 建表迁移）。主进程内单例。 */
export function getMetadataDb(): DatabaseSync {
  if (db) return db
  const path = metadataDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const d = new DatabaseSync(path)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec(SCHEMA)

  // 迁移：检查 photos 表新列并动态自动迁移、建索引
  try {
    const cols = d.prepare('PRAGMA table_info(photos)').all() as { name: string }[]
    const colNames = new Set(cols.map((c) => c.name))

    if (!colNames.has('hash')) {
      try {
        d.exec('ALTER TABLE photos ADD COLUMN hash TEXT')
        log.info('migrated photos table: added hash column')
      } catch (e) {
        log.warn('add hash col failed', { error: String(e) })
      }
    }
    try {
      d.exec('CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos (hash)')
    } catch {
      /* ignore */
    }

    if (!colNames.has('gps_guess')) {
      try {
        d.exec('ALTER TABLE photos ADD COLUMN gps_guess TEXT')
        log.info('migrated photos table: added gps_guess column')
      } catch (e) {
        log.warn('add gps_guess col failed', { error: String(e) })
      }
    }
    try {
      d.exec('CREATE INDEX IF NOT EXISTS idx_photos_gps_guess ON photos (gps_guess)')
    } catch {
      /* ignore */
    }

    if (!colNames.has('gps_corrected')) {
      try {
        d.exec('ALTER TABLE photos ADD COLUMN gps_corrected TEXT')
        log.info('migrated photos table: added gps_corrected column')
      } catch (e) {
        log.warn('add gps_corrected col failed', { error: String(e) })
      }
    }
    try {
      d.exec('CREATE INDEX IF NOT EXISTS idx_photos_gps_corrected ON photos (gps_corrected)')
    } catch {
      /* ignore */
    }

    if (!colNames.has('gps_track')) {
      try {
        d.exec('ALTER TABLE photos ADD COLUMN gps_track TEXT')
        log.info('migrated photos table: added gps_track column')
      } catch (e) {
        log.warn('add gps_track col failed', { error: String(e) })
      }
    }
    try {
      d.exec('CREATE INDEX IF NOT EXISTS idx_photos_gps_track ON photos (gps_track)')
    } catch {
      /* ignore */
    }
  } catch (err) {
    log.warn('migrate photos table check failed', { error: String(err) })
  }

  // 迁移：检查 routes 表 extra_metrics 列
  try {
    const routeCols = d.prepare('PRAGMA table_info(routes)').all() as { name: string }[]
    const routeColNames = new Set(routeCols.map((c) => c.name))
    if (!routeColNames.has('extra_metrics')) {
      try {
        d.exec('ALTER TABLE routes ADD COLUMN extra_metrics TEXT')
        log.info('migrated routes table: added extra_metrics column')
      } catch (e) {
        log.warn('add extra_metrics col failed', { error: String(e) })
      }
    }
  } catch (err) {
    log.warn('migrate routes table check failed', { error: String(err) })
  }

  log.info('metadata db ready', { path })
  db = d
  return db
}

export function closeMetadataDb(): void {
  if (db) {
    try {
      db.close()
    } catch (err) {
      log.warn('close metadata db failed', { error: String(err) })
    }
    db = null
  }
}

// ---------------------------------------------------------------------------
// photos 读写
// ---------------------------------------------------------------------------

export interface PhotoUpsertInput {
  path: string
  root: string
  file_size: number
  mtime: number
  width: number | null
  height: number | null
  orientation: number | null
  taken_at: string | null
  camera_make: string | null
  camera_model: string | null
  lens_model: string | null
  focal_length: number | null
  f_number: number | null
  exposure_time: string | null
  iso: number | null
  gps_lat: number | null
  gps_lon: number | null
  gps_alt: number | null
  hash?: string | null
}

const UPSERT_SQL = `
INSERT INTO photos (
  path, root, file_size, mtime, width, height, orientation, taken_at,
  camera_make, camera_model, lens_model, focal_length, f_number, exposure_time,
  iso, gps_lat, gps_lon, gps_alt, hash, scanned_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
  root = excluded.root,
  file_size = excluded.file_size,
  mtime = excluded.mtime,
  width = excluded.width,
  height = excluded.height,
  orientation = excluded.orientation,
  taken_at = excluded.taken_at,
  camera_make = excluded.camera_make,
  camera_model = excluded.camera_model,
  lens_model = excluded.lens_model,
  focal_length = excluded.focal_length,
  f_number = excluded.f_number,
  exposure_time = excluded.exposure_time,
  iso = excluded.iso,
  gps_lat = excluded.gps_lat,
  gps_lon = excluded.gps_lon,
  gps_alt = excluded.gps_alt,
  hash = COALESCE(excluded.hash, photos.hash),
  scanned_at = excluded.scanned_at
  -- appendix 保留用户数据，扫描器永不覆盖
`

const upsertStmt = (): ReturnType<DatabaseSync['prepare']> => getMetadataDb().prepare(UPSERT_SQL)

/** 写入/更新一张照片的 EXIF 元数据（appendix 保持不变）。 */
export function upsertPhoto(input: PhotoUpsertInput): void {
  upsertStmt().run(
    input.path,
    input.root,
    input.file_size,
    input.mtime,
    input.width,
    input.height,
    input.orientation,
    input.taken_at,
    input.camera_make,
    input.camera_model,
    input.lens_model,
    input.focal_length,
    input.f_number,
    input.exposure_time,
    input.iso,
    input.gps_lat,
    input.gps_lon,
    input.gps_alt,
    input.hash ?? null,
    new Date().toISOString()
  )
}

/** 按绝对路径查一行（用于增量扫描跳过判断）。 */
export function getPhotoRow(path: string): PhotoRow | null {
  const row = getMetadataDb().prepare('SELECT * FROM photos WHERE path = ?').get(path)
  return row ? (row as unknown as PhotoRow) : null
}

/** 按内容哈希查一行（用于重命名/移动追踪与去重识别）。 */
export function getPhotoByHash(hash: string): PhotoRow | null {
  const row = getMetadataDb().prepare('SELECT * FROM photos WHERE hash = ? LIMIT 1').get(hash)
  return row ? (row as unknown as PhotoRow) : null
}

/**
 * 文件移动/重命名：将 oldPath 的记录直接迁移到 newPath（完整保留 appendix、GPS 等所有元数据）。
 */
export function updatePhotoPath(
  oldPath: string,
  newPath: string,
  root: string,
  fileSize: number,
  mtime: number,
  hash?: string | null
): void {
  getMetadataDb()
    .prepare(
      `UPDATE photos
       SET path = ?, root = ?, file_size = ?, mtime = ?, hash = COALESCE(?, hash), scanned_at = ?
       WHERE path = ?`
    )
    .run(newPath, root, fileSize, mtime, hash ?? null, new Date().toISOString(), oldPath)
}

/** 单独补充更新某照片的 hash。 */
export function updatePhotoHash(path: string, hash: string): void {
  getMetadataDb().prepare('UPDATE photos SET hash = ? WHERE path = ?').run(hash, path)
}

export interface PhotoUpdateOptions {
  patch?: Record<string, unknown>
  lat?: number | null
  lon?: number | null
  alt?: number | null
  gps_guess?: GuessedGps | null
  gps_track?: TrackMatchedGps | null
}

/** 更新照片（支持更新 appendix 与 GPS 经纬度/高度/猜测/航线匹配）。 */
export function updatePhoto(path: string, opts: PhotoUpdateOptions): Photo | null {
  const row = getPhotoRow(path)
  if (!row) return null
  let appendix: PhotoAppendix
  try {
    appendix = JSON.parse(row.appendix || '{}') as PhotoAppendix
  } catch {
    appendix = {}
  }
  if (opts.patch) {
    for (const [k, v] of Object.entries(opts.patch)) {
      if (v === null || v === undefined) delete appendix[k]
      else appendix[k] = v
    }
  }
  const newLat = opts.lat !== undefined ? opts.lat : row.gps_lat
  const newLon = opts.lon !== undefined ? opts.lon : row.gps_lon
  const newAlt = opts.alt !== undefined ? opts.alt : row.gps_alt

  // 如果用户正式固化或设定了真实 GPS，默认自动清除 gps_guess 猜测标记与 gps_corrected 纠正标记
  let newGpsGuessStr: string | null = row.gps_guess ?? null
  let newGpsCorrectedStr: string | null = row.gps_corrected ?? null
  let newGpsTrackStr: string | null = row.gps_track ?? null
  if (opts.lat !== undefined && opts.lat !== null && opts.gps_guess === undefined) {
    newGpsGuessStr = null
    newGpsCorrectedStr = null
  } else if (opts.gps_guess !== undefined) {
    newGpsGuessStr = opts.gps_guess ? JSON.stringify(opts.gps_guess) : null
  }
  if (opts.gps_track !== undefined) {
    newGpsTrackStr = opts.gps_track ? JSON.stringify(opts.gps_track) : null
  }

  getMetadataDb()
    .prepare(
      'UPDATE photos SET appendix = ?, gps_lat = ?, gps_lon = ?, gps_alt = ?, gps_guess = ?, gps_corrected = ?, gps_track = ? WHERE path = ?'
    )
    .run(
      JSON.stringify(appendix),
      newLat,
      newLon,
      newAlt,
      newGpsGuessStr,
      newGpsCorrectedStr,
      newGpsTrackStr,
      path
    )

  return photoFromRow({
    ...row,
    appendix: JSON.stringify(appendix),
    gps_lat: newLat,
    gps_lon: newLon,
    gps_alt: newAlt,
    gps_guess: newGpsGuessStr,
    gps_corrected: newGpsCorrectedStr,
    gps_track: newGpsTrackStr
  })
}

/** 更新照片 appendix（patch 合并进现有 appendix JSON）。 */
export function updatePhotoAppendix(path: string, patch: Record<string, unknown>): Photo | null {
  return updatePhoto(path, { patch })
}

export interface BatchGpsUpdateItem {
  path: string
  lat: number | null
  lon: number | null
  alt?: number | null
}

/** 批量更新一组照片的 GPS 坐标（在事务中极速执行）。 */
export function batchUpdatePhotoGps(updates: BatchGpsUpdateItem[]): number {
  if (!updates.length) return 0
  const d = getMetadataDb()
  const stmt = d.prepare(
    'UPDATE photos SET gps_lat = ?, gps_lon = ?, gps_alt = COALESCE(?, gps_alt), gps_guess = NULL, gps_corrected = NULL WHERE path = ?'
  )
  d.exec('BEGIN IMMEDIATE')
  try {
    for (const item of updates) {
      stmt.run(item.lat, item.lon, item.alt ?? null, item.path)
    }
    d.exec('COMMIT')
    return updates.length
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

export interface BatchGpsGuessItem {
  path: string
  guess: GuessedGps | null
}

/** 批量更新照片的 gps_guess 静态猜测字段（扫描完成后在单个事务中极速执行）。 */
export function batchUpdatePhotoGpsGuesses(items: BatchGpsGuessItem[]): number {
  if (!items.length) return 0
  const d = getMetadataDb()
  try {
    const cols = d.prepare('PRAGMA table_info(photos)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'gps_guess')) {
      d.exec('ALTER TABLE photos ADD COLUMN gps_guess TEXT')
      d.exec('CREATE INDEX IF NOT EXISTS idx_photos_gps_guess ON photos (gps_guess)')
    }
  } catch (err) {
    log.warn('ensure gps_guess column failed', { error: String(err) })
  }

  const stmt = d.prepare('UPDATE photos SET gps_guess = ? WHERE path = ?')
  d.exec('BEGIN IMMEDIATE')
  try {
    for (const item of items) {
      stmt.run(item.guess ? JSON.stringify(item.guess) : null, item.path)
    }
    d.exec('COMMIT')
    return items.length
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

export interface BatchGpsCorrectionItem {
  path: string
  correction: CorrectedGps | null
}

/** 批量更新照片的 gps_corrected 字段（在单个事务中极速执行）。 */
export function batchUpdatePhotoGpsCorrections(items: BatchGpsCorrectionItem[]): number {
  if (!items.length) return 0
  const d = getMetadataDb()
  try {
    const cols = d.prepare('PRAGMA table_info(photos)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'gps_corrected')) {
      d.exec('ALTER TABLE photos ADD COLUMN gps_corrected TEXT')
      d.exec('CREATE INDEX IF NOT EXISTS idx_photos_gps_corrected ON photos (gps_corrected)')
    }
  } catch (err) {
    log.warn('ensure gps_corrected column failed', { error: String(err) })
  }

  const stmt = d.prepare('UPDATE photos SET gps_corrected = ? WHERE path = ?')
  d.exec('BEGIN IMMEDIATE')
  try {
    for (const item of items) {
      stmt.run(item.correction ? JSON.stringify(item.correction) : null, item.path)
    }
    d.exec('COMMIT')
    return items.length
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** 清空指定根目录或全部照片的 gps_corrected 字段（取消纠正）。 */
export function clearAllGpsCorrections(root?: string): number {
  const d = getMetadataDb()
  if (root) {
    const res = d.prepare('UPDATE photos SET gps_corrected = NULL WHERE root = ?').run(root)
    return Number(res.changes ?? 0)
  } else {
    const res = d.prepare('UPDATE photos SET gps_corrected = NULL').run()
    return Number(res.changes ?? 0)
  }
}

/** 统计当前已被纠正的照片数量。 */
export function countCorrectedPhotos(root?: string): number {
  const d = getMetadataDb()
  if (root) {
    const row = d
      .prepare('SELECT COUNT(*) as cnt FROM photos WHERE gps_corrected IS NOT NULL AND root = ?')
      .get(root) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }
  const row = d
    .prepare('SELECT COUNT(*) as cnt FROM photos WHERE gps_corrected IS NOT NULL')
    .get() as { cnt: number } | undefined
  return row?.cnt ?? 0
}

export interface BatchPhotoRouteGpsItem {
  path: string
  trackGps: TrackMatchedGps | null
}

/** 批量更新照片的 gps_track 字段（在单个事务中极速执行）。 */
export function batchUpdatePhotoRouteGps(items: BatchPhotoRouteGpsItem[]): number {
  if (!items.length) return 0
  const d = getMetadataDb()
  try {
    const cols = d.prepare('PRAGMA table_info(photos)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'gps_track')) {
      d.exec('ALTER TABLE photos ADD COLUMN gps_track TEXT')
      d.exec('CREATE INDEX IF NOT EXISTS idx_photos_gps_track ON photos (gps_track)')
    }
  } catch (err) {
    log.warn('ensure gps_track column failed', { error: String(err) })
  }

  const stmt = d.prepare('UPDATE photos SET gps_track = ? WHERE path = ?')
  d.exec('BEGIN IMMEDIATE')
  try {
    for (const item of items) {
      stmt.run(item.trackGps ? JSON.stringify(item.trackGps) : null, item.path)
    }
    d.exec('COMMIT')
    return items.length
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** 清空指定根目录或全部照片的 gps_track 航线匹配数据。 */
export function clearAllRouteGps(root?: string): number {
  const d = getMetadataDb()
  if (root) {
    const res = d.prepare('UPDATE photos SET gps_track = NULL WHERE root = ?').run(root)
    return Number(res.changes ?? 0)
  } else {
    const res = d.prepare('UPDATE photos SET gps_track = NULL').run()
    return Number(res.changes ?? 0)
  }
}

/** 统计当前已被航线轨迹匹配的照片数量。 */
export function countRouteGeotaggedPhotos(root?: string): number {
  const d = getMetadataDb()
  if (root) {
    const row = d
      .prepare('SELECT COUNT(*) as cnt FROM photos WHERE gps_track IS NOT NULL AND root = ?')
      .get(root) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }
  const row = d.prepare('SELECT COUNT(*) as cnt FROM photos WHERE gps_track IS NOT NULL').get() as
    { cnt: number } | undefined
  return row?.cnt ?? 0
}

// ---------------------------------------------------------------------------
// routes 读写
// ---------------------------------------------------------------------------

export interface RouteRow {
  id: string
  path: string
  name: string
  desc: string | null
  activity_type: string | null
  start_time: string | null
  end_time: string | null
  duration_sec: number
  moving_duration_sec: number
  total_distance_m: number
  avg_speed_kmh: number
  max_speed_kmh: number
  calories: number | null
  elevation_gain_m: number | null
  elevation_loss_m: number | null
  min_ele: number | null
  max_ele: number | null
  avg_hr: number | null
  max_hr: number | null
  bounds: string | null
  point_count: number
  geojson: string
  splits: string | null
  extra_metrics: string | null
  created_at: string | null
  updated_at: string | null
}

export function routeFromRow(row: RouteRow): Route {
  let bounds: [number, number, number, number] = [0, 0, 0, 0]
  if (row.bounds) {
    try {
      bounds = JSON.parse(row.bounds)
    } catch {
      bounds = [0, 0, 0, 0]
    }
  }
  let splits: RouteSplit[] | undefined = undefined
  if (row.splits) {
    try {
      splits = JSON.parse(row.splits)
    } catch {
      splits = undefined
    }
  }
  let extraMetrics: RouteExtraMetrics | undefined = undefined
  if (row.extra_metrics) {
    try {
      extraMetrics = JSON.parse(row.extra_metrics)
    } catch {
      extraMetrics = undefined
    }
  }
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    desc: row.desc,
    activityType: row.activity_type ?? undefined,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSec: row.duration_sec,
    movingDurationSec: row.moving_duration_sec,
    totalDistanceM: row.total_distance_m,
    avgSpeedKmh: row.avg_speed_kmh,
    maxSpeedKmh: row.max_speed_kmh,
    calories: row.calories,
    elevationGainM: row.elevation_gain_m,
    elevationLossM: row.elevation_loss_m,
    minEle: row.min_ele,
    maxEle: row.max_ele,
    avgHr: row.avg_hr,
    maxHr: row.max_hr,
    minHr: extraMetrics?.minHr ?? null,
    avgCadence: extraMetrics?.avgCadence ?? null,
    maxCadence: extraMetrics?.maxCadence ?? null,
    steps: extraMetrics?.steps ?? null,
    avgStrideCm: extraMetrics?.avgStrideCm ?? null,
    avgPaceSec: extraMetrics?.avgPaceSec ?? null,
    maxPaceSec: extraMetrics?.maxPaceSec ?? null,
    minPaceSec: extraMetrics?.minPaceSec ?? null,
    vo2Max: extraMetrics?.vo2Max ?? null,
    trainLoad: extraMetrics?.trainLoad ?? null,
    trainEffect: extraMetrics?.trainEffect ?? null,
    recoverTimeHours: extraMetrics?.recoverTimeHours ?? null,
    deviceType: extraMetrics?.deviceType ?? null,
    deviceId: extraMetrics?.deviceId ?? null,
    hrZones: extraMetrics?.hrZones ?? null,
    extraMetrics,
    bounds,
    pointCount: row.point_count,
    geojson: row.geojson,
    splits,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined
  }
}

export function upsertRoute(route: Route): void {
  const d = getMetadataDb()
  const now = new Date().toISOString()
  const stmt = d.prepare(`
    INSERT INTO routes (
      id, path, name, desc, activity_type, start_time, end_time,
      duration_sec, moving_duration_sec, total_distance_m, avg_speed_kmh, max_speed_kmh,
      calories, elevation_gain_m, elevation_loss_m, min_ele, max_ele, avg_hr, max_hr,
      bounds, point_count, geojson, splits, extra_metrics, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      desc = excluded.desc,
      activity_type = excluded.activity_type,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      duration_sec = excluded.duration_sec,
      moving_duration_sec = excluded.moving_duration_sec,
      total_distance_m = excluded.total_distance_m,
      avg_speed_kmh = excluded.avg_speed_kmh,
      max_speed_kmh = excluded.max_speed_kmh,
      calories = excluded.calories,
      elevation_gain_m = excluded.elevation_gain_m,
      elevation_loss_m = excluded.elevation_loss_m,
      min_ele = excluded.min_ele,
      max_ele = excluded.max_ele,
      avg_hr = excluded.avg_hr,
      max_hr = excluded.max_hr,
      bounds = excluded.bounds,
      point_count = excluded.point_count,
      geojson = excluded.geojson,
      splits = excluded.splits,
      extra_metrics = excluded.extra_metrics,
      updated_at = excluded.updated_at
  `)
  stmt.run(
    route.id,
    route.path,
    route.name,
    route.desc ?? null,
    route.activityType ?? null,
    route.startTime,
    route.endTime,
    route.durationSec,
    route.movingDurationSec,
    route.totalDistanceM,
    route.avgSpeedKmh,
    route.maxSpeedKmh,
    route.calories ?? null,
    route.elevationGainM ?? null,
    route.elevationLossM ?? null,
    route.minEle ?? null,
    route.maxEle ?? null,
    route.avgHr ?? null,
    route.maxHr ?? null,
    JSON.stringify(route.bounds),
    route.pointCount,
    route.geojson,
    route.splits ? JSON.stringify(route.splits) : null,
    route.extraMetrics ? JSON.stringify(route.extraMetrics) : null,
    route.createdAt ?? now,
    now
  )
}

export function getRoute(id: string): Route | null {
  const row = getMetadataDb().prepare('SELECT * FROM routes WHERE id = ?').get(id)
  return row ? routeFromRow(row as unknown as RouteRow) : null
}

export function getRouteByPath(path: string): Route | null {
  const row = getMetadataDb().prepare('SELECT * FROM routes WHERE path = ?').get(path)
  return row ? routeFromRow(row as unknown as RouteRow) : null
}

export function deleteRoute(id: string): boolean {
  const res = getMetadataDb().prepare('DELETE FROM routes WHERE id = ?').run(id)
  return Number(res.changes ?? 0) > 0
}

export function queryRoutes(filters?: {
  activityType?: string
  q?: string
  since?: string
}): Route[] {
  const conds: string[] = []
  const params: (string | number)[] = []
  if (filters?.activityType) {
    conds.push('activity_type = ?')
    params.push(filters.activityType)
  }
  if (filters?.since) {
    conds.push('start_time >= ?')
    params.push(filters.since)
  }
  if (filters?.q) {
    conds.push('(name LIKE ? OR desc LIKE ? OR path LIKE ?)')
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = getMetadataDb()
    .prepare(`SELECT * FROM routes ${where} ORDER BY start_time DESC, id DESC`)
    .all(...params) as unknown as RouteRow[]
  return rows.map(routeFromRow)
}

export function routeCount(): number {
  return Number(getMetadataDb().prepare('SELECT COUNT(*) c FROM routes').get()?.c ?? 0)
}

/** 照片行 → 渲染端 Photo 视图（appendix 解析为对象）。 */
export function photoFromRow(row: PhotoRow): Photo {
  let appendix: PhotoAppendix = {}
  try {
    appendix = JSON.parse(row.appendix || '{}') as PhotoAppendix
  } catch {
    appendix = {}
  }

  let gpsGuess: GuessedGps | null = null
  if (row.gps_guess) {
    try {
      gpsGuess = JSON.parse(row.gps_guess) as GuessedGps
    } catch {
      gpsGuess = null
    }
  } else if (appendix.gps_guess) {
    gpsGuess = appendix.gps_guess
  }

  let gpsCorrected: CorrectedGps | null = null
  if (row.gps_corrected) {
    try {
      gpsCorrected = JSON.parse(row.gps_corrected) as CorrectedGps
    } catch {
      gpsCorrected = null
    }
  }

  let gpsTrack: TrackMatchedGps | null = null
  if (row.gps_track) {
    try {
      gpsTrack = JSON.parse(row.gps_track) as TrackMatchedGps
    } catch {
      gpsTrack = null
    }
  } else if (appendix.gps_track) {
    gpsTrack = appendix.gps_track
  }

  return {
    id: row.id,
    path: row.path,
    root: row.root,
    file_size: row.file_size,
    taken_at: row.taken_at,
    width: row.width,
    height: row.height,
    orientation: row.orientation,
    gps_lat: row.gps_lat,
    gps_lon: row.gps_lon,
    gps_alt: row.gps_alt,
    camera_make: row.camera_make,
    camera_model: row.camera_model,
    lens_model: row.lens_model,
    focal_length: row.focal_length,
    f_number: row.f_number,
    exposure_time: row.exposure_time,
    iso: row.iso,
    hash: row.hash,
    appendix,
    gps_guess: gpsGuess,
    gps_corrected: gpsCorrected,
    gps_track: gpsTrack
  }
}

/** 查询照片（条件组合：目录 / 仅定位 / 时间下限 / 关键词 / 经纬度框）。 */
export function queryPhotos(filters: {
  root?: string
  hasGps?: boolean
  since?: string
  until?: string
  q?: string
  bbox?: [number, number, number, number]
  orderGpsFirst?: boolean
}): Photo[] {
  const conds: string[] = []
  const params: (string | number)[] = []
  if (filters.root) {
    conds.push('root = ?')
    params.push(filters.root)
  }
  if (filters.hasGps) {
    conds.push('gps_lat IS NOT NULL AND gps_lon IS NOT NULL')
  }
  if (filters.since) {
    conds.push('taken_at >= ?')
    params.push(filters.since)
  }
  if (filters.until) {
    conds.push('taken_at <= ?')
    params.push(filters.until)
  }
  if (filters.q) {
    // 路径模糊匹配 + appendix 内 tags 文本匹配（JSON 字符串 LIKE）
    conds.push('(path LIKE ? OR appendix LIKE ?)')
    params.push(`%${filters.q}%`, `%${filters.q}%`)
  }
  if (filters.bbox) {
    const [minLon, minLat, maxLon, maxLat] = filters.bbox
    conds.push('gps_lon >= ? AND gps_lon <= ? AND gps_lat >= ? AND gps_lat <= ?')
    params.push(minLon, maxLon, minLat, maxLat)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const orderBy = filters.orderGpsFirst
    ? 'ORDER BY (CASE WHEN gps_lat IS NOT NULL AND gps_lon IS NOT NULL THEN 0 ELSE 1 END) ASC, taken_at DESC, id ASC'
    : 'ORDER BY taken_at DESC'

  const rows = getMetadataDb()
    .prepare(`SELECT * FROM photos ${where} ${orderBy}`)
    .all(...params)
  return (rows as unknown as PhotoRow[]).map(photoFromRow)
}

/** 同步清理某根目录下在磁盘已删除的照片记录，返回删除条数。 */
export function pruneDeletedPhotos(root: string, existingPaths: Set<string>): number {
  const db = getMetadataDb()
  const rows = db.prepare('SELECT path FROM photos WHERE root = ?').all(root) as { path: string }[]
  let deletedCount = 0
  const deleteStmt = db.prepare('DELETE FROM photos WHERE path = ?')

  db.exec('BEGIN TRANSACTION')
  try {
    for (const row of rows) {
      if (!existingPaths.has(row.path)) {
        deleteStmt.run(row.path)
        deletedCount++
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return deletedCount
}

/** 清理已不再属于有效根目录的照片记录。 */
export function pruneOrphanedRoots(validRoots: string[]): number {
  const db = getMetadataDb()
  if (!validRoots.length) {
    const info = db.prepare('DELETE FROM photos').run()
    return Number(info.changes)
  }
  const placeholders = validRoots.map(() => '?').join(', ')
  const info = db
    .prepare(`DELETE FROM photos WHERE root NOT IN (${placeholders})`)
    .run(...validRoots)
  return Number(info.changes)
}

// ---------------------------------------------------------------------------
// 扫描统计
// ---------------------------------------------------------------------------

export function photoCount(): number {
  return Number(getMetadataDb().prepare('SELECT COUNT(*) c FROM photos').get()?.c ?? 0)
}

export function photoGpsCount(): number {
  return Number(
    getMetadataDb()
      .prepare('SELECT COUNT(*) c FROM photos WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL')
      .get()?.c ?? 0
  )
}

export function photoCountByRoot(): { root: string; total: number; withGps: number }[] {
  const rows = getMetadataDb()
    .prepare(
      `SELECT root,
              COUNT(*) total,
              SUM(CASE WHEN gps_lat IS NOT NULL AND gps_lon IS NOT NULL THEN 1 ELSE 0 END) withGps
       FROM photos GROUP BY root`
    )
    .all() as unknown as { root: string; total: number; withGps: number }[]
  return rows.map((r) => ({ root: r.root, total: Number(r.total), withGps: Number(r.withGps) }))
}

/** 记录一次扫描运行的开始，返回 run id。 */
export function startScanRun(root: string): number {
  const info = getMetadataDb()
    .prepare('INSERT INTO scan_runs (root, started_at, status) VALUES (?, ?, ?)')
    .run(root, new Date().toISOString(), 'running')
  return Number(info.lastInsertRowid)
}

/** 结束一次扫描运行（done / cancelled / error）。 */
export function finishScanRun(
  id: number,
  status: 'done' | 'cancelled' | 'error',
  total: number,
  withGps: number,
  failed: number,
  error?: string
): void {
  getMetadataDb()
    .prepare(
      'UPDATE scan_runs SET finished_at = ?, status = ?, total = ?, with_gps = ?, failed = ?, error = ? WHERE id = ?'
    )
    .run(new Date().toISOString(), status, total, withGps, failed, error ?? null, id)
}

/** 最近几次扫描运行（默认 10 条）。 */
export function recentScanRuns(limit = 10): ScanRun[] {
  const rows = getMetadataDb()
    .prepare('SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as ScanRun[]
  return rows
}

export interface MatchingPhotosResult {
  photos: Photo[]
  detectedOffsetSec: number
  isLocalTime: boolean
}

/** 高效查询与指定航线时空相符的相册照片（自动检测小米/Keep等当地时间 GPX 时区偏移） */
export function findMatchingPhotosForRoute(routeId: string): MatchingPhotosResult {
  const route = getRoute(routeId)
  if (!route || !route.startTime || !route.endTime) {
    return { photos: [], detectedOffsetSec: 0, isLocalTime: false }
  }

  const startMs = new Date(route.startTime).getTime()
  const endMs = new Date(route.endTime).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { photos: [], detectedOffsetSec: 0, isLocalTime: false }
  }

  // 候选时区补偿值（秒）：
  // 0: 标准 UTC
  // 28800 (+8h): 适用于小米手环/Keep等国内运动软件导出时把本地时间伪装为 Z 的情况
  // systemOffsetSec: 本地时区差值
  const systemOffsetSec = -new Date().getTimezoneOffset() * 60
  const candidateOffsets = Array.from(
    new Set([0, 28800, systemOffsetSec, -28800, -systemOffsetSec])
  )

  let bestOffset = 0
  let bestRows: PhotoRow[] = []

  const stmt = getMetadataDb().prepare(
    'SELECT * FROM photos WHERE taken_at >= ? AND taken_at <= ? ORDER BY taken_at ASC'
  )

  for (const off of candidateOffsets) {
    // 照片真实 UTC + off * 1000 = GPX 记录的时间
    // 也就是说照片的 UTC taken_at 应该在 [startMs - off * 1000, endMs - off * 1000]
    const qStart = new Date(startMs - off * 1000 - 120000).toISOString()
    const qEnd = new Date(endMs - off * 1000 + 120000).toISOString()
    const rows = stmt.all(qStart, qEnd) as unknown as PhotoRow[]
    if (rows.length > bestRows.length) {
      bestRows = rows
      bestOffset = off
    }
  }

  const photos = bestRows.map((r) => photoFromRow(r))
  return {
    photos,
    detectedOffsetSec: bestOffset,
    isLocalTime: bestOffset !== 0
  }
}
