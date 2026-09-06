import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { CommandSpec } from '../../../main/process/commands/types'
import { listTasks, startJobByName } from '../../../main/process/background-tasks'
import { parseFilterCommand, evaluateFilter, FilterParseError } from '../parser/filterGrammar'
import { cachedVariantHaystack, setVariantCacheCapacity } from '../parser/chineseVariants'
import {
  loadAidjConfig,
  loadLibrary,
  scanMusicFiles,
  findMissingSongs,
  syncMetadata,
  loadFrequency,
  invalidateLibrary,
  getPlaylistsDir,
  getDbusManager,
  setDbusManager,
  type DBusManager,
  SessionManager
} from '../service'
import { resetPlayerMode, reconcilePlayerAbilityVisibility } from '../player-backend'
import type { RawHistoryMessage } from '../types'
import {
  state,
  ensureInit,
  ensureLibraryLoaded,
  sampleNames,
  pushPlaylistToSession,
  log,
  MAX_VARIANT_CACHE_BYTES,
  AVG_VARIANT_ENTRY_BYTES
} from './shared'

export const curateCommands: CommandSpec[] = [
  {
    name: 'aidj.generate',
    description: 'AI 生成歌单',
    usage: 'aidj.generate --prompt <text>',
    run: async (ctx) => {
      const prompt = (ctx.named.prompt as string) || ctx.positional.join(' ')
      const { session, config } = await ensureInit()
      state.currentAbort = new AbortController()
      state.streamingChars = 0
      state.retrying = false
      state.retryAttempt = 0
      state.retryWaitMs = 0
      state.retryStart = 0
      state.retryLastError = ''
      try {
        const { playlist, intro, raw, updated } = await session.nextStep(
          prompt,
          (full: string) => {
            if (state.retrying) {
              state.retrying = false
              state.retryLastError = ''
            }
            state.streamingChars = full.length
          },
          state.currentAbort.signal,
          (attempt, waitMs, err) => {
            state.retrying = true
            state.retryAttempt = attempt
            state.retryWaitMs = waitMs
            state.retryStart = state.retryStart || Date.now()
            state.retryLastError = err ? String(err instanceof Error ? err.message : err) : ''
            state.streamingChars = 0
          }
        )
        if (!state.currentAbort?.signal.aborted) {
          let wasNewSession = false
          if (!state.sessionId) {
            state.sessionId = await SessionManager.createSession({
              title: prompt.slice(0, 40),
              type: 'generate'
            })
            wasNewSession = true
          }
          const rawMsgs: RawHistoryMessage[] = []
          if (updated) rawMsgs.push(updated)
          rawMsgs.push(
            { role: 'user', content: prompt, ts: Date.now(), type: 'user' },
            {
              role: 'assistant',
              content: raw || intro || '',
              ts: Date.now(),
              type: 'both',
              playlist
            }
          )
          await SessionManager.appendMessages(state.sessionId, rawMsgs)
          // Auto title: after the first AI output of a new session, fire the
          // background title job (if enabled). Otherwise the raw prompt slice stays.
          const produced = playlist.length > 0 || (intro && intro.trim() !== '')
          if (wasNewSession && produced && config.preferences.auto_title) {
            await startJobByName('aidj.title', {
              sessionId: state.sessionId,
              name: 'AIDJ 标题生成',
              description: '自动生成会话标题'
            })
            log.info('Auto title job started', { sessionId: state.sessionId })
          }
        }
        const enriched = playlist.map((s) => ({
          ...s,
          meta: session.metadata.get(s.name) || null
        }))
        log.info('Generate done', {
          sessionId: state.sessionId || '',
          ok: !intro.startsWith('⚠️'),
          playlistCount: playlist.length,
          introLen: intro.length,
          tokens: { prompt: session.promptTokens, completion: session.completionTokens }
        })
        if (intro.startsWith('⚠️')) {
          return { ok: false, error: intro.replace(/^⚠️\s*/, '') }
        }
        return {
          ok: true,
          intro,
          playlist: enriched,
          tokens: { prompt: session.promptTokens, completion: session.completionTokens },
          context: { prompt: session.lastPromptTokens, completion: session.lastCompletionTokens }
        }
      } finally {
        state.currentAbort = null
        state.streamingChars = 0
        state.retrying = false
        state.retryAttempt = 0
        state.retryWaitMs = 0
        state.retryStart = 0
        state.retryLastError = ''
      }
    }
  },
  {
    name: 'aidj.curate',
    description: '从随机候选中 AI 精选成连贯歌单（计入上下文）',
    usage: 'aidj.curate --count <number>',
    run: async (ctx) => {
      const count = Number(ctx.named.count)
      if (!Number.isFinite(count) || count <= 0) return { ok: false, error: '需要 --count 正整数' }
      const { session } = await ensureInit()
      const keys = [...session.musicPaths.keys()]
      if (!keys.length) return { ok: false, error: '曲库为空' }
      const n = Math.min(count, keys.length, 50)
      let pool = keys.filter((k) => !session.playedSongs.has(k))
      if (pool.length < n) pool = keys
      const candidates = sampleNames(pool, n)

      state.currentAbort = new AbortController()
      state.streamingChars = 0
      state.retrying = false
      state.retryAttempt = 0
      state.retryWaitMs = 0
      state.retryStart = 0
      state.retryLastError = ''
      try {
        const prompt =
          `System Request: I have randomly picked ${candidates.length} candidate songs from the library: ${JSON.stringify(candidates)}.\n` +
          'Task: Curate a coherent playlist from THIS SPECIFIC LIST.\n' +
          `Rules: 1. Sort for flow. 2. Filter clashes. 3. Keep at least ${Math.max(1, Math.floor(candidates.length / 2))} songs. 4. No hallucinations. 5. Write the Intro BEFORE the separator, keys AFTER.`
        const { playlist, intro, raw, updated } = await session.nextStep(
          prompt,
          (full: string) => {
            if (state.retrying) {
              state.retrying = false
              state.retryLastError = ''
            }
            state.streamingChars = full.length
          },
          state.currentAbort.signal,
          (attempt, waitMs, err) => {
            state.retrying = true
            state.retryAttempt = attempt
            state.retryWaitMs = waitMs
            state.retryStart = state.retryStart || Date.now()
            state.retryLastError = err ? String(err instanceof Error ? err.message : err) : ''
            state.streamingChars = 0
          }
        )
        if (!state.currentAbort?.signal.aborted) {
          if (!state.sessionId) {
            state.sessionId = await SessionManager.createSession({
              title: `/pr ${candidates.length}`,
              type: 'generate'
            })
          }
          const rawMsgs: RawHistoryMessage[] = []
          if (updated) rawMsgs.push(updated)
          rawMsgs.push(
            { role: 'user', content: `/pr ${candidates.length}`, ts: Date.now(), type: 'user' },
            {
              role: 'assistant',
              content: raw || intro || '',
              ts: Date.now(),
              type: 'both',
              playlist
            }
          )
          await SessionManager.appendMessages(state.sessionId, rawMsgs)
        }
        const enriched = playlist.map((s) => ({
          ...s,
          meta: session.metadata.get(s.name) || null
        }))
        if (intro.startsWith('⚠️')) {
          return { ok: false, error: intro.replace(/^⚠️\s*/, '') }
        }
        return { ok: true, intro, playlist: enriched }
      } finally {
        state.currentAbort = null
        state.streamingChars = 0
        state.retrying = false
        state.retryAttempt = 0
        state.retryWaitMs = 0
        state.retryStart = 0
        state.retryLastError = ''
      }
    }
  },
  {
    name: 'aidj.random',
    description: '随机选取 N 首歌曲，作为 AIDJ 推送计入会话上下文',
    usage: 'aidj.random --count <number>',
    run: async (ctx) => {
      const count = Number(ctx.named.count)
      if (!Number.isFinite(count) || count <= 0) return { ok: false, error: '需要 --count 正整数' }
      const { session } = await ensureInit()
      const keys = [...session.musicPaths.keys()]
      if (!keys.length) return { ok: false, error: '曲库为空' }
      const n = Math.min(count, keys.length, 50)

      // Avoid the played-memory (songs the DJ already pushed) when possible;
      // fall back to the whole library if there aren't enough fresh songs.
      let pool = keys.filter((k) => !session.playedSongs.has(k))
      if (pool.length < n) pool = keys

      const picked = sampleNames(pool, n)
      const playlist = picked.map((name) => ({
        name,
        path: session.musicPaths.get(name) || '',
        meta: session.metadata.get(name) || null
      }))
      const intro = `已经找到 ${playlist.length} 首随机歌曲。`
      await pushPlaylistToSession(session, `/random ${playlist.length}`, intro, playlist)
      log.info('Random selection pushed', { sessionId: state.sessionId, count: playlist.length })
      return { ok: true, intro, playlist }
    }
  },
  {
    name: 'aidj.explore',
    description: '发现未听过/最少播放的歌曲，作为 AIDJ 推送计入会话上下文',
    usage: 'aidj.explore --count <number>',
    run: async (ctx) => {
      const count = Number(ctx.named.count)
      if (!Number.isFinite(count) || count <= 0) return { ok: false, error: '需要 --count 正整数' }
      const { session } = await ensureInit()
      const freq = await loadFrequency()
      const allNames = [...session.musicPaths.keys()]
      if (!allNames.length) return { ok: false, error: '曲库为空' }
      const n = Math.min(count, allNames.length, 50)

      const heard = new Set(freq.keys())
      let pool = allNames.filter((k) => !heard.has(k) && !session.playedSongs.has(k))
      let label: string
      if (pool.length < n) {
        // All songs have been played (or memory-exhausted) — least-played first.
        pool = allNames
          .filter((k) => !session.playedSongs.has(k))
          .sort((a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0))
        if (pool.length < n) pool = allNames
        const picked = pool.slice(0, n)
        const least = freq.get(picked[0]) ?? 0
        label = `播放最少的 ${picked.length} 首歌曲 (≥${least}x)`
        const playlist = picked.map((name) => ({
          name,
          path: session.musicPaths.get(name) || '',
          meta: session.metadata.get(name) || null
        }))
        await pushPlaylistToSession(session, `/explore ${playlist.length}`, label, playlist)
        log.info('Explore (least-played) pushed', {
          sessionId: state.sessionId,
          count: picked.length
        })
        return { ok: true, intro: label, playlist }
      }

      const picked = sampleNames(pool, n)
      label = `发现 ${picked.length} 首尚未听过的歌曲。`
      const playlist = picked.map((name) => ({
        name,
        path: session.musicPaths.get(name) || '',
        meta: session.metadata.get(name) || null
      }))
      await pushPlaylistToSession(session, `/explore ${playlist.length}`, label, playlist)
      log.info('Explore (unheard) pushed', { sessionId: state.sessionId, count: picked.length })
      return { ok: true, intro: label, playlist }
    }
  },
  {
    name: 'aidj.filter',
    description:
      '按表达式过滤曲库（--query 完整表达式，compare=title/lyrics/all，支持 [字段:值] 元数据筛选）',
    usage:
      'aidj.filter --query --compare=title ("The Weeknd" and "Justin Bieber") or ("Taylor") [emotion:孤独]',
    run: async (ctx) => {
      const query = String(ctx.named.query ?? '')
      if (!query) return { ok: false, error: '需要 --query 过滤表达式' }
      try {
        const fq = parseFilterCommand(query)
        const lib = await loadLibrary()
        // Size the variant cache to the library (title + lyrics = 2 entries per
        // song). If the whole library fits the memory budget the cache survives
        // the run and every later filter is instant; if it can't fit, caching is
        // disabled (capacity 0) so we never build+clear-thrash — a cache that
        // gets wiped mid-run would waste the conversion CPU and hold memory
        // without ever being reused.
        const songCount = lib.musicPaths.size
        const needed = songCount * 2 + 100
        setVariantCacheCapacity(
          needed * AVG_VARIANT_ENTRY_BYTES <= MAX_VARIANT_CACHE_BYTES ? needed : 0
        )
        const results: { name: string; path: string }[] = []
        for (const [name, path] of lib.musicPaths) {
          // ignorecase ON (default): variant-agnostic, lowercased, cached —
          // 「周杰伦」matches 「周杰倫」, "The Weeknd" matches "the weeknd".
          // OFF: raw exact substring match, no normalization, no cache.
          let haystack: string
          if (fq.ignoreCase) {
            const title = cachedVariantHaystack(`t:${name}`, name)
            if (fq.compare === 'title') {
              haystack = title
            } else {
              const lrc = cachedVariantHaystack(`l:${name}`, lib.lyrics.get(name) ?? '')
              haystack = fq.compare === 'all' ? `${title}\n${lrc}` : lrc
            }
          } else {
            const lrc = lib.lyrics.get(name) ?? ''
            haystack =
              fq.compare === 'title' ? name : fq.compare === 'all' ? `${name}\n${lrc}` : lrc
          }
          if (
            evaluateFilter(
              fq.expr,
              {
                haystack,
                meta: (lib.metadata.get(name) ?? {}) as Record<string, unknown>
              },
              fq.ignoreCase
            )
          ) {
            results.push({ name, path })
            if (fq.count > 0 && results.length >= fq.count) break
          }
        }
        return { ok: true, results, total: results.length, compare: fq.compare }
      } catch (e) {
        if (e instanceof FilterParseError) return { ok: false, error: `语法错误: ${e.message}` }
        log.warn('aidj.filter failed', { error: String(e) })
        return { ok: false, error: String(e) }
      }
    }
  },
  {
    name: 'aidj.ftop',
    description: '推送播放次数 Top N / 倒数 N / 区间 A-B 歌曲',
    usage: 'aidj.ftop [--count N] [--bottom true] [--from A] [--to B]',
    run: async (ctx) => {
      const { session } = await ensureInit()
      const freq = await loadFrequency()
      const ranked = [...freq.entries()]
        .filter(([name]) => session.musicPaths.has(name))
        .sort((a, b) => b[1] - a[1])
        .map(([name, times]) => ({ name, times, path: session.musicPaths.get(name) || '' }))
      if (!ranked.length) return { ok: false, error: '没有可用的播放频率数据' }

      let selected: typeof ranked
      let label: string
      const from = Number(ctx.named.from)
      const to = Number(ctx.named.to)
      if (Number.isFinite(from) && Number.isFinite(to)) {
        const a = Math.max(1, Math.min(from, to))
        const b = Math.max(1, Math.max(from, to))
        selected = ranked.slice(a - 1, b)
        label = `播放频率第 ${a}–${b} 名：`
      } else {
        const count = Math.max(1, Number(ctx.named.count) || 20)
        const c = Math.min(count, ranked.length)
        if (String(ctx.named.bottom) === 'true') {
          selected = ranked.slice(ranked.length - c)
          label = `播放次数最少的 ${c} 首歌曲：`
        } else {
          selected = ranked.slice(0, c)
          label = `播放次数最多的 ${c} 首歌曲：`
        }
      }
      if (!selected.length) return { ok: false, error: '没有可用的播放频率数据' }

      const playlist = selected.map((s) => ({
        name: s.name,
        path: s.path,
        meta: session.metadata.get(s.name) || null
      }))
      await pushPlaylistToSession(
        session,
        (ctx.named.text as string) || `/ftop ${selected.length}`,
        label,
        playlist
      )
      log.info('Ftop pushed', { sessionId: state.sessionId, count: selected.length, label })
      return { ok: true, intro: label, playlist }
    }
  },
  {
    name: 'aidj.playlist',
    description: '管理播放队列',
    usage: 'aidj.playlist --action <list|clear|remove|shuffle> [--index <n>]',
    run: async () => {
      return { ok: true, note: '队列管理通过 UI 操作' }
    }
  },
  {
    name: 'aidj.save',
    description: '保存歌单到文件',
    usage: 'aidj.save --name <name> --songs <json>',
    run: async (ctx) => {
      const name = ctx.named.name as string
      const songs = ctx.named.songs as string
      if (!name || !songs) return { ok: false, error: '需要 --name 和 --songs 参数' }
      const dir = getPlaylistsDir()
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${name}.txt`), songs, 'utf-8')
      return { ok: true, path: join(dir, `${name}.txt`) }
    }
  },
  {
    name: 'aidj.load',
    description: '从文件加载歌单',
    usage: 'aidj.load --name <name>',
    run: async (ctx) => {
      const name = ctx.named.name as string
      if (!name) return { ok: false, error: '需要 --name 参数' }
      const dir = getPlaylistsDir()
      const content = await readFile(join(dir, `${name}.txt`), 'utf-8').catch(() => null)
      if (!content) return { ok: false, error: `歌单 ${name} 未找到` }
      return { ok: true, songs: content.split('\n').filter(Boolean) }
    }
  },
  {
    name: 'aidj.search',
    description: '搜索曲库',
    usage: 'aidj.search --q <query>',
    run: async (ctx) => {
      const query = (ctx.named.q as string) || ctx.positional.join(' ')
      if (!query) return { ok: false, error: '需要搜索关键词' }
      const { session } = await ensureInit()
      const keys = [...session.metadata.keys()].filter((k) => session.musicPaths.has(k))
      const results = keys
        .map((name) => ({ name, score: session['tokenSortRatio'](query, name) }))
        .filter((r) => r.score >= 80)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
      return { ok: true, results }
    }
  },
  {
    name: 'aidj.model',
    description: '切换 AI 模型',
    usage: 'aidj.model --set <model>',
    run: async (ctx) => {
      const model = ctx.named.set as string
      if (!model) return { ok: false, error: '需要 --set 参数指定模型名称' }
      if (!state.config) state.config = await loadAidjConfig()
      const config = state.config
      if (!config) return { ok: false, error: '配置未加载' }
      config.preferences.model = model
      return { ok: true, model }
    }
  },
  {
    name: 'aidj.refresh',
    description: '清除已播记录',
    run: async () => {
      const session = state.session
      if (session) {
        session.refresh(true)
        state.sessionId = ''
        return { ok: true, message: '已清除历史记录和已播歌曲' }
      }
      return { ok: false, error: 'DJSession 未初始化' }
    }
  },
  {
    name: 'aidj.sync',
    description: '同步新歌曲元数据',
    run: async () => {
      const { client, config } = await ensureInit()
      const lib = await loadLibrary()
      state.metadata = lib.metadata
      state.musicPaths = lib.musicPaths
      const musicPaths = lib.musicPaths
      const metadata = lib.metadata
      // loadLibrary 缓存可能过期：重新扫描磁盘并就地合并新歌（只增不减）。
      const fresh = await scanMusicFiles(config.music_folders ?? [])
      for (const [name, path] of fresh) {
        if (!musicPaths.has(name)) musicPaths.set(name, path)
      }
      const missing = await findMissingSongs(musicPaths, metadata)
      if (missing.size === 0) return { ok: true, synced: 0, message: '无新歌曲需要同步' }
      const synced = await syncMetadata(
        client,
        missing,
        metadata,
        config.ai_settings.metadata_model,
        config.preferences.metadata_concurrency
      )
      state.metadata = synced.metadata
      return { ok: true, synced: synced.counts.ok }
    }
  },
  {
    name: 'aidj.metadata-sync',
    description: '扫描曲库并更新缺失的歌曲元数据（后台任务）',
    usage: 'aidj.metadata-sync',
    run: async () => {
      const already = listTasks().some(
        (tk) => tk.status === 'running' && tk.name === 'AIDJ 元数据同步'
      )
      if (already) return { ok: false, alreadyRunning: true, error: '元数据同步任务正在运行中' }
      const task = await startJobByName('aidj.metadata-sync', {
        name: 'AIDJ 元数据同步',
        description: '扫描曲库并更新缺失歌曲元数据'
      })
      if (!task) return { ok: false, error: '元数据同步任务无法启动' }
      log.info('Metadata sync job started', { taskId: task.id })
      return { ok: true, task }
    }
  },
  {
    name: 'aidj.analyse',
    description: '元数据分布分析',
    usage: 'aidj.analyse --field <language|emotion|genre|loudness>',
    run: async (ctx) => {
      const field = (ctx.named.field as string) || 'language'
      await ensureLibraryLoaded()
      const metadata = state.metadata
      if (!metadata) return { ok: false, error: '元数据未加载' }
      const counter = new Map<string, number>()
      for (const meta of metadata.values()) {
        const raw = (meta as Record<string, unknown>)[field]
        if (!raw) continue
        const values = Array.isArray(raw) ? raw : [String(raw)]
        for (const v of values) {
          counter.set(String(v), (counter.get(String(v)) ?? 0) + 1)
        }
      }
      const sorted = [...counter.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({
          label,
          count,
          pct: Math.round((count / metadata.size) * 1000) / 10
        }))
      return { ok: true, field, total: metadata.size, distribution: sorted }
    }
  },
  {
    name: 'aidj.reload',
    description: '重新加载曲库元数据',
    run: async () => {
      state.config = null
      state.client = null
      state.session = null
      state.metadata = null
      state.musicPaths = null
      state.sessionId = ''
      invalidateLibrary()
      // Re-read the persisted backend mode + drop the stale wrapper.
      resetPlayerMode()
      const oldDbus = getDbusManager()
      if (oldDbus) oldDbus.disconnect()
      setDbusManager(null as unknown as DBusManager)
      const { session } = await ensureInit()
      reconcilePlayerAbilityVisibility()
      return {
        ok: true,
        librarySize: session.metadata.size,
        pathsSize: session.musicPaths.size
      }
    }
  },
  {
    name: 'aidj.invalidate-library',
    description: '使曲库缓存失效（下次加载重新扫描目录）',
    run: async () => {
      invalidateLibrary()
      state.metadata = null
      state.musicPaths = null
      return { ok: true }
    }
  },
  {
    name: 'aidj.freq',
    description: '歌曲播放频率列表（含曲库路径，按次数降序）',
    usage: 'aidj.freq',
    run: async () => {
      const [freq, lib] = await Promise.all([loadFrequency(), loadLibrary()])
      const rows = [...freq.entries()]
        .map(([name, times]) => ({ name, times, path: lib.musicPaths.get(name) ?? '' }))
        .sort((a, b) => b.times - a.times)
      return { ok: true, rows }
    }
  }
]
