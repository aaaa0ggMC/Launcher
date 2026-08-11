export interface AidjConfig {
  music_folders: string[]
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
    record_freq: boolean
    dynamic_balance_volume: boolean
    sound_adjust_method: 'lufs' | 'linear'
    volume_curve: number
    metadata_concurrency: number
    /** Context management mode: discard drops oldest messages, compact summarizes them. */
    context_mode: 'discard' | 'compact'
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
  }
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
export const FREQ_FILE = 'frequency.csv'
export const PLAYLISTS_DIR = 'playlists'
