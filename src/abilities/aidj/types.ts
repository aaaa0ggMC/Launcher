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
    verbose: boolean
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
    /** Status bar chip visibility & order. 0 = hidden, 1+ = display order. */
    status_bar: {
      tokens: number
      tracks: number
      memory: number
      volbal: number
      record_freq: number
      backgrounds: number
    }
  }
}

export interface SongMeta {
  language?: string
  emotion?: string | string[]
  genre?: string | string[]
  loudness?: string
  review?: string
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
