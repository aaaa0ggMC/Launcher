export type VarType = 'string' | 'number' | 'select' | 'textarea' | 'bool'

export type VarConstraint =
  | { kind: 'range'; min: number; max: number }
  | { kind: 'min'; val: number }
  | { kind: 'max'; val: number }
  | { kind: 'options'; values: string[] }

export interface ParsedVar {
  name: string
  type: VarType
  constraint: VarConstraint | null
  defaultValue: string | undefined
}

export interface TemplatePart {
  kind: 'text' | 'var'
  value: string
  varInfo?: ParsedVar
}

export interface RespTransform {
  id: string
  type: 'text' | 'img' | 'audio' | 'audio-url' | 'video-url' | 'task' | 'script'
  label: string
  format: string
  entry: string
  encoding: 'base64' | 'hex8'
  audioMime: string
  /** User JS source for `script` transforms. */
  script: string
  /** Bumped by the "Update" button; script only re-executes when this changes. */
  scriptVersion: number
  /** Local key/value pairs accessible to `script` transforms via `context.local`. */
  localVars: { key: string; value: string }[]
  // Task acquire
  taskAddr: string
  taskMethod: string
  taskHeaders: string
  taskQuery: string
  taskStatusPath: string
  taskStatusVal: string
  taskPollMs: number
  taskFailVal: string
  taskFailReasonPath: string
  taskTransforms: RespTransform[]
}

export interface RequestTemplate {
  id: string
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  urlTemplate: string
  headersTemplate: string
  bodyTemplate: string
  respTransforms: RespTransform[]
  createdAt: number
}

export interface SendHistoryEntry {
  id: string
  templateId: string
  values: Record<string, string>
  duration: number | null
  error: string | null
  timestamp: number
}

export interface GlobalVar {
  key: string
  value: string
  secret: boolean
}
