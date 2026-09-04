/**
 * yarj 通用照片属性筛选过滤引擎
 *
 * 支持点路径属性访问（例如 ai_generated.type, camera_make, appendix.tags 等），
 * 并提供 in, not_in, equals, contains 等数据库风格的高级筛选操作符。
 */

import type { Photo, PhotoFilterRule } from './types'

/**
 * 安全按路径读取照片或其 appendix 内部字段值
 */
export function getPhotoFieldValue(photo: Photo, fieldPath: string): unknown {
  if (!photo || !fieldPath) return undefined
  const cleanPath = fieldPath.trim()

  // 快捷路径匹配：如果字段直接是顶层属性
  if (cleanPath in photo) {
    return (photo as unknown as Record<string, unknown>)[cleanPath]
  }

  // 如果是在 appendix 里
  const appendix = photo.appendix || {}

  // 兼容 ai_generated / aigenerated
  if (cleanPath.startsWith('ai_generated.') || cleanPath.startsWith('aigenerated.')) {
    const subKey = cleanPath.replace(/^(?:ai_generated|aigenerated)\./, '')
    const aiObj = (appendix.ai_generated || appendix.aigenerated) as
      Record<string, unknown> | undefined
    return aiObj ? aiObj[subKey] : undefined
  }

  if (cleanPath === 'ai_generated' || cleanPath === 'aigenerated') {
    return appendix.ai_generated || appendix.aigenerated
  }

  if (cleanPath in appendix) {
    return appendix[cleanPath]
  }

  // 深度点路径查找
  const parts = cleanPath.split('.')
  let current: unknown = photo
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  if (current !== undefined) return current

  // 尝试在 appendix 下深度查找
  current = appendix
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * 解析用户输入的值列表（支持 JSON 数组、逗号/空格分隔）
 */
export function parseValuesList(rawVal: string): string[] {
  if (!rawVal || typeof rawVal !== 'string') return []
  const trimmed = rawVal.trim()

  // 尝试 JSON 数组解析：如 ["Document", "Blackboard"]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean)
      }
    } catch {
      // ignore
    }
  }

  // 逗号或分号分隔解析
  return trimmed
    .split(/[,;，；\n]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/**
 * 单条规则评估
 */
export function evalFilterRule(photo: Photo, rule: PhotoFilterRule): boolean {
  if (!rule || !rule.enabled) return true

  const rawVal = getPhotoFieldValue(photo, rule.field)
  const op = rule.operator
  const targetStr = (rule.value ?? '').trim()

  // 1. 为空/非空判断
  if (op === 'is_empty') {
    if (rawVal === null || rawVal === undefined || rawVal === '') return true
    if (Array.isArray(rawVal) && rawVal.length === 0) return true
    return false
  }
  if (op === 'is_not_empty') {
    if (rawVal === null || rawVal === undefined || rawVal === '') return false
    if (Array.isArray(rawVal) && rawVal.length === 0) return false
    return true
  }

  // 2. 属于 / 不属于集合判断 (in / not_in)
  if (op === 'in' || op === 'not_in') {
    const candidateList = parseValuesList(targetStr).map((s) => s.toLowerCase())
    if (!candidateList.length) return true // 未填任何候选值时不过滤

    let matches = false
    if (Array.isArray(rawVal)) {
      // 数组字段：只要有任意元素在候选列表中
      matches = rawVal.some((item) => candidateList.includes(String(item).toLowerCase()))
    } else if (rawVal != null) {
      matches = candidateList.includes(String(rawVal).toLowerCase())
    }

    return op === 'in' ? matches : !matches
  }

  // 3. 等于 / 不等于判断 (equals / not_equals)
  if (op === 'equals' || op === 'not_equals') {
    const valStr = rawVal == null ? '' : String(rawVal).trim()
    const matches = valStr.toLowerCase() === targetStr.toLowerCase()
    return op === 'equals' ? matches : !matches
  }

  // 4. 包含 / 不包含判断 (contains / not_contains)
  if (op === 'contains' || op === 'not_contains') {
    if (!targetStr) return true
    let matches = false
    if (Array.isArray(rawVal)) {
      matches = rawVal.some((item) => String(item).toLowerCase().includes(targetStr.toLowerCase()))
    } else if (rawVal != null) {
      matches = String(rawVal).toLowerCase().includes(targetStr.toLowerCase())
    }
    return op === 'contains' ? matches : !matches
  }

  // 5. 大于 / 小于比较 (gt / lt)
  if (op === 'gt' || op === 'lt') {
    const numA = Number(rawVal)
    const numB = Number(targetStr)
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      return op === 'gt' ? numA > numB : numA < numB
    }
    // 字符串比较（如日期时间字符串）
    const strA = String(rawVal || '')
    return op === 'gt' ? strA > targetStr : strA < targetStr
  }

  return true
}

/**
 * 对照片数组应用所有启用的规则
 */
export function filterPhotosByRules(photos: Photo[], rules?: PhotoFilterRule[]): Photo[] {
  if (!rules || !rules.length) return photos
  const activeRules = rules.filter((r) => r.enabled && r.field)
  if (!activeRules.length) return photos

  return photos.filter((photo) => {
    for (const rule of activeRules) {
      if (!evalFilterRule(photo, rule)) {
        return false
      }
    }
    return true
  })
}
