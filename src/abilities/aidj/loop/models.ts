/**
 * Per-agent model selection. `preferences.agent_models.<role>` picks a model
 * for one agent; empty / missing falls back to the default `preferences.model`
 * (also used by text mode and title generation).
 */
import type { AidjConfig } from '../types'

export const AGENT_ROLES = ['loop', 'lib', 'dream', 'rank', 'vocab', 'sanitize'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export function agentModel(config: AidjConfig, role: AgentRole): string {
  const own = config.preferences.agent_models?.[role]
  return (typeof own === 'string' && own.trim()) || config.preferences.model
}
