/**
 * 用户 / 助手的形象（名字、头像）与它们对 AI 是否可见。主进程与渲染端共用的纯函数。
 */
import type { YayaProfile } from './types'

/** 头像 data URL 上限（渲染端会先缩到 192px，正常只有几十 KB） */
export const AVATAR_MAX_CHARS = 400_000
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

export function normalizeAvatar(v: unknown): string {
  return typeof v === 'string' && v.length <= AVATAR_MAX_CHARS && AVATAR_RE.test(v) ? v : ''
}

export function normalizeProfile(raw: unknown): YayaProfile {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const name = typeof p.userName === 'string' ? p.userName.trim().slice(0, 32) : ''
  const mode = p.assistantAvatarMode
  return {
    userName: name,
    userAvatar: normalizeAvatar(p.userAvatar),
    userNameVisible: p.userNameVisible !== false,
    userAvatarVisible: p.userAvatarVisible === true,
    assistantAvatar: normalizeAvatar(p.assistantAvatar),
    assistantAvatarMode: mode === 'custom' || mode === 'model' ? mode : 'default',
    assistantLabel: p.assistantLabel === 'model' ? 'model' : 'name',
    assistantNameVisible: p.assistantNameVisible !== false
  }
}

/** 「模型头像」：模型名的缩写 + 按名字稳定取色，如 gpt-5.5 → G5、deepseek-chat → DC */
export function modelMonogram(model: string): { text: string; hue: number } {
  const clean = (model || '?').replace(/^.*\//, '')
  const words = clean.split(/[-_\s.:]+/).filter(Boolean)
  let text = ''
  for (const w of words) {
    text += /^\d/.test(w) ? w[0] : w[0].toUpperCase()
    if (text.length >= 2) break
  }
  let hash = 0
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return { text: text || '?', hue: hash % 360 }
}
