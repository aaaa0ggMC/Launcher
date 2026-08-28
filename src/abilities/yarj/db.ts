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
import type { Photo, PhotoRow, ScanRun } from './types'

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
  appendix    TEXT NOT NULL DEFAULT '{}',
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
`

/** 惰性打开元数据库（WAL 模式 + 建表迁移）。主进程内单例。 */
export function getMetadataDb(): DatabaseSync {
  if (db) return db
  const path = metadataDbPath()
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  log.info('metadata db ready', { path })
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
}

const UPSERT_SQL = `
INSERT INTO photos (
  path, root, file_size, mtime, width, height, orientation, taken_at,
  camera_make, camera_model, lens_model, focal_length, f_number, exposure_time,
  iso, gps_lat, gps_lon, gps_alt, scanned_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    new Date().toISOString()
  )
}

/** 按绝对路径查一行（用于增量扫描跳过判断）。 */
export function getPhotoRow(path: string): PhotoRow | null {
  const row = getMetadataDb().prepare('SELECT * FROM photos WHERE path = ?').get(path)
  return row ? (row as unknown as PhotoRow) : null
}

export interface PhotoUpdateOptions {
  patch?: Record<string, unknown>
  lat?: number | null
  lon?: number | null
  alt?: number | null
}

/** 更新照片（支持更新 appendix 与 GPS 经纬度/高度）。 */
export function updatePhoto(path: string, opts: PhotoUpdateOptions): Photo | null {
  const row = getPhotoRow(path)
  if (!row) return null
  let appendix: Record<string, unknown>
  try {
    appendix = JSON.parse(row.appendix || '{}') as Record<string, unknown>
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

  getMetadataDb()
    .prepare('UPDATE photos SET appendix = ?, gps_lat = ?, gps_lon = ?, gps_alt = ? WHERE path = ?')
    .run(JSON.stringify(appendix), newLat, newLon, newAlt, path)

  return photoFromRow({
    ...row,
    appendix: JSON.stringify(appendix),
    gps_lat: newLat,
    gps_lon: newLon,
    gps_alt: newAlt
  })
}

/** 更新照片 appendix（patch 合并进现有 appendix JSON）。 */
export function updatePhotoAppendix(path: string, patch: Record<string, unknown>): Photo | null {
  return updatePhoto(path, { patch })
}

/** 照片行 → 渲染端 Photo 视图（appendix 解析为对象）。 */
export function photoFromRow(row: PhotoRow): Photo {
  let appendix: Record<string, unknown> = {}
  try {
    appendix = JSON.parse(row.appendix || '{}') as Record<string, unknown>
  } catch {
    appendix = {}
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
    appendix
  }
}

/** 查询照片（条件组合：目录 / 仅定位 / 时间下限 / 关键词 / 经纬度框）。 */
export function queryPhotos(filters: {
  root?: string
  hasGps?: boolean
  since?: string
  q?: string
  bbox?: [number, number, number, number]
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
  const rows = getMetadataDb()
    .prepare(`SELECT * FROM photos ${where} ORDER BY taken_at DESC`)
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
