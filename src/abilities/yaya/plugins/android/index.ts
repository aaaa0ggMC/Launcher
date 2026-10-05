/**
 * 内置 android 插件（PLAN 6.6「Android Controller」的 Termux 后端）：在安卓手机上让 YAYA 操作手机。
 *
 * 宿主跑在 Termux 里（无头模式，`process.platform === 'android'`）时可用，两个子分组：
 *  - **Termux:API**：`termux-*` 命令（电量、通知、Toast、震动、手电筒、音量、亮度、朗读、剪贴板、
 *    定位、拍照、打开链接）。需要安装 Termux:API App 与 `pkg install termux-api`；
 *  - **Shizuku**：`rish`（adb 级权限）——截屏、点按 / 滑动 / 输入文字 / 按键、启动应用、列出应用、
 *    任意 Shell。等于 adb 权限，比桌面 Shell 更危险：Shell 默认每次确认并要 system.exec 授权。
 * 自有 App 的原生通道（nodejs-mobile 进程内 RPC）还没有：现在的安卓 App 只是连 Termux 宿主的
 * WebView 壳，Node 侧调不到 Java。
 *
 * 安全：工具执行来源是 local-agent，改变手机状态的走 `guard(SCOPE_CONTROL)`，读位置 / 相机 / 剪贴板 /
 * 屏幕走本能力的 sensitive scope；发短信、打电话、读通讯录 / 短信 / 通话记录这类**不提供**。
 * 工具表与 instructions 固定不变（提示词缓存）；不在安卓上 / 命令不存在时整组不可用。
 */
import { guard, SCOPE_CONTROL, SCOPE_EXEC } from '../../../../main/process/privacy'
import { clipText } from '../../services/plugins/registry'
import type {
  PluginGroup,
  PluginStatus,
  PluginTool,
  ToolContentResult,
  YayaPlugin
} from '../../services/plugins/types'
import { P } from '../../privacy'
import { hasCommand, parseOutput, run, type RunResult } from './exec'

const isAndroid = (): boolean => process.platform === 'android'

function groupStatus(probe: string, missing: string): () => PluginStatus {
  return () => {
    if (!isAndroid())
      return { state: 'idle', message: 'Only available when Cockpit runs on Android (Termux)' }
    return hasCommand(probe) ? { state: 'ready' } : { state: 'error', message: missing }
  }
}

const GROUPS: PluginGroup[] = [
  {
    id: 'termux-api',
    label: 'Termux:API',
    labelKey: 'yaya.plugin.android.group_termux',
    description: '电量、通知、震动、手电筒、音量、亮度、朗读、剪贴板、定位、拍照',
    descriptionKey: 'yaya.plugin.android.group_termux_desc',
    status: groupStatus(
      'termux-battery-status',
      'termux-api is not installed (pkg install termux-api, plus the Termux:API app)'
    )
  },
  {
    id: 'shizuku',
    label: 'Shizuku',
    labelKey: 'yaya.plugin.android.group_shizuku',
    description: 'adb 级权限：截屏、点按 / 滑动 / 输入、启动应用、Shell（危险，默认关闭）',
    descriptionKey: 'yaya.plugin.android.group_shizuku_desc',
    defaultEnabled: false,
    status: groupStatus('rish', '`rish` not found: export it from the Shizuku app into PATH')
  }
]

function num(v: unknown, min: number, max: number, name: string): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be ${min}-${max}`)
  return Math.round(n)
}

/** 给 `rish -c` 的 sh 命令行加单引号 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** `input text` 不认空格（要写成 %s），其余字符靠单引号保护 */
export function inputTextCommand(text: string): string {
  return `input text ${shQuote(text.replace(/%/g, '\\%').replace(/ /g, '%s'))}`
}

const PKG_RE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/

function termux(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs?: number
): Promise<unknown> {
  return run(cmd, args, { signal, timeoutMs }).then((r) => parseOutput(r.stdout))
}
function rish(command: string, signal: AbortSignal, timeoutMs?: number): Promise<RunResult> {
  return run('rish', ['-c', command], { signal, timeoutMs })
}

const T = 'termux-api'
const S = 'shizuku'

const tools: PluginTool[] = [
  // ---- Termux:API ----
  {
    name: 'battery',
    group: T,
    description: 'Battery level, charging state, temperature and health of the phone.',
    parameters: { type: 'object', properties: {} },
    run: (_a, ctx) => termux('termux-battery-status', [], ctx.signal)
  },
  {
    name: 'notify',
    group: T,
    description: 'Post a notification on the phone.',
    parameters: {
      type: 'object',
      required: ['content'],
      properties: {
        title: { type: 'string' },
        content: { type: 'string' }
      }
    },
    run: (a, ctx) =>
      termux(
        'termux-notification',
        ['--title', String(a.title ?? 'YAYA'), '--content', String(a.content ?? '')],
        ctx.signal
      )
  },
  {
    name: 'toast',
    group: T,
    description: 'Show a short toast message on the phone screen.',
    parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    run: (a, ctx) => termux('termux-toast', [String(a.text ?? '')], ctx.signal)
  },
  {
    name: 'vibrate',
    group: T,
    description: 'Vibrate the phone.',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'number', description: 'Duration in ms (default 400, max 5000)' } }
    },
    run: (a, ctx) =>
      termux(
        'termux-vibrate',
        ['-f', '-d', String(a.ms === undefined ? 400 : num(a.ms, 1, 5000, 'ms'))],
        ctx.signal
      )
  },
  {
    name: 'speak',
    group: T,
    description: 'Speak text aloud with the phone text-to-speech engine.',
    parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    timeoutMs: 120_000,
    run: async (a, ctx) => {
      await run('termux-tts-speak', [], {
        signal: ctx.signal,
        timeoutMs: 120_000,
        input: String(a.text ?? '')
      })
      return { ok: true }
    }
  },
  {
    name: 'torch',
    group: T,
    description: 'Turn the phone flashlight on or off.',
    parameters: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } } },
    run: async (a, ctx) => {
      await guard(SCOPE_CONTROL)
      return termux('termux-torch', [a.on ? 'on' : 'off'], ctx.signal)
    }
  },
  {
    name: 'volume',
    group: T,
    description:
      'Without arguments: list the volume of each audio stream. With stream + volume: set it.',
    parameters: {
      type: 'object',
      properties: {
        stream: {
          type: 'string',
          enum: ['alarm', 'music', 'notification', 'ring', 'system', 'call']
        },
        volume: { type: 'number' }
      }
    },
    run: async (a, ctx) => {
      if (a.stream === undefined) return termux('termux-volume', [], ctx.signal)
      await guard(SCOPE_CONTROL)
      return termux(
        'termux-volume',
        [String(a.stream), String(num(a.volume, 0, 100, 'volume'))],
        ctx.signal
      )
    }
  },
  {
    name: 'brightness',
    group: T,
    description: 'Set screen brightness 0-255, or "auto".',
    parameters: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: ['number', 'string'] } }
    },
    run: async (a, ctx) => {
      await guard(SCOPE_CONTROL)
      const v = a.value === 'auto' ? 'auto' : String(num(a.value, 0, 255, 'value'))
      return termux('termux-brightness', [v], ctx.signal)
    }
  },
  {
    name: 'clipboard_get',
    group: T,
    description: 'Read the phone clipboard.',
    parameters: { type: 'object', properties: {} },
    run: async (_a, ctx) => {
      await guard(P.android_clipboard)
      const r = await run('termux-clipboard-get', [], { signal: ctx.signal })
      return { text: clipText(r.stdout.toString('utf8'), 20_000) }
    }
  },
  {
    name: 'clipboard_set',
    group: T,
    description: 'Replace the phone clipboard content.',
    parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    approval: 'ask',
    run: async (a, ctx) => {
      await guard(SCOPE_CONTROL)
      await run('termux-clipboard-set', [], { signal: ctx.signal, input: String(a.text ?? '') })
      return { ok: true }
    }
  },
  {
    name: 'location',
    group: T,
    description: 'Current GPS / network location of the phone (may take up to a minute).',
    parameters: {
      type: 'object',
      properties: { provider: { type: 'string', enum: ['gps', 'network', 'passive'] } }
    },
    approval: 'ask',
    timeoutMs: 90_000,
    run: async (a, ctx) => {
      await guard(P.android_location)
      const provider = ['gps', 'network', 'passive'].includes(String(a.provider))
        ? String(a.provider)
        : 'network'
      return termux('termux-location', ['-p', provider, '-r', 'once'], ctx.signal, 90_000)
    }
  },
  {
    name: 'camera_photo',
    group: T,
    description: 'Take a photo with the phone camera and return it as an image.',
    parameters: {
      type: 'object',
      properties: { camera: { type: 'number', description: '0 = back (default), 1 = front' } }
    },
    approval: 'ask',
    timeoutMs: 60_000,
    run: async (a, ctx) => {
      await guard(P.android_camera)
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const dir = await mkdtemp(join(tmpdir(), 'yaya-cam-'))
      try {
        const file = join(dir, 'photo.jpg')
        const cam = a.camera === undefined ? 0 : num(a.camera, 0, 9, 'camera')
        await run('termux-camera-photo', ['-c', String(cam), file], {
          signal: ctx.signal,
          timeoutMs: 60_000
        })
        const data = await readFile(file)
        const out: ToolContentResult = {
          content: [{ type: 'image', mimeType: 'image/jpeg', data: data.toString('base64') }]
        }
        return out
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  },
  {
    name: 'open_url',
    group: T,
    description: 'Open a URL on the phone (browser or the app that handles it).',
    parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    approval: 'ask',
    run: async (a, ctx) => {
      const url = String(a.url ?? '')
      if (!/^(https?|mailto|geo|tel):/i.test(url)) throw new Error('unsupported URL scheme')
      if (/^tel:/i.test(url)) throw new Error('phone calls are not available to the assistant')
      await guard(SCOPE_CONTROL)
      return termux('termux-open-url', [url], ctx.signal)
    }
  },

  // ---- Shizuku（rish，adb 级）----
  {
    name: 'screenshot',
    group: S,
    description: 'Take a screenshot of the phone screen.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30_000,
    run: async (_a, ctx) => {
      await guard(P.android_screen)
      const r = await rish('screencap -p', ctx.signal)
      if (r.stdout.subarray(0, 4).toString('hex') !== '89504e47')
        throw new Error(`screencap did not return a PNG: ${r.stderr || r.stdout.toString('utf8', 0, 200)}`)
      const out: ToolContentResult = {
        content: [{ type: 'image', mimeType: 'image/png', data: r.stdout.toString('base64') }]
      }
      return out
    }
  },
  {
    name: 'tap',
    group: S,
    description: 'Tap the phone screen at pixel coordinates (from screenshot).',
    parameters: {
      type: 'object',
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } }
    },
    run: async (a, ctx) => {
      await guard(SCOPE_CONTROL)
      const x = num(a.x, 0, 20000, 'x')
      const y = num(a.y, 0, 20000, 'y')
      await rish(`input tap ${x} ${y}`, ctx.signal)
      return { ok: true }
    }
  },
  {
    name: 'swipe',
    group: S,
    description: 'Swipe on the phone screen from (x1,y1) to (x2,y2).',
    parameters: {
      type: 'object',
      required: ['x1', 'y1', 'x2', 'y2'],
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        ms: { type: 'number', description: 'Duration (default 300)' }
      }
    },
    run: async (a, ctx) => {
      await guard(SCOPE_CONTROL)
      const p = ['x1', 'y1', 'x2', 'y2'].map((k) => num(a[k], 0, 20000, k))
      const ms = a.ms === undefined ? 300 : num(a.ms, 1, 10000, 'ms')
      await rish(`input swipe ${p.join(' ')} ${ms}`, ctx.signal)
      return { ok: true }
    }
  },
  {
    name: 'type_text',
    group: S,
    description: 'Type text into the focused input field on the phone (ASCII works best).',
    parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    run: async (a, ctx) => {
      await guard(SCOPE_CONTROL)
      await rish(inputTextCommand(String(a.text ?? '')), ctx.signal)
      return { ok: true }
    }
  },
  {
    name: 'key',
    group: S,
    description: 'Press a key on the phone.',
    parameters: {
      type: 'object',
      required: ['key'],
      properties: {
        key: {
          type: 'string',
          enum: ['back', 'home', 'recents', 'enter', 'delete', 'power', 'volume_up', 'volume_down']
        }
      }
    },
    run: async (a, ctx) => {
      const codes: Record<string, string> = {
        back: 'KEYCODE_BACK',
        home: 'KEYCODE_HOME',
        recents: 'KEYCODE_APP_SWITCH',
        enter: 'KEYCODE_ENTER',
        delete: 'KEYCODE_DEL',
        power: 'KEYCODE_POWER',
        volume_up: 'KEYCODE_VOLUME_UP',
        volume_down: 'KEYCODE_VOLUME_DOWN'
      }
      const code = codes[String(a.key)]
      if (!code) throw new Error('unknown key')
      await guard(SCOPE_CONTROL)
      await rish(`input keyevent ${code}`, ctx.signal)
      return { ok: true }
    }
  },
  {
    name: 'list_apps',
    group: S,
    description: 'List installed third-party app package names.',
    parameters: { type: 'object', properties: {} },
    run: async (_a, ctx) => {
      const r = await rish('pm list packages -3', ctx.signal)
      const apps = r.stdout
        .toString('utf8')
        .split('\n')
        .map((l) => l.replace(/^package:/, '').trim())
        .filter(Boolean)
        .sort()
      return { apps }
    }
  },
  {
    name: 'launch_app',
    group: S,
    description: 'Launch an app by package name (see list_apps).',
    parameters: {
      type: 'object',
      required: ['package'],
      properties: { package: { type: 'string' } }
    },
    run: async (a, ctx) => {
      const pkg = String(a.package ?? '')
      if (!PKG_RE.test(pkg)) throw new Error('invalid package name')
      await guard(SCOPE_CONTROL)
      await rish(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, ctx.signal)
      return { ok: true }
    }
  },
  {
    name: 'shell',
    group: S,
    description:
      'Run a shell command on the phone with adb (Shizuku) privileges. Dangerous; prefer the specific tools.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' } }
    },
    approval: 'ask',
    timeoutMs: 120_000,
    run: async (a, ctx) => {
      await guard(SCOPE_EXEC)
      const r = await rish(String(a.command ?? ''), ctx.signal, 120_000)
      return {
        stdout: clipText(r.stdout.toString('utf8'), 20_000),
        ...(r.stderr ? { stderr: clipText(r.stderr, 4000) } : {})
      }
    }
  }
]

const INSTRUCTIONS = [
  '## Android phone',
  'Cockpit runs on an Android phone (Termux). The android_* tools act on that phone. To operate apps,',
  'take android_screenshot first and use its pixel coordinates for android_tap / android_swipe; take a',
  'new screenshot after each action to check the result. Sending SMS, calling and reading contacts or',
  'messages are not available.'
].join('\n')

const DOCS = `# 安卓控制（Termux）

宿主跑在手机的 Termux 里时（无头模式），让 YAYA 操作这台手机。两个子分组：

| 分组 | 需要 | 工具 |
| --- | --- | --- |
| Termux:API | \`pkg install termux-api\` + Termux:API App | 电量、通知、Toast、震动、朗读、手电筒、音量、亮度、剪贴板、定位、拍照、打开链接 |
| Shizuku（默认关闭） | Shizuku App 导出的 \`rish\` 放进 PATH | 截屏、点按、滑动、输入文字、按键、列出 / 启动应用、Shell |

- 改变手机状态的操作要「控制系统」授权；定位、拍照、剪贴板、截屏各有自己的隐私授权；Shell 要「执行任意命令」授权，并且每次确认。
- 发短信、打电话、读通讯录 / 短信 / 通话记录**不提供**给 AI。
- Shizuku 等于 adb 权限，只在需要时打开这个分组。
- 自有 App 的原生通道（不经 Termux）还没有做。
`

const plugin: YayaPlugin = {
  id: 'android',
  kind: 'builtin',
  label: '安卓控制',
  labelKey: 'yaya.plugin.android.label',
  description: '宿主在手机 Termux 里时操作这台手机（Termux:API / Shizuku）',
  descriptionKey: 'yaya.plugin.android.desc',
  icon: 'mdi-cellphone-cog',
  namespace: 'android',
  // 桌面上默认关：工具表本来也会因为分组不可用而为空，关掉免得设置页里一片「不可用」
  defaultEnabled: isAndroid(),
  docs: DOCS,
  // 平台在进程内不变，所以这里按平台给 / 不给仍然是稳定的
  instructions: () => (isAndroid() ? INSTRUCTIONS : ''),
  groups: () => GROUPS,
  tools: () => tools
}

export default plugin
