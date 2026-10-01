/**
 * Agent 会话登记：每个 MCP 会话 / Remote 客户端一条，供设置页展示与断开。
 * 会话结束时撤销它的 once 授权（privacy.revokeSessionGrants）。
 */
import { getBroadcast } from '../broadcast'
import { revokeSessionGrants } from '../privacy'

export interface AgentSession {
  id: string
  transport: 'mcp' | 'remote'
  client: string
  startedAt: number
  lastSeen: number
  calls: number
}

const sessions = new Map<string, AgentSession>()
const closers = new Map<string, () => void>()

function changed(): void {
  getBroadcast()('cockpit:agent-sessions', listSessions())
}

export function touchSession(
  id: string,
  transport: AgentSession['transport'],
  client: string,
  close?: () => void
): AgentSession {
  const now = Date.now()
  let s = sessions.get(id)
  if (!s) {
    s = { id, transport, client, startedAt: now, lastSeen: now, calls: 0 }
    sessions.set(id, s)
    if (close) closers.set(id, close)
    changed()
  }
  if (client && s.client !== client) s.client = client
  s.lastSeen = now
  s.calls++
  return s
}

export function endSession(id: string): void {
  if (!sessions.delete(id)) return
  closers.delete(id)
  revokeSessionGrants(id)
  changed()
}

/** 设置页「断开」：关闭底层连接（MCP transport）并清理。 */
export function disconnectSession(id: string): boolean {
  const close = closers.get(id)
  if (!sessions.has(id)) return false
  try {
    close?.()
  } finally {
    endSession(id)
  }
  return true
}

export function endTransportSessions(transport: AgentSession['transport']): void {
  for (const s of [...sessions.values()]) if (s.transport === transport) disconnectSession(s.id)
}

export function listSessions(): AgentSession[] {
  return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}
