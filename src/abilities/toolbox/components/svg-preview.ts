/** SVG downloads may contain user text; preview only a non-executable, offline subset. */
export function safeSvgPreview(base64: string): string | undefined {
  if (base64.length > 8 * 1024 * 1024) return undefined
  try {
    const svg = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    )
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(svg)) return undefined
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg')
      return undefined
    const elements = new Set([
      'svg',
      'g',
      'rect',
      'circle',
      'ellipse',
      'line',
      'polyline',
      'polygon',
      'path',
      'text',
      'tspan',
      'textPath',
      'defs',
      'linearGradient',
      'radialGradient',
      'stop',
      'clipPath',
      'image',
      'title',
      'desc'
    ])
    for (const element of document.querySelectorAll('*')) {
      if (!elements.has(element.localName) || element.namespaceURI !== 'http://www.w3.org/2000/svg')
        return undefined
      for (const attribute of element.attributes) {
        const value = attribute.value.trim()
        if (attribute.localName === 'base') return undefined
        if (/^on/i.test(attribute.name) || /@import|javascript:/i.test(value)) return undefined
        if (
          attribute.localName === 'href' &&
          !/^#[\w-]+$/.test(value) &&
          !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
        )
          return undefined
        for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
          if (!/^['"]?#[\w-]+['"]?$/.test(match[1].trim())) return undefined
        }
      }
    }
    return `data:image/svg+xml;base64,${base64}`
  } catch {
    return undefined
  }
}
