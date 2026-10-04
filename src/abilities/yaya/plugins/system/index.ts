/**
 * 内置 system 插件：时间、文件读写、Shell、网页抓取。
 * 不加工具名前缀（namespace: false），旧会话里的工具名保持有效。
 * （Cockpit 命令 / 界面的操作已移到独立的 `cockpit` 插件。）
 */
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { guard, SCOPE_EXEC } from '../../../../main/process/privacy'
import { runShell } from './shell'
import { isPrivateUrl } from './net-guard'
import { clipText } from '../../services/plugins/registry'
import type { PluginTool, YayaPlugin } from '../../services/plugins/types'

const MAX_REDIRECTS = 5

const tools: PluginTool[] = [
  {
    name: 'get_system_time',
    description: '获取当前系统的精确时间、星期与时区信息。',
    parameters: {
      type: 'object',
      properties: {}
    },
    run: async () => {
      const now = new Date()
      return {
        iso: now.toISOString(),
        localeString: now.toLocaleString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: Date.now()
      }
    }
  },
  {
    name: 'read_file',
    description: '读取本机文本文件（可分段：offset + maxLines）；路径是目录时列出目录内容。',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '绝对路径' },
        offset: { type: 'number', description: '起始行（0 起），默认 0' },
        maxLines: { type: 'number', description: '最多读取行数，默认 400' }
      }
    },
    run: async (args, ctx) => {
      await guard(SCOPE_EXEC)
      ctx.signal.throwIfAborted()
      const filePath = String(args.path)
      if (!existsSync(filePath)) {
        return { error: `File not found: ${filePath}` }
      }
      const st = await stat(filePath)
      if (st.isDirectory()) {
        const entries = await readdir(filePath, { withFileTypes: true })
        return {
          directory: filePath,
          entries: entries.slice(0, 500).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
          isTruncated: entries.length > 500
        }
      }
      const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0
      const maxLines =
        typeof args.maxLines === 'number' ? Math.max(1, Math.floor(args.maxLines)) : 400
      const content = await readFile(filePath, 'utf8')
      const lines = content.split('\n')
      return {
        totalLines: lines.length,
        offset,
        isTruncated: offset + maxLines < lines.length,
        content: clipText(lines.slice(offset, offset + maxLines).join('\n'))
      }
    }
  },
  {
    name: 'write_file',
    description: '向指定路径写入文件。这是一个具有修改性的操作。',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: '绝对路径' },
        content: { type: 'string', description: '写入的完整内容' }
      }
    },
    run: async (args, ctx) => {
      await guard(SCOPE_EXEC)
      ctx.signal.throwIfAborted()
      const filePath = String(args.path)
      const content = String(args.content)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf8')
      return { ok: true, path: filePath, bytesWritten: Buffer.byteLength(content) }
    }
  },
  {
    name: 'run_bash',
    description: '在 Linux 终端执行 Bash 命令，返回标准输出和错误。具有潜在副作用。',
    approval: 'ask',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Bash 命令行' },
        cwd: { type: 'string', description: '工作目录' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 30000' }
      }
    },
    run: async (args, ctx) => {
      await guard(SCOPE_EXEC)
      ctx.signal.throwIfAborted()
      const cmd = String(args.command)
      const cwd = args.cwd ? String(args.cwd) : homedir()
      const timeout =
        typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
          ? Math.max(1, Math.min(args.timeoutMs, 300_000))
          : 30_000
      try {
        const { stdout, stderr } = await runShell(cmd, {
          cwd,
          timeout,
          maxBuffer: 8 * 1024 * 1024,
          signal: ctx.signal
        })
        return { ok: true, stdout: clipText(stdout), stderr: clipText(stderr, 8000) }
      } catch (e: unknown) {
        const err = e as { message?: string; stdout?: string; stderr?: string; code?: number }
        return {
          ok: false,
          exitCode: err.code,
          error: err.message || String(e),
          stdout: clipText(err.stdout ?? ''),
          stderr: clipText(err.stderr ?? '', 8000)
        }
      }
    }
  },
  {
    name: 'fetch_url',
    docs: '访问本机 / 局域网 / 链路本地地址（含经重定向到达的）需要隐私授权。',
    description:
      '以 GET 请求抓取 http(s) URL，返回状态码与正文文本（HTML 会去掉标签，长文本截断）。',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: '完整的 http(s) URL' },
        maxChars: { type: 'number', description: '正文最多返回字符数，默认 20000' }
      }
    },
    run: async (args, ctx) => {
      const url = String(args.url)
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs are supported' }
      const maxChars = typeof args.maxChars === 'number' ? Math.max(500, args.maxChars) : 20_000
      const timeout = AbortSignal.timeout(20_000)
      const signal = AbortSignal.any([ctx.signal, timeout])
      // 本机 / 局域网地址要先过隐私授权；重定向逐跳检查（公网地址不能把请求跳到本机）
      let target = new URL(url)
      let res: Response | null = null
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!/^https?:$/.test(target.protocol)) {
          return { ok: false, error: 'only http(s) URLs are supported' }
        }
        if (await isPrivateUrl(target))
          await guard(SCOPE_EXEC, `fetch_url 访问本机 / 局域网地址 ${target.host}`)
        res = await fetch(target, { signal, redirect: 'manual' })
        const loc = res.headers.get('location')
        if (res.status < 300 || res.status >= 400 || !loc) break
        target = new URL(loc, target)
        res = null
      }
      if (!res) return { ok: false, error: `too many redirects (> ${MAX_REDIRECTS})` }
      const type = res.headers.get('content-type') ?? ''
      if (!/text|json|xml|javascript/i.test(type)) {
        return { ok: res.ok, status: res.status, contentType: type, note: 'non-text body omitted' }
      }
      let text = await res.text()
      if (/html/i.test(type)) text = htmlToText(text)
      return {
        ok: res.ok,
        status: res.status,
        contentType: type,
        content: clipText(text, maxChars)
      }
    }
  }
]

const plugin: YayaPlugin = {
  id: 'system',
  kind: 'builtin',
  label: '系统工具',
  labelKey: 'yaya.plugin.system.label',
  description: '时间、读写文件、执行 Shell 命令、抓取网页',
  descriptionKey: 'yaya.plugin.system.desc',
  icon: 'mdi-console',
  namespace: false,
  tools: () => tools
}

export default plugin

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}
