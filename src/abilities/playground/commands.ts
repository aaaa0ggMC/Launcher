import type { CommandSpec } from '../../main/process/commands/types'
import { writeTextFile, writeBinaryFile } from '../../main/process/util'
import { readFile } from 'fs/promises'
import { makeLogger } from '../../main/process/logger'
import './jobs'

const log = makeLogger('playground')

/**
 * Provider Playground commands — CLI-first for the two backend-touching
 * operations (export / import of config) plus remote-media download. Everything
 * else in this ability is frontend-only; these commands let the config persist
 * and media land on disk via the main process.
 */
export default [
  {
    name: 'playground.export',
    description: '导出接口调试配置 (--path <目标文件> --data <json>)',
    usage: 'playground.export --path /abs/playground.json --data {"data":{...}}',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const data = ctx.named.data
      if (!path || !data) {
        log.warn('playground.export invalid args', { path, hasData: !!data })
        return { ok: false, error: '需要 --path 与 --data' }
      }
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        data
      }
      const res = await writeTextFile(path, JSON.stringify(payload, null, 2))
      if (res.ok) log.info('playground.export ok', { path })
      else log.error('playground.export failed', { path, error: res.error })
      return { ok: res.ok, path, error: res.error }
    }
  },
  {
    name: 'playground.import',
    description: '导入接口调试配置 (--path <源文件>)',
    usage: 'playground.import --path /abs/playground.json',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) {
        log.warn('playground.import missing path')
        return { ok: false, error: '需要 --path' }
      }
      try {
        const raw = await readFile(path, 'utf-8')
        const parsed = JSON.parse(raw) as { data?: Record<string, unknown> }
        if (!parsed.data || !Array.isArray(parsed.data.templates)) {
          log.warn('playground.import bad format', { path })
          return { ok: false, error: '无效文件：缺少 templates 数组' }
        }
        log.info('playground.import ok', { path, templates: parsed.data.templates.length })
        log.debug('playground.import details', {
          path,
          templates: parsed.data.templates.length,
          vars: Array.isArray(parsed.data.vars) ? parsed.data.vars.length : 0,
          globals: Array.isArray(parsed.data.globals) ? parsed.data.globals.length : 0
        })
        return { ok: true, ...parsed.data }
      } catch (e) {
        log.error('playground.import failed', {
          path,
          error: e instanceof Error ? e.message : String(e)
        })
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  },
  {
    name: 'playground.download-url',
    description: '下载远程资源到本地文件 (--url <地址> 或 --text <内容> + --path <目标文件>)',
    usage: 'playground.download-url --url https://... --path /abs/file.jpg',
    run: async (ctx) => {
      const url = String(ctx.named.url ?? '')
      const text = String(ctx.named.text ?? '')
      const path = String(ctx.named.path ?? '')
      if (!path || (!url && !text)) {
        log.warn('playground.download-url invalid args', {
          hasUrl: !!url,
          hasText: !!text,
          hasPath: !!path
        })
        return { ok: false, error: '需要 --path 以及 --url 或 --text' }
      }
      try {
        if (url) {
          const resp = await fetch(url)
          if (!resp.ok) {
            log.error('playground.download-url http error', { url, status: resp.status })
            return { ok: false, error: `下载失败 (HTTP ${resp.status})` }
          }
          const buf = Buffer.from(await resp.arrayBuffer())
          const res = await writeBinaryFile(path, buf)
          if (res.ok) log.info('playground.download-url ok', { url, path, bytes: buf.length })
          return { ok: res.ok, path, bytes: buf.length, error: res.error }
        }
        const res = await writeTextFile(path, text)
        if (res.ok) log.info('playground.download-text ok', { path, chars: text.length })
        return { ok: res.ok, path, error: res.error }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        log.error('playground.download-url failed', { url, error })
        return { ok: false, error }
      }
    }
  }
] satisfies CommandSpec[]
