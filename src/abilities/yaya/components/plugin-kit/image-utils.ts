/**
 * 图类显示插件的公共小工具：SVG 文本 → data URL（`<img>` 显示）、
 * data URL → PNG（canvas 重绘，供导出）。都不碰 v-html——模型输出不可信，
 * 图一律走图片上下文。
 */

/** SVG 文本 → data URL（charset=utf-8 + encodeURIComponent，非 ASCII 安全） */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * 把 SVG 的 data URL 画进 canvas 导出 PNG（2x 清晰度，白底——PNG 无 alpha 通道，
 * 透明底在多数看图软件里是黑的）。失败返回 null（图片解码不出来 / canvas 不可用）。
 */
export async function svgToPngDataUrl(src: string, scale = 2): Promise<string | null> {
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('decode failed'))
      img.src = src
    })
    // SVG 没有 width/height 时 naturalWidth 可能是 0，给个兜底尺寸
    const w = img.naturalWidth || 960
    const h = img.naturalHeight || 640
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
