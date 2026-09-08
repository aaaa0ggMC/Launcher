import type { CommandSpec } from '../../../main/process/commands/types'
import { startJobByName } from '../../../main/process/background-tasks'
import { loadAidjConfig, saveAidjConfig } from '../services/config'
import { setNcmApproved, setNcmMode } from '../services/ncm'
import { state } from './shared'
import { BiliClient, BiliCredential, getNavProfile, generateQrCode, pollQrCode } from '../bili_api'

const DISCLAIMER_NCM = `
【关于网易云音乐 (NCM) 内置直连免责声明】
1. 本功能仅供个人学习、技术研究与个人音乐离线元数据整理之用。
2. 开发者及本项目不存储、不提供、不传播任何网易云音乐版权音视频或商业数据。
3. 用户使用内置直连功能所产生的一切网络交互与数据使用，均由使用者本人承担全部法律责任。
`

const DISCLAIMER_BILI = `
【关于 Bilibili API 视频与元数据导入免责声明】
1. 本功能仅供个人学习交流与多媒体技术研究之用。
2. 开发者及本项目不托管、不传播任何 Bilibili 网站音视频或用户数据，亦不保证第三方接口的永久有效性。
3. 用户使用本功能下载、解析视频或使用衍生元数据，须遵守相关法律法规及平台规范，自行承担全部风险与责任。
`

export const approveCommands: CommandSpec[] = [
  {
    name: 'aidj.approve-ncm',
    description: '签署或撤销网易云音乐内置 API 免责声明授权',
    usage: 'aidj.approve-ncm [--enable true|false]',
    run: async (ctx) => {
      const config = (await loadAidjConfig()) ?? state.config
      if (!config) return { ok: false, error: 'AIDJ 配置未找到' }

      const rawEnable = ctx.named.enable
      const enable = rawEnable === undefined ? true : rawEnable === true || rawEnable === 'true'

      config.preferences = config.preferences || {}
      config.preferences.ncm_approved = enable
      if (!enable && config.preferences.ncm_mode === 'builtin') {
        config.preferences.ncm_mode = 'external'
      }

      setNcmApproved(enable)
      setNcmMode(config.preferences.ncm_mode)
      state.config = config
      await saveAidjConfig(config)

      return {
        ok: true,
        approved: enable,
        disclaimer: DISCLAIMER_NCM.trim(),
        message: enable
          ? '已同意免责声明，已授权启用网易云内置 API 直连'
          : '已撤销网易云内置 API 授权，已降级为仅外部服务模式'
      }
    }
  },
  {
    name: 'aidj-approve-ncm',
    description: '签署或撤销网易云音乐内置 API 免责声明授权（快捷别名）',
    usage: 'aidj-approve-ncm [--enable true|false]',
    run: async (ctx) => {
      const cmd = approveCommands.find((c) => c.name === 'aidj.approve-ncm')
      return cmd ? cmd.run(ctx) : { ok: false }
    }
  },
  {
    name: 'aidj.approve-bilibili',
    description: '签署或撤销 Bilibili API 视频与元数据功能免责声明授权',
    usage: 'aidj.approve-bilibili [--enable true|false]',
    run: async (ctx) => {
      const config = (await loadAidjConfig()) ?? state.config
      if (!config) return { ok: false, error: 'AIDJ 配置未找到' }

      const rawEnable = ctx.named.enable
      const enable = rawEnable === undefined ? true : rawEnable === true || rawEnable === 'true'

      config.preferences = config.preferences || {}
      config.preferences.bilibili_approved = enable
      config.preferences.bilibili_enabled = enable

      state.config = config
      await saveAidjConfig(config)

      return {
        ok: true,
        approved: enable,
        disclaimer: DISCLAIMER_BILI.trim(),
        message: enable
          ? '已同意免责声明，已授权启用 Bilibili API 与视频导入功能'
          : '已撤销 Bilibili API 授权，功能已关闭'
      }
    }
  },
  {
    name: 'aidj-approve-bilibili',
    description: '签署或撤销 Bilibili API 视频与元数据功能免责声明授权（快捷别名）',
    usage: 'aidj-approve-bilibili [--enable true|false]',
    run: async (ctx) => {
      const cmd = approveCommands.find((c) => c.name === 'aidj.approve-bilibili')
      return cmd ? cmd.run(ctx) : { ok: false }
    }
  },
  {
    name: 'aidj.bili-import',
    description: '从 Bilibili 导入视频/音频、解析字幕、弹幕、评论并由 AI 推断元数据',
    usage: 'aidj.bili-import --bvid <bvid_or_url> [--folder <dir>] [--audio-only true|false]',
    run: async (ctx) => {
      const bvid = (ctx.named.bvid || ctx.positional[0]) as string
      if (!bvid) return { ok: false, error: '请提供 --bvid 参数或视频链接' }
      const folder = ctx.named.folder as string | undefined
      const audioOnly = ctx.named['audio-only'] === true || ctx.named['audio-only'] === 'true'
      const task = await startJobByName('aidj.bili-import', {
        name: `Bilibili 导入: ${bvid}`,
        description: `从 Bilibili 导入音视频与 AI 元数据`,
        bvid,
        folder,
        audioOnly
      })
      if (!task) return { ok: false, error: '启动导入任务失败' }
      return { ok: true, taskId: task.id, message: `已启动后台导入任务 [${task.id}]` }
    }
  },
  {
    name: 'aidj.bili-profile',
    description: '获取当前配置的 Bilibili 账号个人信息与凭据状态',
    usage: 'aidj.bili-profile',
    run: async () => {
      const config = (await loadAidjConfig()) ?? state.config
      const customPath = config?.preferences?.bili_credential_path
      const { credential, sourcePath } = BiliCredential.resolve(customPath)
      const client = new BiliClient({ credential })
      const profile = await getNavProfile(client)
      return {
        ok: true,
        isLogin: profile.isLogin,
        profile,
        sourcePath,
        hasSessdata: credential.hasSessdata()
      }
    }
  },
  {
    name: 'aidj.bili-qr-generate',
    description: '生成 Bilibili 扫码登录二维码及密钥',
    usage: 'aidj.bili-qr-generate',
    run: async () => {
      const client = new BiliClient({ credential: new BiliCredential() })
      try {
        const res = await generateQrCode(client)
        return {
          ok: true,
          qrcode_key: res.qrcode_key,
          url: res.url,
          qrDataUrl: res.qrDataUrl
        }
      } catch (err: unknown) {
        return {
          ok: false,
          error: `生成二维码失败: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  },
  {
    name: 'aidj.bili-qr-poll',
    description: '轮询 Bilibili 二维码扫码登录状态，成功时自动持久化凭据',
    usage: 'aidj.bili-qr-poll --key <qrcode_key>',
    run: async (ctx) => {
      const key = (ctx.named.key || ctx.positional[0]) as string
      if (!key) return { ok: false, error: '缺少 --key 参数' }
      const client = new BiliClient({ credential: new BiliCredential() })
      try {
        const res = await pollQrCode(client, key)
        if (res.code === 0 && res.credential) {
          if (!res.credential.hasSessdata()) {
            return {
              ok: false,
              code: res.code,
              error: '登录成功但未能提取到有效的凭据 Cookie，请尝试手动导入'
            }
          }
          const savedPath = res.credential.save()
          const newClient = new BiliClient({ credential: res.credential })
          const profile = await getNavProfile(newClient)
          return {
            ok: true,
            code: res.code,
            message: res.message,
            savedPath,
            profile
          }
        }
        return {
          ok: true,
          code: res.code,
          message: res.message
        }
      } catch (err: unknown) {
        return {
          ok: false,
          error: `轮询二维码状态失败: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  },
  {
    name: 'aidj.bili-import-credential',
    description: '导入 Bilibili 凭据（支持文件路径、Cookie字符串或JSON文本）并验证保存',
    usage: 'aidj.bili-import-credential [--file <path>] [--content <raw_cookie_or_json>]',
    run: async (ctx) => {
      const filePath = (ctx.named.file || ctx.positional[0]) as string | undefined
      const rawContent = ctx.named.content as string | undefined
      let cred: BiliCredential

      try {
        if (filePath) {
          cred = BiliCredential.fromFile(filePath)
        } else if (rawContent) {
          cred = BiliCredential.parseFromString(rawContent)
        } else {
          return { ok: false, error: '请提供 --file 文件路径或 --content 内容' }
        }
      } catch (err: unknown) {
        return {
          ok: false,
          error: `解析凭据内容失败: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      if (!cred.hasSessdata()) {
        return { ok: false, error: '未能从输入中提取到有效的 SESSDATA 凭据' }
      }

      // Verify with Bilibili nav API
      const client = new BiliClient({ credential: cred })
      const profile = await getNavProfile(client)
      if (!profile.isLogin) {
        return {
          ok: false,
          error: '凭据测试失败：Bilibili API 返回未登录或 SESSDATA 已失效'
        }
      }

      const savedPath = cred.save()
      return {
        ok: true,
        message: `凭据导入成功！已成功登录为: ${profile.uname || 'Bilibili 用户'}`,
        savedPath,
        profile
      }
    }
  },
  {
    name: 'aidj.bili-logout',
    description: '退出 Bilibili 账号并移除保存在本地的凭据文件',
    usage: 'aidj.bili-logout',
    run: async () => {
      BiliCredential.clear()
      return {
        ok: true,
        message: '已退出登录并清除本地保存的 Bilibili 凭据'
      }
    }
  }
]
