import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { RiskLevel } from './types'

export interface Assessment {
  risk: RiskLevel
  auto_note?: string
}

interface DangerRule {
  re: RegExp
  note: string
  /** network download behavior */
  network?: boolean
  /** privilege escalation behavior */
  priv?: boolean
  /** system-level file modification */
  sys?: boolean
}

const DANGER_RULES: DangerRule[] = [
  { re: /curl\s+.*\|\s*(ba)?sh\b/, note: '检测到 curl | sh 下载行为', network: true, sys: true },
  { re: /wget\s+.*\|\s*(ba)?sh\b/, note: '检测到 wget | sh 下载行为', network: true, sys: true },
  { re: /\bsudo\b/, note: '脚本内包含 sudo 提权操作', priv: true },
  { re: /\bpkexec\b/, note: '脚本内包含 pkexec 提权操作', priv: true },
  { re: /\bchmod\s+[0-7]{3}\b|\bchown\b/, note: '脚本涉及权限变更操作', priv: true, sys: true },
  { re: /\/etc\/|rm\s+-[rf]+/, note: '脚本涉及系统级文件修改', sys: true },
  { re: /\bcurl\b|\bwget\b|\bnc\b|\bssh\b/, note: '存在网络连接行为', network: true },
  { re: /\.env|api[_-]?key|token|secret/, note: '可能包含敏感凭据', sys: true }
]

const TEXT_FILES = ['.sh', '.bash', '.py', '.js', '.ts', '.mjs', '.cjs', '.rb', '.pl']

/** Risk assessment by content scanning a directory for shell/python/node scripts. */
export async function assessDir(dir: string): Promise<Assessment> {
  const names = await readdir(dir).catch(() => [])
  const notes = new Set<string>()
  let network = false
  let priv = false
  let sys = false

  for (const name of names) {
    const lower = name.toLowerCase()
    if (!TEXT_FILES.some((ext) => lower.endsWith(ext))) continue
    const full = join(dir, name)
    if (dir.startsWith('.') || name.startsWith('.')) continue
    const content = await readFile(full, 'utf-8').catch(() => '')
    if (!content) continue
    for (const rule of DANGER_RULES) {
      if (rule.re.test(content)) {
        notes.add(rule.note)
        if (rule.network) network = true
        if (rule.priv) priv = true
        if (rule.sys) sys = true
      }
    }
  }

  let risk: RiskLevel = 'low'
  if (network || sys || priv) risk = 'medium'
  if (priv && (network || sys)) risk = 'high'

  return {
    risk,
    auto_note: notes.size ? [...notes].join('; ') : undefined
  }
}
