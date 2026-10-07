/**
 * speech 插件的纯文本工具（主进程 / 渲染端共用，不碰 DOM / fs）：
 * - `speechText`：把回答的 Markdown 变成适合朗读的纯文本（去掉代码块、链接地址、表格竖线等符号）；
 * - `splitSpeech`：按句子切成若干段，逐段合成 / 朗读。第一段短一些，让声音尽快出来。
 */

/** Markdown → 朗读用纯文本 */
export function speechText(md: string): string {
  let s = md.replace(/\r\n?/g, '\n')
  // 代码块 / 数学块：念出来没意义，整块去掉
  s = s.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\s*\1[^\n]*|$)/gm, '\n')
  s = s.replace(/\$\$[\s\S]*?\$\$/g, ' ')
  // 图片去掉；链接只留文字；裸网址去掉
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/<https?:\/\/[^>]+>/g, ' ')
  s = s.replace(/https?:\/\/\S+/g, ' ')
  // HTML 标签
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  // 行内代码 / 行内公式：留内容
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/\$([^$\n]+)\$/g, '$1')
  const lines = s.split('\n').map((line) => {
    let l = line
    // 表格分隔行整行去掉，其余行的竖线换成停顿
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)) return ''
    if (/^\s*---+\s*$|^\s*\*\*\*+\s*$/.test(l)) return ''
    l = l.replace(/^\s{0,3}#{1,6}\s+/, '')
    l = l.replace(/^\s*>\s?/, '')
    l = l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    if (l.includes('|'))
      l = l
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .replace(/\s*\|\s*/g, '，')
    return l
  })
  s = lines.join('\n')
  // 强调符号 / 删除线 / 脚注标记
  s = s.replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
  s = s.replace(/\[\^[^\]]+\]/g, '')
  return (
    s
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      // 标题 / 列表项这类没有句末标点的行补一个，念的时候才有停顿（逐行拼段时不会连成一句）
      .map((l) =>
        /[。！？!?；;…：:，,.、)）」』"”]$/.test(l) ? l : l + (CJK_END.test(l) ? '。' : '.')
      )
      .join('\n')
  )
}

/** 句末标点（含中文）与紧跟的右引号 / 右括号 */
/** 以中日韩文字 / 全角标点结尾：拼下一句时不加空格 */
const CJK_END = /[\u3000-\u9fff\uff00-\uffef]$/

const END_CHARS = '。！？!?；;…'
const CLOSERS = '"\'”’）)」』'

/** 按句子切（换行也算一句结束），保留句末标点 */
export function sentencesOf(text: string): string[] {
  const out: string[] = []
  let cur = ''
  const push = (): void => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      push()
      continue
    }
    cur += c
    const isEnd =
      END_CHARS.includes(c) || (c === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1])))
    if (!isEnd) continue
    while (
      i + 1 < text.length &&
      (END_CHARS.includes(text[i + 1]) || CLOSERS.includes(text[i + 1]))
    )
      cur += text[++i]
    push()
  }
  push()
  return out
}

/**
 * 切段：先按句子切，再把句子拼到不超过 `max` 字；第一段上限是 `first`（尽快出声）。
 * 单句比上限还长就在逗号 / 空白处硬切。
 */
export function splitSpeech(text: string, max = 400, first = Math.min(120, max)): string[] {
  const sentences = sentencesOf(text)
  const out: string[] = []
  let cur = ''
  const limit = (): number => (out.length === 0 ? first : max)
  const flush = (): void => {
    const v = cur.trim()
    if (v) out.push(v)
    cur = ''
  }
  for (const raw of sentences) {
    let sentence = raw.trim()
    if (!sentence) continue
    while (sentence.length > limit()) {
      // 单句太长：在上限内最后一个逗号 / 空白处切开
      flush()
      const lim = limit()
      const head = sentence.slice(0, lim)
      const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf(' '))
      const at = cut > lim / 3 ? cut + 1 : lim
      out.push(sentence.slice(0, at).trim())
      sentence = sentence.slice(at).trim()
    }
    if (cur && (cur + sentence).length > limit()) flush()
    cur = cur ? `${cur}${CJK_END.test(cur) ? '' : ' '}${sentence}` : sentence
  }
  flush()
  return out.filter(Boolean)
}
