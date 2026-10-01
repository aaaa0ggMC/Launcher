/**
 * 文本类工具执行层（主进程）。
 *
 * 约定：
 *  - 字段值一律取自 args[field.key]，缺失时回落到 definitions 中的默认值（CLI 兜底）；
 *  - 校验失败返回 { ok: false, error }；本模块完全不写日志，用户输入不会进入任何日志；
 *  - 所有 SVG 都由固定模板拼装，用户文本只以 XML 转义后的文本节点/属性值出现，
 *    颜色等属性值用白名单正则校验，绝不接受任意 markup；
 *  - 不联网、不读写文件、不调用外部程序；随机数一律来自系统 CSPRNG。
 */
import { diffLines } from 'diff'
import figlet from 'figlet'
import fontStandard from 'figlet/importable-fonts/Standard.js'
import fontBig from 'figlet/importable-fonts/Big.js'
import fontSmall from 'figlet/importable-fonts/Small.js'
import fontBanner from 'figlet/importable-fonts/Banner.js'
import fontGhost from 'figlet/importable-fonts/Ghost.js'
import fontSlant from 'figlet/importable-fonts/Slant.js'
import fontShadow from 'figlet/importable-fonts/Shadow.js'
import fontBlock from 'figlet/importable-fonts/Block.js'
import fontLean from 'figlet/importable-fonts/Lean.js'
import fontMini from 'figlet/importable-fonts/Mini.js'
import fontScript from 'figlet/importable-fonts/Script.js'
import fontDigital from 'figlet/importable-fonts/Digital.js'
import * as OpenCC from 'opencc-js'
import { pinyin } from 'pinyin-pro'
import QRCode from 'qrcode'
import { definitions } from './definitions'
import type { ToolArgs, ToolField, ToolFile, ToolResult } from '../../types'

/* ------------------------------------------------------------------ */
/* 通用读取 / 编码 / 随机                                              */
/* ------------------------------------------------------------------ */

function fieldFor(id: string, key: string): ToolField | undefined {
  return definitions.find((tool) => tool.id === id)?.fields.find((field) => field.key === key)
}

type ParsedNumber = { ok: true; value: number } | { ok: false; error: string }

/** 数字字段：CLI 与界面共用 definitions 里的 min/max/默认值兜底。 */
function readNumberField(args: ToolArgs, id: string, key: string, label: string): ParsedNumber {
  const field = fieldFor(id, key)
  const fallback = typeof field?.default === 'number' ? field.default : 0
  const min = typeof field?.min === 'number' ? field.min : Number.NEGATIVE_INFINITY
  const max = typeof field?.max === 'number' ? field.max : Number.POSITIVE_INFINITY
  const raw = args[key]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: fallback }
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value)) {
    return { ok: false, error: `${label}必须是数字 / ${label} must be a number` }
  }
  if (!Number.isInteger(value)) {
    return { ok: false, error: `${label}必须是整数 / ${label} must be an integer` }
  }
  if (value < min || value > max) {
    return { ok: false, error: `${label}需在 ${min} 到 ${max} 之间 / ${label} out of range` }
  }
  return { ok: true, value }
}

function readString(args: ToolArgs, key: string, fallback: string): string {
  const raw = args[key]
  if (raw === undefined || raw === null) return fallback
  return String(raw)
}

function readBool(args: ToolArgs, key: string, fallback: boolean): boolean {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return fallback
}

/** UTF-8 字符串 → base64（同时适用于主进程与测试环境）。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 系统 CSPRNG： rejection sampling 保证 [0, max) 均匀。 */
function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
    throw new Error('随机数范围无效 / Invalid random range')
  }
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive
  const buffer = new Uint32Array(1)
  let value = 0
  do {
    crypto.getRandomValues(buffer)
    value = buffer[0]
  } while (value >= limit)
  return value % maxExclusive
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

/** XML 文本/属性转义；SVG 中所有用户文本都必须经过它。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/

type ParsedText = { ok: true; value: string } | { ok: false; error: string }

/** 颜色等进入 SVG 属性的用户输入：只接受十六进制颜色，绝不原样透传。 */
function readColor(args: ToolArgs, key: string, fallback: string, label: string): ParsedText {
  const value = readString(args, key, fallback).trim()
  if (!HEX_COLOR.test(value)) {
    return { ok: false, error: `${label}需为 #RGB/#RRGGBB 形式 / ${label} must be a hex color` }
  }
  return { ok: true, value }
}

function svgFile(name: string, xml: string): ToolFile {
  return { name, mime: 'image/svg+xml', base64: toBase64(xml) }
}

/* ------------------------------------------------------------------ */
/* 字符统计                                                            */
/* ------------------------------------------------------------------ */

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2a6df}]/u

function charStatistics(args: ToolArgs): ToolResult {
  const text = readString(args, 'text', '')
  if (text.trim() === '') {
    return { ok: false, error: '请输入要统计的文本 / Text is required' }
  }
  const chars = [...text]
  const chinese = chars.filter((ch) => CJK_PATTERN.test(ch)).length
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length
  const digits = (text.match(/[0-9]/g) ?? []).length
  const whitespace = (text.match(/\s/g) ?? []).length
  const latinWords = (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length
  const lines = text.split(/\r\n|\r|\n/)
  const data = {
    codePoints: chars.length,
    chineseCharacters: chinese,
    latinLetters: latin,
    digits,
    whitespace,
    words: latinWords + chinese,
    latinWords,
    lines: lines.length,
    nonEmptyLines: lines.filter((line) => line.trim() !== '').length
  }
  return {
    ok: true,
    data,
    text: [
      `码位 Code points: ${data.codePoints}`,
      `汉字 Han: ${data.chineseCharacters}`,
      `英文字母 Letters: ${data.latinLetters}`,
      `数字 Digits: ${data.digits}`,
      `空白 Whitespace: ${data.whitespace}`,
      `单词 Words: ${data.words}（英文 ${data.latinWords} + 汉字 ${data.chineseCharacters}）`,
      `行数 Lines: ${data.lines}（非空 ${data.nonEmptyLines}）`
    ].join('\n'),
    note: '按 Unicode 码位统计；单词数 = 英文单词数 + 汉字数，纯数字不计入单词。'
  }
}

/* ------------------------------------------------------------------ */
/* 文本对比                                                            */
/* ------------------------------------------------------------------ */

interface DiffRow {
  type: 'same' | 'add' | 'del'
  oldLine: number | null
  newLine: number | null
  text: string
}

function textDiff(args: ToolArgs): ToolResult {
  const original = readString(args, 'original', '')
  const modified = readString(args, 'modified', '')
  if (original.trim() === '' && modified.trim() === '') {
    return { ok: false, error: '请输入需要对比的两段文本 / Both texts are required' }
  }
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const change of diffLines(original, modified, { ignoreNewlineAtEof: true })) {
    if (change.value === '') continue
    const type: DiffRow['type'] = change.added ? 'add' : change.removed ? 'del' : 'same'
    const lines = change.value.replace(/\n$/, '').split('\n')
    for (const line of lines) {
      if (type === 'same') {
        oldNo += 1
        newNo += 1
        rows.push({ type, oldLine: oldNo, newLine: newNo, text: line })
      } else if (type === 'del') {
        oldNo += 1
        rows.push({ type, oldLine: oldNo, newLine: null, text: line })
      } else {
        newNo += 1
        rows.push({ type, oldLine: null, newLine: newNo, text: line })
      }
    }
  }
  const added = rows.filter((row) => row.type === 'add').length
  const removed = rows.filter((row) => row.type === 'del').length
  const unchanged = rows.length - added - removed
  const view = rows
    .map((row) => `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} ${row.text}`)
    .join('\n')
  return {
    ok: true,
    data: { added, removed, unchanged, rows },
    text: `${view}\n\n+${added} / -${removed} / =${unchanged}`
  }
}

/* ------------------------------------------------------------------ */
/* 文本清理                                                            */
/* ------------------------------------------------------------------ */

const MAX_CLEAN_LINES = 10_000

function textClean(args: ToolArgs): ToolResult {
  const raw = readString(args, 'text', '')
  if (raw.trim() === '') {
    return { ok: false, error: '请输入要清理的文本 / Text is required' }
  }
  const inputLines = raw.split(/\r\n|\r|\n/)
  if (inputLines.length > MAX_CLEAN_LINES) {
    return { ok: false, error: `最多处理 ${MAX_CLEAN_LINES} 行 / Too many lines` }
  }
  let lines = readBool(args, 'trimLines', true)
    ? inputLines.map((line) => line.trim())
    : [...inputLines]
  if (readBool(args, 'dropEmpty', true)) lines = lines.filter((line) => line !== '')
  if (readBool(args, 'dedupe', false)) lines = lines.filter((line, i) => lines.indexOf(line) === i)
  const sort = readString(args, 'sort', 'none')
  if (sort === 'asc') lines = [...lines].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  else if (sort === 'desc') lines = [...lines].sort((a, b) => b.localeCompare(a, 'zh-Hans-CN'))
  return {
    ok: true,
    data: {
      inputLines: inputLines.length,
      outputLines: lines.length,
      removed: inputLines.length - lines.length
    },
    text: lines.join('\n')
  }
}

/* ------------------------------------------------------------------ */
/* 汉字转拼音                                                          */
/* ------------------------------------------------------------------ */

function chinesePinyin(args: ToolArgs): ToolResult {
  const text = readString(args, 'text', '')
  if (text.trim() === '') {
    return { ok: false, error: '请输入要转换的文本 / Text is required' }
  }
  const mode = readString(args, 'mode', 'full')
  if (!['full', 'plain', 'numeric', 'first', 'initial'].includes(mode)) {
    return { ok: false, error: '未知输出方式 / Unknown pinyin mode' }
  }
  const separator = readString(args, 'separator', ' ')
  const upper = readString(args, 'letterCase', 'lower') === 'upper'
  const multiple = readBool(args, 'multiple', false)
  const toneType = mode === 'numeric' ? 'num' : mode === 'plain' ? 'none' : 'symbol'
  const pattern = mode === 'first' ? 'first' : mode === 'initial' ? 'initial' : undefined
  const applyCase = (value: string): string => (upper ? value.toUpperCase() : value)

  let result: string
  if (multiple) {
    // 多音字：逐字取全部读音，用 / 分隔
    const parts: string[] = []
    for (const ch of [...text]) {
      if (!CJK_PATTERN.test(ch)) {
        parts.push(ch)
        continue
      }
      const readings: string[] = pinyin(ch, { type: 'array', multiple: true, toneType, pattern })
      parts.push(readings.length > 0 ? readings.map(applyCase).join('/') : ch)
    }
    result = parts.join(' ')
  } else {
    const tokens: string[] = pinyin(text, { type: 'array', toneType, pattern })
    result = tokens.map(applyCase).join(separator)
  }
  return {
    ok: true,
    data: { mode, separator, upper, multiple, result },
    text: result,
    note: '拼音来自 pinyin-pro 本地词典；非汉字字符按原样保留，多音字模式逐字标注全部读音。'
  }
}

/* ------------------------------------------------------------------ */
/* 中文分词                                                            */
/* ------------------------------------------------------------------ */

const MAX_SEGMENTS = 20_000

function chineseSegment(args: ToolArgs): ToolResult {
  const text = readString(args, 'text', '')
  if (text.trim() === '') {
    return { ok: false, error: '请输入要分词的文本 / Text is required' }
  }
  const granularityRaw = readString(args, 'granularity', 'word')
  if (!['word', 'grapheme', 'sentence'].includes(granularityRaw)) {
    return { ok: false, error: '未知切分粒度 / Unknown granularity' }
  }
  const granularity: 'grapheme' | 'word' | 'sentence' =
    granularityRaw === 'grapheme' || granularityRaw === 'sentence' ? granularityRaw : 'word'
  const keepPunct = readBool(args, 'keepPunct', false)
  const segmenter = new Intl.Segmenter('zh', { granularity })
  const tokens: string[] = []
  for (const segment of segmenter.segment(text)) {
    if (!keepPunct) {
      if (segment.isWordLike === false) continue
      if (segment.segment.trim() === '') continue
    }
    tokens.push(segment.segment)
    if (tokens.length > MAX_SEGMENTS) {
      return { ok: false, error: `分词结果超过 ${MAX_SEGMENTS} 个 / Too many segments` }
    }
  }
  return {
    ok: true,
    data: { granularity, count: tokens.length, tokens },
    text: tokens.join(' / '),
    note: 'Intl.Segmenter（ICU）按 Unicode 文本分割规则与内置词典切分，汉语多为单字级结果，不等于 jieba 等统计分词的词级别效果。'
  }
}

/* ------------------------------------------------------------------ */
/* 简繁体转换                                                          */
/* ------------------------------------------------------------------ */

const CONVERT_TARGETS: Record<string, { from: string; to: string }> = {
  s2t: { from: 'cn', to: 'tw' },
  s2h: { from: 'cn', to: 'hk' },
  t2s: { from: 'tw', to: 'cn' },
  h2s: { from: 'hk', to: 'cn' }
}

const converters = new Map<string, (text: string) => string>()

function convertChinese(target: string, text: string): string {
  let convert = converters.get(target)
  if (!convert) {
    const spec = CONVERT_TARGETS[target] ?? CONVERT_TARGETS.s2t
    convert = OpenCC.Converter({ from: spec.from, to: spec.to })
    converters.set(target, convert)
  }
  return convert(text)
}

function chineseConvert(args: ToolArgs): ToolResult {
  const text = readString(args, 'text', '')
  if (text.trim() === '') {
    return { ok: false, error: '请输入要转换的文本 / Text is required' }
  }
  const target = readString(args, 'target', 's2t')
  if (!CONVERT_TARGETS[target]) {
    return { ok: false, error: '未知转换方向 / Unknown conversion direction' }
  }
  const result = convertChinese(target, text)
  return {
    ok: true,
    data: { target, result },
    text: result,
    note: '基于 opencc-js 词汇级转换；台湾/香港地区用词存在差异（如「软件/軟件」），按所选地区词典输出。'
  }
}

/* ------------------------------------------------------------------ */
/* ASCII 艺术字                                                        */
/* ------------------------------------------------------------------ */

const FIGLET_FONT_DATA: Record<string, string> = {
  Standard: fontStandard,
  Big: fontBig,
  Small: fontSmall,
  Banner: fontBanner,
  Ghost: fontGhost,
  Slant: fontSlant,
  Shadow: fontShadow,
  Block: fontBlock,
  Lean: fontLean,
  Mini: fontMini,
  Script: fontScript,
  Digital: fontDigital
}

// 发行版没有 figlet/fonts 目录，字体数据随包内联，运行时绝不读取文件系统。
for (const [name, data] of Object.entries(FIGLET_FONT_DATA)) {
  figlet.parseFont(name, data)
}

function asciiArt(args: ToolArgs): ToolResult {
  const text = readString(args, 'text', '')
  if (text.trim() === '') {
    return { ok: false, error: '请输入文本 / Text is required' }
  }
  if ([...text].length > 40) {
    return { ok: false, error: '最多 40 个字符 / At most 40 characters' }
  }
  if (!/^[\x20-\x7E]+$/.test(text)) {
    return {
      ok: false,
      error:
        'FIGlet 字体仅支持 ASCII 可打印字符（空格到 ~），中文请改用其他工具 / ASCII printable only'
    }
  }
  const font = readString(args, 'font', 'Standard')
  if (!FIGLET_FONT_DATA[font]) {
    return { ok: false, error: '未知字体 / Unknown font' }
  }
  const art = figlet.textSync(text, { font })
  return {
    ok: true,
    data: { font, characters: [...text].length, lines: art.split('\n') },
    text: art,
    note: '字体来自 figlet 字体集，仅支持 ASCII；不同字体高度不同，粘贴时请使用等宽显示。'
  }
}

/* ------------------------------------------------------------------ */
/* 人民币大写                                                          */
/* ------------------------------------------------------------------ */

const RMB_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const RMB_UNITS = ['', '拾', '佰', '仟']
const RMB_GROUPS = ['', '万', '亿', '万亿']

/** 0-9999 → 大写，组内连续零只保留一个。 */
function rmbSection(value: number): string {
  let rest = value
  let out = ''
  let pendingZero = false
  for (let i = 3; i >= 0; i -= 1) {
    const divisor = 10 ** i
    const digit = Math.floor(rest / divisor)
    rest %= divisor
    if (digit === 0) {
      pendingZero = true
      continue
    }
    if (pendingZero && out !== '') out += '零'
    pendingZero = false
    out += RMB_DIGITS[digit] + RMB_UNITS[i]
  }
  return out
}

/** 数字字符串（无符号）→ 大写，按 4 位分组（万/亿/万亿）。 */
function rmbInteger(digits: string): string {
  const groups: number[] = []
  for (let i = digits.length; i > 0; i -= 4) {
    groups.push(Number(digits.slice(Math.max(0, i - 4), i)))
  }
  let out = ''
  for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
    const section = groups[gi]
    if (section === 0) continue
    const text = rmbSection(section) + RMB_GROUPS[gi]
    out += out !== '' && section < 1000 ? `零${text}` : text
  }
  return out
}

function rmbUppercase(args: ToolArgs): ToolResult {
  const cleaned = String(args.amount ?? '1234.56')
    .trim()
    .replace(/[¥￥\s,，]/g, '')
    .replace(/^cny/i, '')
  let text = cleaned
  if (text.startsWith('.')) text = `0${text}`
  if (text.endsWith('.')) text = `${text}0`
  const match = text.match(/^([+-]?)(\d{1,12})(?:\.(\d{1,2}))?$/)
  if (!match) {
    return {
      ok: false,
      error: '金额格式无效：支持可选正负号、最多两位小数；整数部分最多 12 位 / Invalid amount'
    }
  }
  const negative = match[1] === '-'
  const fraction = (match[3] ?? '').padEnd(2, '0')
  // 全程字符串 + BigInt，避免任何浮点误差
  const cents = BigInt(`${match[2]}${fraction}`)
  const abs = cents
  if (abs === 0n) {
    const zero = '人民币零元整'
    return {
      ok: true,
      data: { normalized: '0.00', yuan: '零元', jiao: '', fen: '', uppercase: zero },
      text: zero,
      note: '整数部分上限 999,999,999,999（万亿位）；工具结果由调用方按隐私策略脱敏。'
    }
  }
  const yuanPart = abs / 100n
  const jiao = (abs % 100n) / 10n
  const fen = abs % 10n
  const digitAt = (value: bigint): string => RMB_DIGITS[Number(value)]
  const yuanText = yuanPart === 0n ? '' : `${rmbInteger(yuanPart.toString())}元`
  let tail: string
  if (jiao > 0n && fen > 0n) tail = `${digitAt(jiao)}角${digitAt(fen)}分`
  else if (jiao > 0n) tail = `${digitAt(jiao)}角整`
  else if (fen > 0n) tail = `${digitAt(fen)}分`
  else tail = '整'
  let core: string
  if (yuanText === '') core = tail
  else if (jiao === 0n && fen > 0n) core = `${yuanText}零${tail}`
  else core = `${yuanText}${tail}`
  const sign = negative ? '负' : ''
  const uppercase = `人民币${sign}${core}`
  return {
    ok: true,
    data: {
      normalized: `${negative ? '-' : ''}${match[2]}.${fraction}`,
      cents: (negative ? -cents : cents).toString(),
      yuan: yuanPart === 0n ? '' : rmbInteger(yuanPart.toString()),
      jiao: jiao === 0n ? '' : digitAt(jiao),
      fen: fen === 0n ? '' : digitAt(fen),
      uppercase
    },
    text: uppercase,
    note: '整数部分上限 999,999,999,999（万亿位）；工具结果由调用方按隐私策略脱敏。'
  }
}

/* ------------------------------------------------------------------ */
/* 随机选择                                                            */
/* ------------------------------------------------------------------ */

const MAX_CHOICE_LINES = 1_000

function randomChoice(args: ToolArgs): ToolResult {
  const raw = readString(args, 'options', '')
  const options = raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (options.length === 0) {
    return { ok: false, error: '请输入选项（每行一个）/ Options are required' }
  }
  if (options.length > MAX_CHOICE_LINES) {
    return { ok: false, error: `最多 ${MAX_CHOICE_LINES} 个选项 / Too many options` }
  }
  const count = readNumberField(args, 'choice', 'count', '抽取数量')
  if (!count.ok) return { ok: false, error: count.error }
  const unique = readBool(args, 'unique', true)
  if (unique && count.value > options.length) {
    return {
      ok: false,
      error: `不重复抽取时数量不能超过选项数（${options.length}）/ Not enough options`
    }
  }
  let picked: string[]
  if (unique) {
    picked = shuffled(options).slice(0, count.value)
  } else {
    picked = Array.from({ length: count.value }, () => options[randomInt(options.length)])
  }
  return {
    ok: true,
    data: { picked, count: count.value, unique, from: options.length },
    text: picked.map((item, index) => `${index + 1}. ${item}`).join('\n'),
    note: '使用系统加密随机数（crypto.getRandomValues）抽取；只从给定选项中选择，不联网。'
  }
}

/* ------------------------------------------------------------------ */
/* 二维码                                                              */
/* ------------------------------------------------------------------ */

type QrLevel = 'L' | 'M' | 'Q' | 'H'

async function qrCode(args: ToolArgs): Promise<ToolResult> {
  const content = readString(args, 'content', '')
  if (content.trim() === '') {
    return { ok: false, error: '请输入二维码内容 / Content is required' }
  }
  const format = readString(args, 'format', 'svg') === 'png' ? 'png' : 'svg'
  const levelRaw = readString(args, 'level', 'M')
  const level: QrLevel = (['L', 'M', 'Q', 'H'] as const).includes(levelRaw as QrLevel)
    ? (levelRaw as QrLevel)
    : 'M'
  const size = readNumberField(args, 'qrcode', 'size', 'PNG 像素宽')
  if (!size.ok) return { ok: false, error: size.error }
  try {
    const info = QRCode.create(content, { errorCorrectionLevel: level })
    const modules = info.modules.size
    const data = {
      format,
      level,
      version: info.version,
      modules,
      characters: content.length
    }
    if (format === 'svg') {
      const svg = await QRCode.toString(content, {
        type: 'svg',
        errorCorrectionLevel: level,
        margin: 1
      })
      return {
        ok: true,
        data,
        files: [svgFile('qrcode.svg', svg)],
        text: `二维码已生成（SVG，版本 ${info.version}，${modules}×${modules} 模块）。`,
        note: '二维码在本地编码，不联网；二维码可被任意设备扫描，请勿对敏感信息编码后公开传播。'
      }
    }
    const dataUrl = await QRCode.toDataURL(content, {
      type: 'image/png',
      errorCorrectionLevel: level,
      margin: 1,
      width: size.value
    })
    return {
      ok: true,
      data,
      files: [{ name: 'qrcode.png', mime: 'image/png', base64: dataUrl.split(',')[1] }],
      text: `二维码已生成（PNG，${size.value}px 宽，版本 ${info.version}，${modules}×${modules} 模块）。`,
      note: '二维码在本地编码，不联网；二维码可被任意设备扫描，请勿对敏感信息编码后公开传播。'
    }
  } catch {
    return { ok: false, error: '内容过长或无法编码为二维码 / Content too long for a QR code' }
  }
}

/* ------------------------------------------------------------------ */
/* 密码生成                                                            */
/* ------------------------------------------------------------------ */

const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/'
} as const

const CHARSETS_NO_AMBIGUOUS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnpqrstuvwxyz',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/'
} as const

function passwordGenerator(args: ToolArgs): ToolResult {
  const length = readNumberField(args, 'password-generator', 'length', '密码长度')
  if (!length.ok) return { ok: false, error: length.error }
  const count = readNumberField(args, 'password-generator', 'count', '生成数量')
  if (!count.ok) return { ok: false, error: count.error }

  const sets = readBool(args, 'excludeAmbiguous', false) ? CHARSETS_NO_AMBIGUOUS : CHARSETS
  const pools: string[] = []
  if (readBool(args, 'upper', true)) pools.push(sets.upper)
  if (readBool(args, 'lower', true)) pools.push(sets.lower)
  if (readBool(args, 'digits', true)) pools.push(sets.digits)
  if (readBool(args, 'symbols', false)) pools.push(sets.symbols)
  if (pools.length === 0) {
    return { ok: false, error: '至少选择一种字符集 / Choose at least one character set' }
  }
  if (length.value < pools.length) {
    return {
      ok: false,
      error: `长度至少 ${pools.length} 才能覆盖所选字符集 / Length too short for the chosen sets`
    }
  }
  const combined = pools.join('')
  const passwords: string[] = []
  for (let n = 0; n < count.value; n += 1) {
    // 先保证每个字符集至少出现一次，再补齐并洗牌，消除位置偏差
    const chars = pools.map((pool) => pool[randomInt(pool.length)])
    while (chars.length < length.value) chars.push(combined[randomInt(combined.length)])
    passwords.push(shuffled(chars).join(''))
  }
  return {
    ok: true,
    data: { length: length.value, count: count.value, passwords },
    text: passwords.map((pwd, index) => `${index + 1}. ${pwd}`).join('\n'),
    note: '密码使用系统加密随机数生成，只出现在本次结果中：不保存、不写日志、也不提供示例；agent 调用已被禁止。'
  }
}

/* ------------------------------------------------------------------ */
/* 亲戚称谓                                                            */
/* ------------------------------------------------------------------ */

type KinStep = 'f' | 'm' | 'ob' | 'lb' | 'os' | 'ls' | 'h' | 'w' | 's' | 'd'

const KIN_TERMS: Record<string, KinStep> = {
  父亲: 'f',
  爸: 'f',
  爸爸: 'f',
  老爸: 'f',
  爹: 'f',
  父: 'f',
  母亲: 'm',
  妈: 'm',
  妈妈: 'm',
  老妈: 'm',
  娘: 'm',
  母: 'm',
  哥哥: 'ob',
  兄: 'ob',
  大哥: 'ob',
  哥: 'ob',
  弟弟: 'lb',
  弟: 'lb',
  小弟: 'lb',
  姐姐: 'os',
  姐: 'os',
  大姐: 'os',
  妹妹: 'ls',
  妹: 'ls',
  小妹: 'ls',
  丈夫: 'h',
  老公: 'h',
  先生: 'h',
  夫: 'h',
  妻子: 'w',
  老婆: 'w',
  太太: 'w',
  妻: 'w',
  儿子: 's',
  犬子: 's',
  女儿: 'd',
  闺女: 'd'
}

const KIN_NAMES: Record<string, string> = {
  self: '我',
  f: '爸爸（父亲）',
  m: '妈妈（母亲）',
  gf: '爷爷（祖父）',
  gm: '奶奶（祖母）',
  ggf: '太爷爷（曾祖父）',
  ggm: '太奶奶（曾祖母）',
  wgf: '外公（外祖父）',
  wgm: '外婆（外祖母）',
  wggf: '外太爷爷（外曾祖父）',
  wggm: '外太奶奶（外曾祖母）',
  h: '丈夫（老公）',
  w: '妻子（老婆）',
  ob: '哥哥',
  lb: '弟弟',
  os: '姐姐',
  ls: '妹妹',
  s: '儿子',
  d: '女儿',
  bf: '伯父（大爷）',
  uf: '叔叔',
  gu: '姑姑（姑妈）',
  wf: '舅舅（舅父）',
  ym: '姨妈',
  hf: '公公',
  hm: '婆婆',
  wff: '岳父',
  wfm: '岳母',
  bm: '伯母',
  sm: '婶婶',
  gfu: '姑父',
  jm: '舅妈',
  yfu: '姨父',
  zz: '孙子',
  zn: '孙女',
  ws: '外孙',
  wn: '外孙女',
  zzi: '侄子',
  zni: '侄女',
  wszi: '外甥',
  wszn: '外甥女',
  xi: '嫂子',
  dxi: '弟媳',
  jf: '姐夫',
  mf: '妹夫',
  db: '大伯子（大伯）',
  dm: '小叔子（小叔）',
  dz: '大姑子',
  xz: '小姑子',
  nj: '大舅子（内兄）',
  nl: '小舅子（内弟）',
  nz: '大姨子',
  nls: '小姨子',
  erxi: '儿媳',
  nxf: '女婿',
  sxi: '孙媳',
  zxi: '侄媳',
  tb: '堂哥或堂弟',
  ts: '堂姐或堂妹',
  bb: '表哥或表弟',
  bs: '表姐或表妹'
}

type KinMove = string | { ambiguous: string[] }

/** 常见关系链推算表：当前角色 + 一步关系 → 新角色、歧义说明或不支持。 */
const KIN_MOVES: Record<string, Partial<Record<KinStep, KinMove>>> = {
  self: { f: 'f', m: 'm', ob: 'ob', lb: 'lb', os: 'os', ls: 'ls', h: 'h', w: 'w', s: 's', d: 'd' },
  f: {
    f: 'gf',
    m: 'gm',
    w: 'm',
    ob: 'bf',
    lb: 'uf',
    os: 'gu',
    ls: 'gu',
    s: { ambiguous: ['你自己（如果你是男性）', '你的兄弟'] },
    d: { ambiguous: ['你自己（如果你是女性）', '你的姐妹'] }
  },
  m: { f: 'wgf', m: 'wgm', h: 'f', ob: 'wf', lb: 'wf', os: 'ym', ls: 'ym' },
  gf: { f: 'ggf', m: 'ggm', w: 'gm', s: { ambiguous: ['你的爸爸', '你的伯父', '你的叔叔'] } },
  gm: { f: 'ggf', m: 'ggm', h: 'gf', s: { ambiguous: ['你的爸爸', '你的伯父', '你的叔叔'] } },
  wgf: { f: 'wggf', m: 'wggm', w: 'wgm' },
  wgm: { f: 'wggf', m: 'wggm', h: 'wgf' },
  ggf: { w: 'ggm' },
  ggm: { h: 'ggf' },
  wggf: { w: 'wggm' },
  wggm: { h: 'wggf' },
  h: {
    f: 'hf',
    m: 'hm',
    ob: 'db',
    lb: 'dm',
    os: 'dz',
    ls: 'xz',
    s: { ambiguous: ['你的儿子（如果是你们共同的孩子）', '继子'] },
    d: { ambiguous: ['你的女儿', '继女'] }
  },
  w: { f: 'wff', m: 'wfm', ob: 'nj', lb: 'nl', os: 'nz', ls: 'nls' },
  ob: { f: 'bf', m: 'bm', w: 'xi', s: 'zzi', d: 'zni' },
  lb: { f: 'uf', m: 'sm', w: 'dxi', s: 'zzi', d: 'zni' },
  os: { h: 'jf', s: 'wszi', d: 'wszn' },
  ls: { h: 'mf', s: 'wszi', d: 'wszn' },
  s: { s: 'zz', d: 'zn', w: 'erxi' },
  d: { s: 'ws', d: 'wn', h: 'nxf' },
  zz: { f: 's', w: 'sxi' },
  zn: { f: 's' },
  ws: { f: 'd' },
  wn: { f: 'd' },
  zzi: { w: 'zxi' },
  bf: { w: 'bm', s: 'tb', d: 'ts' },
  uf: { w: 'sm', s: 'tb', d: 'ts' },
  gu: { h: 'gfu', s: 'bb', d: 'bs' },
  wf: { w: 'jm', s: 'bb', d: 'bs' },
  ym: { h: 'yfu', s: 'bb', d: 'bs' },
  hf: { w: 'hm' },
  hm: { h: 'hf' },
  wff: { w: 'wfm' },
  wfm: { h: 'wff' },
  xi: { s: 'zzi', d: 'zni' },
  dxi: { s: 'zzi', d: 'zni' },
  jf: { s: 'wszi', d: 'wszn' },
  mf: { s: 'wszi', d: 'wszn' },
  erxi: { s: 'zz', d: 'zn' },
  nxf: { s: 'ws', d: 'wn' }
}

const MAX_KIN_STEPS = 8

function kinship(args: ToolArgs): ToolResult {
  const raw = readString(args, 'chain', '')
    .replace(/爷爷/g, '爸爸的爸爸')
    .replace(/奶奶/g, '爸爸的妈妈')
    .replace(/外公/g, '妈妈的爸爸')
    .replace(/外婆/g, '妈妈的妈妈')
  const tokens = raw
    .split(/的|、|\/|>|→|,|，|\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
  if (tokens.length === 0) {
    return { ok: false, error: '请输入关系链，如「妈妈的哥哥」/ Relation chain is required' }
  }
  const chain: KinStep[] = []
  const words: string[] = []
  for (const token of tokens) {
    if (chain.length === 0 && ['我', '自己', '本人'].includes(token)) continue
    const step = KIN_TERMS[token]
    if (!step) {
      return {
        ok: false,
        error: `无法识别关系词「${token}」；支持：爸爸/妈妈/哥哥/弟弟/姐姐/妹妹/老公/老婆/儿子/女儿 / Unknown kin term`
      }
    }
    chain.push(step)
    words.push(token)
  }
  if (chain.length === 0) {
    return { ok: false, error: '关系链只有「我」，请继续补充关系 / Chain must contain a relation' }
  }
  if (chain.length > MAX_KIN_STEPS) {
    return { ok: false, error: `关系链最多 ${MAX_KIN_STEPS} 步 / Chain too long` }
  }

  let role = 'self'
  const path: string[] = ['我']
  for (let i = 0; i < chain.length; i += 1) {
    const step = chain[i]
    const move = KIN_MOVES[role]?.[step]
    const soFar = words.slice(0, i + 1).join('的')
    if (move === undefined) {
      return {
        ok: false,
        error: `无法推断「${soFar}」：「${KIN_NAMES[role]}」的「${words[i]}」这一组合暂不支持 / Unsupported combination`
      }
    }
    if (typeof move !== 'string') {
      return {
        ok: false,
        error: `无法确定「${soFar}」：「${KIN_NAMES[role]}」的「${words[i]}」可能是多种亲戚（如：${move.ambiguous.join('、')}），请换用更明确的说法 / Ambiguous combination`
      }
    }
    role = move
    path.push(KIN_NAMES[role])
  }
  const name = KIN_NAMES[role]
  return {
    ok: true,
    data: { chain: words, steps: chain.length, name, path },
    text: `${words.join('的')} → ${name}\n推断路径：${path.join(' → ')}`,
    note: '按普通家庭结构（兄弟姐妹默认同父同母）推算；遇到多种可能时给出具体说明而不是猜测，也不做无限推导。'
  }
}

/* ------------------------------------------------------------------ */
/* 签名 / 印章 / 文字图标                                              */
/* ------------------------------------------------------------------ */

const SIGNATURE_FONTS: Record<string, string> = {
  kai: '"KaiTi","STKaiti","KaiTi_GB2312","楷体",cursive',
  xingkai: '"Xingkai SC","STXingkai","华文行楷",cursive',
  lishu: '"LiSu","隶书","STLiti",serif',
  script: '"Brush Script MT","Segoe Script","URW Chancery L",cursive',
  comic: '"Comic Sans MS","Chalkboard SE","Comic Neue",cursive'
}

const STAMP_FONT = '"SimSun","Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif'
const ICON_FONT = '"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif'

function signature(args: ToolArgs): ToolResult {
  const text = readString(args, 'text', '')
  if (text.trim() === '') {
    return { ok: false, error: '请输入签名文字 / Signature text is required' }
  }
  if ([...text].length > 24) {
    return { ok: false, error: '签名最多 24 个字符 / At most 24 characters' }
  }
  if (/[\r\n\t]/.test(text)) {
    return { ok: false, error: '签名文字不能包含换行或制表符 / No line breaks allowed' }
  }
  const fontKey = readString(args, 'font', 'kai')
  const family = SIGNATURE_FONTS[fontKey]
  if (!family) {
    return { ok: false, error: '未知字体风格 / Unknown font style' }
  }
  const color = readColor(args, 'color', '#1a1a1a', '颜色')
  if (!color.ok) return { ok: false, error: color.error }
  const size = readNumberField(args, 'signature', 'size', '字号')
  if (!size.ok) return { ok: false, error: size.error }
  const tilt = readBool(args, 'tilt', true)
  const length = [...text].length
  const width = Math.max(160, Math.round(size.value * length * 1.05))
  const height = Math.round(size.value * 1.9)
  const cx = width / 2
  const cy = height / 2
  const rotate = tilt ? ` transform="rotate(-3 ${cx} ${cy})"` : ''
  const xml =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="none"/>` +
    `<text x="${cx}" y="${cy}" font-family="${family}" font-size="${size.value}" fill="${color.value}" ` +
    `text-anchor="middle" dominant-baseline="central"${rotate}>${escapeXml(text)}</text>` +
    `</svg>`
  return {
    ok: true,
    data: { font: fontKey, size: size.value, tilt, color: color.value, width, height },
    files: [svgFile('signature.svg', xml)],
    text: `签名 SVG 已生成（${width}×${height}，字体风格：${fontKey}）。`,
    note: '这是用系统字体渲染的矢量文字，不是真人手写识别；效果取决于本机是否安装对应字体，未安装时按通用 cursive 兜底。'
  }
}

function stampGenerator(args: ToolArgs): ToolResult {
  const top = readString(args, 'top', '').trim()
  const center = readString(args, 'center', '').trim()
  const bottom = readString(args, 'bottom', '').trim()
  if (top === '' && center === '' && bottom === '') {
    return { ok: false, error: '请至少填写一项文字 / At least one text is required' }
  }
  if ([...top].length > 10 || [...bottom].length > 10 || [...center].length > 8) {
    return { ok: false, error: '顶部/底部弧形文字最多 10 字，中心文字最多 8 字 / Text too long' }
  }
  const shape = readString(args, 'shape', 'circle')
  if (!['circle', 'ellipse', 'square'].includes(shape)) {
    return { ok: false, error: '未知形状 / Unknown shape' }
  }
  const color = readColor(args, 'color', '#b3261e', '印色')
  if (!color.ok) return { ok: false, error: color.error }
  const ink = color.value

  const esc = (value: string): string => escapeXml(value)
  let xml: string
  if (shape === 'circle') {
    xml =
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">` +
      `<circle cx="120" cy="120" r="108" fill="none" stroke="${ink}" stroke-width="7"/>` +
      `<circle cx="120" cy="120" r="88" fill="none" stroke="${ink}" stroke-width="2.5"/>` +
      `<path id="stampTop" d="M 48,120 A 72,72 0 0 1 192,120" fill="none"/>` +
      `<path id="stampBottom" d="M 48,120 A 72,72 0 0 0 192,120" fill="none"/>` +
      (top
        ? `<text font-family="${STAMP_FONT}" font-size="24" fill="${ink}" text-anchor="middle"><textPath href="#stampTop" startOffset="50%">${esc(top)}</textPath></text>`
        : '') +
      (bottom
        ? `<text font-family="${STAMP_FONT}" font-size="22" fill="${ink}" text-anchor="middle"><textPath href="#stampBottom" startOffset="50%">${esc(bottom)}</textPath></text>`
        : '') +
      (center
        ? `<text x="120" y="120" font-family="${STAMP_FONT}" font-size="30" fill="${ink}" text-anchor="middle" dominant-baseline="central">${esc(center)}</text>`
        : '') +
      `</svg>`
  } else if (shape === 'ellipse') {
    xml =
      `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="180" viewBox="0 0 260 180">` +
      `<ellipse cx="130" cy="90" rx="118" ry="82" fill="none" stroke="${ink}" stroke-width="7"/>` +
      `<ellipse cx="130" cy="90" rx="100" ry="64" fill="none" stroke="${ink}" stroke-width="2.5"/>` +
      `<path id="stampTop" d="M 30,90 A 100,64 0 0 1 230,90" fill="none"/>` +
      `<path id="stampBottom" d="M 30,90 A 100,64 0 0 0 230,90" fill="none"/>` +
      (top
        ? `<text font-family="${STAMP_FONT}" font-size="22" fill="${ink}" text-anchor="middle"><textPath href="#stampTop" startOffset="50%">${esc(top)}</textPath></text>`
        : '') +
      (bottom
        ? `<text font-family="${STAMP_FONT}" font-size="20" fill="${ink}" text-anchor="middle"><textPath href="#stampBottom" startOffset="50%">${esc(bottom)}</textPath></text>`
        : '') +
      (center
        ? `<text x="130" y="90" font-family="${STAMP_FONT}" font-size="26" fill="${ink}" text-anchor="middle" dominant-baseline="central">${esc(center)}</text>`
        : '') +
      `</svg>`
  } else {
    xml =
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">` +
      `<rect x="8" y="8" width="224" height="224" rx="10" fill="none" stroke="${ink}" stroke-width="7"/>` +
      (top
        ? `<text x="120" y="64" font-family="${STAMP_FONT}" font-size="24" fill="${ink}" text-anchor="middle">${esc(top)}</text>`
        : '') +
      (center
        ? `<text x="120" y="124" font-family="${STAMP_FONT}" font-size="30" fill="${ink}" text-anchor="middle">${esc(center)}</text>`
        : '') +
      (bottom
        ? `<text x="120" y="180" font-family="${STAMP_FONT}" font-size="24" fill="${ink}" text-anchor="middle">${esc(bottom)}</text>`
        : '') +
      `</svg>`
  }
  return {
    ok: true,
    data: { shape, top, center, bottom, color: ink },
    files: [svgFile('stamp.svg', xml)],
    text: `印章 SVG 已生成（${shape}）。`,
    note: '仅供版式学习/演示，生成的印章不具任何法律效力，请勿用于正式文件。'
  }
}

function iconGenerator(args: ToolArgs): ToolResult {
  const text = readString(args, 'text', '').trim()
  if (text === '') {
    return { ok: false, error: '请输入 1-4 个文字 / Text is required' }
  }
  const length = [...text].length
  if (length > 4) {
    return { ok: false, error: '最多 4 个字符 / At most 4 characters' }
  }
  if (Array.from(text).some((c) => c.charCodeAt(0) < 32)) {
    return { ok: false, error: '文字不能包含控制字符 / Control characters are not allowed' }
  }
  const bg = readColor(args, 'bg', '#4f46e5', '背景色')
  if (!bg.ok) return { ok: false, error: bg.error }
  const fg = readColor(args, 'fg', '#ffffff', '文字色')
  if (!fg.ok) return { ok: false, error: fg.error }
  const size = readNumberField(args, 'icon-generator', 'size', '尺寸')
  if (!size.ok) return { ok: false, error: size.error }
  const radius = readNumberField(args, 'icon-generator', 'radius', '圆角')
  if (!radius.ok) return { ok: false, error: radius.error }
  const fontSize = length <= 1 ? 46 : length === 2 ? 34 : length === 3 ? 26 : 20
  const xml =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.value}" height="${size.value}" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" rx="${radius.value}" fill="${bg.value}"/>` +
    `<text x="50" y="52" font-family="${ICON_FONT}" font-size="${fontSize}" fill="${fg.value}" ` +
    `text-anchor="middle" dominant-baseline="middle">${escapeXml(text)}</text>` +
    `</svg>`
  return {
    ok: true,
    data: {
      text,
      background: bg.value,
      textColor: fg.value,
      size: size.value,
      radius: radius.value
    },
    files: [svgFile('icon.svg', xml)],
    text: `图标 SVG 已生成（${size.value}×${size.value}，圆角 ${radius.value}%）。`,
    note: 'SVG 只使用固定语法生成；文字与颜色均经过转义/白名单校验，不会注入任意标记。'
  }
}

/* ------------------------------------------------------------------ */
/* 分发                                                                */
/* ------------------------------------------------------------------ */

export async function execute(id: string, args: ToolArgs): Promise<ToolResult> {
  try {
    switch (id) {
      case 'char-statistics':
        return charStatistics(args)
      case 'text-diff':
        return textDiff(args)
      case 'text-clean':
        return textClean(args)
      case 'chinese-pinyin':
        return chinesePinyin(args)
      case 'chinese-segment':
        return chineseSegment(args)
      case 'chinese-convert':
        return chineseConvert(args)
      case 'ascii-art':
        return asciiArt(args)
      case 'rmb-uppercase':
        return rmbUppercase(args)
      case 'choice':
        return randomChoice(args)
      case 'qrcode':
        return await qrCode(args)
      case 'password-generator':
        return passwordGenerator(args)
      case 'kinship':
        return kinship(args)
      case 'signature':
        return signature(args)
      case 'stamp-generator':
        return stampGenerator(args)
      case 'icon-generator':
        return iconGenerator(args)
      default:
        return { ok: false, error: `未知文本工具: ${id}` }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '处理失败 / Operation failed' }
  }
}
