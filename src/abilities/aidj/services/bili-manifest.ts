import { existsSync } from 'node:fs'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { makeLogger } from '../../../main/process/logger'

const log = makeLogger('bili-manifest')

export interface BiliDownloadRecord {
  bvid: string
  cid: number
  page?: number
  partTitle?: string
  cleanBase: string
  mediaFile: string
  downloadedAt: number
  fileSize?: number
}

export interface BiliManifestData {
  bvid: string
  items: Record<string, BiliDownloadRecord>
}

export interface BiliCheckItemSpec {
  bvid: string
  cid?: number
  page?: number
  partTitle?: string
  title?: string
  isMultiPart?: boolean
}

export interface BiliCheckResult {
  exists: boolean
  cleanBase?: string
  mediaFile?: string
}

function sanitize(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim()
}

function getManifestPath(targetFolder: string): string {
  return join(targetFolder, '.bili_manifest.json')
}

/**
 * Load the manifest data for a Bilibili target folder.
 */
export async function loadBiliManifest(targetFolder: string): Promise<BiliManifestData | null> {
  const mPath = getManifestPath(targetFolder)
  if (!existsSync(mPath)) return null
  try {
    const raw = await readFile(mPath, 'utf-8')
    return JSON.parse(raw) as BiliManifestData
  } catch (e) {
    log.warn('Failed to parse .bili_manifest.json', { targetFolder, error: String(e) })
    return null
  }
}

/**
 * Save the manifest data for a Bilibili target folder.
 */
export async function saveBiliManifest(
  targetFolder: string,
  data: BiliManifestData
): Promise<void> {
  try {
    await mkdir(targetFolder, { recursive: true })
    const mPath = getManifestPath(targetFolder)
    await writeFile(mPath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e) {
    log.warn('Failed to write .bili_manifest.json', { targetFolder, error: String(e) })
  }
}

/**
 * Record a downloaded item into the folder's .bili_manifest.json.
 */
export async function recordBiliDownload(
  targetFolder: string,
  record: BiliDownloadRecord
): Promise<void> {
  try {
    let manifest = await loadBiliManifest(targetFolder)
    if (!manifest) {
      manifest = {
        bvid: record.bvid,
        items: {}
      }
    }

    if (record.cid) {
      manifest.items[String(record.cid)] = record
    }
    if (record.page !== undefined) {
      manifest.items[`p_${record.page}`] = record
    }
    if (!record.page && !record.cid) {
      manifest.items['single'] = record
    }

    await saveBiliManifest(targetFolder, manifest)
  } catch (e) {
    log.warn('recordBiliDownload error', { error: String(e) })
  }
}

/**
 * Check if a Bilibili video item has already been downloaded.
 * 1. Checks .bili_manifest.json
 * 2. Scans physical disk files for matches (supporting existing downloads prior to manifest)
 */
export async function checkBiliItemDownloaded(
  targetFolder: string,
  item: BiliCheckItemSpec
): Promise<BiliCheckResult> {
  if (!existsSync(targetFolder)) {
    return { exists: false }
  }

  // 1. Check manifest
  const manifest = await loadBiliManifest(targetFolder)
  if (manifest?.items) {
    let matchedRecord: BiliDownloadRecord | undefined
    if (item.cid && manifest.items[String(item.cid)]) {
      matchedRecord = manifest.items[String(item.cid)]
    } else if (item.page !== undefined && manifest.items[`p_${item.page}`]) {
      matchedRecord = manifest.items[`p_${item.page}`]
    } else if (!item.isMultiPart && (!item.page || item.page <= 1) && manifest.items['single']) {
      matchedRecord = manifest.items['single']
    }

    if (matchedRecord) {
      const fullPath = join(targetFolder, matchedRecord.mediaFile)
      if (existsSync(fullPath)) {
        try {
          const s = await stat(fullPath)
          if (s.size > 1024) {
            return {
              exists: true,
              cleanBase: matchedRecord.cleanBase,
              mediaFile: matchedRecord.mediaFile
            }
          }
        } catch {
          /* ignore stat failure */
        }
      }
    }
  }

  // 2. Scan physical disk files
  try {
    const files = await readdir(targetFolder)
    const mediaFiles = files.filter((f) => {
      const ext = extname(f).toLowerCase()
      return (
        (ext === '.mp4' || ext === '.m4a') &&
        !f.endsWith('.tmp') &&
        !f.endsWith('.download') &&
        !f.startsWith('.')
      )
    })

    if (mediaFiles.length === 0) {
      return { exists: false }
    }

    // Verify each candidate file size > 1KB
    const validMediaFiles: { file: string; size: number }[] = []
    for (const f of mediaFiles) {
      try {
        const s = await stat(join(targetFolder, f))
        if (s.size > 1024) {
          validMediaFiles.push({ file: f, size: s.size })
        }
      } catch {
        /* ignore */
      }
    }

    if (validMediaFiles.length === 0) {
      return { exists: false }
    }

    const isMulti = Boolean(item.isMultiPart || (item.page && item.page > 0) || item.partTitle)

    if (isMulti) {
      for (const { file } of validMediaFiles) {
        const ext = extname(file)
        const nameNoExt = basename(file, ext)
        const nameLower = nameNoExt.toLowerCase()

        // Page number check (e.g. [P1], [P1 01.xxx], P1 _, P01)
        if (item.page !== undefined) {
          const pRegex = new RegExp(
            `(\\[P0*${item.page}(\\s|[^\\]])*?\\]|(^|[\\s._-])P0*${item.page}([\\s._-]|$))`,
            'i'
          )
          if (pRegex.test(nameNoExt)) {
            // Auto backfill into manifest
            await recordBiliDownload(targetFolder, {
              bvid: item.bvid,
              cid: item.cid || 0,
              page: item.page,
              partTitle: item.partTitle,
              cleanBase: nameNoExt,
              mediaFile: file,
              downloadedAt: Date.now()
            })
            return { exists: true, cleanBase: nameNoExt, mediaFile: file }
          }
        }

        // Part title check
        if (item.partTitle) {
          const rawPart = sanitize(item.partTitle).toLowerCase()
          const strippedPart = rawPart.replace(/^\d+[\s._-]+/, '').trim() // e.g. "01.少年少女 TV ver" -> "少年少女 tv ver"

          if (rawPart.length >= 2 && nameLower.includes(rawPart)) {
            await recordBiliDownload(targetFolder, {
              bvid: item.bvid,
              cid: item.cid || 0,
              page: item.page,
              partTitle: item.partTitle,
              cleanBase: nameNoExt,
              mediaFile: file,
              downloadedAt: Date.now()
            })
            return { exists: true, cleanBase: nameNoExt, mediaFile: file }
          }

          if (strippedPart.length >= 2 && nameLower.includes(strippedPart)) {
            await recordBiliDownload(targetFolder, {
              bvid: item.bvid,
              cid: item.cid || 0,
              page: item.page,
              partTitle: item.partTitle,
              cleanBase: nameNoExt,
              mediaFile: file,
              downloadedAt: Date.now()
            })
            return { exists: true, cleanBase: nameNoExt, mediaFile: file }
          }
        }
      }
    } else {
      // Single-part video: any valid media file in this BVID directory matches
      const { file } = validMediaFiles[0]
      const ext = extname(file)
      const nameNoExt = basename(file, ext)
      await recordBiliDownload(targetFolder, {
        bvid: item.bvid,
        cid: item.cid || 0,
        page: item.page || 1,
        partTitle: item.partTitle,
        cleanBase: nameNoExt,
        mediaFile: file,
        downloadedAt: Date.now()
      })
      return { exists: true, cleanBase: nameNoExt, mediaFile: file }
    }
  } catch (e) {
    log.warn('Disk check error in checkBiliItemDownloaded', { error: String(e) })
  }

  return { exists: false }
}
