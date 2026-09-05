import type { CommandSpec } from '../../main/process/commands/types'
import {
  listUserScripts,
  loadScriptFile,
  saveScriptFile,
  deleteScriptFile,
  executeScript,
  stopCurrentScript,
  extractScriptConfigSchema
} from './service'
import { SCRIPT_TEMPLATES } from './templates'
import type { ScriptLanguage } from './types'
import './jobs'

export default [
  {
    name: 'scripting.run',
    description: '运行 JS/TS 脚本 (--code <code> --lang ts|js)',
    usage: 'scripting.run --code "cockpit.log(1+1)" --lang js',
    run: async (ctx) => {
      const code = String(ctx.named.code ?? '')
      const language = ((ctx.named.lang || ctx.named.language) as ScriptLanguage) || 'ts'
      const userConfig = (ctx.named.config as Record<string, unknown>) || {}
      if (!code.trim()) {
        return { ok: false, error: '代码不能为空' }
      }
      return await executeScript(code, language, {}, userConfig)
    }
  },
  {
    name: 'scripting.stop',
    description: '停止正在运行的脚本',
    usage: 'scripting.stop',
    run: async () => {
      const stopped = stopCurrentScript()
      return { ok: stopped }
    }
  },
  {
    name: 'scripting.parseConfig',
    description: '解析脚本中声明的配置结构 (--code <code> --lang ts|js)',
    usage: 'scripting.parseConfig --code "export const config = { ... }"',
    run: async (ctx) => {
      const code = String(ctx.named.code ?? '')
      const language = ((ctx.named.lang || ctx.named.language) as ScriptLanguage) || 'ts'
      return await extractScriptConfigSchema(code, language)
    }
  },
  {
    name: 'scripting.eval',
    description: '快速评估 JS/TS 表达式 (--expr <expression>)',
    usage: 'scripting.eval --expr "cockpit.listCommands()"',
    run: async (ctx) => {
      const expr = String(ctx.named.expr ?? ctx.positional.join(' ') ?? '')
      if (!expr.trim()) return { ok: false, error: '表达式不能为空' }
      const wrapped = `return (${expr});`
      return await executeScript(wrapped, 'ts')
    }
  },
  {
    name: 'scripting.list',
    description: '列出用户保存的脚本',
    usage: 'scripting.list',
    run: async () => {
      return await listUserScripts()
    }
  },
  {
    name: 'scripting.load',
    description: '读取脚本文件 (--path <filePath>)',
    usage: 'scripting.load --path ~/.config/LinuxCockpit/scripts/test.ts',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) return { ok: false, error: '需要 --path' }
      return await loadScriptFile(path)
    }
  },
  {
    name: 'scripting.save',
    description: '保存脚本文件 (--name <name> --code <code> --lang ts|js [--path <path>])',
    usage: 'scripting.save --name test --code "..." --lang ts',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? 'untitled')
      const code = String(ctx.named.code ?? '')
      const language = ((ctx.named.lang || ctx.named.language) as ScriptLanguage) || 'ts'
      const path = ctx.named.path ? String(ctx.named.path) : undefined
      return await saveScriptFile({ name, code, language, path })
    }
  },
  {
    name: 'scripting.delete',
    description: '删除指定脚本 (--path <path>)',
    usage: 'scripting.delete --path test.ts',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? ctx.named.id ?? '')
      if (!path) return { ok: false, error: '需要 --path' }
      const ok = await deleteScriptFile(path)
      return { ok }
    }
  },
  {
    name: 'scripting.templates',
    description: '获取内置工作流预设模板列表',
    usage: 'scripting.templates',
    run: async () => {
      return SCRIPT_TEMPLATES
    }
  }
] satisfies CommandSpec[]
