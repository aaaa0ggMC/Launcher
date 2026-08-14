export interface AidjConfig {
  music_folders: string[]
  /** Folders scanned (recursively) for `.lrc` lyric files, shown in the desktop-lyrics window. */
  lyrics_folders?: string[]
  ncm_base_url: string
  secrets: { api_key: string }
  ai_settings: {
    base_url: string
    metadata_model: string
  }
  preferences: {
    model: string
    auto_play: boolean
    dbus_target: string
    /**
     * Active playback backend mode: `dbus` (external player via MPRIS) or `web`
     * (built-in HTML5 player). Absent → platform default (Linux: dbus, else web).
     */
    player_mode?: 'dbus' | 'web'
    /** NCM source: 'auto' external-first w/ built-in fallback | 'external' only | 'builtin' only */
    ncm_mode?: 'auto' | 'external' | 'builtin'
    record_freq: boolean
    dynamic_balance_volume: boolean
    sound_adjust_method: 'lufs' | 'linear'
    volume_curve: number
    metadata_concurrency: number
    /** Number of NCM hot comments fetched per song to ground the AI review (0 = off). */
    metadata_comment_count?: number
    /** Context management mode: discard drops oldest messages, compact summarizes them. */
    context_mode: 'discard' | 'compact'
    /** Auto-generate the session title via AI after the first AI output (else: use the first user input). */
    auto_title?: boolean
    /** Max messages kept in the chat history (library prompt is always kept). */
    max_history_length: number
    /** Continuous player: reconnect window in minutes. 0 = exit on disconnect, >0 = retry N min, <0 = never give up. */
    reconnect_minutes: number
    /** AI API network retry: 0 = fail fast, >0 = retry within N minutes, <0 = retry forever. */
    network_retry_minutes: number
    library_injects: {
      genre: boolean
      emotion: boolean
      language: boolean
      loudness: boolean
      review: boolean
    }
    /** Status bar chip visibility & order. 0 = hidden, 1+ = display order.
     *  tokens = cumulative total tokens (prompt+completion); context = single-request input tokens. */
    status_bar: {
      tokens: number
      context: number
      tracks: number
      memory: number
      volbal: number
      record_freq: number
      backgrounds: number
    }
    /** Customizable DJ persona — replaces the built-in ROLE DEFINITION. Empty = built-in default. */
    persona?: string
    /** Extra behavior rules appended to every DJ prompt. Empty = none. */
    extra_rules?: string
    /** Desktop-lyrics window display settings (mirrors `vp wshowlyrics` flags). */
    lyrics?: Partial<LyricsDisplayConfig>
    /** Built-in player (M4): crossfade between tracks (fade out/in). */
    crossfade?: { enabled: boolean; seconds: number }
    /** Built-in player EQ preset id. */
    eq_preset?: 'flat' | 'pop' | 'rock' | 'classical' | 'vocal'
    /** Built-in player playback rate (0.5–2.0). */
    playback_rate?: number
    /** Built-in player initial software volume (0–1). */
    default_volume?: number
    /** Built-in player spectrum strip visible by default. */
    spectrum_enabled?: boolean
    /** Built-in player LAN web-remote server port (0 = disabled). */
    web_remote_port?: number
  }
}

/**
 * Full default AIDJ config — materialized on first run when
 * `~/.config/LinuxCockpit/aidj/config.json` doesn't exist yet, so the settings
 * UI gets a real object to mutate + persist instead of every update/save
 * bailing with "配置未加载".
 */
export const DEFAULT_AIDJ_CONFIG: AidjConfig = {
  music_folders: [],
  ncm_base_url: 'http://localhost:3000',
  secrets: { api_key: '' },
  ai_settings: { base_url: 'http://localhost:1145/v1', metadata_model: '' },
  preferences: {
    model: '',
    auto_play: true,
    dbus_target: 'vlc',
    ncm_mode: 'auto',
    record_freq: true,
    dynamic_balance_volume: true,
    sound_adjust_method: 'lufs',
    volume_curve: 3.0,
    metadata_concurrency: 8,
    metadata_comment_count: 10,
    context_mode: 'discard',
    max_history_length: 10,
    reconnect_minutes: 0,
    network_retry_minutes: 0,
    library_injects: {
      genre: true,
      emotion: true,
      language: true,
      loudness: true,
      review: true
    },
    status_bar: {
      tokens: 1,
      context: 2,
      tracks: 3,
      memory: 4,
      volbal: 5,
      record_freq: 6,
      backgrounds: 7
    },
    crossfade: { enabled: false, seconds: 2.5 },
    eq_preset: 'flat',
    playback_rate: 1.0,
    default_volume: 0.8,
    spectrum_enabled: false,
    web_remote_port: 17320
  }
}

/**
 * Desktop-lyrics display config, mirroring `vp wshowlyrics -F '<font> <size>' -a
 * <anchor> -m <margin> -b <bg> -f <fg>`. Colors are RRGGBBAA hex (alpha last).
 *
 * Styling is split per element — header (track name/artist), current line and
 * candidate lines (the dim ones before/after the current) each get their own
 * size, weight and color; typography is rounded out with shadow, letter
 * spacing and line height.
 */
export interface LyricsDisplayConfig {
  /** shared font family, e.g. "Iansui Regular" */
  font_family: string
  /** current-line font size (px) */
  font_size: number
  /** track-header font size (px) */
  header_size: number
  /** non-current (candidate) line font size (px) */
  candidate_size: number
  /** backdrop color RRGGBBAA — '00000000' = fully transparent */
  bg_color: string
  /** current-line text color RRGGBBAA */
  fg_color: string
  /** track-header text color RRGGBBAA */
  header_color: string
  /** candidate line text color RRGGBBAA */
  candidate_color: string
  /** current-line font weight (400–900) */
  current_weight: number
  /** candidate line font weight (400–900) */
  candidate_weight: number
  /** header font weight (400–900) */
  header_weight: number
  /** current-line text shadow strength 0–1 (0 = none) */
  shadow: number
  /** letter spacing (px) */
  letter_spacing: number
  /** line-height factor (1.0–2.0) */
  line_height: number
  /** vertical anchor of the lyrics card within the window */
  anchor: 'top' | 'center' | 'bottom'
  /** gap from the anchor edge, px */
  margin: number
  /** initial window width (px); auto-expands beyond this when `auto_width` */
  width: number
  /** auto-expand the window to fit long lines */
  auto_width: boolean
  /** lock (mouse passthrough / untouchable) as soon as the window opens */
  lock_on_open: boolean
  /** lines shown ABOVE the current line */
  lines_before: number
  /** lines shown BELOW the current line */
  lines_after: number
  /** show the track name + artist header */
  show_title: boolean
  /** empty-timestamp line (instrumental gap): true = keep the last lyric lit;
   *  false = hide the window fully transparent during the gap */
  ignore_empty_lines: boolean
  /** position adjustment in ms. Positive = show lyrics EARLIER (compensate the
   *  poll lag, ~+200 to match wshowlyrics); negative = later. */
  position_offset_ms: number
  /** word-by-word karaoke fill on the current line (uses inline LRC timestamps) */
  karaoke?: boolean
  /** card corner radius (px) */
  card_radius: number
  /** card top/bottom padding (px) */
  card_padding_y: number
  /** card left/right padding (px) */
  card_padding_x: number
  /** vertical gap between lyric lines, px */
  line_gap: number
}

export const DEFAULT_LYRICS_CFG: LyricsDisplayConfig = {
  font_family: 'Iansui Regular',
  font_size: 36,
  header_size: 13,
  candidate_size: 22,
  bg_color: '00000044',
  fg_color: 'EEEEFFEE',
  header_color: 'EEEEFF66',
  candidate_color: 'EEEEFF99',
  current_weight: 700,
  candidate_weight: 500,
  header_weight: 600,
  shadow: 0.5,
  letter_spacing: 0,
  line_height: 1.3,
  anchor: 'top',
  margin: 50,
  width: 560,
  auto_width: true,
  lock_on_open: false,
  lines_before: 0,
  lines_after: 1,
  show_title: true,
  ignore_empty_lines: true,
  position_offset_ms: 0,
  karaoke: true,
  card_radius: 12,
  card_padding_y: 12,
  card_padding_x: 26,
  line_gap: 6
}

/**
 * In-app lyrics page (`aidj-lyrics` ability) display config. Unlike the desktop
 * floating lyrics window, the page's COLORS are not configurable here — the
 * page always follows the app theme (`rgb(var(--v-theme-*))`), so this only
 * carries typography and playback-presentation options (karaoke, scroll, …).
 * Stored in `~/.config/LinuxCockpit/aidj-lyrics/config.json`.
 */
export interface AidjLyricsPageConfig {
  /** shared font family, e.g. "Iansui Regular" */
  font_family: string
  /** current-line font size (px) */
  font_size: number
  /** non-current (candidate) line font size (px) */
  candidate_size: number
  /** current-line font weight (400–900) */
  current_weight: number
  /** candidate line font weight (400–900) */
  candidate_weight: number
  /** line-height factor (1.0–2.0) */
  line_height: number
  /** letter spacing (px) */
  letter_spacing: number
  /** vertical gap between lyric lines, px */
  line_gap: number
  /** position adjustment in ms (positive = show earlier, negative = later) */
  position_offset_ms: number
  /** word-by-word karaoke fill on the current line */
  karaoke: boolean
  /** auto-scroll so the current line stays centered (false = static window) */
  scroll_follow: boolean
  /** lines shown ABOVE the current line (static-window mode) */
  lines_before: number
  /** lines shown BELOW the current line (static-window mode) */
  lines_after: number
  /** dim non-current lines */
  dim_candidates: boolean
  /** show the track/player header + playback controls */
  show_header: boolean
  /** immersive mode: overlay the (blurred + dimmed) cover as the page
   *  background instead of the user-configured one (only when a cover exists) */
  immerse_mode: boolean
}

export const DEFAULT_LYRICS_PAGE_CFG: AidjLyricsPageConfig = {
  font_family: 'Iansui Regular',
  font_size: 34,
  candidate_size: 20,
  current_weight: 700,
  candidate_weight: 500,
  line_height: 1.3,
  letter_spacing: 0,
  line_gap: 10,
  position_offset_ms: 0,
  karaoke: true,
  scroll_follow: true,
  lines_before: 2,
  lines_after: 3,
  dim_candidates: true,
  show_header: true,
  immerse_mode: false
}

/** Built-in DJ persona. Users can override it via `preferences.persona`. */
export const DEFAULT_PERSONA = `You are a **charismatic, knowledgeable, and expressive AI Radio Host**.
Your goal is not just to list songs, but to **curate an experience**.
- **Personality:** Passionate, poetic, slightly "hyped" or "deep" (depending on the mood), and vibe-focused.
- **Rule:** BE EXPRESSIVE. Do NOT give short, robotic responses like "Here is your list."
- **Method:** Weave a narrative. Talk about the *texture* of the sound, the *emotion* of the artists, and *why* these songs fit the moment.`

export interface SongMeta {
  language?: string
  emotion?: string | string[]
  genre?: string | string[]
  loudness?: string
  review?: string
}

/** Per-sync counters returned by syncMetadata. networkError = NCM API unreachable. */
export interface MetadataSyncCounts {
  ok: number
  noLyric: number
  failed: number
  networkError: number
}

/** Per-song progress emitted by syncMetadata (status/result/error for the console). */
export interface MetadataSyncProgress {
  done: number
  total: number
  name: string
  status: 'ok' | 'noLyric' | 'networkError' | 'failed'
  /** NCM song id when the search hit. */
  sid?: number | null
  /** Lyric text length when the search hit. */
  lyricLen?: number
  /** The final extracted metadata (status='ok' only). */
  meta?: SongMeta
  /** Failure reason (status='networkError' | 'failed'). */
  error?: string
}

export interface SongEntry {
  name: string
  path: string
}

export interface PlaylistEntry {
  name: string
  path: string
  meta?: SongMeta | null
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  playlist?: PlaylistEntry[]
  timestamp: number
  chars?: number
  /** Monotonic unique id for Vue key stability (timestamps can collide). */
  uid?: number
}

/** Raw history.jsonl entry. type: user=UI only, model=AI only, both=display+AI, updated=compact/drop marker. */
export interface RawHistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: number
  type?: 'user' | 'model' | 'both' | 'updated'
  playlist?: PlaylistEntry[]
}

export interface SessionMeta {
  id: string
  title: string
  type: 'chat' | 'generate'
  initialPrompt?: string
  created_at: number
  updated_at: number
  /** Pinned sessions sort above the rest in the sessions list. */
  pinned?: boolean
}

export interface PlayerStatus {
  status: 'Playing' | 'Paused' | 'Stopped' | 'Unknown'
  track: string
  volume: number | null
  player: string
}

export interface LoudnessInfo {
  peak_db: number | null
  rms_db: number | null
  integrated_lufs: number | null
}

export interface PersistentSessionState {
  chat_history: ChatMessage[]
  rolling_history: string[]
  current_queue: PlaylistEntry[]
  buffer: PlaylistEntry[][]
  fetch_count: number
  working: boolean
}

export const SEPARATOR = '[---SONG_LIST---]'
export const AIDJ_DATA_DIR = 'aidj'
export const METADATA_FILE = 'music_metadata.jsonl'
export const LYRICS_FILE = 'music_lyrics.jsonl'
export const FREQ_FILE = 'frequency.csv'
export const PLAYLISTS_DIR = 'playlists'

/** Desktop-lyrics window id prefix — the full id is `<prefix>-<playerKey>`, so
 *  each DBus instance (player) gets its own single-instance lyrics window. */
export const LYRICS_WINDOW_ID = 'aidj-lyrics'

/**
 * Live DBus playback snapshot for the desktop-lyrics window. `position` /
 * `length` are in milliseconds; `lyric` is the LRC text resolved for the
 * current track (null when no lyric is stored for it); `path` is the resolved
 * library file path of the current track (null when unknown — used for cover
 * art). `karaokeLyric` is the same song in inline-timestamp LRC form (from
 * Netease YRC) when available — null otherwise. It's decoupled from `lyric`
 * so the desktop window keeps using the plain LRC while the in-app page can
 * do real word-by-word karaoke.
 */
export interface LyricPlaybackState {
  ok: boolean
  status: PlayerStatus['status']
  track: string
  artist: string
  album: string
  player: string
  positionMs: number | null
  lengthMs: number | null
  lyric: string | null
  karaokeLyric?: string | null
  path?: string | null
}
