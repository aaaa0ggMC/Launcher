/**
 * yarj 高级照片搜索与过滤语法引擎
 *
 * 语法规范：
 * 1. 兼容现有常规搜索：
 *    - 若没有使用指令 (:)、引号 ("") 或括号 (())，则 100% 保持原有搜索行为；
 *    - 例如搜索 `text and love` 检索的就是字面包含 "text and love" 的内容；
 *    - 例如搜索 `text or love` 检索的就是字面包含 "text or love" 的内容。
 *
 * 2. 划定与布尔逻辑：
 *    - 使用引号划定精确词组，如 `"text and love" or "love and peace"`；
 *    - 支持顶层布尔运算：and / or / not，支持括号嵌套 (A or B) and C；
 *
 * 3. 指令语法：:directiveName 或 :directiveName(args...)
 *    - :guess_gps / :guess         列出所有处于猜测阶段的 GPS 图片
 *    - :has_gps / :gps             筛选有真实 GPS 定位的照片
 *    - :no_gps                     筛选无 GPS 且无推测的照片
 *    - :tags("风景" and "夜景")     标签过滤，支持 and / or / not / 逗号列表
 *    - :city("北京" or "上海")       拍摄城市
 *    - :country("中国" or "日本")   拍摄国家/地区
 *    - :address("故宫" or "西湖")    详细地址
 *    - :camera("Sony" and "A7M4")  相机品牌/型号
 *    - :lens("24-70" or "50mm")    镜头型号
 *    - :iso(> 800) / :iso(100, 200) 感光度数值比较
 *    - :f(<= 2.8)                  光圈数值比较
 *    - :focal(>= 50)               焦距 (mm) 数值比较
 *    - :year(2024 or 2025)         拍摄年份
 *    - :date(>= 2024-06-01)        拍摄日期/区间比较
 *    - :name("IMG_" and not ".heic") 文件名匹配
 *    - :path("2024年旅行")          文件完整路径匹配
 *    - :comment("暑假" and not "作业") 照片备注
 *    - :appendix(key, valueExpr)   自定义 appendix 属性
 *    - :video / :image             媒体类型过滤
 *    - :flagged / :rejected        标记/排除状态
 */

import type { Photo } from './types'
import { isVideoFile, resolvePhotoGps } from './types'
import { haversineDistance } from './photo-guess'

export type SearchAstNode =
  | { type: 'and'; left: SearchAstNode; right: SearchAstNode }
  | { type: 'or'; left: SearchAstNode; right: SearchAstNode }
  | { type: 'not'; operand: SearchAstNode }
  | { type: 'text'; query: string; exact?: boolean }
  | { type: 'directive'; name: string; args: string }

export interface InnerExprNode {
  type: 'and' | 'or' | 'not' | 'term'
  left?: InnerExprNode
  right?: InnerExprNode
  operand?: InnerExprNode
  value?: string
}

// ---------------------------------------------------------------------------
// 检查是否包含高级语法特征
// ---------------------------------------------------------------------------

export function hasAdvancedSyntax(query: string): boolean {
  if (!query) return false
  // 包含指令冒号（如 :guess_gps、:tags）、引号（""、''）或括号 ( )
  return /:[a-zA-Z0-9_\u4e00-\u9fa5-]+/i.test(query) || /["'()]/.test(query)
}

// ---------------------------------------------------------------------------
// 词法分析 Tokenizer
// ---------------------------------------------------------------------------

type TokenType = 'AND' | 'OR' | 'NOT' | 'LPAREN' | 'RPAREN' | 'DIRECTIVE' | 'QUOTED' | 'TEXT'

interface Token {
  type: TokenType
  value: string
  directiveArgs?: string
}

export function tokenizeSearchQuery(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = src.length

  while (i < n) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }

    if (c === '(') {
      tokens.push({ type: 'LPAREN', value: '(' })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ type: 'RPAREN', value: ')' })
      i++
      continue
    }

    // 字符串引号（"..." 或 '...'）
    if (c === '"' || c === "'") {
      let buf = ''
      const quote = c
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          buf += src[i + 1]
          i += 2
        } else {
          buf += src[i]
          i++
        }
      }
      if (i < n && src[i] === quote) i++
      tokens.push({ type: 'QUOTED', value: buf })
      continue
    }

    // 指令 token：以冒号开头 :directive 或 :directive(...)
    if (c === ':') {
      let j = i + 1
      while (j < n && /[a-zA-Z0-9_\u4e00-\u9fa5-]/.test(src[j])) {
        j++
      }
      const dirName = src.slice(i + 1, j).toLowerCase()
      if (dirName) {
        // 检查后面是否紧跟括号参数，如 :tags("foo", "bar")
        if (j < n && src[j] === '(') {
          let pCount = 1
          let k = j + 1
          let inQuote: string | null = null
          while (k < n && pCount > 0) {
            const ch = src[k]
            if (inQuote) {
              if (ch === inQuote && src[k - 1] !== '\\') {
                inQuote = null
              }
            } else if (ch === '"' || ch === "'") {
              inQuote = ch
            } else if (ch === '(') {
              pCount++
            } else if (ch === ')') {
              pCount--
            }
            if (pCount > 0) k++
          }
          const args = src.slice(j + 1, k)
          i = k < n ? k + 1 : n
          tokens.push({ type: 'DIRECTIVE', value: dirName, directiveArgs: args })
          continue
        } else {
          tokens.push({ type: 'DIRECTIVE', value: dirName, directiveArgs: '' })
          i = j
          continue
        }
      }
    }

    // 普通词法单元（单词、布尔关键字）
    let j = i
    while (j < n && !/\s/.test(src[j]) && src[j] !== '(' && src[j] !== ')') {
      j++
    }
    const word = src.slice(i, j)
    i = j

    const lower = word.toLowerCase()
    if (lower === 'and' || word === '&&') {
      tokens.push({ type: 'AND', value: 'and' })
    } else if (lower === 'or' || word === '||') {
      tokens.push({ type: 'OR', value: 'or' })
    } else if (lower === 'not' || word === '!') {
      tokens.push({ type: 'NOT', value: 'not' })
    } else {
      tokens.push({ type: 'TEXT', value: word })
    }
  }

  return tokens
}

// ---------------------------------------------------------------------------
// 语法解析器 AST Parser
// ---------------------------------------------------------------------------

export function parseSearchQuery(query: string): SearchAstNode | null {
  const trimmed = query.trim()
  if (!trimmed) return null

  // 如果不包含任何指令、引号或括号，直接作为纯文本搜索（保持现有行为：如 "text and love" 就是查文字）
  if (!hasAdvancedSyntax(trimmed)) {
    return { type: 'text', query: trimmed, exact: false }
  }

  try {
    const tokens = tokenizeSearchQuery(trimmed)
    if (!tokens.length) return null

    let pos = 0
    const peek = (): Token | undefined => tokens[pos]
    const next = (): Token | undefined => tokens[pos++]

    function parseOr(): SearchAstNode {
      let left = parseAnd()
      while (peek()?.type === 'OR') {
        next()
        const right = parseAnd()
        // 宽容处理用户正在输入但尚未输入右操作数的情况，如 `xxx or `
        if (!right || (right.type === 'text' && !right.query)) {
          return left
        }
        left = { type: 'or', left, right }
      }
      return left
    }

    function parseAnd(): SearchAstNode {
      let left = parseUnary()
      while (true) {
        const p = peek()
        if (!p || p.type === 'OR' || p.type === 'RPAREN') {
          break
        }
        if (p.type === 'AND') {
          next()
          const right = parseUnary()
          if (!right || (right.type === 'text' && !right.query)) {
            return left
          }
          left = { type: 'and', left, right }
        } else if (
          p.type === 'NOT' ||
          p.type === 'LPAREN' ||
          p.type === 'DIRECTIVE' ||
          p.type === 'QUOTED' ||
          p.type === 'TEXT'
        ) {
          // 隐式 AND 连接，例如 `"故宫" :camera("Sony")`
          const right = parseUnary()
          if (right && (right.type !== 'text' || right.query)) {
            left = { type: 'and', left, right }
          }
        } else {
          break
        }
      }
      return left
    }

    function parseUnary(): SearchAstNode {
      if (peek()?.type === 'NOT') {
        next()
        const operand = parseUnary()
        return { type: 'not', operand }
      }
      return parsePrimary()
    }

    function parsePrimary(): SearchAstNode {
      const t = next()
      if (!t) return { type: 'text', query: '' }

      if (t.type === 'LPAREN') {
        const inner = parseOr()
        if (peek()?.type === 'RPAREN') next()
        return inner
      }

      if (t.type === 'DIRECTIVE') {
        return { type: 'directive', name: t.value, args: t.directiveArgs || '' }
      }

      if (t.type === 'QUOTED') {
        return { type: 'text', query: t.value, exact: true }
      }

      return { type: 'text', query: t.value, exact: false }
    }

    return parseOr()
  } catch {
    // 语法解析异常时安全回退到纯文本模糊匹配
    return { type: 'text', query: trimmed, exact: false }
  }
}

// ---------------------------------------------------------------------------
// 内部布尔表达式解析（针对指令参数如 :tags("A" and "B" or "C")）
// ---------------------------------------------------------------------------

export function parseInnerBooleanExpr(src: string): InnerExprNode {
  const trimmed = src.trim()
  if (!trimmed) return { type: 'term', value: '' }

  // 如果包含逗号分隔且没有显式的 and/or/not 关键字，直接将其转换为逗号 OR 语法树
  if (trimmed.includes(',') && !/\b(and|or|not)\b/i.test(trimmed)) {
    const parts = trimmed
      .split(',')
      .map((p) => p.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    if (!parts.length) return { type: 'term', value: '' }
    let node: InnerExprNode = { type: 'term', value: parts[0] }
    for (let i = 1; i < parts.length; i++) {
      node = { type: 'or', left: node, right: { type: 'term', value: parts[i] } }
    }
    return node
  }

  // 使用词法分析解析内部表达式
  const tokens = tokenizeSearchQuery(trimmed)
  if (!tokens.length) return { type: 'term', value: trimmed }

  let pos = 0
  const peek = (): Token | undefined => tokens[pos]
  const next = (): Token | undefined => tokens[pos++]

  function parseOr(): InnerExprNode {
    let left = parseAnd()
    while (peek()?.type === 'OR') {
      next()
      const right = parseAnd()
      // 容错处理尾部悬空 or
      if (!right || (right.type === 'term' && !right.value)) {
        return left
      }
      left = { type: 'or', left, right }
    }
    return left
  }

  function parseAnd(): InnerExprNode {
    let left = parseUnary()
    while (true) {
      const p = peek()
      if (!p || p.type === 'OR' || p.type === 'RPAREN') break
      if (p.type === 'AND') {
        next()
        const right = parseUnary()
        if (!right || (right.type === 'term' && !right.value)) {
          return left
        }
        left = { type: 'and', left, right }
      } else if (
        p.type === 'NOT' ||
        p.type === 'LPAREN' ||
        p.type === 'TEXT' ||
        p.type === 'QUOTED' ||
        p.type === 'DIRECTIVE'
      ) {
        const right = parseUnary()
        if (right && (right.type !== 'term' || right.value)) {
          left = { type: 'and', left, right }
        }
      } else {
        break
      }
    }
    return left
  }

  function parseUnary(): InnerExprNode {
    if (peek()?.type === 'NOT') {
      next()
      return { type: 'not', operand: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary(): InnerExprNode {
    const t = next()
    if (!t) return { type: 'term', value: '' }
    if (t.type === 'LPAREN') {
      const inner = parseOr()
      if (peek()?.type === 'RPAREN') next()
      return inner
    }
    return { type: 'term', value: t.value }
  }

  return parseOr()
}

/** 评估内部布尔树是否与目标字符串列表或单个字符串匹配 */
export function evalInnerBoolean(node: InnerExprNode, matcher: (term: string) => boolean): boolean {
  switch (node.type) {
    case 'and':
      return (
        (!node.left || evalInnerBoolean(node.left, matcher)) &&
        (!node.right || evalInnerBoolean(node.right, matcher))
      )
    case 'or':
      return (
        (node.left ? evalInnerBoolean(node.left, matcher) : false) ||
        (node.right ? evalInnerBoolean(node.right, matcher) : false)
      )
    case 'not':
      return node.operand ? !evalInnerBoolean(node.operand, matcher) : true
    case 'term':
      return matcher(node.value || '')
  }
}

// ---------------------------------------------------------------------------
// 数值范围比较辅助
// ---------------------------------------------------------------------------

function evaluateNumberComparison(actual: number | null | undefined, expr: string): boolean {
  if (actual == null || Number.isNaN(actual)) return false
  const trimmed = expr.trim()
  const m = /^(>=|<=|>|<|=)?\s*([0-9.]+)/.exec(trimmed)
  if (!m) return false
  const op = m[1] || '='
  const target = parseFloat(m[2])
  if (Number.isNaN(target)) return false

  switch (op) {
    case '>':
      return actual > target
    case '>=':
      return actual >= target
    case '<':
      return actual < target
    case '<=':
      return actual <= target
    case '=':
    default:
      return Math.abs(actual - target) < 0.0001
  }
}

// ---------------------------------------------------------------------------
// 指令评估逻辑
// ---------------------------------------------------------------------------

function evaluateDirective(photo: Photo, name: string, args: string): boolean {
  const normName = name.toLowerCase().replace(/-/g, '_')
  const appendix = photo.appendix || {}

  // 1. GPS 纠正指令 :corrected_gps / :corrected
  if (normName === 'corrected_gps' || normName === 'corrected') {
    return photo.gps_corrected != null
  }

  // 2. GPS 猜测指令 :guess_gps / :guess
  if (normName === 'guess_gps' || normName === 'guess' || normName === 'guessed') {
    // 检查是否有静态推算（且没有真实 GPS 定位）
    const guess = photo.gps_guess || appendix.gps_guess
    const hasGuess = guess != null && photo.gps_lat == null && photo.gps_lon == null
    if (!hasGuess) return false
    if (!args.trim()) return true

    // 如果指定了距离范围，如 :guess_gps(<= 5000) 或 :guess_gps(dist < 3000)
    const distMatch = /(?:dist|distance)?\s*(<=|>=|<|>|=)?\s*([0-9.]+)/i.exec(args)
    if (distMatch && guess) {
      const op = distMatch[1] || '<='
      const val = parseFloat(distMatch[2])
      return evaluateNumberComparison(guess.distanceM, `${op} ${val}`)
    }
    return true
  }

  // 3. GPS 定位与坐标范围检索 :has_gps / :gps
  if (normName === 'has_gps' || normName === 'gps') {
    const cleanArgs = args.trim().toLowerCase()
    const hasRealCoord =
      (photo.gps_lat != null && photo.gps_lon != null) || photo.gps_corrected != null

    if (cleanArgs === 'none' || cleanArgs === 'false' || cleanArgs === '0' || cleanArgs === 'no') {
      return !hasRealCoord
    }

    if (!cleanArgs || cleanArgs === 'true' || cleanArgs === 'yes') {
      return hasRealCoord
    }

    // 支持 :gps(long, lat, km) 进行经纬度坐标半径搜索（遵循优先级：corrected > guess > db > exif）
    // 示例：:gps(116.4074, 39.9042, 5) 或 :gps(116.4, 39.9, 10km)
    const stripped = cleanArgs.replace(/^near[,;\s]*/, '').replace(/km/gi, '')
    const coordParts = stripped
      .split(/[,;\s]+/)
      .map((s) => parseFloat(s))
      .filter((n) => !Number.isNaN(n))

    if (coordParts.length >= 2) {
      const targetLon = coordParts[0]
      const targetLat = coordParts[1]
      const radiusKm = coordParts.length >= 3 ? coordParts[2] : 10 // 默认 10km 范围

      const resolved = resolvePhotoGps(photo)
      if (resolved) {
        const distM = haversineDistance(resolved.lat, resolved.lon, targetLat, targetLon)
        return distM <= radiusKm * 1000
      }
      return false
    }

    return hasRealCoord
  }

  // 4. 无 GPS 且无推测指令 :no_gps
  if (normName === 'no_gps') {
    const hasGuess = photo.gps_guess != null || appendix.gps_guess != null
    const hasRealCoord =
      (photo.gps_lat != null && photo.gps_lon != null) || photo.gps_corrected != null
    return !hasRealCoord && !hasGuess
  }

  // 4. 标签指令 :tags(...)
  if (normName === 'tags' || normName === 'tag') {
    const tags = Array.isArray(appendix.tags)
      ? appendix.tags.map((s) => String(s).toLowerCase())
      : []
    if (!args.trim()) return tags.length > 0
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (term) => {
      const t = term.toLowerCase().trim()
      if (!t) return true
      return tags.some((tag) => tag.includes(t))
    })
  }

  // 5. 地名 / 城市 / 国家 / 地址指令
  if (normName === 'city') {
    const city = String(appendix.city || '').toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => city.includes(t.toLowerCase().trim()))
  }

  if (normName === 'country') {
    const country = String(appendix.country || '').toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => country.includes(t.toLowerCase().trim()))
  }

  if (normName === 'address' || normName === 'addr') {
    const addr = String(appendix.formatted_address || '').toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => addr.includes(t.toLowerCase().trim()))
  }

  // 6. 相机与镜头指令
  if (normName === 'camera') {
    const cam = `${photo.camera_make || ''} ${photo.camera_model || ''}`.toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => cam.includes(t.toLowerCase().trim()))
  }

  if (normName === 'lens') {
    const lens = String(photo.lens_model || '').toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => lens.includes(t.toLowerCase().trim()))
  }

  // 7. EXIF 参数指令
  if (normName === 'iso') {
    return evaluateNumberComparison(photo.iso, args)
  }

  if (normName === 'f' || normName === 'aperture') {
    return evaluateNumberComparison(photo.f_number, args)
  }

  if (normName === 'focal' || normName === 'focal_length') {
    return evaluateNumberComparison(photo.focal_length, args)
  }

  // 8. 日期时间指令
  if (normName === 'year') {
    const taken = photo.taken_at || ''
    const yearStr = taken.slice(0, 4)
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => yearStr === t.trim())
  }

  if (normName === 'date') {
    const taken = photo.taken_at || ''
    const clean = args.trim()
    const mRange = /^([0-9-]+)\s*(?:\.\.|~|至)\s*([0-9-]+)$/.exec(clean)
    if (mRange) {
      return taken >= mRange[1] && taken <= `${mRange[2]}T23:59:59`
    }
    const mCmp = /^(>=|<=|>|<|=)?\s*([0-9-]+)/.exec(clean)
    if (mCmp) {
      const op = mCmp[1] || '='
      const target = mCmp[2]
      if (op === '>=') return taken >= target
      if (op === '<=') return taken <= `${target}T23:59:59`
      if (op === '>') return taken > `${target}T23:59:59`
      if (op === '<') return taken < target
      if (op === '=') return taken.startsWith(target)
    }
    return taken.includes(clean)
  }

  // 9. 文件名与路径指令
  if (normName === 'name' || normName === 'file') {
    const filename = (photo.path.split('/').pop() || '').toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => filename.includes(t.toLowerCase().trim()))
  }

  if (normName === 'path') {
    const fullPath = photo.path.toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => fullPath.includes(t.toLowerCase().trim()))
  }

  // 10. 备注指令
  if (normName === 'comment') {
    const comment = String(appendix.comment || '').toLowerCase()
    const innerTree = parseInnerBooleanExpr(args)
    return evalInnerBoolean(innerTree, (t) => comment.includes(t.toLowerCase().trim()))
  }

  // 11. 媒体类型指令
  if (normName === 'video') {
    return isVideoFile(photo.path)
  }
  if (normName === 'image') {
    return !isVideoFile(photo.path)
  }

  // 12. 标记状态指令
  if (normName === 'flagged') {
    return Boolean(appendix.flagged)
  }
  if (normName === 'rejected') {
    return Boolean(appendix.rejected)
  }

  // 13. 通用 appendix(key, value)
  if (normName === 'appendix') {
    const commaIdx = args.indexOf(',')
    if (commaIdx > 0) {
      const key = args.slice(0, commaIdx).trim()
      const valExpr = args.slice(commaIdx + 1).trim()
      const targetVal = String(appendix[key] ?? '').toLowerCase()
      const innerTree = parseInnerBooleanExpr(valExpr)
      return evalInnerBoolean(innerTree, (t) => targetVal.includes(t.toLowerCase().trim()))
    } else {
      const allAppText = JSON.stringify(appendix).toLowerCase()
      const innerTree = parseInnerBooleanExpr(args)
      return evalInnerBoolean(innerTree, (t) => allAppText.includes(t.toLowerCase().trim()))
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// 纯文本模糊匹配（支持全字段）
// ---------------------------------------------------------------------------

export function matchPhotoFreeText(photo: Photo, term: string, exact = false): boolean {
  if (!term) return true
  const q = term.toLowerCase().trim()
  if (!q) return true

  const filename = (photo.path.split('/').pop() || '').toLowerCase()
  const path = photo.path.toLowerCase()
  const camera =
    `${photo.camera_make || ''} ${photo.camera_model || ''} ${photo.lens_model || ''}`.toLowerCase()
  const appendix = photo.appendix || {}
  const comment = String(appendix.comment || '').toLowerCase()
  const address = String(appendix.formatted_address || '').toLowerCase()
  const tags = Array.isArray(appendix.tags) ? appendix.tags.map(String).join(' ').toLowerCase() : ''
  const city = String(appendix.city || '').toLowerCase()
  const country = String(appendix.country || '').toLowerCase()

  const aiType = String(
    appendix.ai_generated?.type || appendix.aigenerated?.type || ''
  ).toLowerCase()
  const aiBrief = String(
    appendix.ai_generated?.brief || appendix.aigenerated?.brief || ''
  ).toLowerCase()
  const aiOcr = String(appendix.ai_generated?.ocr || appendix.aigenerated?.ocr || '').toLowerCase()

  const combined = `${filename} ${path} ${camera} ${comment} ${address} ${tags} ${city} ${country} ${aiType} ${aiBrief} ${aiOcr}`

  // 如果使用了双引号精确划定（exact = true），要求整段子串完全匹配
  if (exact) {
    return combined.includes(q)
  }

  // 普通未加引号输入：拆分空格，每个词都必须包含（保持与旧有 matchPhotoItem 行为完全一致）
  const qTerms = q.split(/\s+/).filter(Boolean)
  if (!qTerms.length) return true
  return qTerms.every((t) => combined.includes(t))
}

// ---------------------------------------------------------------------------
// 树求值入口
// ---------------------------------------------------------------------------

export function evaluateSearchAst(node: SearchAstNode, photo: Photo): boolean {
  switch (node.type) {
    case 'and':
      return evaluateSearchAst(node.left, photo) && evaluateSearchAst(node.right, photo)
    case 'or':
      return evaluateSearchAst(node.left, photo) || evaluateSearchAst(node.right, photo)
    case 'not':
      return !evaluateSearchAst(node.operand, photo)
    case 'directive':
      return evaluateDirective(photo, node.name, node.args)
    case 'text':
      return matchPhotoFreeText(photo, node.query, node.exact)
  }
}

/**
 * 高级照片过滤统一方法：对照片列表执行高级语法查询。
 * 兼容未用高级语法时的原汁原味搜索行为。
 */
export function filterPhotosWithQuery(photos: Photo[], queryStr: string): Photo[] {
  if (!photos || !photos.length) return []
  const trimmed = (queryStr || '').trim()
  if (!trimmed) return photos

  const ast = parseSearchQuery(trimmed)
  if (!ast) return photos

  return photos.filter((p) => evaluateSearchAst(ast, p))
}
