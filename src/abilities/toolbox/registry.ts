import type { ToolDefinition } from './types'
import { definitions as developer } from './tools/developer/definitions'
import { definitions as text } from './tools/text/definitions'
import { definitions as image } from './tools/image/definitions'
import { definitions as files } from './tools/files/definitions'
import { definitions as time } from './tools/time/definitions'
import { definitions as leisure } from './tools/leisure/definitions'

export const tools: ToolDefinition[] = [
  ...time,
  ...developer,
  ...text,
  ...image,
  ...files,
  ...leisure
]
const seen = new Set<string>()
for (const tool of tools) {
  if (!/^[a-z][a-z0-9-]*$/.test(tool.id) || seen.has(tool.id)) {
    throw new Error(`Invalid or duplicate toolbox tool: ${tool.id}`)
  }
  seen.add(tool.id)
}
export const toolById = new Map(tools.map((tool) => [tool.id, tool]))
