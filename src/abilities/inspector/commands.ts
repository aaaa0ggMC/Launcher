import type { CommandSpec } from '../../main/process/commands/types'
import {
  snapshot,
  click,
  type,
  key,
  scroll,
  navigate,
  waitFor,
  screenshot
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

/**
 * ui.* —— 像用户一样看和操作主窗口（CLI-first：CLI / 脚本 / AI 共用）。
 * 隐私：快照 / 截图按 DOM 隐私标签脱敏，点击隐私区前要许可，禁区拒绝（inspector 内部处理）。
 */
export default [
  {
    name: 'ui.snapshot',
    description:
      '读取主窗口的界面快照：可交互元素带 [ref=eN]，可滚动区域标注位置 (--mode interactive|full)',
    usage: 'ui.snapshot [--mode full]',
    privacy: {},
    run: async (ctx) => {
      const r = await snapshot({ mode: ctx.named.mode === 'full' ? 'full' : 'interactive' })
      return r
    }
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
        button:
          ctx.named.button === 'right'
            ? 'right'
            : ctx.named.button === 'middle'
              ? 'middle'
              : 'left',
        double: bool(ctx.named.double)
      })
  },
  {
    name: 'ui.type',
    description: '在输入框里输入文本 (--ref eN --text "..." [--clear true] [--submit true])',
    usage: 'ui.type --ref e7 --text "hello" --submit true',
    privacy: {},
    run: async (ctx) =>
      type(needRef(ctx.named.ref), String(ctx.named.text ?? ''), {
        clear: bool(ctx.named.clear),
        submit: bool(ctx.named.submit)
      })
  },
  {
    name: 'ui.key',
    description: '按键 (--key Enter|Escape|Tab|ArrowDown|PageDown|...)',
    usage: 'ui.key --key Escape',
    privacy: {},
    run: async (ctx) => key(String(ctx.named.key ?? ''))
  },
  {
    name: 'ui.scroll',
    description: '滚动（鼠标滚轮）：页面中央或某个元素上 (--dy 400 [--ref eN] [--dx 0])',
    usage: 'ui.scroll --ref e30 --dy 600',
    privacy: {},
    run: async (ctx) =>
      scroll({
        ref: ctx.named.ref ? String(ctx.named.ref) : undefined,
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
      '截取主窗口（隐私区域遮盖）(--ref eN 只截该元素；--save true 存到 ~/.config/LinuxCockpit/screenshots，CLI 默认保存)',
    usage: 'ui.screenshot [--ref e10] [--save false]',
    privacy: {},
    run: async (ctx) =>
      screenshot({
        ref: ctx.named.ref ? String(ctx.named.ref) : undefined,
        save: ctx.named.save === undefined ? undefined : bool(ctx.named.save)
      })
  }
] satisfies CommandSpec[]
