/** Data-only tool contracts shared by the renderer and command registry. */
export type ToolCategory = 'developer' | 'text' | 'image' | 'files' | 'time' | 'leisure'
export interface ToolField {
  key: string
  label: string
  labelEn?: string
  type:
    'text' | 'textarea' | 'number' | 'select' | 'boolean' | 'file' | 'files' | 'password' | 'color'
  default?: string | number | boolean
  placeholder?: string
  options?: { title: string; value: string | number }[]
  min?: number
  max?: number
  accept?: string
  required?: boolean
  hint?: string
}
export interface ToolDefinition {
  id: string
  title: string
  titleEn: string
  description: string
  descriptionEn?: string
  category: ToolCategory
  icon: string
  keywords: string[]
  fields: ToolField[]
  view?: 'epoch' | 'pomodoro'
  /** Fixed external executable requirement, shown before users run the tool. */
  dependency?: string
  /** Needs outbound network access (the only exception to the offline rule). */
  network?: boolean
  /** Secrets/password-based operations stay user-only. */
  agentDenied?: boolean
}
export interface ToolFile {
  name: string
  mime: string
  base64: string
}
export interface ToolResult {
  ok: boolean
  text?: string
  data?: unknown
  files?: ToolFile[]
  error?: string
  note?: string
}
export type ToolArgs = Record<string, unknown>
export interface ToolModule {
  definitions: ToolDefinition[]
  execute: (id: string, args: ToolArgs) => ToolResult | Promise<ToolResult>
}

/** In-memory file-job state; payload is read through the toolbox privacy scope. */
export interface ToolTask {
  id: string
  tool: string
  status: 'running' | 'done' | 'cancelled'
  result?: ToolResult
}
