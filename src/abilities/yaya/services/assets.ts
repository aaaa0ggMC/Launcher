/**
 * YAYA 多模态资产存储服务
 * 管理用户上传的图片、文档、音频，将其安全存储在本地文件系统中。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { writeFile, readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { USER_CONFIG_DIR } from '../../../main/process/paths'
import type { MessageAttachment } from '../types'

export function getYayaAssetsDir(sessionId?: string): string {
  const base = join(USER_CONFIG_DIR, 'yaya', 'assets')
  return sessionId ? join(base, sessionId) : base
}

export async function saveAsset(
  sessionId: string,
  originalName: string,
  data: Buffer | Uint8Array,
  mimeType: string
): Promise<MessageAttachment> {
  const dir = getYayaAssetsDir(sessionId)
  mkdirSync(dir, { recursive: true })

  const ext = extname(originalName) || mimeToExt(mimeType)
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)
  const filename = `${hash}${ext}`
  const filePath = join(dir, filename)

  if (!existsSync(filePath)) {
    await writeFile(filePath, data)
  }

  const st = await stat(filePath)

  return {
    id: hash,
    name: originalName,
    mimeType,
    size: st.size,
    assetPath: `yaya-asset://${sessionId}/${filename}`
  }
}

export function resolveAssetLocalPath(assetUri: string): string | null {
  if (!assetUri.startsWith('yaya-asset://')) return null
  const rel = assetUri.slice('yaya-asset://'.length)
  const [sessionId, filename] = rel.split('/')
  if (!sessionId || !filename) return null
  return join(getYayaAssetsDir(sessionId), filename)
}

export async function readAssetData(assetUri: string): Promise<Buffer | null> {
  const localPath = resolveAssetLocalPath(assetUri)
  if (!localPath || !existsSync(localPath)) return null
  return readFile(localPath)
}

export function deleteSessionAssets(sessionId: string): void {
  const dir = getYayaAssetsDir(sessionId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

function mimeToExt(mime: string): string {
  if (mime.includes('png')) return '.png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('pdf')) return '.pdf'
  if (mime.includes('json')) return '.json'
  if (mime.includes('markdown') || mime.includes('md')) return '.md'
  if (mime.includes('text')) return '.txt'
  return '.bin'
}
