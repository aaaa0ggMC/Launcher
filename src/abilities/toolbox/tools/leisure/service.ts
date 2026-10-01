/**
 * 番茄钟（pomodoro）—— 本地专注/休息循环计时计划。
 *
 * 纯函数实现：不联网、不读写文件、不调用外部程序，CLI 与界面走同一套校验逻辑。
 * 输入缺失时回落到定义里的默认值，便于 CLI 不带参数直接运行。
 */
import { definitions } from './definitions'
import type { ToolArgs, ToolResult } from '../../types'

const TOOL_ID = 'pomodoro'

interface NumberSpec {
  min: number
  max: number
  fallback: number
}

/** 从定义里取数字字段的 min/max/默认值，保证 CLI 与 UI 边界一致。 */
function specFor(key: string, fallback: NumberSpec): NumberSpec {
  const field = definitions.find((d) => d.id === TOOL_ID)?.fields.find((f) => f.key === key)
  const rawDefault = field?.default
  return {
    min: typeof field?.min === 'number' ? field.min : fallback.min,
    max: typeof field?.max === 'number' ? field.max : fallback.max,
    fallback:
      typeof rawDefault === 'number' && Number.isFinite(rawDefault) ? rawDefault : fallback.fallback
  }
}

const FOCUS_SPEC = specFor('focusMinutes', { min: 1, max: 180, fallback: 25 })
const BREAK_SPEC = specFor('breakMinutes', { min: 1, max: 60, fallback: 5 })
/** 轮次不出现在 fields 里（界面侧不需要），CLI 可按 cycles 覆盖。 */
const CYCLES_SPEC: NumberSpec = { min: 1, max: 12, fallback: 4 }

const FIELD_LABELS: Record<string, string> = {
  focusMinutes: '专注分钟',
  breakMinutes: '休息分钟',
  cycles: '循环轮次'
}

type Parsed = { ok: true; value: number } | { ok: false; error: string }

/** 布尔开关也走同一解析，缺少时按默认值处理。 */
function readNumber(args: ToolArgs, key: string, spec: NumberSpec): Parsed {
  const raw = args[key]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: spec.fallback }
  }
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN
  if (!Number.isFinite(n)) return { ok: false, error: `${FIELD_LABELS[key] ?? key} 必须是数字` }
  if (!Number.isInteger(n)) return { ok: false, error: `${FIELD_LABELS[key] ?? key} 必须是整数` }
  if (n < spec.min || n > spec.max) {
    return { ok: false, error: `${FIELD_LABELS[key] ?? key} 需在 ${spec.min} 到 ${spec.max} 之间` }
  }
  return { ok: true, value: n }
}

export interface PomodoroSegment {
  kind: 'focus' | 'break'
  minutes: number
  labelZh: string
  labelEn: string
}

export interface PomodoroPlan {
  focusMinutes: number
  breakMinutes: number
  cycles: number
  cycleMinutes: number
  totalFocusMinutes: number
  totalBreakMinutes: number
  totalMinutes: number
  segments: PomodoroSegment[]
}

/** 纯函数：把时长/轮次换算成可读的时间计划（界面倒计时与 CLI 输出共用同一口径）。 */
export function buildPomodoroPlan(
  focusMinutes: number,
  breakMinutes: number,
  cycles: number
): PomodoroPlan {
  const cycleList = Array.from({ length: cycles }, (_, i) => i + 1)
  const segments: PomodoroSegment[] = cycleList.flatMap((index) => [
    {
      kind: 'focus' as const,
      minutes: focusMinutes,
      labelZh: `第 ${index} 轮专注`,
      labelEn: `Focus ${index}`
    },
    {
      kind: 'break' as const,
      minutes: breakMinutes,
      labelZh: `第 ${index} 轮休息`,
      labelEn: `Break ${index}`
    }
  ])
  return {
    focusMinutes,
    breakMinutes,
    cycles,
    cycleMinutes: focusMinutes + breakMinutes,
    totalFocusMinutes: focusMinutes * cycles,
    totalBreakMinutes: breakMinutes * cycles,
    totalMinutes: (focusMinutes + breakMinutes) * cycles,
    segments
  }
}

function planText(plan: PomodoroPlan): string {
  return [
    `番茄钟计划：${plan.cycles} 轮循环，每轮专注 ${plan.focusMinutes} 分钟 + 休息 ${plan.breakMinutes} 分钟。`,
    `一轮 ${plan.cycleMinutes} 分钟，总计 ${plan.totalMinutes} 分钟（专注 ${plan.totalFocusMinutes} 分钟，休息 ${plan.totalBreakMinutes} 分钟）。`,
    `阶段顺序：${plan.segments.map((s) => `${s.labelZh} ${s.minutes} 分钟`).join(' → ')}。`
  ].join('\n')
}

export async function execute(id: string, args: ToolArgs): Promise<ToolResult> {
  if (id !== TOOL_ID) return { ok: false, error: `未知工具: ${id}` }

  const focus = readNumber(args, 'focusMinutes', FOCUS_SPEC)
  if (!focus.ok) return { ok: false, error: focus.error }
  const rest = readNumber(args, 'breakMinutes', BREAK_SPEC)
  if (!rest.ok) return { ok: false, error: rest.error }
  const cycles = readNumber(args, 'cycles', CYCLES_SPEC)
  if (!cycles.ok) return { ok: false, error: cycles.error }

  const plan = buildPomodoroPlan(focus.value, rest.value, cycles.value)
  return {
    ok: true,
    data: plan,
    text: planText(plan),
    note: '番茄钟只是本地计时计划：不联网、不读写文件、不弹系统通知。'
  }
}
