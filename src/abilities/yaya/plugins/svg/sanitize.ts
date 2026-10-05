/**
 * SVG 净化：模型输出是不可信内容。先用 DOMParser 按 XML（image/svg+xml）解析，
 * 删掉 script / foreignObject、所有 on* 事件属性、以及不是 `#` 开头的外链引用
 * （href / xlink:href），再序列化。
 *
 * 调用方把结果做成 data URL 用 `<img>` 显示——图片上下文里脚本本来就不执行、
 * 也不加载外部资源；净化是第二道防线（防的是 <use> 外部引用之类在部分查看器里的行为）。
 *
 * 净化规则拆成两份：
 * - `sanitizeElement`：只依赖一棵「元素抽象树」，纯逻辑，可在 node:test 里用手写树测；
 * - `sanitizeSvg`：解析 + 净化 + 序列化，解析 / 序列化实现由 `SvgDom` 注入
 *   （浏览器实现见 `browserSvgDom`，测试里可注入最小 DOM）。
 */

/** 净化需要的最小元素能力（浏览器用 DOMParser 的元素包一层；测试用手写树） */
export interface SanitizeElement {
  /** 小写标签名 */
  readonly tag: string
  /** 属性名（原样，含 `xlink:href` 这类带前缀的） */
  attributeNames(): string[]
  getAttribute(name: string): string | null
  removeAttribute(name: string): void
  /** 所有后代元素的实时快照（不含自身） */
  descendants(): SanitizeElement[]
  /** 把自己从父节点摘下（已在树外的节点再 remove 是无操作） */
  remove(): void
}

/** 解析 + 序列化（浏览器用 DOMParser / XMLSerializer 包一层，见 browserSvgDom） */
export interface SvgDom {
  /** 解析 SVG；不是合法 XML / 根元素不是 svg 时返回 null */
  parse(text: string): SanitizeElement | null
  serialize(root: SanitizeElement): string
}

/** 直接删除的标签：脚本与富文本容器（foreignObject 里能塞任意 HTML） */
const DROP_TAGS = new Set(['script', 'foreignobject'])

/** 引用属性：只允许 `#` 开头的文档内引用（内部 <defs> / symbol） */
const REF_ATTRS = new Set(['href', 'xlink:href'])

/**
 * 纯净规则（纯函数，不依赖具体 DOM 实现）：就地清理一棵已解析的 SVG 树。
 * descendants() 是快照，遍历中删除节点是安全的。
 */
export function sanitizeElement(root: SanitizeElement): void {
  for (const el of root.descendants()) {
    if (DROP_TAGS.has(el.tag.toLowerCase())) {
      el.remove()
      continue
    }
    for (const name of el.attributeNames()) {
      if (name.toLowerCase().startsWith('on')) {
        el.removeAttribute(name)
        continue
      }
      if (REF_ATTRS.has(name)) {
        const value = el.getAttribute(name) ?? ''
        if (!value.startsWith('#')) el.removeAttribute(name)
      }
    }
  }
}

/** 解析 → 净化 → 序列化；text 不是合法 SVG（解析失败 / 根元素不是 svg）时返回 null */
export function sanitizeSvg(text: string, dom: SvgDom): string | null {
  const root = dom.parse(text)
  if (!root || root.tag !== 'svg') return null
  sanitizeElement(root)
  return dom.serialize(root)
}

/**
 * 浏览器实现。DOMParser 对畸形 XML 会给出 `parsererror` 根节点——按根元素不是 svg
 * 处理（返回 null，由调用方回退显示源码）。
 */
export function browserSvgDom(): SvgDom {
  const raw = new WeakMap<SanitizeElement, Element>()
  return {
    parse(text) {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      const el = doc?.documentElement
      if (!el || el.tagName.toLowerCase() !== 'svg') return null
      const wrapped = wrapElement(el)
      raw.set(wrapped, el)
      return wrapped
    },
    serialize(root) {
      const el = raw.get(root)
      return el ? new XMLSerializer().serializeToString(el) : ''
    }
  }
}

function wrapElement(el: Element): SanitizeElement {
  return {
    get tag(): string {
      return el.tagName.toLowerCase()
    },
    attributeNames: () => Array.from(el.attributes, (a) => a.name),
    getAttribute: (name) => el.getAttribute(name),
    removeAttribute: (name) => el.removeAttribute(name),
    descendants: () => Array.from(el.querySelectorAll('*')).map(wrapElement),
    remove: () => el.remove()
  }
}
