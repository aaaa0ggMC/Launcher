// Shared markdown helpers for the playground components' toMarkdown() output.

/** Escape a value so it renders safely inside an inline code span. */
export function inline(s: string): string {
  return s.replace(/`/g, '\\`').replace(/\r?\n/g, '\\n')
}

/** Wrap text in a fenced code block, guarding against embedded triple backticks. */
export function fence(s: string, lang?: string): string {
  const body = s.replace(/```/g, '` ` `')
  return ['```' + (lang ?? ''), body, '```'].join('\n')
}
