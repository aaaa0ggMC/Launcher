/**
 * Command contract — the ability-injected command registry.
 *
 * Every ability owns a set of commands (`src/abilities/<id>/commands.ts`),
 * each exporting a `CommandSpec[]`. The main-process abilities loader
 * (`src/main/process/abilities-loader.ts`) globs those files and registers
 * them here, so adding a new ability only means adding a folder — never
 * editing a central switchboard.
 */

export interface CommandContext {
  /** --key value pairs (CLI) or structured object (UI via IPC). */
  named: Record<string, unknown>
  /** bare positional tokens (CLI). */
  positional: string[]
  /** 命令声明了 `exclusive` 时由注册表填入当前租约（写盘处把 epoch 传给 `assertFence`）。 */
  lease?: { scope: string; key: string; epoch: number }
}

export interface CommandSpec {
  /** kebab-case, namespaced `<ability>.<command>` */
  name: string
  description: string
  usage?: string
  /** Set false when user-supplied content must not be persisted in IPC logs. */
  logArgs?: boolean
  run: (ctx: CommandContext) => unknown | Promise<unknown>
  /**
   * Optional runtime gate — when it resolves false the command behaves as NOT
   * registered (the CLI/UI report an unknown command). Used for mode-gated
   * commands (e.g. MPRIS-only commands hidden in web-player mode) instead of
   * per-command `if` guards. Shared commands that exist in both modes keep the
   * normal dispatch (the gate is evaluated at every dispatch).
   */
  enabled?: () => boolean | Promise<boolean>
  /**
   * Why the command is unavailable when `enabled` resolves false — surfaced in
   * the command catalog and in the dispatch error (instead of a bare "unknown
   * command"), e.g. `'需要 MPRIS/DBus 播放模式（当前为内置播放器模式）'`.
   */
  unavailableReason?: string
  /**
   * Related commands / named jobs an agent should know about — e.g. the newer
   * command that supersedes this one, or the job a UI flow actually starts.
   * Free-form refs: `'aidj.session-fork'`, `'job:aidj.chat'`.
   */
  related?: string[]
  /**
   * UI entry points that trigger this command (cross-layer map), e.g.
   * `['aidj 聊天框 /persist']`. Lets an agent go from what the user sees to
   * the command, and back.
   */
  ui?: string[]
  /**
   * Agent-facing privacy declaration (see `src/main/process/privacy.ts` and
   * docs/agent-access-design.md §3.4). Only consulted for agent origins
   * (remote / mcp / script-agent); UI / CLI dispatch is unaffected.
   */
  privacy?: CommandPrivacy
  /**
   * 独占声明（独占 SDK，见 `src/main/process/exclusive.ts`）：执行前自动获取 / 续期 `scope`+`key` 的租约，
   * 冲突时抛 ExclusiveBusyError / LeaseLostError。`access: 'read'` 的命令不获取租约（截图 / 状态等）。
   */
  exclusive?: {
    scope: string
    key: (ctx: CommandContext) => string | Promise<string>
    access?: 'write' | 'read'
  }
}

export interface CommandPrivacy {
  /** Scopes the result may contain (already shielded at the source) — shown to agents. */
  reads?: string[]
  /** Scopes an agent must hold before the command runs (`guard` is applied by the registry). */
  requires?: string[]
  /** `deny` = agents may never call this command (credential login, privacy settings…). */
  agent?: 'deny'
}
