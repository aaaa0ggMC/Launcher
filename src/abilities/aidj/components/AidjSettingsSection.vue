<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed, inject } from 'vue'
import type { Ref } from 'vue'
import { DEFAULT_PERSONA, DEFAULT_LYRICS_CFG } from '../types'
import { translate, translateTemplate } from '../../../main/ui/i18n'

defineOptions({ name: 'cockpit-aidj-settings' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string | number>, fallback?: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])) as Record<
      string,
      string
    >,
    fallback
  )

/** Localized labels for dynamic field keys (metadata inject + status bar). */
const injectLabels: Record<string, string> = {
  genre: t('aidj.settings.inject_genre', '风格'),
  emotion: t('aidj.settings.inject_emotion', '情绪'),
  language: t('aidj.settings.inject_language', '语言'),
  loudness: t('aidj.settings.inject_loudness', '响度'),
  review: t('aidj.settings.inject_review', '乐评')
}
const statusLabels: Record<string, string> = {
  tokens: t('aidj.settings.status_tokens', 'Token 数'),
  context: t('aidj.settings.status_context', '上下文'),
  tracks: t('aidj.settings.status_tracks', '曲目'),
  memory: t('aidj.settings.status_memory', '记忆'),
  volbal: t('aidj.settings.status_volbal', '响度平衡'),
  record_freq: t('aidj.settings.status_record_freq', '播放频次'),
  backgrounds: t('aidj.settings.status_backgrounds', '后台任务'),
  listening: t('aidj.settings.status_listening', '时长统计')
}

/** Localized label for a dynamic field key (metadata inject / status bar). */
function labelFor(k: string): string {
  return injectLabels[k] ?? statusLabels[k] ?? k
}

const model = ref('')
const metadataModel = ref('')
const baseUrl = ref('')
const apiKey = ref('')
const ncmBaseUrl = ref('')
const ncmMode = ref<'auto' | 'external' | 'builtin'>('auto')
const ncmApproved = ref(false)
const bilibiliApproved = ref(false)
const bilibiliEnabled = ref(false)
const audioOnly = ref(false)

interface BiliProfileState {
  isLogin: boolean
  mid?: number
  uname?: string
  face?: string
  money?: number
  level?: number
  vipType?: number
  vipStatus?: number
  vipDueDate?: number
}
const biliProfile = ref<BiliProfileState | null>(null)
const biliProfileLoading = ref(false)
const biliSourcePath = ref<string | null>(null)

const ncmDialog = ref(false)
const biliDialog = ref(false)

const qrDialog = ref(false)
const qrLoading = ref(false)
const qrDataUrl = ref('')
const qrcodeKey = ref('')
const qrStatusText = ref('')
let qrPollTimer: ReturnType<typeof setInterval> | null = null

const importDialog = ref(false)
const importTab = ref<'file' | 'text'>('file')
const importFilePath = ref('')
const importTextContent = ref('')
const importSubmitting = ref(false)
const importErrorMsg = ref('')

const ncmModeItems = computed(() => {
  if (!ncmApproved.value) {
    return [
      {
        title: t('aidj.settings.ncm_mode_external', '外部服务（仅 NCM API 地址）'),
        value: 'external'
      }
    ]
  }
  return [
    { title: t('aidj.settings.ncm_mode_auto', 'Auto（外部优先，内置兜底）'), value: 'auto' },
    {
      title: t('aidj.settings.ncm_mode_external', '外部服务（仅 NCM API 地址）'),
      value: 'external'
    },
    { title: t('aidj.settings.ncm_mode_builtin', '内置（进程内直连网易）'), value: 'builtin' }
  ]
})
const dbusTarget = ref('vlc')
const startFromNowTemplate = ref('从 {info} 开始')
const playerMode = ref<'dbus' | 'web' | ''>('')
const isLinux = window.cockpit?.platform === 'linux'
const playerModeItems = computed(() =>
  isLinux
    ? [
        { title: t('aidj.settings.backend_dbus', '外部播放器 (MPRIS / DBus)'), value: 'dbus' },
        { title: t('aidj.settings.backend_web', '内置播放器'), value: 'web' }
      ]
    : [{ title: t('aidj.settings.backend_web', '内置播放器'), value: 'web' }]
)
const musicFolders = ref<string[]>([])
const musicFolderInput = ref('')
const lyricsFolders = ref<string[]>([])
const lyricsFolderInput = ref('')
const lyricsCfg = ref({ ...DEFAULT_LYRICS_CFG })
const autoPlay = ref(true)
const dynamicBalance = ref(true)
const adjMethod = ref<'lufs' | 'linear'>('lufs')
const volumeCurve = ref(3.0)
const recordFreq = ref(true)
const listeningStats = ref(true)
const songTimeline = ref(true)
const metadataConcurrency = ref(8)
const metadataCommentCount = ref(10)
const maxHistoryLength = ref(10)
const contextMode = ref<'discard' | 'compact'>('discard')
const autoTitle = ref(false)
const reconnectMinutes = ref(0)
const networkRetryMinutes = ref(0)
const availableModels = ref<string[]>([])
const modelsLoading = ref(false)
const modelsError = ref(false)
const libraryInjects = ref<Record<string, boolean>>({})
const persona = ref(DEFAULT_PERSONA)
const extraRules = ref<string[]>([''])
const statusBar = ref<Record<string, number>>({
  tokens: 1,
  context: 2,
  tracks: 3,
  memory: 4,
  volbal: 5,
  record_freq: 6,
  backgrounds: 7
})

onMounted(async () => {
  const r = (await window.cockpit.command('aidj.get-config')) as Record<string, unknown>
  if (!r?.ok || !r.config) return
  const cfg = r.config as Record<string, unknown>
  const prefs = cfg.preferences as Record<string, unknown>
  const ai = cfg.ai_settings as Record<string, unknown>
  const sec = cfg.secrets as Record<string, unknown>
  model.value = (prefs.model as string) || ''
  metadataModel.value = (ai.metadata_model as string) || ''
  baseUrl.value = (ai.base_url as string) || ''
  apiKey.value = (sec.api_key as string) || ''
  ncmBaseUrl.value = (cfg.ncm_base_url as string) || ''
  ncmApproved.value = (prefs.ncm_approved as boolean) ?? false
  bilibiliApproved.value = (prefs.bilibili_approved as boolean) ?? false
  bilibiliEnabled.value = (prefs.bilibili_enabled as boolean) ?? false
  audioOnly.value = (prefs.audio_only as boolean) ?? false
  ncmMode.value = (prefs.ncm_mode as 'auto' | 'external' | 'builtin') || 'auto'
  if (!ncmApproved.value && ncmMode.value !== 'external') {
    ncmMode.value = 'external'
  }
  dbusTarget.value = (prefs.dbus_target as string) || 'vlc'
  startFromNowTemplate.value = (prefs.start_from_now_template as string) || '从 {info} 开始'
  playerMode.value = (prefs.player_mode as 'dbus' | 'web' | undefined) ?? ''
  musicFolders.value = Array.isArray(cfg.music_folders) ? (cfg.music_folders as string[]) : []
  lyricsFolders.value = Array.isArray(cfg.lyrics_folders) ? (cfg.lyrics_folders as string[]) : []
  lyricsCfg.value = {
    ...DEFAULT_LYRICS_CFG,
    ...((prefs.lyrics as Record<string, unknown>) ?? {})
  }
  autoPlay.value = (prefs.auto_play as boolean) ?? true
  dynamicBalance.value = (prefs.dynamic_balance_volume as boolean) ?? true
  adjMethod.value = (prefs.sound_adjust_method as 'lufs' | 'linear') || 'lufs'
  volumeCurve.value = (prefs.volume_curve as number) ?? 3.0
  recordFreq.value = (prefs.record_freq as boolean) ?? true
  listeningStats.value = (prefs.listening_stats as boolean) ?? true
  songTimeline.value = (prefs.song_timeline as boolean) ?? true
  metadataConcurrency.value = (prefs.metadata_concurrency as number) ?? 8
  metadataCommentCount.value = (prefs.metadata_comment_count as number) ?? 10
  maxHistoryLength.value = (prefs.max_history_length as number) ?? 10
  contextMode.value = (prefs.context_mode as 'discard' | 'compact') || 'discard'
  autoTitle.value = (prefs.auto_title as boolean) ?? false
  reconnectMinutes.value = (prefs.reconnect_minutes as number) ?? 0
  networkRetryMinutes.value = (prefs.network_retry_minutes as number) ?? 0
  libraryInjects.value = { ...((prefs.library_injects as Record<string, boolean>) || {}) }
  persona.value = (prefs.persona as string) || DEFAULT_PERSONA
  extraRules.value = ((prefs.extra_rules as string) || '').split('\n').filter((l) => l.trim())
  if (extraRules.value.length === 0) extraRules.value = ['']
  statusBar.value = {
    tokens: 1,
    context: 2,
    tracks: 3,
    memory: 4,
    volbal: 5,
    record_freq: 6,
    backgrounds: 7,
    listening: 8,
    ...((prefs.status_bar as Record<string, number>) || {})
  }
  // Effective backend mode (config may not store it yet → platform default).
  const pm = (await window.cockpit.command('aidj.player-mode')) as {
    ok?: boolean
    mode?: string
  } | null
  if (pm?.ok && (pm.mode === 'dbus' || pm.mode === 'web')) {
    playerMode.value = pm.mode
  }
  fetchModels()
  if (bilibiliApproved.value) {
    void fetchBiliProfile()
  }
})

async function fetchModels(): Promise<void> {
  modelsLoading.value = true
  modelsError.value = false
  try {
    const r = (await window.cockpit.command('aidj.get-models')) as Record<string, unknown>
    if (r?.ok && Array.isArray(r.models)) {
      availableModels.value = r.models as string[]
    } else {
      modelsError.value = true
    }
  } catch {
    modelsError.value = true
  } finally {
    modelsLoading.value = false
  }
}

function update(path: string, value: unknown): void {
  window.cockpit
    .command('aidj.update-config', { path, value })
    .then(() => window.cockpit.command('aidj.save-config'))
    .catch(() => {})
}

async function persistMusicFolders(): Promise<void> {
  try {
    await window.cockpit.command('aidj.update-config', {
      path: 'music_folders',
      value: [...musicFolders.value]
    })
    await window.cockpit.command('aidj.save-config')
    await window.cockpit.command('aidj.invalidate-library')
  } catch {
    /* noop */
  }
}

function addMusicFolder(): void {
  const p = musicFolderInput.value.trim()
  if (!p || musicFolders.value.includes(p)) return
  musicFolders.value = [...musicFolders.value, p]
  musicFolderInput.value = ''
  void persistMusicFolders()
}

function removeMusicFolder(p: string): void {
  musicFolders.value = musicFolders.value.filter((x) => x !== p)
  void persistMusicFolders()
}

async function pickMusicFolder(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: t('aidj.settings.pick_music_dir', '选择音乐目录'),
    directory: true
  })
  if (path) musicFolderInput.value = path
}

async function persistLyricsFolders(): Promise<void> {
  try {
    await window.cockpit.command('aidj.update-config', {
      path: 'lyrics_folders',
      value: [...lyricsFolders.value]
    })
    await window.cockpit.command('aidj.save-config')
    await window.cockpit.command('aidj.invalidate-library')
  } catch {
    /* noop */
  }
}

function addLyricsFolder(): void {
  const p = lyricsFolderInput.value.trim()
  if (!p || lyricsFolders.value.includes(p)) return
  lyricsFolders.value = [...lyricsFolders.value, p]
  lyricsFolderInput.value = ''
  void persistLyricsFolders()
}

function removeLyricsFolder(p: string): void {
  lyricsFolders.value = lyricsFolders.value.filter((x) => x !== p)
  void persistLyricsFolders()
}

async function pickLyricsFolder(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: t('aidj.settings.pick_lyrics_dir', '选择歌词目录'),
    directory: true
  })
  if (path) lyricsFolderInput.value = path
}

/** Move a music folder one position up (-1) / down (+1). Earlier folders win
 * song-name collisions in the library scan, so order is meaningful. */
function moveMusicFolder(i: number, dir: -1 | 1): void {
  const j = i + dir
  if (j < 0 || j >= musicFolders.value.length) return
  const arr = [...musicFolders.value]
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  musicFolders.value = arr
  void persistMusicFolders()
}

/** Move a lyrics folder one position up (-1) / down (+1). Same-name `.lrc`
 * collisions keep the longest file, so the order is organizational only. */
function moveLyricsFolder(i: number, dir: -1 | 1): void {
  const j = i + dir
  if (j < 0 || j >= lyricsFolders.value.length) return
  const arr = [...lyricsFolders.value]
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  lyricsFolders.value = arr
  void persistLyricsFolders()
}

watch(lyricsCfg, (v) => update('preferences.lyrics', { ...v }), { deep: true })

watch(model, (v) => update('preferences.model', v))
watch(metadataModel, (v) => update('ai_settings.metadata_model', v))
watch(baseUrl, (v) => update('ai_settings.base_url', v))
watch(apiKey, (v) => update('secrets.api_key', v))
watch(ncmBaseUrl, (v) => update('ncm_base_url', v))
watch(ncmMode, (v) => update('preferences.ncm_mode', v))
watch(dbusTarget, (v) => update('preferences.dbus_target', v))
watch(startFromNowTemplate, (v) => update('preferences.start_from_now_template', v))
watch(playerMode, (v) => {
  if (!v) return
  update('preferences.player_mode', v)
  window.cockpit
    .command('aidj.player-mode', { set: v })
    .then((r) => {
      const res = r as { ok?: boolean; error?: string } | null
      if (!res?.ok) playerMode.value = ''
    })
    .catch(() => {
      playerMode.value = ''
    })
})
watch(autoPlay, (v) => update('preferences.auto_play', v))
watch(dynamicBalance, (v) => update('preferences.dynamic_balance_volume', v))
watch(adjMethod, (v) => update('preferences.sound_adjust_method', v))
watch(volumeCurve, (v) => update('preferences.volume_curve', v))
watch(recordFreq, (v) => update('preferences.record_freq', v))
watch(listeningStats, (v) => update('preferences.listening_stats', v))
watch(songTimeline, (v) => update('preferences.song_timeline', v))
watch(metadataConcurrency, (v) => update('preferences.metadata_concurrency', v))
watch(audioOnly, (v) => update('preferences.audio_only', v))

async function confirmNcmApproval(): Promise<void> {
  ncmDialog.value = false
  ncmApproved.value = true
  update('preferences.ncm_approved', true)
  await window.cockpit.command('aidj.approve-ncm', { enable: true })
}

function revokeNcmApproval(): void {
  ncmApproved.value = false
  ncmMode.value = 'external'
  update('preferences.ncm_approved', false)
  update('preferences.ncm_mode', 'external')
  void window.cockpit.command('aidj.approve-ncm', { enable: false })
}

async function confirmBiliApproval(): Promise<void> {
  biliDialog.value = false
  bilibiliApproved.value = true
  bilibiliEnabled.value = true
  update('preferences.bilibili_approved', true)
  update('preferences.bilibili_enabled', true)
  await window.cockpit.command('aidj.approve-bilibili', { enable: true })
  void fetchBiliProfile()
}

function revokeBiliApproval(): void {
  bilibiliApproved.value = false
  bilibiliEnabled.value = false
  biliProfile.value = null
  biliSourcePath.value = null
  update('preferences.bilibili_approved', false)
  update('preferences.bilibili_enabled', false)
  void window.cockpit.command('aidj.approve-bilibili', { enable: false })
}

function onBilibiliSwitchChange(val: boolean | null): void {
  const enabled = !!val
  if (enabled && !bilibiliApproved.value) {
    biliDialog.value = true
    bilibiliEnabled.value = false
    return
  }
  bilibiliEnabled.value = enabled
  update('preferences.bilibili_enabled', enabled)
}

async function openQrLogin(): Promise<void> {
  qrDialog.value = true
  await refreshQrCode()
}

async function refreshQrCode(): Promise<void> {
  if (qrPollTimer) clearInterval(qrPollTimer)
  qrLoading.value = true
  qrDataUrl.value = ''
  qrcodeKey.value = ''
  qrStatusText.value = t('aidj.settings.bili_qr_scan_prompt', '请使用 哔哩哔哩 手机客户端 扫码登录')
  try {
    const res = (await window.cockpit.command('aidj.bili-qr-generate')) as {
      ok?: boolean
      qrcode_key?: string
      qrDataUrl?: string
      error?: string
    } | null
    if (res?.ok && res.qrcode_key && res.qrDataUrl) {
      qrcodeKey.value = res.qrcode_key
      qrDataUrl.value = res.qrDataUrl
      startPollingQr(res.qrcode_key)
    } else {
      qrStatusText.value = res?.error || t('aidj.settings.bili_qr_failed', '生成二维码失败')
    }
  } catch (e) {
    qrStatusText.value = String(e)
  } finally {
    qrLoading.value = false
  }
}

function startPollingQr(key: string): void {
  qrPollTimer = setInterval(async () => {
    if (!qrDialog.value) {
      if (qrPollTimer) clearInterval(qrPollTimer)
      return
    }
    try {
      const res = (await window.cockpit.command('aidj.bili-qr-poll', { key })) as {
        ok?: boolean
        code?: number
        message?: string
        profile?: BiliProfileState
      } | null

      if (res?.code === 0) {
        if (qrPollTimer) clearInterval(qrPollTimer)
        qrStatusText.value = t('aidj.settings.bili_login_success', '登录成功！')
        if (res.profile) biliProfile.value = res.profile
        setTimeout(() => {
          qrDialog.value = false
          void fetchBiliProfile()
        }, 1000)
      } else if (res?.code === 86090) {
        qrStatusText.value = t('aidj.settings.bili_qr_scanned', '已扫码，请在手机端点击确认登录')
      } else if (res?.code === 86038) {
        if (qrPollTimer) clearInterval(qrPollTimer)
        qrStatusText.value = t('aidj.settings.bili_qr_expired', '二维码已失效，请点击刷新')
      }
    } catch {
      /* ignore poll errors */
    }
  }, 2000)
}

watch(qrDialog, (val) => {
  if (!val && qrPollTimer) {
    clearInterval(qrPollTimer)
    qrPollTimer = null
  }
})

onBeforeUnmount(() => {
  if (qrPollTimer) {
    clearInterval(qrPollTimer)
    qrPollTimer = null
  }
})

async function pickCredentialFile(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: t('aidj.settings.pick_credential_file', '选择 Bilibili 凭据文件 (JSON)'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (path) importFilePath.value = path
}

async function submitImportCredential(): Promise<void> {
  importSubmitting.value = true
  importErrorMsg.value = ''
  try {
    const args =
      importTab.value === 'file'
        ? { file: importFilePath.value.trim() }
        : { content: importTextContent.value.trim() }
    const res = (await window.cockpit.command('aidj.bili-import-credential', args)) as {
      ok?: boolean
      error?: string
      message?: string
      profile?: BiliProfileState
      savedPath?: string
    } | null
    if (res?.ok) {
      importDialog.value = false
      importFilePath.value = ''
      importTextContent.value = ''
      if (res.profile) biliProfile.value = res.profile
      if (res.savedPath) biliSourcePath.value = res.savedPath
    } else {
      importErrorMsg.value = res?.error || '导入失败'
    }
  } catch (e) {
    importErrorMsg.value = String(e)
  } finally {
    importSubmitting.value = false
  }
}

async function logoutBili(): Promise<void> {
  try {
    await window.cockpit.command('aidj.bili-logout')
    biliProfile.value = { isLogin: false }
    biliSourcePath.value = null
  } catch {
    /* noop */
  }
}

async function fetchBiliProfile(): Promise<void> {
  if (!bilibiliApproved.value) return
  biliProfileLoading.value = true
  try {
    const res = (await window.cockpit.command('aidj.bili-profile')) as {
      ok?: boolean
      isLogin?: boolean
      profile?: BiliProfileState
      sourcePath?: string | null
    } | null
    if (res?.ok && res.profile) {
      biliProfile.value = res.profile
      biliSourcePath.value = res.sourcePath ?? null
    }
  } catch {
    /* noop */
  } finally {
    biliProfileLoading.value = false
  }
}
watch(metadataCommentCount, (v) => update('preferences.metadata_comment_count', v))
watch(maxHistoryLength, (v) => update('preferences.max_history_length', v))
watch(contextMode, (v) => update('preferences.context_mode', v))
watch(autoTitle, (v) => update('preferences.auto_title', v))
watch(reconnectMinutes, (v) => update('preferences.reconnect_minutes', v))
watch(networkRetryMinutes, (v) => update('preferences.network_retry_minutes', v))
watch(libraryInjects, (v) => update('preferences.library_injects', { ...v }), { deep: true })
watch(statusBar, (v) => update('preferences.status_bar', { ...v }), { deep: true })
watch(persona, (v) => update('preferences.persona', v))
watch(
  extraRules,
  (v) =>
    update(
      'preferences.extra_rules',
      v
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n')
    ),
  { deep: true }
)

function addRule(): void {
  extraRules.value.push('')
}
function removeRule(i: number): void {
  extraRules.value.splice(i, 1)
  if (extraRules.value.length === 0) extraRules.value = ['']
}
function moveRule(i: number, dir: -1 | 1): void {
  const j = i + dir
  if (j < 0 || j >= extraRules.value.length) return
  const arr = [...extraRules.value]
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  extraRules.value = arr
}
function resetDj(): void {
  persona.value = DEFAULT_PERSONA
  extraRules.value = ['']
}

/** Deep export: core AI DJ configuration (API key masked). */
defineExpose({
  toMarkdown: (): string => {
    const on = t('aidj.settings.on', '开')
    const off = t('aidj.settings.off', '关')
    const backend =
      playerMode.value === 'web'
        ? t('aidj.settings.backend_web', '内置播放器')
        : t('aidj.settings.backend_dbus', '外部播放器 (MPRIS / DBus)')
    const ncm =
      ncmMode.value === 'external'
        ? t('aidj.settings.ncm_mode_external', '外部服务')
        : ncmMode.value === 'builtin'
          ? t('aidj.settings.ncm_mode_builtin', '内置')
          : t('aidj.settings.ncm_mode_auto', 'Auto')
    const keyMasked = apiKey.value
      ? `****${apiKey.value.slice(-4)}`
      : t('aidj.settings.none', '未设置')
    return [
      `${t('aidj.settings.backend', '播放后端')}: ${backend}`,
      `${t('aidj.settings.model_label', '模型')}: ${model.value || '—'}`,
      `${t('aidj.settings.base_url', 'API 地址')}: ${baseUrl.value || '—'}`,
      `${t('aidj.settings.api_key', 'API 密钥')}: ${keyMasked}`,
      `${t('aidj.settings.ncm_mode', 'NCM 模式')}: ${ncm}`,
      `${t('aidj.settings.dbus_target', '默认播放器')}: ${dbusTarget.value}`,
      `${t('aidj.settings.record_freq', '记录播放频率')}: ${recordFreq.value ? on : off}`,
      `${t('aidj.settings.listening_stats', '听歌时长统计')}: ${listeningStats.value ? on : off}`,
      `${t('aidj.settings.song_timeline', '记录听歌时间线')}: ${songTimeline.value ? on : off}`,
      `${t('aidj.settings.music_folders', '音乐目录')}: ${musicFolders.value.length}`
    ].join('\n')
  }
})
</script>

<template>
  <v-card rounded="lg" variant="tonal" class="card-fill">
    <v-card-title>
      <v-icon start>mdi-radio-tower</v-icon>
      AI DJ
    </v-card-title>

    <v-divider />

    <v-card-text class="d-flex flex-column ga-4 py-4">
      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.api_config', 'API 配置') }}</div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="baseUrl"
              :label="t('aidj.settings.api_url', 'API 地址')"
              placeholder="http://localhost:1145/v1"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="apiKey"
              :label="t('aidj.settings.api_key', 'API 密钥')"
              type="password"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.ai_models', 'AI 模型') }}</div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-combobox
              v-model="model"
              :items="availableModels"
              :loading="modelsLoading"
              :no-data-text="
                modelsError
                  ? t('aidj.settings.models_unavailable', 'API 未提供模型列表')
                  : t('aidj.settings.no_data', '无数据')
              "
              :label="t('aidj.settings.chat_model', '对话模型')"
              hide-details
              density="compact"
              variant="outlined"
              clearable
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-combobox
              v-model="metadataModel"
              :items="availableModels"
              :loading="modelsLoading"
              :no-data-text="
                modelsError
                  ? t('aidj.settings.models_unavailable', 'API 未提供模型列表')
                  : t('aidj.settings.no_data', '无数据')
              "
              :label="t('aidj.settings.metadata_model', '元数据提取模型')"
              hide-details
              density="compact"
              variant="outlined"
              clearable
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">
          {{ t('aidj.settings.library_player', '音乐库与播放器') }}
        </div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="ncmBaseUrl"
              :label="t('aidj.settings.ncm_url', 'NCM API 地址')"
              placeholder="http://localhost:3000"
              :disabled="ncmMode === 'builtin'"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-select
              v-model="ncmMode"
              :items="ncmModeItems"
              :label="t('aidj.settings.ncm_mode', '歌词来源')"
              :hint="
                t(
                  'aidj.settings.ncm_mode_hint',
                  'auto：外部服务优先，不可达时用内置；内置为进程内直连网易'
                )
              "
              persistent-hint
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
        <v-row dense class="mt-2">
          <v-col cols="12">
            <div
              class="d-flex align-center justify-space-between flex-wrap ga-2 pa-2 rounded border"
            >
              <div>
                <div class="text-body-2 font-weight-medium">
                  {{ t('aidj.settings.ncm_builtin_auth', '网易云内置直连授权') }}
                  <v-chip
                    size="small"
                    :color="ncmApproved ? 'success' : 'warning'"
                    variant="tonal"
                    class="ml-2"
                  >
                    {{
                      ncmApproved
                        ? t('aidj.settings.approved', '已授权')
                        : t('aidj.settings.unapproved_external_only', '未授权（仅外部服务）')
                    }}
                  </v-chip>
                </div>
                <div class="text-caption text-medium-emphasis mt-1">
                  {{
                    ncmApproved
                      ? t(
                          'aidj.settings.ncm_approved_hint',
                          '已签署免责声明，已解锁内置直连网易云 API 选项'
                        )
                      : t(
                          'aidj.settings.ncm_unapproved_hint',
                          '未签署免责声明：禁止内置抓取，歌词来源仅限外部服务地址'
                        )
                  }}
                </div>
              </div>
              <div>
                <v-btn
                  v-if="!ncmApproved"
                  color="primary"
                  variant="tonal"
                  prepend-icon="mdi-shield-check-outline"
                  @click="ncmDialog = true"
                >
                  {{ t('aidj.settings.agree_and_enable', '签署免责并启用') }}
                </v-btn>
                <v-btn
                  v-else
                  color="error"
                  variant="text"
                  prepend-icon="mdi-shield-off-outline"
                  @click="revokeNcmApproval"
                >
                  {{ t('aidj.settings.revoke_approval', '撤销授权') }}
                </v-btn>
              </div>
            </div>
          </v-col>
        </v-row>
        <v-row dense class="mt-2">
          <v-col cols="12" md="6">
            <v-text-field
              v-model="dbusTarget"
              :label="t('aidj.settings.dbus_target', 'DBus 播放器目标')"
              placeholder="vlc"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="startFromNowTemplate"
              :label="t('aidj.settings.start_from_now_template', '“从此刻开始”提示词模板')"
              placeholder="从 {info} 开始"
              :hint="
                t(
                  'aidj.settings.start_from_now_hint',
                  '自动 /persist 提示词格式，支持 {info}、{track}、{artist}、{album}'
                )
              "
              persistent-hint
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
        <v-row dense class="mt-2">
          <v-col cols="12" md="6">
            <v-select
              v-model="playerMode"
              :items="playerModeItems"
              :label="t('aidj.settings.playback_backend', '播放后端')"
              :hint="
                t(
                  'aidj.settings.backend_hint',
                  '切换会停止运行中的连续播放/持久会话；内置播放器为实验性后端'
                )
              "
              persistent-hint
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
        <div class="mt-3">
          <div class="text-caption text-medium-emphasis mb-2">
            {{ t('aidj.settings.music_scan_hint', '搜索目录（递归扫描目录下所有音乐文件）') }}
          </div>
          <div v-if="musicFolders.length > 0" class="d-flex flex-column ga-2 rules-list">
            <div v-for="(p, i) in musicFolders" :key="p" class="d-flex align-center ga-2 flex-wrap">
              <v-text-field
                :model-value="p"
                :label="tt('aidj.settings.music_folder_n', { n: i + 1 }, `音乐目录 ${i + 1}`)"
                readonly
                density="compact"
                variant="outlined"
                hide-details
                class="flex-grow-1 rule-input"
              />
              <div class="d-flex ga-1">
                <v-btn
                  icon
                  size="small"
                  variant="flat"
                  :disabled="i === 0"
                  :title="t('aidj.settings.move_up', '上移')"
                  @click="moveMusicFolder(i, -1)"
                >
                  <v-icon size="small">mdi-arrow-up</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="flat"
                  :disabled="i === musicFolders.length - 1"
                  :title="t('aidj.settings.move_down', '下移')"
                  @click="moveMusicFolder(i, 1)"
                >
                  <v-icon size="small">mdi-arrow-down</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="flat"
                  color="error"
                  :title="t('aidj.settings.delete_folder', '删除该目录')"
                  @click="removeMusicFolder(p)"
                >
                  <v-icon size="small">mdi-close</v-icon>
                </v-btn>
              </div>
            </div>
          </div>
          <div v-else class="text-caption on-surface-variant rules-empty">
            {{ t('aidj.settings.no_music_folders', '未配置音乐目录') }}
          </div>
          <div class="d-flex align-center ga-2 mt-2 flex-wrap">
            <v-text-field
              v-model="musicFolderInput"
              placeholder="/home/aaaa0ggmc/Music"
              variant="outlined"
              density="compact"
              hide-details
              class="flex-grow-1 rule-input"
            >
              <template #append-inner>
                <v-btn
                  icon
                  variant="text"
                  size="small"
                  :title="t('aidj.settings.pick_dir', '选择目录')"
                  @click="pickMusicFolder"
                >
                  <v-icon>mdi-folder-open</v-icon>
                </v-btn>
              </template>
            </v-text-field>
            <v-btn color="primary" variant="tonal" height="40" class="px-5" @click="addMusicFolder">
              {{ t('aidj.settings.add', '添加') }}
            </v-btn>
          </div>
        </div>

        <div class="mt-3">
          <div class="text-caption text-medium-emphasis mb-2">
            {{
              t(
                'aidj.settings.lyrics_scan_hint',
                '歌词搜索目录（递归扫描 .lrc 歌词文件，供桌面歌词窗口使用）'
              )
            }}
          </div>
          <div v-if="lyricsFolders.length > 0" class="d-flex flex-column ga-2 rules-list">
            <div
              v-for="(p, i) in lyricsFolders"
              :key="p"
              class="d-flex align-center ga-2 flex-wrap"
            >
              <v-text-field
                :model-value="p"
                :label="tt('aidj.settings.lyrics_folder_n', { n: i + 1 }, `歌词目录 ${i + 1}`)"
                readonly
                density="compact"
                variant="outlined"
                hide-details
                class="flex-grow-1 rule-input"
              />
              <div class="d-flex ga-1">
                <v-btn
                  icon
                  size="small"
                  variant="flat"
                  :disabled="i === 0"
                  :title="t('aidj.settings.move_up', '上移')"
                  @click="moveLyricsFolder(i, -1)"
                >
                  <v-icon size="small">mdi-arrow-up</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="flat"
                  :disabled="i === lyricsFolders.length - 1"
                  :title="t('aidj.settings.move_down', '下移')"
                  @click="moveLyricsFolder(i, 1)"
                >
                  <v-icon size="small">mdi-arrow-down</v-icon>
                </v-btn>
                <v-btn
                  icon
                  size="small"
                  variant="flat"
                  color="error"
                  :title="t('aidj.settings.delete_folder', '删除该目录')"
                  @click="removeLyricsFolder(p)"
                >
                  <v-icon size="small">mdi-close</v-icon>
                </v-btn>
              </div>
            </div>
          </div>
          <div v-else class="text-caption on-surface-variant rules-empty">
            {{ t('aidj.settings.no_lyrics_folders', '未配置歌词目录') }}
          </div>
          <div class="d-flex align-center ga-2 mt-2 flex-wrap">
            <v-text-field
              v-model="lyricsFolderInput"
              placeholder="/home/aaaa0ggmc/Music/Lyrics"
              variant="outlined"
              density="compact"
              hide-details
              class="flex-grow-1 rule-input"
            >
              <template #append-inner>
                <v-btn
                  icon
                  variant="text"
                  size="small"
                  :title="t('aidj.settings.pick_dir', '选择目录')"
                  @click="pickLyricsFolder"
                >
                  <v-icon>mdi-folder-open</v-icon>
                </v-btn>
              </template>
            </v-text-field>
            <v-btn
              color="primary"
              variant="tonal"
              height="40"
              class="px-5"
              @click="addLyricsFolder"
            >
              {{ t('aidj.settings.add', '添加') }}
            </v-btn>
          </div>
        </div>

        <div class="mt-3">
          <div class="text-caption text-medium-emphasis mb-2">
            {{
              t(
                'aidj.settings.lyrics_title',
                '桌面歌词显示（等价 vp wshowlyrics 参数，按元素定制）'
              )
            }}
          </div>
          <v-row dense>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="lyricsCfg.font_family"
                :label="t('aidj.settings.lyrics_font', '字体')"
                placeholder="Iansui Regular"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="12" md="6">
              <v-text-field
                v-model="lyricsCfg.bg_color"
                :label="t('aidj.settings.lyrics_bg', '背景色 (RRGGBBAA)')"
                placeholder="00000044"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>

            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.font_size"
                :label="t('aidj.settings.lyrics_font_size', '当前行字号')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.candidate_size"
                :label="t('aidj.settings.lyrics_candidate_size', '候选行字号')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.header_size"
                :label="t('aidj.settings.lyrics_header_size', '歌名字号')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.line_gap"
                :label="t('aidj.settings.lyrics_line_gap', '行间距')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>

            <v-col cols="6" md="3">
              <v-text-field
                v-model="lyricsCfg.fg_color"
                :label="t('aidj.settings.lyrics_fg', '当前行色')"
                placeholder="EEEEFFEE"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model="lyricsCfg.candidate_color"
                :label="t('aidj.settings.lyrics_candidate_color', '候选行色')"
                placeholder="EEEEFF99"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model="lyricsCfg.header_color"
                :label="t('aidj.settings.lyrics_header_color', '歌名色')"
                placeholder="EEEEFF66"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.shadow"
                :label="t('aidj.settings.lyrics_shadow', '阴影 (0-1)')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>

            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.current_weight"
                :label="t('aidj.settings.lyrics_weight', '当前行字重')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.candidate_weight"
                :label="t('aidj.settings.lyrics_candidate_weight', '候选行字重')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.header_weight"
                :label="t('aidj.settings.lyrics_header_weight', '歌名字重')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.line_height"
                :label="t('aidj.settings.lyrics_line_height', '行高 (1.0-2.0)')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>

            <v-col cols="6" md="3">
              <v-text-field
                v-model.number="lyricsCfg.letter_spacing"
                :label="t('aidj.settings.lyrics_letter_spacing', '字间距')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-select
                v-model="lyricsCfg.anchor"
                :items="[
                  { title: t('aidj.settings.anchor_top', '顶部'), value: 'top' },
                  { title: t('aidj.settings.anchor_center', '居中'), value: 'center' },
                  { title: t('aidj.settings.anchor_bottom', '底部'), value: 'bottom' }
                ]"
                :label="t('aidj.settings.lyrics_anchor', '窗口位置')"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.width"
                :label="t('aidj.settings.lyrics_width', '初始宽度')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.margin"
                :label="t('aidj.settings.lyrics_margin', '边距')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.lines_before"
                :label="t('aidj.settings.lyrics_before', '上方行数')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.lines_after"
                :label="t('aidj.settings.lyrics_after', '下方行数')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.position_offset_ms"
                :label="t('aidj.settings.lyrics_offset', '位置偏移(ms)')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>

            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.card_radius"
                :label="t('aidj.settings.lyrics_radius', '圆角')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.card_padding_y"
                :label="t('aidj.settings.lyrics_pad_y', '上下留白')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>
            <v-col cols="4" md="2">
              <v-text-field
                v-model.number="lyricsCfg.card_padding_x"
                :label="t('aidj.settings.lyrics_pad_x', '两侧留白')"
                type="number"
                hide-details
                density="compact"
                variant="outlined"
              />
            </v-col>

            <v-col cols="6" md="3">
              <v-switch
                v-model="lyricsCfg.auto_width"
                color="primary"
                :label="t('aidj.settings.lyrics_auto_width', '自动扩张宽度')"
                hide-details
                density="compact"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-switch
                v-model="lyricsCfg.lock_on_open"
                color="primary"
                :label="t('aidj.settings.lyrics_lock', '打开即锁定')"
                hide-details
                density="compact"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-switch
                v-model="lyricsCfg.show_title"
                color="primary"
                :label="t('aidj.settings.lyrics_show_title', '显示歌曲名')"
                hide-details
                density="compact"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-switch
                v-model="lyricsCfg.ignore_empty_lines"
                color="primary"
                :label="t('aidj.settings.lyrics_ignore_empty', '忽略空行')"
                hide-details
                density="compact"
              />
            </v-col>
            <v-col cols="6" md="3">
              <v-switch
                v-model="lyricsCfg.karaoke"
                color="primary"
                :label="t('aidj.settings.karaoke', '逐字卡拉OK')"
                hide-details
                density="compact"
              />
            </v-col>
          </v-row>
        </div>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.playback_prefs', '播放偏好') }}</div>
        <v-row dense>
          <v-col cols="6" md="3">
            <v-switch
              v-model="autoPlay"
              color="primary"
              :label="t('aidj.settings.auto_play', '自动播放')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="dynamicBalance"
              color="primary"
              :label="t('aidj.settings.dynamic_balance', '动态响度平衡')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="recordFreq"
              color="primary"
              :label="t('aidj.settings.record_freq', '记录播放频率')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="listeningStats"
              color="primary"
              :label="t('aidj.settings.listening_stats', '听歌时长统计')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="songTimeline"
              color="primary"
              :label="t('aidj.settings.song_timeline', '记录听歌时间线')"
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="6" md="3">
            <v-switch
              v-model="audioOnly"
              color="primary"
              :label="t('aidj.settings.audio_only', '仅音频模式 (Audio Only)')"
              hide-details
              density="compact"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">
          {{ t('aidj.settings.bilibili_section', 'Bilibili 视频导入与扩展') }}
        </div>
        <div class="d-flex align-center justify-space-between flex-wrap ga-2 pa-2 rounded border">
          <div>
            <div class="d-flex align-center ga-2 flex-wrap">
              <span class="text-body-2 font-weight-medium">{{
                t('aidj.settings.bili_feature', 'Bilibili 视频导入与 AI 乐评')
              }}</span>
              <v-chip
                size="small"
                :color="bilibiliApproved ? 'success' : 'warning'"
                variant="tonal"
              >
                {{
                  bilibiliApproved
                    ? t('aidj.settings.approved', '已授权')
                    : t('aidj.settings.unapproved', '未授权')
                }}
              </v-chip>
            </div>
            <div class="text-caption text-medium-emphasis mt-1">
              {{
                bilibiliApproved
                  ? t(
                      'aidj.settings.bili_approved_hint',
                      '已签署免责声明，支持下载视频、提取官方/AI字幕、抓取弹幕及评论并生成 AI 元数据'
                    )
                  : t(
                      'aidj.settings.bili_unapproved_hint',
                      '未签署免责声明：使用前必须阅读并同意免责声明以撇清责任'
                    )
              }}
            </div>
          </div>
          <div class="d-flex align-center ga-2">
            <v-switch
              :model-value="bilibiliEnabled"
              color="primary"
              :label="
                bilibiliEnabled
                  ? t('aidj.settings.enabled', '已启用')
                  : t('aidj.settings.disabled', '已禁用')
              "
              hide-details
              density="compact"
              @update:model-value="onBilibiliSwitchChange"
            />
            <v-btn
              v-if="bilibiliApproved"
              color="error"
              variant="text"
              prepend-icon="mdi-shield-off-outline"
              @click="revokeBiliApproval"
            >
              {{ t('aidj.settings.revoke_approval', '撤销授权') }}
            </v-btn>
          </div>
        </div>

        <!-- Bilibili Profile & Account Info (when approved) -->
        <div v-if="bilibiliApproved" class="mt-3 pa-3 rounded border bg-surface">
          <div class="d-flex align-center justify-space-between flex-wrap ga-3">
            <!-- Left: Avatar & Info -->
            <div class="d-flex align-center ga-3">
              <v-avatar size="52" color="surface-variant" rounded="circle">
                <img
                  v-if="biliProfile?.isLogin && biliProfile.face"
                  :src="biliProfile.face"
                  alt="avatar"
                  referrerpolicy="no-referrer"
                  style="width: 100%; height: 100%; object-fit: cover"
                />
                <v-icon v-else size="32" color="medium-emphasis">mdi-account-circle-outline</v-icon>
              </v-avatar>

              <div class="d-flex flex-column">
                <div class="d-flex align-center ga-2 flex-wrap">
                  <span class="text-body-1 font-weight-bold">
                    {{
                      biliProfile?.isLogin
                        ? biliProfile.uname || 'Bilibili 用户'
                        : t('aidj.settings.bili_not_logged_in', '未登录 Bilibili 账号')
                    }}
                  </span>
                  <v-chip
                    v-if="biliProfile?.isLogin && biliProfile.level !== undefined"
                    size="x-small"
                    color="primary"
                    variant="flat"
                    class="font-weight-bold"
                  >
                    Lv.{{ biliProfile.level }}
                  </v-chip>
                  <v-chip
                    v-if="biliProfile?.isLogin && biliProfile.vipStatus === 1"
                    size="x-small"
                    color="pink"
                    variant="tonal"
                  >
                    {{
                      biliProfile.vipType === 2
                        ? t('aidj.settings.bili_vip_year', '年度大会员')
                        : t('aidj.settings.bili_vip', '大会员')
                    }}
                  </v-chip>
                  <v-chip
                    size="small"
                    :color="biliProfile?.isLogin ? 'success' : 'default'"
                    variant="tonal"
                  >
                    {{
                      biliProfile?.isLogin
                        ? t('aidj.settings.bili_logged_in', '已登录')
                        : t('aidj.settings.bili_guest', '游客模式')
                    }}
                  </v-chip>
                </div>

                <div class="text-caption text-medium-emphasis mt-1">
                  <template v-if="biliProfile?.isLogin">
                    <span>UID: {{ biliProfile.mid }}</span>
                    <span class="mx-2">•</span>
                    <span
                      >{{ t('aidj.settings.bili_coins', '硬币') }}:
                      {{ biliProfile.money ?? 0 }}</span
                    >
                    <span v-if="biliSourcePath" class="mx-2">•</span>
                    <span v-if="biliSourcePath" :title="biliSourcePath">
                      {{ t('aidj.settings.bili_source', '凭据来源') }}:
                      {{ biliSourcePath.split('/').slice(-2).join('/') }}
                    </span>
                  </template>
                  <template v-else>
                    {{
                      t(
                        'aidj.settings.bili_guest_hint',
                        '未配置登录凭据。游客模式仅可解析下载 360P/480P 基础画质，登录后可解锁 1080P+ 高清音画与会员内容。'
                      )
                    }}
                  </template>
                </div>
              </div>
            </div>

            <!-- Right: Action Buttons -->
            <div class="d-flex align-center flex-wrap ga-2">
              <v-btn
                color="primary"
                variant="tonal"
                prepend-icon="mdi-qrcode-scan"
                @click="openQrLogin"
              >
                {{
                  biliProfile?.isLogin
                    ? t('aidj.settings.bili_switch_account', '切换账号 (扫码)')
                    : t('aidj.settings.bili_qr_login', '扫码登录')
                }}
              </v-btn>
              <v-btn
                variant="outlined"
                prepend-icon="mdi-file-import-outline"
                @click="importDialog = true"
              >
                {{ t('aidj.settings.bili_import_cred', '导入凭据') }}
              </v-btn>
              <v-btn
                v-if="biliProfile?.isLogin"
                icon
                size="small"
                variant="text"
                :loading="biliProfileLoading"
                :title="t('aidj.settings.bili_refresh', '刷新个人信息')"
                @click="fetchBiliProfile"
              >
                <v-icon size="small">mdi-refresh</v-icon>
              </v-btn>
              <v-btn
                v-if="biliProfile?.isLogin"
                color="error"
                variant="text"
                prepend-icon="mdi-logout-variant"
                @click="logoutBili"
              >
                {{ t('aidj.settings.bili_logout', '退出登录') }}
              </v-btn>
            </div>
          </div>
        </div>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.loudness', '响度调整') }}</div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-select
              v-model="adjMethod"
              :items="[
                { title: 'LUFS', value: 'lufs' },
                { title: 'RMS (Linear)', value: 'linear' }
              ]"
              :label="t('aidj.settings.adjust_method', '调整方法')"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-slider
              v-model="volumeCurve"
              color="primary"
              :label="t('aidj.settings.volume_curve', '音量曲线')"
              min="1"
              max="5"
              step="0.1"
              hide-details
              density="compact"
              thumb-label
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="metadataConcurrency"
              :label="t('aidj.settings.sync_concurrency', '同步并发数')"
              type="number"
              min="1"
              max="16"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="metadataCommentCount"
              :label="t('aidj.settings.metadata_comment_count', '乐评抓取数量')"
              type="number"
              min="0"
              max="50"
              :hint="
                t(
                  'aidj.settings.metadata_comment_hint',
                  '每条歌曲抓取的网易热评数，供 AI 参考撰写 review；0 = 关闭'
                )
              "
              persistent-hint
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.context', '上下文管理') }}</div>
        <div class="text-caption text-medium-emphasis mb-2">
          即时与持久模式共用：会话历史超过上限时处理最旧消息（库提示词始终保留）；界面仍展示全部消息
        </div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-select
              v-model="contextMode"
              :items="[
                {
                  title: t('aidj.settings.context_discard', 'Discard（丢弃最旧）'),
                  value: 'discard'
                },
                {
                  title: t('aidj.settings.context_compact', 'Compact（压缩为摘要）'),
                  value: 'compact'
                }
              ]"
              :label="t('aidj.settings.context_mode', '处理方式')"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="maxHistoryLength"
              :label="t('aidj.settings.history_limit', '历史消息上限')"
              type="number"
              min="2"
              max="100"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="4" class="switch-col">
            <div class="d-flex align-center h-100 switch-align">
              <v-switch
                v-model="autoTitle"
                color="primary"
                :label="t('aidj.settings.auto_title', '自动 AI 生成标题')"
                hide-details
              />
            </div>
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.persona', 'DJ 人设定制') }}</div>
        <div class="text-caption text-medium-emphasis mb-2">
          即时与持久模式共用。空人设 = 使用内置默认；人设会替换 Role
          定义，附加规则追加到每次请求的提示词
        </div>
        <v-row dense>
          <v-col cols="12" md="6">
            <v-textarea
              v-model="persona"
              :label="t('aidj.settings.persona_role', 'DJ 人设（Role 定义）')"
              no-resize
              hide-details
              density="compact"
              variant="outlined"
              class="persona-input"
            />
          </v-col>
          <v-col cols="12" md="6">
            <div class="d-flex flex-column ga-2 rules-list">
              <div
                v-for="(_rule, i) in extraRules"
                :key="i"
                class="d-flex align-center ga-2 flex-wrap"
              >
                <v-text-field
                  v-model="extraRules[i]"
                  :label="tt('aidj.settings.rule_n', { n: i + 1 }, `规则 ${i + 1}`)"
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="flex-grow-1 rule-input"
                  placeholder="t('aidj.settings.rule_placeholder', '例如：不要播放悲伤的歌')"
                />
                <div class="d-flex ga-1">
                  <v-btn
                    icon
                    size="small"
                    variant="flat"
                    :disabled="i === 0"
                    :title="t('aidj.settings.move_up', '上移')"
                    @click="moveRule(i, -1)"
                  >
                    <v-icon size="small">mdi-arrow-up</v-icon>
                  </v-btn>
                  <v-btn
                    icon
                    size="small"
                    variant="flat"
                    :disabled="i === extraRules.length - 1"
                    :title="t('aidj.settings.move_down', '下移')"
                    @click="moveRule(i, 1)"
                  >
                    <v-icon size="small">mdi-arrow-down</v-icon>
                  </v-btn>
                  <v-btn
                    icon
                    size="small"
                    variant="flat"
                    color="error"
                    :title="t('aidj.settings.delete_rule', '删除该规则')"
                    @click="removeRule(i)"
                  >
                    <v-icon size="small">mdi-close</v-icon>
                  </v-btn>
                </div>
              </div>
            </div>
            <div class="d-flex align-center ga-2 mt-2 flex-wrap">
              <v-btn variant="text" color="primary" prepend-icon="mdi-plus" @click="addRule">
                添加规则
              </v-btn>
              <v-btn
                variant="text"
                color="primary"
                prepend-icon="mdi-backup-restore"
                @click="resetDj"
              >
                恢复默认
              </v-btn>
            </div>
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.continuous', '连续播放') }}</div>
        <div class="text-caption text-medium-emphasis mb-2">
          播放器断开时的处理：0 = 立即结束，大于 0 = 在 N 分钟内尝试重连，小于 0 = 永不停止重连
        </div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="reconnectMinutes"
              :label="t('aidj.settings.reconnect_minutes', '重连时长（分钟）')"
              type="number"
              step="1"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.network_retry', '网络重试') }}</div>
        <div class="text-caption text-medium-emphasis mb-2">
          AI API 请求失败（断网）时的重试：0 = 立即报错，大于 0 = 在 N 分钟内重试，小于 0 =
          永不停止重试
        </div>
        <v-row dense>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="networkRetryMinutes"
              :label="t('aidj.settings.network_retry_minutes', '网络重试时长（分钟）')"
              type="number"
              step="1"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">
          {{ t('aidj.settings.metadata_inject', '元数据字段注入') }}
        </div>
        <v-row dense>
          <v-col v-for="(_v, k) in libraryInjects" :key="k" cols="6" md="2">
            <v-switch
              v-model="libraryInjects[k]"
              color="primary"
              :label="labelFor(k)"
              hide-details
              density="compact"
            />
          </v-col>
        </v-row>
      </div>

      <v-divider />

      <div>
        <div class="text-subtitle-2 mb-2">{{ t('aidj.settings.status_bar', '状态栏指示器') }}</div>
        <div class="text-caption text-medium-emphasis mb-2">
          {{ t('aidj.settings.status_hint', '数值为显示顺序，0 = 隐藏；相同数值按字母排序') }}
        </div>
        <v-row dense>
          <v-col v-for="(_v, k) in statusBar" :key="k" cols="6" md="3">
            <v-text-field
              v-model.number="statusBar[k]"
              :label="labelFor(k)"
              type="number"
              min="0"
              step="1"
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>
      </div>

      <!-- NCM Disclaimer Dialog -->
      <v-dialog v-model="ncmDialog" max-width="560" persistent>
        <v-card rounded="lg">
          <v-card-title class="d-flex align-center ga-2 px-4 pt-4 pb-2">
            <v-icon color="warning">mdi-alert-circle-outline</v-icon>
            <span class="text-h6 font-weight-bold">{{
              t('aidj.disclaimer.ncm_title', '免责声明：网易云音乐内置直连')
            }}</span>
          </v-card-title>
          <v-card-text class="px-4 py-2 text-body-2 line-height-relaxed">
            <p class="mb-3">
              {{
                t(
                  'aidj.disclaimer.ncm_p1',
                  '开启内置直连模式后，本程序将在本地进程中直接向第三方服务器（网易云音乐）发起检索与歌词获取请求。'
                )
              }}
            </p>
            <div class="pa-3 rounded bg-surface-variant text-caption mb-3">
              <div class="font-weight-bold mb-1">
                {{ t('aidj.disclaimer.terms_title', '特别声明与责任限制：') }}
              </div>
              <ol class="pl-4 d-flex flex-column ga-1">
                <li>
                  {{
                    t(
                      'aidj.disclaimer.ncm_term1',
                      '本功能仅供个人学习、技术研究与离线本地音乐元数据整理之用。'
                    )
                  }}
                </li>
                <li>
                  {{
                    t(
                      'aidj.disclaimer.ncm_term2',
                      '开发者及本项目不托管、不传播、不存储任何受版权保护的音视频或商业数据。'
                    )
                  }}
                </li>
                <li>
                  {{
                    t(
                      'aidj.disclaimer.ncm_term3',
                      '使用者需自愿承担因调用第三方接口所产生的所有网络流量、法律及合规责任。'
                    )
                  }}
                </li>
              </ol>
            </div>
            <p class="text-caption text-medium-emphasis">
              {{
                t(
                  'aidj.disclaimer.agree_hint',
                  '点击「同意并启用」即表示您已充分阅读并理解上述声明，自愿承担所有使用风险与责任。'
                )
              }}
            </p>
          </v-card-text>
          <v-card-actions class="px-4 pb-4 pt-0 ga-2">
            <v-btn variant="text" @click="ncmDialog = false">
              {{ t('aidj.disclaimer.cancel', '取消') }}
            </v-btn>
            <v-spacer />
            <v-btn color="primary" variant="flat" @click="confirmNcmApproval">
              {{ t('aidj.disclaimer.agree_and_enable', '同意并启用') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Bilibili Disclaimer Dialog -->
      <v-dialog v-model="biliDialog" max-width="560" persistent>
        <v-card rounded="lg">
          <v-card-title class="d-flex align-center ga-2 px-4 pt-4 pb-2">
            <v-icon color="warning">mdi-alert-circle-outline</v-icon>
            <span class="text-h6 font-weight-bold">{{
              t('aidj.disclaimer.bili_title', '免责声明：Bilibili API 视频与元数据导入')
            }}</span>
          </v-card-title>
          <v-card-text class="px-4 py-2 text-body-2 line-height-relaxed">
            <p class="mb-3">
              {{
                t(
                  'aidj.disclaimer.bili_p1',
                  '开启 Bilibili 扩展后，本程序可根据用户指定的 BV 号/链接下载视频流、提取字幕与弹幕，并通过 AI 生成音乐元数据。'
                )
              }}
            </p>
            <div class="pa-3 rounded bg-surface-variant text-caption mb-3">
              <div class="font-weight-bold mb-1">
                {{ t('aidj.disclaimer.terms_title', '特别声明与责任限制：') }}
              </div>
              <ol class="pl-4 d-flex flex-column ga-1">
                <li>
                  {{
                    t(
                      'aidj.disclaimer.bili_term1',
                      '本功能仅供个人学习交流与多媒体技术研究之用，请勿用于商业传播。'
                    )
                  }}
                </li>
                <li>
                  {{
                    t(
                      'aidj.disclaimer.bili_term2',
                      '开发者及本项目不托管、不提供任何 Bilibili 网站内容，亦不提供破解保护措施。'
                    )
                  }}
                </li>
                <li>
                  {{
                    t(
                      'aidj.disclaimer.bili_term3',
                      '使用者须自觉遵守相关法律法规及平台规范，对所有下载与使用行为独立承担全部法律责任。'
                    )
                  }}
                </li>
              </ol>
            </div>
            <p class="text-caption text-medium-emphasis">
              {{
                t(
                  'aidj.disclaimer.agree_hint',
                  '点击「同意并启用」即表示您已充分阅读并理解上述声明，自愿承担所有使用风险与责任。'
                )
              }}
            </p>
          </v-card-text>
          <v-card-actions class="px-4 pb-4 pt-0 ga-2">
            <v-btn variant="text" @click="biliDialog = false">
              {{ t('aidj.disclaimer.cancel', '取消') }}
            </v-btn>
            <v-spacer />
            <v-btn color="primary" variant="flat" @click="confirmBiliApproval">
              {{ t('aidj.disclaimer.agree_and_enable', '同意并启用') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Bilibili QR Login Dialog -->
      <v-dialog v-model="qrDialog" max-width="440" persistent>
        <v-card rounded="lg">
          <v-card-title class="d-flex align-center justify-space-between px-4 pt-4 pb-2">
            <div class="d-flex align-center ga-2">
              <v-icon color="primary">mdi-qrcode-scan</v-icon>
              <span class="text-h6 font-weight-bold">
                {{ t('aidj.settings.bili_qr_dialog_title', 'Bilibili 扫码登录') }}
              </span>
            </div>
            <v-btn icon size="small" variant="text" @click="qrDialog = false">
              <v-icon size="small">mdi-close</v-icon>
            </v-btn>
          </v-card-title>
          <v-card-text class="d-flex flex-column align-center px-4 py-4">
            <div
              class="pa-2 border rounded-lg bg-white d-flex align-center justify-center"
              style="width: 236px; height: 236px"
            >
              <v-progress-circular v-if="qrLoading" indeterminate color="primary" size="48" />
              <img
                v-else-if="qrDataUrl"
                :src="qrDataUrl"
                alt="QR Code"
                style="width: 220px; height: 220px; display: block"
              />
              <div v-else class="text-caption text-error text-center pa-4">
                {{ qrStatusText }}
              </div>
            </div>
            <div class="text-body-2 font-weight-medium mt-4 text-center">
              {{ qrStatusText }}
            </div>
            <div class="text-caption text-medium-emphasis mt-1 text-center">
              {{ t('aidj.settings.bili_qr_subhint', '请使用 哔哩哔哩 手机客户端 扫码并确认') }}
            </div>
          </v-card-text>
          <v-card-actions class="px-4 pb-4 pt-0 ga-2">
            <v-btn variant="text" @click="qrDialog = false">
              {{ t('aidj.disclaimer.cancel', '取消') }}
            </v-btn>
            <v-spacer />
            <v-btn
              variant="tonal"
              color="primary"
              prepend-icon="mdi-refresh"
              :loading="qrLoading"
              @click="refreshQrCode"
            >
              {{ t('aidj.settings.bili_qr_refresh', '刷新二维码') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

      <!-- Bilibili Import Credential Dialog -->
      <v-dialog v-model="importDialog" max-width="560">
        <v-card rounded="lg">
          <v-card-title class="d-flex align-center justify-space-between px-4 pt-4 pb-2">
            <div class="d-flex align-center ga-2">
              <v-icon color="primary">mdi-file-import-outline</v-icon>
              <span class="text-h6 font-weight-bold">
                {{ t('aidj.settings.bili_import_dialog_title', '导入 Bilibili 凭据') }}
              </span>
            </div>
            <v-btn icon size="small" variant="text" @click="importDialog = false">
              <v-icon size="small">mdi-close</v-icon>
            </v-btn>
          </v-card-title>
          <v-card-text class="px-4 py-2">
            <v-tabs v-model="importTab" density="compact" color="primary" class="mb-3">
              <v-tab value="file">{{ t('aidj.settings.import_tab_file', '选择文件') }}</v-tab>
              <v-tab value="text">
                {{ t('aidj.settings.import_tab_text', '手动粘贴 Cookie / JSON') }}
              </v-tab>
            </v-tabs>

            <v-window v-model="importTab">
              <v-window-item value="file">
                <div class="text-caption text-medium-emphasis mb-2">
                  {{
                    t(
                      'aidj.settings.import_file_hint',
                      '支持选择包含 bili_info.json 或带有 SESSDATA 的 JSON 文件'
                    )
                  }}
                </div>
                <div class="d-flex align-center ga-2">
                  <v-text-field
                    v-model="importFilePath"
                    :placeholder="
                      t('aidj.settings.import_file_placeholder', '/home/user/Apps/bili_info.json')
                    "
                    density="compact"
                    variant="outlined"
                    hide-details
                    class="flex-grow-1"
                  >
                    <template #append-inner>
                      <v-btn
                        icon
                        variant="text"
                        size="small"
                        :title="t('aidj.settings.pick_file', '浏览文件')"
                        @click="pickCredentialFile"
                      >
                        <v-icon>mdi-folder-open</v-icon>
                      </v-btn>
                    </template>
                  </v-text-field>
                </div>
              </v-window-item>

              <v-window-item value="text">
                <div class="text-caption text-medium-emphasis mb-2">
                  {{
                    t(
                      'aidj.settings.import_text_hint',
                      '支持直接粘贴浏览器 Cookie（如 SESSDATA=xxx; bili_jct=yyy;）或完整凭据 JSON'
                    )
                  }}
                </div>
                <v-textarea
                  v-model="importTextContent"
                  :placeholder="
                    t(
                      'aidj.settings.import_text_placeholder',
                      'SESSDATA=xxx; bili_jct=yyy; buvid3=zzz; DedeUserID=123...'
                    )
                  "
                  density="compact"
                  variant="outlined"
                  rows="4"
                  no-resize
                  hide-details
                />
              </v-window-item>
            </v-window>

            <v-alert
              v-if="importErrorMsg"
              type="error"
              variant="tonal"
              density="compact"
              class="mt-3 text-caption"
            >
              {{ importErrorMsg }}
            </v-alert>
          </v-card-text>
          <v-card-actions class="px-4 pb-4 pt-0 ga-2">
            <v-btn variant="text" @click="importDialog = false">
              {{ t('aidj.disclaimer.cancel', '取消') }}
            </v-btn>
            <v-spacer />
            <v-btn
              color="primary"
              variant="flat"
              :loading="importSubmitting"
              @click="submitImportCredential"
            >
              {{ t('aidj.settings.bili_save_cred', '验证并保存') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </v-card-text>
  </v-card>
</template>

<style scoped>
/* Both columns are fixed to the same height so the persona textarea and the
   rules list align. The rules list scrolls internally when it overflows. */
.persona-input {
  height: 232px;
}
.persona-input :deep(.v-field),
.persona-input :deep(.v-field__field),
.persona-input :deep(.v-field__input) {
  height: 100%;
}
.rules-list {
  height: 232px;
  overflow-y: auto;
  /* Top padding gives the floating outlined label (which straddles the field's
     top border) room so the first rule's label isn't clipped by the scroll box. */
  padding: 10px 6px 8px 2px;
}
.rule-input {
  min-width: 160px;
}
.rules-empty {
  min-height: 44px;
  display: flex;
  align-items: center;
}
/* Center the switch against the outlined select/text-field siblings in the same row. */
.switch-align {
  min-height: 44px;
}
.switch-align :deep(.v-selection-control) {
  min-width: 4ch;
}
/* Gap between the toggle and the preceding input box (at least 4ch). */
.switch-col {
  padding-inline-start: 4ch;
}
</style>
