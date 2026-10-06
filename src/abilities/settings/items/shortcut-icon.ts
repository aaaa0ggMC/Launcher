/**
 * 把页面上渲染好的能力图标（AbilityIcon：SVG / 图片 / emoji）画成桌面快捷方式用的方形 PNG
 * data URL：深色底（与 App 启动图标同色）+ 居中图标，图标约占六成面积。画不出来返回 null，
 * 原生侧退回 App 自己的图标。
 */
const SIZE = 192
const BG = '#1B1F24'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('icon load failed'))
    img.src = src
  })
}

export async function iconToDataUrl(host: HTMLElement): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, SIZE, SIZE)
  const inner = SIZE * 0.6
  const at = (SIZE - inner) / 2
  try {
    const svg = host.querySelector('svg')
    const img = host.querySelector('img')
    if (svg) {
      const copy = svg.cloneNode(true) as SVGSVGElement
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      copy.setAttribute('width', String(inner))
      copy.setAttribute('height', String(inner))
      // currentColor 在独立的 SVG 图片里没有上下文：换成图标当前的实际颜色
      copy.style.color = getComputedStyle(host).color
      const xml = new XMLSerializer()
        .serializeToString(copy)
        .replace(/currentColor/g, getComputedStyle(host).color)
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
      ctx.drawImage(await loadImage(url), at, at, inner, inner)
    } else if (img) {
      ctx.drawImage(await loadImage(img.src), at, at, inner, inner)
    } else {
      const text = host.textContent?.trim()
      if (!text) return null
      ctx.font = `${Math.round(inner * 0.85)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, SIZE / 2, SIZE / 2 + inner * 0.04)
    }
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
