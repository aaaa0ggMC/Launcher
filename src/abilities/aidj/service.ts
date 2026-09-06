/**
 * AIDJ Core Service Facade.
 *
 * Subsystems are modularized under `services/`:
 * - `config.ts`: Configuration, EQ profiles, frequency tracking, paths.
 * - `cover.ts`: Cover art resolution (directory file & embedded tags).
 * - `loudness.ts`: LoudnessCache, integrated LUFS / volumedetect analysis & gain curve.
 * - `lyrics.ts`: YRC/LRC conversion, lyric resolution & playback formatting.
 * - `library.ts`: Music scanning, metadata persistence, library caching & diffing.
 * - `ncm.ts`: Netease Cloud Music search, comment fetching, AI extraction & sync.
 * - `dbus.ts`: MPRIS DBusManager, player switching, playback detail & track resolution.
 * - `session.ts`: DJSession, PersistentSession, SessionManager, retry helpers.
 */

export * from './services/config'
export * from './services/cover'
export * from './services/loudness'
export * from './services/lyrics'
export * from './services/library'
export * from './services/ncm'
export * from './services/dbus'
export * from './services/session'
