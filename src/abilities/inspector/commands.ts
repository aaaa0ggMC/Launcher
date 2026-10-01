import type { CommandSpec } from '../../main/process/commands/types'
import {
  snapshot,
  click,
  clickAt,
  moveTo,
  mouseButton,
  drag,
  type,
  key,
  scroll,
  navigate,
  waitFor,
  screenshot,
  type CoordSpace,
  type Modifier,
  type MouseButton,
  type Point
} from '../../main/process/inspector'

function bool(v: unknown): boolean {
  return v === true || v === 'true'
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function needRef(v: unknown): string {
  const ref = String(v ?? '').trim()
  if (!ref) throw new Error('需要 --ref（来自 ui.snapshot 的 eN）')
  return ref
}

function point(named: Record<string, unknown>, xKey = 'x', yKey = 'y'): Point {
  const x = num(named[xKey])
  const y = num(named[yKey])
  if (x === undefined || y === undefined) {
    throw new Error(`需要 --${xKey} 与 --${yKey}（截图像素坐标）`)
  }
  return { x, y }
}

/** 坐标空间：默认 image（截图像素），--space css 为页面 CSS 像素。 */
function space(v: unknown): CoordSpace {
  return v === 'css' ? 'css' : 'image'
}

function button(v: unknown): MouseButton {
  return v === 'right' ? 'right' : v === 'middle' ? 'middle' : 'left'
}

/** --settle false：不等页面稳定（游戏等连续操作）。 */
function settleOpt(v: unknown): boolean | undefined {
  return v === false || v === 'false' ? false : undefined
}

function modifiers(v: unknown): Modifier[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/[,+]/) : []
  return list
    .map((x) => String(x).trim())
    .filter((x): x is Modifier => ['Shift', 'Control', 'Alt', 'Meta'].includes(x))
}

/**
 * ui.* —— 像用户一样看和操作主窗口（CLI-first：CLI / 脚本 / AI 共用）。
 * 两种定位方式：快照里的 ref（语义化元素），或截图上的坐标（画布 / 游戏 / 任意位置）。
 * 隐私：快照 / 截图按 DOM 隐私标签脱敏；点击（含按坐标点击）落在隐私区前要许可，禁区拒绝。
 */
export default [
  {
    name: 'ui.snapshot',
    description:
      '读取主窗口的界面快照：可交互元素带 [ref=eN]，可滚动区域标注位置，<canvas> 也给 ref；--boxes true 附上每个 ref 在截图上的位置 (--mode interactive|full)',
    usage: 'ui.snapshot [--mode full] [--boxes true]',
    privacy: {},
    run: async (ctx) =>
      snapshot({
        mode: ctx.named.mode === 'full' ? 'full' : 'interactive',
        boxes: bool(ctx.named.boxes)
      })
  },
  {
    name: 'ui.navigate',
    description: '切换到某个能力页面（等价于点击侧栏）(--ability <id>)',
    usage: 'ui.navigate --ability campusinfo',
    privacy: {},
    run: async (ctx) => navigate(String(ctx.named.ability ?? ctx.positional[0] ?? ''))
  },
  {
    name: 'ui.click',
    description: '点击快照里的元素 (--ref eN [--button right] [--double true])',
    usage: 'ui.click --ref e12',
    privacy: {},
    run: async (ctx) =>
      click(needRef(ctx.named.ref), {
        button: button(ctx.named.button),
        double: bool(ctx.named.double)
      })
  },
  {
    name: 'ui.click-at',
    description:
      '按坐标点击（默认截图像素；--space css 为 CSS 像素）。点到隐私区需许可，禁区拒绝 (--x --y [--button right] [--double true] [--settle false])',
    usage: 'ui.click-at --x 640 --y 360',
    privacy: {},
    run: async (ctx) =>
      clickAt(point(ctx.named), {
        space: space(ctx.named.space),
        button: button(ctx.named.button),
        double: bool(ctx.named.double),
        settle: settleOpt(ctx.named.settle)
      })
  },
  {
    name: 'ui.move',
    description: '移动鼠标到坐标（悬停；按住鼠标键时即拖动中的移动）(--x --y [--space css])',
    usage: 'ui.move --x 640 --y 360',
    privacy: {},
    run: async (ctx) =>
      moveTo(point(ctx.named), {
        space: space(ctx.named.space),
        settle: settleOpt(ctx.named.settle)
      })
  },
  {
    name: 'ui.mouse',
    description: '单独按下 / 松开鼠标键（按住不放）(--action down|up --x --y [--button right])',
    usage: 'ui.mouse --action down --x 100 --y 200',
    privacy: {},
    run: async (ctx) =>
      mouseButton(ctx.named.action === 'up' ? 'up' : 'down', point(ctx.named), {
        space: space(ctx.named.space),
        button: button(ctx.named.button),
        settle: settleOpt(ctx.named.settle)
      })
  },
  {
    name: 'ui.drag',
    description:
      '拖动：从 (--from-x --from-y) 到 (--to-x --to-y)，起点与终点都做隐私检查 ([--steps 12] [--duration 240] [--button])',
    usage: 'ui.drag --from-x 100 --from-y 200 --to-x 400 --to-y 200',
    privacy: {},
    run: async (ctx) =>
      drag(point(ctx.named, 'from-x', 'from-y'), point(ctx.named, 'to-x', 'to-y'), {
        space: space(ctx.named.space),
        button: button(ctx.named.button),
        steps: num(ctx.named.steps),
        durationMs: num(ctx.named.duration),
        settle: settleOpt(ctx.named.settle)
      })
  },
  {
    name: 'ui.type',
    description:
      '输入文本：给 --ref 先点击聚焦，不给则输入到当前焦点 (--text "..." [--clear true] [--submit true])',
    usage: 'ui.type --ref e7 --text "hello" --submit true',
    privacy: {},
    run: async (ctx) =>
      type(ctx.named.ref ? String(ctx.named.ref) : undefined, String(ctx.named.text ?? ''), {
        clear: bool(ctx.named.clear),
        submit: bool(ctx.named.submit)
      })
  },
  {
    name: 'ui.key',
    description:
      '按键：命名键 / 单个字母数字符号 / F1–F12；--hold 毫秒按住，--action down|up 自己控制按住与松开，--modifiers Control,Shift 组合键',
    usage: 'ui.key --key ArrowRight --hold 500',
    privacy: {},
    run: async (ctx) =>
      key(String(ctx.named.key ?? ''), {
        holdMs: num(ctx.named.hold),
        action: ctx.named.action === 'down' ? 'down' : ctx.named.action === 'up' ? 'up' : 'press',
        modifiers: modifiers(ctx.named.modifiers),
        settle: settleOpt(ctx.named.settle)
      })
  },
  {
    name: 'ui.scroll',
    description:
      '滚动（鼠标滚轮）：页面中央、某个元素上或指定坐标处 (--dy 400 [--ref eN | --x --y] [--dx 0])',
    usage: 'ui.scroll --ref e30 --dy 600',
    privacy: {},
    run: async (ctx) =>
      scroll({
        ref: ctx.named.ref ? String(ctx.named.ref) : undefined,
        at: ctx.named.x !== undefined && ctx.named.y !== undefined ? point(ctx.named) : undefined,
        space: space(ctx.named.space),
        settle: settleOpt(ctx.named.settle),
        dy: num(ctx.named.dy),
        dx: num(ctx.named.dx)
      })
  },
  {
    name: 'ui.wait',
    description: '等待页面稳定 / 出现某段文本 / 固定时长 (--text "..." [--timeout ms] | --ms 500)',
    usage: 'ui.wait --text "加载完成" --timeout 8000',
    privacy: {},
    run: async (ctx) =>
      waitFor({
        text: ctx.named.text !== undefined ? String(ctx.named.text) : undefined,
        ms: num(ctx.named.ms),
        timeoutMs: num(ctx.named.timeout)
      })
  },
  {
    name: 'ui.screenshot',
    description:
      '截取主窗口（隐私区域遮盖）；结果的 scale = 截图像素 / CSS 像素，坐标类命令默认就用截图像素 (--ref eN 只截该元素；--save true 存到 ~/.config/LinuxCockpit/screenshots，CLI 默认保存)',
    usage: 'ui.screenshot [--ref e10] [--save false]',
    privacy: {},
    run: async (ctx) =>
      screenshot({
        ref: ctx.named.ref ? String(ctx.named.ref) : undefined,
        save: ctx.named.save === undefined ? undefined : bool(ctx.named.save)
      })
  }
] satisfies CommandSpec[]
