/**
 * balance 的隐私 scope（隐私 SDK：src/main/process/privacy.ts）。
 *  - 余额 / 用量 / 原始响应涉及金钱 → sensitive（balance.amount）
 *  - 网页登录的账号（邮箱）能定位到人 → sensitive（balance.account）
 *  - API Key 与 extra（可能含 token / cookie）→ secret，只写不读
 */
import { definePrivacyScopes, shieldFields, SCOPE_SECRET } from '../../main/process/privacy'

export const P = definePrivacyScopes('balance', {
  amount: {
    level: 'sensitive',
    label: 'balance.privacy.amount',
    description: 'balance.privacy.amount_desc'
  },
  account: {
    level: 'sensitive',
    label: 'balance.privacy.account',
    description: 'balance.privacy.account_desc'
  }
})

const FIELD_SCOPES: Record<string, string> = {
  amount: P.amount,
  voucher: P.amount,
  total: P.amount,
  used: P.amount,
  raw: P.amount,
  account: P.account,
  apiKey: SCOPE_SECRET,
  extra: SCOPE_SECRET
}

/** agent 来源：余额 / 账号脱敏、凭据占位；其他来源原样。适用于结果、配置、profile 列表。 */
export function shieldBalance<T>(value: T): T {
  return shieldFields(value, FIELD_SCOPES)
}
