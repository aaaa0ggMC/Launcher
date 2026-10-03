/**
 * Prompt templates of the DJ loop. The text lives in `loop/prompts/<name>.md`
 * (one file per template — edit those, not this file); this module only loads,
 * overrides and renders them.
 *
 * Each template may be overridden from `preferences.loop_prompts.<name>` in the
 * AIDJ config (empty / missing → the file). Placeholders are `{name}`, rendered
 * in one pass (inserted values are never re-scanned); unknown placeholders stay
 * as-is. Preview the next prompt without calling the LLM: `aidj.loop-preview`.
 *
 * Common placeholders:
 *   {goal} {phase} {batchSize} {candidateTarget} {recent} {relaxHint} {played}
 *   {artistRule} {maxPerArtist} {finishWhat}  — batch instruction (planner.ts)
 *   {persona} {extraRules} {body} {playbooks} {filterGuide} {finish}  — system prompts
 *   {separator} {brief} {limit} {seeds} {instruction} {note} {pinned} {candidates}
 */
import type { AidjConfig } from '../types'
import { loopAssets } from './assets'

/** Template names = file names in `loop/prompts/`. */
export const LOOP_PROMPT_NAMES = [
  // agent kernel
  'agent_role',
  'agent_system',
  'agent_rules',
  'finish_rank',
  'finish_intro',
  'filter_light',
  'filter_medium',
  'filter_strong',
  // sub-agents
  'library_agent',
  'library_agent_brief',
  'dream_agent',
  'dream_agent_brief',
  'rank_agent',
  'rank_agent_brief',
  // batch instruction (both modes)
  'initial',
  'directed',
  'autonomous',
  'relax_keep',
  'relax_loose',
  'artist_rule',
  // metadata sanitizer
  'tag_vocab',
  'tag_vocab_user',
  'tag_vocab_canonical',
  'tag_vocab_map',
  'tag_vocab_map_user',
  'sanitize_agent',
  'sanitize_agent_user',
  // text mode
  'rules',
  'text_system',
  'text_layout',
  'text_turn'
] as const

export type LoopPromptName = (typeof LOOP_PROMPT_NAMES)[number]
export type LoopPrompts = Record<LoopPromptName, string>

function loadDefaults(): LoopPrompts {
  const files = loopAssets('prompts')
  const missing = LOOP_PROMPT_NAMES.filter((n) => typeof files[n] !== 'string')
  if (missing.length) throw new Error(`AIDJ loop prompt files missing: ${missing.join(', ')}`)
  return Object.fromEntries(LOOP_PROMPT_NAMES.map((n) => [n, files[n]])) as LoopPrompts
}

/** Built-in templates (the `.md` files). */
export const DEFAULT_LOOP_PROMPTS: LoopPrompts = loadDefaults()

export function resolveLoopPrompts(config: AidjConfig | null | undefined): LoopPrompts {
  const raw = (config?.preferences?.loop_prompts ?? {}) as Partial<LoopPrompts>
  const out = { ...DEFAULT_LOOP_PROMPTS }
  for (const k of LOOP_PROMPT_NAMES) {
    const v = raw[k]
    if (typeof v === 'string' && v.trim()) out[k] = v
  }
  return out
}

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
