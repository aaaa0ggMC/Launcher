import type { CommandSpec } from '../../../main/process/commands/types'
import {
  loadAidjConfig,
  saveAidjConfig,
  loadEqProfiles,
  saveEqProfiles,
  findEqProfile,
  getEqGainRange,
  BUILTIN_EQ_PROFILES
} from '../service'
import { startJobByName, stopTask } from '../../../main/process/background-tasks'
import { getWebPlayerBackend, PLAYBACK_TAG } from '../player-backend'
import type { WebPlayerReport } from '../player-backend'
import type { EqProfile } from '../types'
import { EQ_BAND_COUNT } from '../types'
import { isWebRemoteRunning, getWebRemotePort, stopWebRemoteServer } from '../web-remote'
import { log, webMode, findWebRemoteTaskId } from './shared'

export const webPlayerCommands: CommandSpec[] = [
  {
    name: 'aidj.web-player-report',
    description: '渲染端内置播放器状态上报（内部）',
    usage: 'aidj.web-player-report --state <json>',
    // web-exclusive: no renderer engine exists in dbus mode
    enabled: webMode,
    run: async (ctx) => {
      // The renderer engine passes the report directly as named args; the CLI
      // form is `--state <json>`.
      let state = (ctx.named.state as string | WebPlayerReport | undefined) ?? ctx.named
      if (typeof state === 'string') {
        try {
          state = JSON.parse(state) as WebPlayerReport
        } catch {
          return { ok: false, error: '--state 不是合法 JSON' }
        }
      }
      if (!state || typeof state !== 'object') {
        return { ok: false, error: '需要 --state 状态对象' }
      }
      getWebPlayerBackend().report(state as WebPlayerReport)
      return { ok: true }
    }
  },
  {
    name: 'aidj.player-volbal',
    description: '查询或设置内置播放器的响度平衡（--enabled <bool> --method <lufs|linear>）',
    usage: 'aidj.player-volbal [--enabled <true|false>] [--method <lufs|linear>]',
    enabled: webMode,
    run: async (ctx) => {
      const backend = getWebPlayerBackend()
      if (ctx.named.enabled === undefined && ctx.named.method === undefined) {
        return { ok: true, ...backend.getVolbalState() }
      }
      const enabled = String(ctx.named.enabled ?? '') !== 'false'
      const method = ctx.named.method as 'lufs' | 'linear' | undefined
      if (method && method !== 'lufs' && method !== 'linear') {
        return { ok: false, error: 'method 必须是 lufs 或 linear' }
      }
      await backend.setVolbal(enabled, method)
      // Persist the shared preference (same fields the continuous task uses).
      try {
        const config = await loadAidjConfig()
        if (config) {
          config.preferences.dynamic_balance_volume = enabled
          if (method) config.preferences.sound_adjust_method = method
          await saveAidjConfig(config)
        }
      } catch (e) {
        log.warn('persist player volbal failed', { error: String(e) })
      }
      return { ok: true, ...backend.getVolbalState() }
    }
  },
  {
    name: 'aidj.player-rebase',
    description: '将当前音量设为内置播放器响度平衡的新基准',
    usage: 'aidj.player-rebase --base <0-1>',
    enabled: webMode,
    run: async (ctx) => {
      const base = Number(ctx.named.base)
      if (isNaN(base) || base < 0 || base > 1) return { ok: false, error: '需要 --base (0-1)' }
      const ok = await getWebPlayerBackend().rebase(base)
      return ok ? { ok: true, base } : { ok: false, error: 'rebase 失败' }
    }
  },
  {
    name: 'aidj.player-clear-queue',
    description: '清空内置播放器的播放队列（停止播放并移除全部曲目）',
    usage: 'aidj.player-clear-queue',
    enabled: webMode,
    run: async () => {
      await getWebPlayerBackend().clearQueue()
      return { ok: true }
    }
  },
  {
    name: 'aidj.player-crossfade',
    description: '查询或设置内置播放器的曲间淡入淡出（--enabled <bool> [--seconds <n>]）',
    usage: 'aidj.player-crossfade [--enabled <true|false>] [--seconds <n>]',
    enabled: webMode,
    run: async (ctx) => {
      const backend = getWebPlayerBackend()
      const enabled =
        ctx.named.enabled !== undefined ? String(ctx.named.enabled) !== 'false' : undefined
      const seconds = ctx.named.seconds !== undefined ? Number(ctx.named.seconds) : undefined
      if (enabled === undefined && seconds === undefined) {
        const s = await backend.getPlaybackDetail()
        return { ok: true, enabled: s.crossfade === true, seconds: s.crossfadeSeconds ?? 2.5 }
      }
      const next = enabled ?? (await backend.getPlaybackDetail()).crossfade === true
      const sec = seconds ?? (await backend.getPlaybackDetail()).crossfadeSeconds ?? 2.5
      await backend.setCrossfade(next, sec)
      // Persist the shared preference.
      try {
        const config = await loadAidjConfig()
        if (config) {
          config.preferences.crossfade = { enabled: next, seconds: sec }
          await saveAidjConfig(config)
        }
      } catch (e) {
        log.warn('persist player crossfade failed', { error: String(e) })
      }
      return { ok: true, enabled: next, seconds: sec }
    }
  },
  {
    name: 'aidj.eq-list',
    description: '列出所有 EQ 配置（内置 + 用户自定义）与当前激活项',
    usage: 'aidj.eq-list',
    enabled: webMode,
    run: async () => {
      const profiles = await loadEqProfiles()
      const config = await loadAidjConfig()
      const activeId = config?.preferences.eq_preset ?? 'flat'
      const range = await getEqGainRange()
      return { ok: true, profiles, activeId, range }
    }
  },
  {
    name: 'aidj.eq-range',
    description: '查询或设置 EQ 最大增益范围（±dB，默认 20，范围 12–60）',
    usage: 'aidj.eq-range [--set <12-60>]',
    enabled: webMode,
    run: async (ctx) => {
      const config = await loadAidjConfig()
      if (ctx.named.set === undefined) {
        return { ok: true, range: await getEqGainRange() }
      }
      const n = Number(ctx.named.set)
      if (isNaN(n) || n < 12 || n > 60) {
        return { ok: false, error: '范围必须在 12–60 dB 之间' }
      }
      const range = Math.round(n)
      if (config) {
        config.preferences.eq_gain_range = range
        await saveAidjConfig(config)
      }
      return { ok: true, range }
    }
  },
  {
    name: 'aidj.eq-reset',
    description: '重置内置 EQ 预设为出厂默认（用户自定义配置保留）',
    usage: 'aidj.eq-reset',
    enabled: webMode,
    run: async () => {
      const profiles = await loadEqProfiles()
      // Restore builtin profiles' gains + names to factory defaults; keep any
      // user-defined profiles untouched.
      const next = profiles.map((p) => {
        const builtin = BUILTIN_EQ_PROFILES.find((b) => b.id === p.id)
        return builtin ? { ...builtin, gains: [...builtin.gains] } : p
      })
      await saveEqProfiles(next)
      return { ok: true }
    }
  },
  {
    name: 'aidj.eq-save',
    description: '新增或更新一个 EQ 配置（--name <名> --gains <JSON 数组> [--id <id>]）',
    usage: 'aidj.eq-save --name <name> --gains "[..10 个 dB..]" [--id <id>]',
    enabled: webMode,
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '').trim()
      if (!name) return { ok: false, error: '需要 --name' }
      // UI 直接传数组、CLI 传 JSON 字符串——两种形态都兼容
      const gainsArg = ctx.named.gains
      const raw = typeof gainsArg === 'string' ? gainsArg : JSON.stringify(gainsArg ?? [])
      let gains: number[]
      const range = await getEqGainRange()
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('not array')
        gains = parsed
          .slice(0, EQ_BAND_COUNT)
          .map((g) => Math.max(-range, Math.min(range, Number(g) || 0)))
        while (gains.length < EQ_BAND_COUNT) gains.push(0)
      } catch {
        return { ok: false, error: `--gains 需要 ${EQ_BAND_COUNT} 个 dB 的 JSON 数组` }
      }
      const profiles = await loadEqProfiles()
      let id = String(ctx.named.id ?? '')
      const existing = id ? profiles.find((p) => p.id === id) : null
      if (id && !existing) return { ok: false, error: 'id 不存在' }
      if (!id) {
        id = `eq-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      }
      const updated: EqProfile = {
        id,
        name,
        gains,
        builtin: existing?.builtin === true
      }
      const idx = profiles.findIndex((p) => p.id === id)
      if (idx >= 0) profiles[idx] = updated
      else profiles.push(updated)
      await saveEqProfiles(profiles)
      return { ok: true, profile: updated }
    }
  },
  {
    name: 'aidj.eq-delete',
    description: '删除一个用户 EQ 配置（内置不可删）',
    usage: 'aidj.eq-delete --id <id>',
    enabled: webMode,
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const profiles = await loadEqProfiles()
      const target = profiles.find((p) => p.id === id)
      if (!target) return { ok: false, error: 'id 不存在' }
      if (target.builtin) return { ok: false, error: '内置 EQ 不可删除' }
      const next = profiles.filter((p) => p.id !== id)
      await saveEqProfiles(next)
      // If the deleted profile was active, fall back to flat.
      const config = await loadAidjConfig()
      if (config?.preferences.eq_preset === id) {
        config.preferences.eq_preset = 'flat'
        await saveAidjConfig(config)
        const backend = getWebPlayerBackend()
        const flat = await findEqProfile('flat')
        backend.setEqPreset('flat')
        await backend.setEQ(flat?.gains ?? Array(EQ_BAND_COUNT).fill(0))
      }
      return { ok: true }
    }
  },
  {
    name: 'aidj.eq-active',
    description: '应用某个 EQ 配置（--id <id>）',
    usage: 'aidj.eq-active --id <id>',
    enabled: webMode,
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const profile = await findEqProfile(id)
      if (!profile) return { ok: false, error: 'id 不存在' }
      const backend = getWebPlayerBackend()
      backend.setEqPreset(id)
      await backend.setEQ(profile.gains)
      try {
        const config = await loadAidjConfig()
        if (config) {
          config.preferences.eq_preset = id
          await saveAidjConfig(config)
        }
      } catch (e) {
        log.warn('persist active eq failed', { error: String(e) })
      }
      return { ok: true, id, gains: profile.gains }
    }
  },
  {
    name: 'aidj.player-eq',
    description: '查询或实时预览 EQ 曲线（--gains <JSON 数组>，不落盘）',
    usage: 'aidj.player-eq [--gains "[..10 个 dB..]"]',
    enabled: webMode,
    run: async (ctx) => {
      const backend = getWebPlayerBackend()
      if (ctx.named.gains === undefined) {
        const s = await backend.getPlaybackDetail()
        return { ok: true, id: s.eqPreset ?? 'flat', gains: s.eqGains }
      }
      let gains: number[]
      const range = await getEqGainRange()
      try {
        // UI 传数组、CLI 传 JSON 字符串——两种形态都兼容
        const gainsArg = ctx.named.gains
        const parsed = JSON.parse(
          typeof gainsArg === 'string' ? gainsArg : JSON.stringify(gainsArg)
        )
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('not array')
        gains = parsed
          .slice(0, EQ_BAND_COUNT)
          .map((g) => Math.max(-range, Math.min(range, Number(g) || 0)))
        while (gains.length < EQ_BAND_COUNT) gains.push(0)
      } catch {
        return { ok: false, error: `--gains 需要 ${EQ_BAND_COUNT} 个 dB 的 JSON 数组` }
      }
      await backend.setEQ(gains)
      return { ok: true, gains }
    }
  },
  {
    name: 'aidj.player-rate',
    description: '查询或设置内置播放器的播放倍速（任意正数；>16 为静音快进）',
    usage: 'aidj.player-rate [--set <rate>]',
    enabled: webMode,
    run: async (ctx) => {
      const backend = getWebPlayerBackend()
      const rate = ctx.named.set !== undefined ? Number(ctx.named.set) : undefined
      if (rate === undefined || isNaN(rate)) {
        const s = await backend.getPlaybackDetail()
        return { ok: true, rate: s.playbackRate ?? 1.0 }
      }
      if (rate <= 0) return { ok: false, error: '倍速必须是正数' }
      await backend.setRate(rate)
      // Persist the shared preference (survives restarts, mirrors the settings page).
      try {
        const config = await loadAidjConfig()
        if (config) {
          config.preferences.playback_rate = rate
          await saveAidjConfig(config)
        }
      } catch (e) {
        log.warn('persist player rate failed', { error: String(e) })
      }
      return { ok: true, rate }
    }
  },
  {
    name: 'aidj.player-abloop',
    description: '设置内置播放器的 AB 循环点（秒；--off 清除）',
    usage: 'aidj.player-abloop [--a <sec>] [--b <sec>] [--off true]',
    enabled: webMode,
    run: async (ctx) => {
      const backend = getWebPlayerBackend()
      if (String(ctx.named.off ?? '') === 'true') {
        await backend.setAbloop(null, null)
        return { ok: true, loopA: null, loopB: null }
      }
      const a = ctx.named.a === undefined || ctx.named.a === null ? null : Number(ctx.named.a)
      const b = ctx.named.b === undefined || ctx.named.b === null ? null : Number(ctx.named.b)
      if ((a != null && isNaN(a)) || (b != null && isNaN(b))) {
        return { ok: false, error: '--a/--b 需要秒数' }
      }
      await backend.setAbloop(a, b)
      return { ok: true, loopA: a, loopB: b }
    }
  },
  {
    name: 'aidj.player-sleep',
    description: '设置内置播放器的睡眠定时（分钟；0 = 取消）',
    usage: 'aidj.player-sleep --minutes <n>',
    enabled: webMode,
    run: async (ctx) => {
      const minutes = Number(ctx.named.minutes)
      if (isNaN(minutes) || minutes < 0) return { ok: false, error: '需要 --minutes 非负分钟数' }
      await getWebPlayerBackend().setSleep(minutes)
      return { ok: true, minutes }
    }
  },
  {
    name: 'aidj.web-remote-status',
    description: '查询内置播放器局域网遥控服务器的运行状态',
    usage: 'aidj.web-remote-status',
    enabled: webMode,
    run: async () => {
      const config = await loadAidjConfig()
      return {
        ok: true,
        running: isWebRemoteRunning(),
        port: isWebRemoteRunning() ? getWebRemotePort() : (config?.preferences.web_remote_port ?? 0)
      }
    }
  },
  {
    name: 'aidj.web-remote-start',
    description: '启动内置播放器的局域网遥控服务器（后台任务）',
    usage: 'aidj.web-remote-start',
    enabled: webMode,
    run: async () => {
      if (isWebRemoteRunning()) {
        return { ok: true, alreadyRunning: true, port: getWebRemotePort() }
      }
      const task = await startJobByName('aidj.web-remote', {
        name: 'AIDJ 局域网遥控',
        description: '内置播放器的局域网 Web 遥控服务器',
        view: 'log',
        tags: [PLAYBACK_TAG]
      })
      if (!task) return { ok: false, error: '无法启动遥控服务器' }
      return { ok: true, taskId: task.id }
    }
  },
  {
    name: 'aidj.web-remote-stop',
    description: '停止内置播放器的局域网遥控服务器',
    usage: 'aidj.web-remote-stop',
    enabled: webMode,
    run: async () => {
      if (!isWebRemoteRunning()) return { ok: true, running: false }
      const stopped = await stopTask(findWebRemoteTaskId())
      await stopWebRemoteServer()
      return { ok: true, stopped }
    }
  }
]
