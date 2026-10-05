/**
 * aidj 的隐私声明（隐私 SDK：src/main/process/privacy.ts）。
 *
 * - B 站 uid / 昵称 / 头像、听歌统计、会话聊天、歌单：不能定位到真人 → personal（默认对 AI 可见）
 * - OpenAI API Key、B 站 / NCM Cookie（SESSDATA）：secret，只写不读
 * - 登录、导入凭据、签署免责声明：只能由用户本人操作（agent: 'deny'）
 * - 局域网遥控：对外开放端口 → system.exec
 *
 * 声明集中在这里按命令名套到 CommandSpec 上，命令文件本身不用改。
 */
import {
  definePrivacyScopes,
  isAgentOrigin,
  PrivacyDeniedError,
  SCOPE_EXEC
} from '../../main/process/privacy'
import type { CommandPrivacy, CommandSpec } from '../../main/process/commands/types'

export const P = definePrivacyScopes('aidj', {
  bili: { level: 'personal', label: 'aidj.privacy.bili' },
  listening: { level: 'personal', label: 'aidj.privacy.listening' }
})

const DENY: CommandPrivacy = { agent: 'deny' }

const DECLARATIONS: Record<string, CommandPrivacy> = {
  'aidj.get-config': {},
  'aidj.approve-ncm': DENY,
  'aidj.approve-bilibili': DENY,
  'aidj.bili-qr-generate': DENY,
  'aidj.bili-qr-poll': DENY,
  'aidj.bili-import-credential': DENY,
  'aidj.bili-logout': DENY,
  'aidj.bili-profile': { reads: [P.bili] },
  'aidj.time-stats': { reads: [P.listening] },
  'aidj.time-range': { reads: [P.listening] },
  'aidj.web-remote-start': { requires: [SCOPE_EXEC] }
}

/** `aidj.update-config --path secrets.*`：agent 不能写凭据（也防止用占位符覆盖真实 Key）。 */
function guardUpdateConfig(spec: CommandSpec): CommandSpec {
  return {
    ...spec,
    privacy: {},
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (isAgentOrigin() && /^secrets(\.|$)/.test(path)) {
        throw new PrivacyDeniedError('agent_denied', [], 'agent may not modify aidj secrets')
      }
      return spec.run(ctx)
    }
  }
}

/**
 * 规范名：快捷别名 `aidj-xxx` 与 `aidj.xxx` 等价。别名的 run 直接调用原命令的 run，
 * 绕过了注册表的隐私中间件——所以别名必须和原命令套上**同一份**声明，否则 agent 能经别名
 * 做原命令禁止它做的事（曾经：AI 可经 aidj-approve-ncm 替用户签署免责声明）。
 */
export function canonicalAidjName(name: string): string {
  return name.replace(/^aidj-/, 'aidj.')
}

/** 给 aidj 的命令套上隐私声明。 */
export function withPrivacy(specs: CommandSpec[]): CommandSpec[] {
  return specs.map((s) => {
    if (canonicalAidjName(s.name) === 'aidj.update-config') return guardUpdateConfig(s)
    const decl = DECLARATIONS[canonicalAidjName(s.name)]
    return decl ? { ...s, privacy: decl } : s
  })
}
