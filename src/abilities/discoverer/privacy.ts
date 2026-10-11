/**
 * discoverer 的隐私声明（隐私 SDK：src/main/process/privacy.ts）。
 *
 * - 局域网设备名 / IPv4 / IPv6 / 平台：能勾勒用户身边有哪些设备，但默认
 *   不关联到真人 → personal（默认对 AI 可见，可申请）
 * - 验证共享密码：凭据，agent 不能写（也不能读——config-get 只回「是否已设置」）
 *
 * 声明集中在这里按命令名套到 CommandSpec 上，命令文件本身不用改。
 */
import {
  definePrivacyScopes,
  isAgentOrigin,
  PrivacyDeniedError,
  SCOPE_CONTROL
} from '../../main/process/privacy'
import type { CommandPrivacy, CommandSpec } from '../../main/process/commands/types'

export const P = definePrivacyScopes('discoverer', {
  peers: { level: 'personal', label: 'discoverer.privacy.peers' }
})

const DECLARATIONS: Record<string, CommandPrivacy> = {
  'discoverer.config-get': {},
  'discoverer.self': { reads: [P.peers] },
  'discoverer.peers': { reads: [P.peers] },
  'discoverer.announce': { requires: [SCOPE_CONTROL] },
  'discoverer.start': { requires: [SCOPE_CONTROL] },
  'discoverer.verify': { requires: [SCOPE_CONTROL] },
  'discoverer.unverify': { requires: [SCOPE_CONTROL] }
}

/** agent 不能写验证共享密码（也不能借 config-save 覆盖它）。 */
function guardConfigSave(spec: CommandSpec): CommandSpec {
  return {
    ...spec,
    privacy: {},
    run: async (ctx) => {
      if (isAgentOrigin() && 'verifyPassword' in ctx.named) {
        throw new PrivacyDeniedError(
          'agent_denied',
          [],
          'agent may not set the discoverer verify password'
        )
      }
      return spec.run(ctx)
    }
  }
}

/** 给 discoverer 的命令套上隐私声明。 */
export function withPrivacy(specs: CommandSpec[]): CommandSpec[] {
  return specs.map((s) => {
    if (s.name === 'discoverer.config-save') return guardConfigSave(s)
    const decl = DECLARATIONS[s.name]
    return decl ? { ...s, privacy: decl } : s
  })
}
