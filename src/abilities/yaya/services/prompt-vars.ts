/**
 * 系统提示词里的 `{变量}`：助手名、模型、日期时间、系统、电量、语言。
 *
 * - 每次运行开始时取一次快照（`collectPromptVars`），整次运行内不变：同一次运行的多步调用
 *   提示词一致，缓存不被打穿；`{time}` 这类会变的变量只影响下一次运行。
 * - 只替换认识的变量名，其余 `{…}` 原样保留（提示词里本来就可能有花括号）。
 * - 取值慢的（电量要读文件 / 调 termux-battery-status）只在提示词里出现时才取。
 */
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { readConfigLang } from '../../../main/process/i18n'

export const PROMPT_VARS = [
  'name',
  'model',
  'provider',
  'date',
  'time',
  'datetime',
  'weekday',
  'timezone',
  'system',
  'power',
  'language'
] as const
export type PromptVar = (typeof PROMPT_VARS)[number]

export interface PromptVarSources {
  name: string
  model?: string
  provider?: string
  now?: Date
  /** 测试注入：电量读取 */
  readPower?: () => Promise<string>
  /** 测试注入：系统描述 */
  readSystem?: () => string
}

const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function tzLabel(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const utc = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  let zone = ''
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    /* 没有 Intl 时区数据 */
  }
  return zone ? `${zone} (${utc})` : utc
}

/** 「Arch Linux (Linux 6.9.1, x64)」/「Android (Termux, arm64)」/「Windows 10.0.22631 (x64)」 */
export function describeSystem(): string {
  const arch = process.arch
  if (process.platform === 'android') return `Android (Termux, ${arch})`
  if (process.platform === 'linux') {
    let distro = ''
    try {
      const m = readFileSync('/etc/os-release', 'utf-8').match(/^PRETTY_NAME="?([^"\n]*)"?/m)
      distro = m?.[1]?.trim() ?? ''
    } catch {
      /* 没有 os-release */
    }
    return `${distro || 'Linux'} (Linux ${os.release()}, ${arch})`
  }
  if (process.platform === 'darwin') return `macOS (Darwin ${os.release()}, ${arch})`
  if (process.platform === 'win32') return `Windows ${os.release()} (${arch})`
  return `${os.type()} ${os.release()} (${arch})`
}

/** Linux 笔记本：/sys/class/power_supply/BAT*；读不到返回空 */
function readSysBattery(): string {
  const base = '/sys/class/power_supply'
  let names: string[] = []
  try {
    names = readdirSync(base).filter((n) => /^(BAT|battery)/i.test(n))
  } catch {
    return ''
  }
  for (const n of names) {
    try {
      const cap = readFileSync(`${base}/${n}/capacity`, 'utf-8').trim()
      let status = ''
      try {
        status = readFileSync(`${base}/${n}/status`, 'utf-8').trim()
      } catch {
        /* 没有状态 */
      }
      if (cap) return status ? `${cap}% (${status})` : `${cap}%`
    } catch {
      /* 下一块电池 */
    }
  }
  return ''
}

/** Termux：termux-battery-status（需要 Termux:API；没装时 3 秒放弃） */
function readTermuxBattery(): Promise<string> {
  return new Promise((resolve) => {
    execFile('termux-battery-status', [], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve('')
      try {
        const j = JSON.parse(String(stdout)) as { percentage?: number; status?: string }
        if (typeof j.percentage !== 'number') return resolve('')
        resolve(j.status ? `${j.percentage}% (${j.status.toLowerCase()})` : `${j.percentage}%`)
      } catch {
        resolve('')
      }
    })
  })
}

export async function readPower(): Promise<string> {
  const sys = readSysBattery()
  if (sys) return sys
  if (process.platform === 'android') {
    const t = await readTermuxBattery()
    if (t) return t
  }
  return 'unknown (no battery info)'
}

function used(prompt: string, key: PromptVar): boolean {
  return prompt.includes(`{${key}}`)
}

/** 取一份变量快照；只计算提示词里真的用到的 */
export async function collectPromptVars(
  prompt: string,
  src: PromptVarSources
): Promise<Partial<Record<PromptVar, string>>> {
  const now = src.now ?? new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const out: Partial<Record<PromptVar, string>> = {
    name: src.name,
    model: src.model ?? '',
    provider: src.provider ?? '',
    date,
    time,
    datetime: `${date} ${time}`,
    weekday: WEEKDAYS[now.getDay()],
    timezone: tzLabel(now)
  }
  if (used(prompt, 'system')) out.system = (src.readSystem ?? describeSystem)()
  if (used(prompt, 'power')) out.power = await (src.readPower ?? readPower)()
  if (used(prompt, 'language')) out.language = readConfigLang()
  return out
}

/** 把认识的 `{变量}` 换成值；没取到的保持原样 */
export function applyPromptVars(prompt: string, vars: Partial<Record<PromptVar, string>>): string {
  return prompt.replace(/\{([a-z]+)\}/g, (all, key: string) => {
    const v = vars[key as PromptVar]
    return typeof v === 'string' ? v : all
  })
}
