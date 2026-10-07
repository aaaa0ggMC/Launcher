/**
 * speech 插件的命令：
 * - `yaya.speech-speak`：接口朗读。在后台任务里逐段合成（切页面不中断、面板里可停止），
 *   每段写成临时音频文件后推送 `{ type: 'chunk', index, total, url }`，渲染端播放器按顺序播放；
 * - `yaya.speech-transcribe`：一段录音（base64）→ 文字。
 * 两条都会用用户的密钥、消耗额度（转写还涉及麦克风录音），只许用户本人调用。
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandSpec } from '../../../../main/process/commands/types'
import { startJobTask } from '../../../../main/process/background-tasks'
import { makeLogger } from '../../../../main/process/logger'
import { t, te } from '../../../../main/process/i18n'
import { getYayaConfigPath, loadYayaConfig } from '../../services/config'
import { getPlugin, pluginConfigValues } from '../../services/plugins/registry'
import { SPEECH_PLUGIN_ID } from './index'
import {
  AUDIO_EXT,
  asrMissing,
  asrSettings,
  synthesize,
  transcribe,
  ttsMissing,
  ttsSettings
} from './service'
import { splitSpeech } from './text'

const log = makeLogger('yaya-speech')

/** 录音上限（base64 解码后）：OpenAI 转写接口单文件 25MB */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
/** 朗读文本上限：再长就截断（一条回答念几十分钟没有意义） */
const MAX_TEXT_CHARS = 20_000
/** 临时音频保留时长 */
const CACHE_TTL_MS = 6 * 3600_000

function speechValues(): Record<string, unknown> {
  const plugin = getPlugin(SPEECH_PLUGIN_ID)
  if (!plugin) throw new Error(t('yaya.plugin.cmd_err_unknown_plugin', '插件不存在：speech'))
  return pluginConfigValues(plugin, loadYayaConfig())
}

function cacheDir(): string {
  const dir = join(dirname(getYayaConfigPath()), 'speech-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 清掉几小时前的临时音频（每次朗读前顺手做） */
function sweepCache(dir: string): void {
  const now = Date.now()
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (now - statSync(p).mtimeMs > CACHE_TTL_MS) rmSync(p, { force: true })
      } catch {
        /* 单个文件失败不影响 */
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
}

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

const commands: CommandSpec[] = [
  {
    name: 'yaya.speech-speak',
    description:
      '用语音插件的接口引擎（OpenAI 兼容 /audio/speech）朗读一段文字：在后台任务里逐段合成，返回任务 id；' +
      '每段合成好推送 { type: "chunk", index, total, url }，结束推送 { type: "done" }，失败推送 { type: "error" }。' +
      '「系统语音」引擎在界面里直接朗读，不经过这条命令',
    usage: 'yaya.speech-speak --text <文字>',
    ui: ['YAYA → 回答下面的朗读按钮'],
    related: ['background.stop', 'yaya.speech-transcribe'],
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const text = String(ctx.named.text ?? '')
        .trim()
        .slice(0, MAX_TEXT_CHARS)
      if (!text) throw new Error(t('yaya.speech.err_no_text', '没有可以朗读的文字'))
      const values = speechValues()
      const s = ttsSettings(values)
      const missing = ttsMissing(s)
      if (missing.length)
        throw new Error(
          te(
            'yaya.speech.err_tts_config',
            { fields: missing.join('、') },
            '朗读接口还没配置好（{fields}）：设置 → YAYA → 插件 → 语音'
          )
        )
      const max = Math.max(80, Math.min(4000, Number(values.tts_chunk) || 400))
      const chunks = splitSpeech(text, max, Math.min(160, max))
      if (!chunks.length) throw new Error(t('yaya.speech.err_no_text', '没有可以朗读的文字'))

      const dir = cacheDir()
      sweepCache(dir)
      const ac = new AbortController()
      const control = startJobTask({
        name: t('yaya.speech.task_name', '朗读'),
        description: text.length > 60 ? `${text.slice(0, 60)}…` : text,
        onCancel: () => ac.abort()
      })

      void (async () => {
        try {
          for (let i = 0; i < chunks.length; i++) {
            if (ac.signal.aborted) {
              control.finish('cancelled')
              return
            }
            control.pushLine(`[${i + 1}/${chunks.length}] ${chunks[i].slice(0, 40)}`)
            const audio = await synthesize(s, chunks[i], ac.signal)
            const path = join(dir, `${control.id}-${i}.${AUDIO_EXT[s.format] ?? 'mp3'}`)
            writeFileSync(path, audio)
            control.push({
              data: {
                type: 'chunk',
                index: i,
                total: chunks.length,
                text: chunks[i],
                url: `cockpit-audio://${encodeURIComponent(path)}`
              }
            })
            control.setProgress(Math.round(((i + 1) / chunks.length) * 100))
          }
          control.push({ data: { type: 'done', total: chunks.length } })
          control.finish('exited')
        } catch (e) {
          if (ac.signal.aborted) {
            control.finish('cancelled')
            return
          }
          const message = errText(e)
          log.warn('tts failed', { error: message })
          control.pushLine(message, 'stderr')
          control.push({ data: { type: 'error', message } })
          control.finish('error')
        }
      })()

      return { taskId: control.id, total: chunks.length }
    }
  },
  {
    name: 'yaya.speech-transcribe',
    description:
      '语音输入：把一段录音（base64）交给语音插件配置的转写接口（OpenAI 兼容 /audio/transcriptions），返回 { text }',
    usage: 'yaya.speech-transcribe --audio <base64> --mime audio/webm',
    ui: ['YAYA → 输入框「+」→ 语音输入'],
    related: ['yaya.speech-speak'],
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const b64 = String(ctx.named.audio ?? '')
      const mime = String(ctx.named.mime ?? 'audio/webm')
      const audio = Buffer.from(b64, 'base64')
      if (!audio.length) throw new Error(t('yaya.speech.err_no_audio', '没有录到声音'))
      if (audio.length > MAX_AUDIO_BYTES)
        throw new Error(t('yaya.speech.err_audio_too_big', '录音太长了（超过 24MB）'))
      const s = asrSettings(speechValues())
      const missing = asrMissing(s)
      if (missing.length)
        throw new Error(
          te(
            'yaya.speech.err_asr_config',
            { fields: missing.join('、') },
            '语音输入接口还没配置好（{fields}）：设置 → YAYA → 插件 → 语音'
          )
        )
      const text = await transcribe(s, audio, mime, AbortSignal.timeout(120_000))
      return { text }
    }
  }
]

export default commands
