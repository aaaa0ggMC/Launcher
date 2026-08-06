/**
 * Simple markdown → HTML renderer.
 * Pure function, no dependencies. Safe for both main and renderer processes.
 * Input is HTML-escaped first, then markdown patterns are replaced.
 */

export function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  html = html
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang: string, code: string) => {
      const lines = code
        .split('\n')
        .map((l: string) => l.trimEnd())
        .join('\n')
      return `<pre><code>${lines}</code></pre>`
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  // Tables: | col1 | col2 | → <table><tr><td>...
  html = html.replace(
    /^\|(.+)\|\n\|[-| :]+\|\n((?:(?:^\|.+\|\n?)*))/gm,
    (_match: string, headerRow: string, bodyRows: string) => {
      const headers = headerRow
        .split('|')
        .map((h: string) => h.trim())
        .filter(Boolean)
      const rows = bodyRows
        .trim()
        .split('\n')
        .map((row: string) => {
          const cells = row
            .split('|')
            .map((c: string) => c.trim())
            .filter(Boolean)
          return `<tr>${cells.map((c: string) => `<td>${c}</td>`).join('')}</tr>`
        })
        .join('')
      return `<table><thead><tr>${headers.map((h: string) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
    }
  )

  // Lists: - item or 1. item
  html = html.replace(/^( *)((?:-|\d+\.) .+(\n\1 (?:-|\d+\.) .+)*)/gm, (_match, _indent, content) => {
    const items = content
      .split('\n')
      .map((line: string) => {
        const m = line.match(/^( *)(?:-|\d+\.)\s+(.+)/)
        return m ? `<li>${m[2]}</li>` : ''
      })
      .filter(Boolean)
      .join('')
    return `<ul>${items}</ul>`
  })

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Paragraphs: double newline separates paragraphs
  const parts = html.split(/\n\n+/)
  html = parts
    .map((block: string) => {
      block = block.trim()
      if (!block) return ''
      if (
        block.startsWith('<pre>') ||
        block.startsWith('<table>') ||
        block.startsWith('<ul>') ||
        block.startsWith('<h') ||
        block.startsWith('<li>')
      ) {
        return block
      }
      // Single newlines within a paragraph become <br>
      block = block.replace(/\n/g, '<br>')
      return `<p>${block}</p>`
    })
    .join('\n')

  return html
}