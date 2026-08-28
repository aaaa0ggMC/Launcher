import type { CommandSpec } from '../../main/process/commands/types'
import {
  checkAllPlatforms,
  checkSinglePlatform,
  getBalanceConfig,
  getCachedBalances,
  importLegacyConfig,
  listProfiles,
  upsertProfile,
  removeProfile,
  checkProfileStatus,
  loginProfileProvider,
  logoutProfileProvider,
  openProfileWindow,
  loginOpenAIWeb,
  logoutOpenAIWeb,
  loginGoogleWeb,
  logoutGoogleWeb,
  loginMimoWeb,
  logoutMimoWeb,
  loginBigModelWeb,
  logoutBigModelWeb,
  openPlatformWindow,
  removePlatform,
  saveBalanceConfig,
  upsertPlatform
} from './service'
import { makeLogger } from '../../main/process/logger'
import type { BalanceConfig, BalanceProviderType, PlatformConfig } from './types'

const log = makeLogger('balance')

export default [
  {
    name: 'balance.list',
    description: '获取所有平台余额列表 (--refresh 强制重新查询)',
    usage: 'balance.list [--refresh true|false]',
    run: async (ctx) => {
      const refresh = ctx.named.refresh === 'true' || ctx.named.refresh === true
      if (refresh) {
        return await checkAllPlatforms()
      }
      return await getCachedBalances()
    }
  },
  {
    name: 'balance.check',
    description: '查询单个平台余额 (--id <platformId>)',
    usage: 'balance.check --id deepseek',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '').trim()
      if (!id) {
        log.warn('balance.check: missing id parameter')
        return { ok: false, error: '需要 --id 参数' }
      }
      return await checkSinglePlatform(id)
    }
  },
  {
    name: 'balance.config.get',
    description: '获取余额查询配置 (--reveal true 返回解密密钥)',
    usage: 'balance.config.get [--reveal true|false]',
    run: async (ctx) => {
      const reveal = ctx.named.reveal === 'true' || ctx.named.reveal === true
      return await getBalanceConfig({ revealSecrets: reveal })
    }
  },
  {
    name: 'balance.config.set',
    description: '保存余额配置 (--config <json>)',
    usage: 'balance.config.set --config <json>',
    run: async (ctx) => {
      const raw = ctx.named.config
      let cfg: BalanceConfig
      if (typeof raw === 'string') {
        cfg = JSON.parse(raw) as BalanceConfig
      } else if (raw && typeof raw === 'object') {
        cfg = raw as BalanceConfig
      } else {
        return { ok: false, error: '无效的配置参数' }
      }

      await saveBalanceConfig(cfg)
      return { ok: true }
    }
  },
  {
    name: 'balance.config.upsert',
    description: '添加或修改单个平台配置 (--platform <json>)',
    usage: 'balance.config.upsert --platform <json>',
    run: async (ctx) => {
      const raw = ctx.named.platform
      let platform: PlatformConfig
      if (typeof raw === 'string') {
        platform = JSON.parse(raw) as PlatformConfig
      } else if (raw && typeof raw === 'object') {
        platform = raw as PlatformConfig
      } else {
        return { ok: false, error: '无效的平台参数' }
      }

      const res = await upsertPlatform(platform)
      return { ok: true, platform: res }
    }
  },
  {
    name: 'balance.config.remove',
    description: '删除平台配置 (--id <platformId>)',
    usage: 'balance.config.remove --id <platformId>',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '').trim()
      if (!id) {
        return { ok: false, error: '需要 --id 参数' }
      }
      const ok = await removePlatform(id)
      return { ok }
    }
  },
  {
    name: 'balance.profiles.list',
    description: '获取所有 Browser Profile 及其登录状态',
    usage: 'balance.profiles.list',
    run: async () => {
      return await listProfiles()
    }
  },
  {
    name: 'balance.profiles.upsert',
    description: '创建或更新 Profile (--id <id> --name <name> 或 --profile <json>)',
    usage: 'balance.profiles.upsert [--id <id>] --name <name>',
    run: async (ctx) => {
      let id = ctx.named.id ? String(ctx.named.id).trim() : undefined
      let name = ctx.named.name ? String(ctx.named.name).trim() : ''

      if (ctx.named.profile) {
        const raw = ctx.named.profile
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (parsed.id) id = parsed.id
        if (parsed.name) name = parsed.name
      }

      if (!name) {
        return { ok: false, error: 'Profile 名称不能为空' }
      }

      const profile = await upsertProfile({ id, name })
      return { ok: true, profile }
    }
  },
  {
    name: 'balance.profiles.remove',
    description: '删除 Profile (--id <profileId> [--clearStorage true|false])',
    usage: 'balance.profiles.remove --id <profileId>',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '').trim()
      if (!id) {
        return { ok: false, error: '需要 --id 参数' }
      }
      const clearStorage = ctx.named.clearStorage !== 'false' && ctx.named.clearStorage !== false
      try {
        const ok = await removeProfile(id, { clearStorage })
        return { ok }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
      }
    }
  },
  {
    name: 'balance.profiles.check',
    description: '检测单个 Profile 各厂商的实时登录状态 (--id <profileId>)',
    usage: 'balance.profiles.check --id <profileId>',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '').trim()
      if (!id) {
        return { ok: false, error: '需要 --id 参数' }
      }
      try {
        const profile = await checkProfileStatus(id)
        return { ok: true, profile }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
      }
    }
  },
  {
    name: 'balance.profiles.login',
    description:
      '在指定 Profile 中登录特定厂商 (--id <profileId> --provider <openai|mimo|bigmodel|google>)',
    usage: 'balance.profiles.login --id <profileId> --provider <provider> [--url <url>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      const provider = String(ctx.named.provider ?? 'openai').trim() as BalanceProviderType
      const url = ctx.named.url ? String(ctx.named.url).trim() : undefined
      return await loginProfileProvider(id, provider, url)
    }
  },
  {
    name: 'balance.profiles.logout',
    description: '在指定 Profile 中注销厂商或清空会话 (--id <profileId> [--provider <provider>])',
    usage: 'balance.profiles.logout --id <profileId> [--provider <provider>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      const provider = ctx.named.provider
        ? (String(ctx.named.provider).trim() as BalanceProviderType)
        : undefined
      return await logoutProfileProvider(id, provider)
    }
  },
  {
    name: 'balance.profiles.open_window',
    description:
      '在指定 Profile 的隔离环境中打开厂商控制台 (--id <profileId> --provider <provider>)',
    usage:
      'balance.profiles.open_window --id <profileId> --provider <provider> [--url <url>] [--title <title>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      const provider = String(ctx.named.provider ?? 'google').trim() as BalanceProviderType
      const url = ctx.named.url ? String(ctx.named.url).trim() : undefined
      const title = ctx.named.title ? String(ctx.named.title).trim() : undefined
      return await openProfileWindow(id, provider, url, title)
    }
  },
  {
    name: 'balance.import',
    description: '从 balance_checker 导入旧配置 (--path <filePath>)',
    usage: 'balance.import [--path ~/Apps/balance_checker/config.json]',
    run: async (ctx) => {
      const customPath = ctx.named.path ? String(ctx.named.path).trim() : undefined
      try {
        const res = await importLegacyConfig(customPath)
        return { ok: true, count: res.count }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
      }
    }
  },
  {
    name: 'balance.openai_web.login',
    description: '弹出原生窗口登录 OpenAI 账号 (--id <profileId|platformId>)',
    usage: 'balance.openai_web.login [--id <profileId|platformId>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      return await loginOpenAIWeb(id)
    }
  },
  {
    name: 'balance.openai_web.logout',
    description: '清除 OpenAI 授权会话 (--id <profileId|platformId>)',
    usage: 'balance.openai_web.logout [--id <profileId|platformId>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      await logoutOpenAIWeb(id)
      return { ok: true }
    }
  },
  {
    name: 'balance.google_web.login',
    description: '弹出原生窗口登录 Google 账号 (--id <profileId|platformId> [--url <url>])',
    usage: 'balance.google_web.login [--id <profileId|platformId>] [--url <url>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      const url = ctx.named.url ? String(ctx.named.url).trim() : undefined
      return await loginGoogleWeb(id, url)
    }
  },
  {
    name: 'balance.google_web.logout',
    description: '清除 Google 网页端授权会话 (--id <profileId|platformId>)',
    usage: 'balance.google_web.logout [--id <profileId|platformId>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      await logoutGoogleWeb(id)
      return { ok: true }
    }
  },
  {
    name: 'balance.mimo_web.login',
    description: '弹出原生窗口登录小米账号 (--id <profileId|platformId> [--url <url>])',
    usage: 'balance.mimo_web.login [--id <profileId|platformId>] [--url <url>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      const url = ctx.named.url ? String(ctx.named.url).trim() : undefined
      return await loginMimoWeb(id, url)
    }
  },
  {
    name: 'balance.mimo_web.logout',
    description: '清除小米 MiMo 授权会话 (--id <profileId|platformId>)',
    usage: 'balance.mimo_web.logout [--id <profileId|platformId>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      await logoutMimoWeb(id)
      return { ok: true }
    }
  },
  {
    name: 'balance.bigmodel_web.login',
    description: '弹出原生窗口登录智谱账号 (--id <profileId|platformId> [--url <url>])',
    usage: 'balance.bigmodel_web.login [--id <profileId|platformId>] [--url <url>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      const url = ctx.named.url ? String(ctx.named.url).trim() : undefined
      return await loginBigModelWeb(id, url)
    }
  },
  {
    name: 'balance.bigmodel_web.logout',
    description: '清除智谱 BigModel 授权会话 (--id <profileId|platformId>)',
    usage: 'balance.bigmodel_web.logout [--id <profileId|platformId>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      await logoutBigModelWeb(id)
      return { ok: true }
    }
  },
  {
    name: 'balance.open_window',
    description: '在 Electron 原生独立隔离窗口中打开指定平台控制台页面',
    usage: 'balance.open_window --id <platformId> [--type <type>] [--url <url>] [--title <title>]',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? 'default').trim()
      const type = ctx.named.type ? String(ctx.named.type).trim() : undefined
      const url = ctx.named.url ? String(ctx.named.url).trim() : undefined
      const title = ctx.named.title ? String(ctx.named.title).trim() : undefined
      return await openPlatformWindow(id, type, url, title)
    }
  }
] satisfies CommandSpec[]
