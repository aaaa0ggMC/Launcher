/**
 * YAYA 多模态资产存储服务
 * 管理用户上传的图片、文档、音频，将其安全存储在本地文件系统中。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { writeFile, readFile, stat } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
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

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

export function resolveAssetLocalPath(assetUri: string): string | null {
  if (!assetUri.startsWith('yaya-asset://')) return null
  const rel = assetUri.slice('yaya-asset://'.length)
  const parts = rel.split('/')
  if (parts.length !== 2) return null
  const [sessionId, filename] = parts
  // 两段都必须是普通文件名，防止 ../ 越出资产目录
  for (const seg of parts) {
    if (!SAFE_SEGMENT.test(seg) || seg === '.' || seg === '..') return null
  }
  return join(getYayaAssetsDir(sessionId), filename)
}

/** 单个附件上限（图片会以 base64 发给模型，过大的文件没有意义） */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024

/** 把宿主上的文件复制进会话资产目录（pickFile 给的是宿主路径，网页模式同样适用） */
export async function importAssetFromPath(
  sessionId: string,
  filePath: string
): Promise<MessageAttachment> {
  const st = await stat(filePath)
  if (!st.isFile()) throw new Error(`not a file: ${filePath}`)
  if (st.size > MAX_ASSET_BYTES) {
    throw new Error(`file too large (${st.size} bytes > ${MAX_ASSET_BYTES})`)
  }
  const data = await readFile(filePath)
  const name = basename(filePath)
  return saveAsset(sessionId, name, data, guessMimeType(name))
}

/** 渲染端预览用：小图转 data URL（大文件 / 非图片返回 null） */
export async function assetDataUrl(
  assetUri: string,
  maxBytes = 4 * 1024 * 1024
): Promise<string | null> {
  const localPath = resolveAssetLocalPath(assetUri)
  if (!localPath || !existsSync(localPath)) return null
  const st = await stat(localPath)
  if (st.size > maxBytes) return null
  const mime = guessMimeType(localPath)
  if (!mime.startsWith('image/')) return null
  const data = await readFile(localPath)
  return `data:${mime};base64,${data.toString('base64')}`
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.xml': 'text/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.vue': 'text/plain',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java'
}

export function guessMimeType(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** 能当纯文本内联进上下文的类型 */
export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json'
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
