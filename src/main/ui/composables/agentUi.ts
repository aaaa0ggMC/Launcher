/**
 * AI 指示（标题栏图标条 / 全窗口描边）的显示配置 —— config.json `agent.ui`。
 * 放在 `agent.*` 下是有意的：settings 的 config.set 拒绝 agent 改 `agent.*`，
 * agent 不能替自己调长「过期时间」或关掉提示。
 * 所有取值都在这里归一化 + 夹紧，渲染端各处只读 `resolveAgentUi(...)` 的结果。
 */
export interface AgentUiConfig {
  /** agent 在自己的独立视图里操作（不动你的主窗口）；关 = agent 直接操作主窗口。主进程读原始 config，改完下一次 ui.* 调用生效 */
  isolateView: boolean
  /** 点头像后怎么跟随：inplace = 主窗口里跟随；window = 单独窗口。主进程读原始 config */
  followMode: 'inplace' | 'window'
  /** 截图方式：capture 不闪但被遮挡时可能失败；cdp 稳但可能闪一下；auto 先 capture 失败再 cdp。主进程读原始 config */
  screenshotMode: 'capture' | 'cdp' | 'auto'
  /** 标题栏显示 AI 图标条 */
  showBar: boolean
  /** agent 操作时给整个窗口描边 */
  outline: boolean
  /** Agent 过期时间（秒）：距离最近一次调用多久内算「正在操作」；描边也按它渐隐 */
  busyTimeoutSec: number
  /** set_status 文字的有效期（秒） */
  statusTtlSec: number
  /** 空闲超过 N 分钟就从图标条隐藏；0 = 不隐藏（直到会话断开） */
  hideIdleAfterMin: number
  /** 悬停提示里显示页面 / 状态 / 最近工具（关 = 只显示名称） */
  tooltipDetail: boolean
  /** 接受 agent 自带头像；关 = 一律用默认图标 */
  allowAvatar: boolean
  /** 没有头像时：随机动物图标 / 名字首字母 */
  defaultIcon: 'icon' | 'initial'
}

export const AGENT_UI_DEFAULTS: AgentUiConfig = {
  isolateView: true,
  followMode: 'inplace',
  screenshotMode: 'auto',
  showBar: true,
  outline: true,
  busyTimeoutSec: 60,
  statusTtlSec: 120,
  hideIdleAfterMin: 0,
  tooltipDetail: true,
  allowAvatar: true,
  defaultIcon: 'icon'
}

/** 数值项的合法范围（设置页校验与这里的夹紧共用）。 */
export const AGENT_UI_LIMITS = {
  busyTimeoutSec: { min: 3, max: 600 },
  statusTtlSec: { min: 10, max: 3600 },
  hideIdleAfterMin: { min: 0, max: 1440 }
} as const

function num(v: unknown, key: keyof typeof AGENT_UI_LIMITS): number {
  const n = Number(v)
  const { min, max } = AGENT_UI_LIMITS[key]
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : AGENT_UI_DEFAULTS[key]
}

export function resolveAgentUi(raw: unknown): AgentUiConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (k: keyof AgentUiConfig): boolean =>
    typeof r[k] === 'boolean' ? (r[k] as boolean) : (AGENT_UI_DEFAULTS[k] as boolean)
  return {
    isolateView: bool('isolateView'),
    followMode: r.followMode === 'window' ? 'window' : 'inplace',
    screenshotMode:
      r.screenshotMode === 'capture' || r.screenshotMode === 'cdp' ? r.screenshotMode : 'auto',
    showBar: bool('showBar'),
    outline: bool('outline'),
    busyTimeoutSec: num(r.busyTimeoutSec, 'busyTimeoutSec'),
    statusTtlSec: num(r.statusTtlSec, 'statusTtlSec'),
    hideIdleAfterMin: num(r.hideIdleAfterMin, 'hideIdleAfterMin'),
    tooltipDetail: bool('tooltipDetail'),
    allowAvatar: bool('allowAvatar'),
    defaultIcon: r.defaultIcon === 'initial' ? 'initial' : 'icon'
  }
}
