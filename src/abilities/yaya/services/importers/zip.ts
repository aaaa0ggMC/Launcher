/**
 * 极简 zip 读取（只读、无依赖）：各家导出都是 zip（ChatGPT / Claude / DeepSeek 的 conversations.json、
 * Rikkahub 的数据库备份）。支持 stored / deflate，不支持 ZIP64 与加密（导出文件用不到）。
 */
import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  size: number
  read(): Buffer
}

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOC
}

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error('corrupt zip central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    entries.push({
      name,
      size,
      read: () => {
        if (flags & 1) throw new Error(`encrypted zip entry: ${name}`)
        if (buf.readUInt32LE(local) !== LOC) throw new Error(`corrupt zip entry: ${name}`)
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
        const data = buf.subarray(start, start + compSize)
        if (method === 0) return Buffer.from(data)
        if (method === 8) return inflateRawSync(data)
        throw new Error(`unsupported zip compression ${method}: ${name}`)
      }
    })
  }
  return entries
}

/** 按文件名（不含目录）找条目，大小写不敏感 */
export function findEntry(entries: ZipEntry[], base: string): ZipEntry | undefined {
  const want = base.toLowerCase()
  return entries.find((e) => e.name.split('/').pop()!.toLowerCase() === want)
}
