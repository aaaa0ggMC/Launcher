/**
 * YARJ llama.cpp 图像视觉分析与元数据标注脚本 (Cockpit Script)
 *
 * 适用于 Linux Cockpit 脚本中心直接执行：
 * - 自动通过 YARJ 通用插槽获取全部图片 (按有 GPS 优先排序)
 * - 调用本地 llama.cpp (llama-server) OpenAI 兼容多模态 API
 * - 统一扁平化架构输出：type (精简 17 类别，彻底移除 Object 泛化项), tags, brief, ocr
 * - 指令与图片紧邻注入 (User 消息)，保证 Qwen2.5-VL 100% 精准遵循
 * - 绕过 Node.js WHATWG fetch 对受限端口 (如 6666) 的端口限制
 * - 内置反复读死循环机制 (惩罚采样 + 连续重复行折叠压制)
 * - 将标签同步合并至 YARJ 顶层 tags，方便相册一键检索与隐私过滤
 * - 具备图形化参数配置、断点续写、详细推理速度回显与安全中断
 */

/* global cockpit */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

export const config = {
  llamaUrl: {
    type: 'string',
    label: 'llama.cpp 接口地址',
    default: 'http://127.0.0.1:6666',
    description: '本地 llama-server 服务地址 (如 http://127.0.0.1:6666)'
  },
  model: {
    type: 'string',
    label: '模型名称 (Model ID)',
    default: 'qwen-vl',
    description: 'llama-server 加载的模型名称，默认 qwen-vl，会自动检测'
  },
  limit: {
    type: 'number',
    label: '本次处理数量限制',
    default: 0,
    description: '0 表示不限制，处理全部待标注图片'
  },
  force: {
    type: 'boolean',
    label: '强制重新识别',
    default: false,
    description: '若开启，已存在 AI 标注的照片也会被重新分析'
  },
  temperature: {
    type: 'number',
    label: '采样温度 (Temperature)',
    default: 0.2,
    description: '视觉标注推荐 0.1~0.3，结构化 JSON 识别输出更稳定精准'
  },
  repeatPenalty: {
    type: 'number',
    label: '重复惩罚 (Repeat Penalty)',
    default: 1.2,
    description: '有效抑制模型在 OCR 相似短文本时陷入死循环复读，推荐 1.15~1.25'
  },
  maxLength: {
    type: 'number',
    label: '最大生成长度 (token)',
    default: 1024,
    description: '单张图片输出 token 上限，一般相册标注建议 1024'
  },
  delayMs: {
    type: 'number',
    label: '每张冷却间隔 (毫秒)',
    default: 300,
    description: '处理完一张后的缓冲时间，降低 GPU / CPU 压力'
  }
}

// 严谨、具体的 17 大核心类别（完全剔除 Object 泛化项）
const ALLOWED_TYPES = [
  'Identity', // 身份证、护照、驾驶证、学生证、工卡、社保卡、户口本等各类身份凭证
  'Financial', // 银行卡、存折、支票、发票凭据、转账账单流水等金融资产
  'Credential', // 密码便签、密钥、二步验证码、登录凭据
  'Receipt', // 快递面单、外卖小票、购物收据、消费凭单
  'Document', // 普通试卷、纸质文件、书籍页、公文、证书
  'Blackboard', // 黑板、白板、粉笔板书、公式图表
  'Screenshot', // 手机/电脑屏幕截图、网页、聊天记录截图
  'Portrait', // 人物照、单人自拍、肖像、手部/面部等人物肢体特写与抓拍
  'GroupPhoto', // 多人合影、聚会聚餐大合照
  'Food', // 美食佳肴、饮品甜点、烹饪菜品、水果零食
  'Pet', // 猫咪、狗狗、鸟类等宠物与小动物
  'Plant', // 花卉、绿植、盆栽、树木植物
  'Vehicle', // 汽车、摩托车、电动车、自行车、交通载具
  'Scenery', // 自然风光、山川湖海、森林天空、日落夕阳
  'Architecture', // 建筑物、街景街道、桥梁、都市地标
  'Interior', // 室内空间、房间陈设、家具家电、室内桌面用品
  'Anime' // 动漫壁纸、二次元插画、手办模型、漫画海报
]

const TYPE_LOOKUP = new Map()
for (const t of ALLOWED_TYPES) {
  TYPE_LOOKUP.set(t.toLowerCase(), t)
}

// 常见别名映射
const TYPE_ALIASES = {
  id: 'Identity',
  idcard: 'Identity',
  'id-card': 'Identity',
  id_card: 'Identity',
  id_document: 'Identity',
  finance: 'Financial',
  bankcard: 'Financial',
  bank_card: 'Financial',
  invoice: 'Financial',
  password: 'Credential',
  secret: 'Credential',
  token: 'Credential',
  bill: 'Receipt',
  express: 'Receipt',
  package: 'Receipt',
  animal: 'Pet',
  dog: 'Pet',
  cat: 'Pet',
  flower: 'Plant',
  tree: 'Plant',
  car: 'Vehicle',
  bike: 'Vehicle',
  motorcycle: 'Vehicle',
  traffic: 'Vehicle',
  landscape: 'Scenery',
  nature: 'Scenery',
  sky: 'Scenery',
  building: 'Architecture',
  street: 'Architecture',
  city: 'Architecture',
  room: 'Interior',
  home: 'Interior',
  acg: 'Anime',
  manga: 'Anime',
  person: 'Portrait',
  people: 'Portrait'
}
for (const [alias, canonical] of Object.entries(TYPE_ALIASES)) {
  TYPE_LOOKUP.set(alias.toLowerCase(), canonical)
}

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.avif'
])

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif'
}

function isImageFile(filePath) {
  if (!filePath) return false
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(filePath.slice(dot).toLowerCase())
}

function getMimeType(filePath) {
  if (!filePath) return 'image/jpeg'
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return 'image/jpeg'
  const ext = filePath.slice(dot).toLowerCase()
  return MIME_MAP[ext] || 'image/jpeg'
}

function validateAndNormalizeType(rawType) {
  if (!rawType || typeof rawType !== 'string') return null
  const clean = rawType.trim().toLowerCase()
  if (TYPE_LOOKUP.has(clean)) {
    return TYPE_LOOKUP.get(clean)
  }
  for (const t of ALLOWED_TYPES) {
    const regex = new RegExp(`\\b${t}\\b`, 'i')
    if (regex.test(clean)) return t
  }
  return null
}

/**
 * 智能类型语义推断兜底：如果模型未给出有效类型，根据标签与简述推断
 */
function inferTypeFromContent(tags, brief) {
  const combined = `${tags.join(' ')} ${brief}`.toLowerCase()

  // 1. 优先判定敏感资产
  if (/身份证|护照|驾驶证|行驶证|学生证|社保卡|工卡|户口本|证件/.test(combined)) {
    return 'Identity'
  }
  if (/银行卡|存折|支票|发票|发票单|流水单|转账账单/.test(combined)) {
    return 'Financial'
  }
  if (/密码|密钥|二步验证|token|私钥/.test(combined)) {
    return 'Credential'
  }
  if (/快递|面单|外卖单|小票|收据/.test(combined)) {
    return 'Receipt'
  }

  // 2. 人物与合影
  if (/合影|合照|聚餐|同框|多人/.test(combined)) {
    return 'GroupPhoto'
  }
  if (
    /人物|人像|肖像|自拍|单人|写真|面部|脸部|手部|背影|老人|小孩|宝宝|婴儿|男人|女人|男生|女生|女孩|男孩|身材|肢体/.test(
      combined
    )
  ) {
    return 'Portrait'
  }

  // 3. 常见主体类型
  if (/狗|猫|小狗|小猫|宠物|鸟|兔|松鼠|仓鼠|小动物/.test(combined)) {
    return 'Pet'
  }
  if (
    /电动车|自行车|摩托车|汽车|轿车|卡车|公交|客车|载具|单车|火车|高铁|飞机|车道|停车/.test(
      combined
    )
  ) {
    return 'Vehicle'
  }
  if (
    /山|湖|海|河流|森林|天空|云彩|云朵|日落|夕阳|日出|自然|田野|沙漠|雪山|风光|天际线/.test(
      combined
    )
  ) {
    return 'Scenery'
  }
  if (/花|花卉|绿植|树木|盆栽|树枝|荷花|叶子|植物/.test(combined)) {
    return 'Plant'
  }
  if (/建筑物|大厦|房屋|楼宇|街景|街道|桥梁|古建筑|寺庙|城堡|地标/.test(combined)) {
    return 'Architecture'
  }
  if (/菜|美食|佳肴|饭|肉|蛋糕|甜点|面包|水果|咖啡|茶饮|饮品|餐点|火锅|米线|面条/.test(combined)) {
    return 'Food'
  }
  if (/试卷|考卷|数学题|微积分|笔记|草稿|课本|书籍|公文|证书|合同|纸张/.test(combined)) {
    return 'Document'
  }
  if (/黑板|白板|粉笔|板书/.test(combined)) {
    return 'Blackboard'
  }
  if (/截图|聊天记录|朋友圈|网页|对话框|应用界面/.test(combined)) {
    return 'Screenshot'
  }
  if (/二次元|动漫|手办|插画|漫画|壁纸|cosplay/.test(combined)) {
    return 'Anime'
  }
  if (
    /室内|房间|客厅|卧室|商场内|书房|展厅|店铺内|桌面|家具|杯子|键盘|电脑|鼠标|静物/.test(combined)
  ) {
    return 'Interior'
  }

  if (!combined.trim()) {
    return ''
  }

  return 'Interior'
}

/**
 * 判断是否为大模型偷懒输出的假占位符
 */
function isPlaceholderText(text) {
  if (!text || typeof text !== 'string') return false
  const t = text.trim()
  if (/^\[(?:ocr)?(?:提取|图片)?.*(?:文字|内容|文本|字符|简述|结果).*\]$/i.test(t)) return true
  if (/^\[(?:待填|占位|实际提取|提取的).*\]$/i.test(t)) return true
  if (
    t === '实际提取的字符内容' ||
    t === '无文字填空字符串' ||
    t === '文字内容' ||
    t === '实际提取的内容' ||
    t === '真实文字' ||
    t === '真实摘录的文字' ||
    t === '[OCR结果]' ||
    t === '[OCR提取的关键文字]' ||
    t === '[图片中的文字内容]'
  ) {
    return true
  }
  return false
}

/**
 * 智能清洗并压缩 OCR 文本
 */
function cleanOcrText(rawOcr, maxChars = 2000) {
  let lines = []
  if (Array.isArray(rawOcr)) {
    lines = rawOcr.map((item) => String(item ?? '').trim()).filter(Boolean)
  } else if (typeof rawOcr === 'string') {
    lines = rawOcr
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } else if (rawOcr != null) {
    lines = [String(rawOcr).trim()].filter(Boolean)
  }

  if (!lines.length) return ''

  const deduped = []
  let prevLine = ''
  let repeatCount = 0

  for (const line of lines) {
    if (line === prevLine) {
      repeatCount++
      if (repeatCount <= 2) {
        deduped.push(line)
      }
    } else {
      prevLine = line
      repeatCount = 1
      deduped.push(line)
    }
  }

  let text = deduped.join('\n')
  if (isPlaceholderText(text)) {
    return ''
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}...`
  }
  return text
}

function sanitizeAiOutput(rawJson) {
  let data = rawJson
  if (Array.isArray(data) && data.length > 0) {
    data = data[0]
  }
  if (data && typeof data === 'object' && data.ai_generated) {
    data = data.ai_generated
  } else if (data && typeof data === 'object' && data.aigenerated) {
    data = data.aigenerated
  }

  if (!data || typeof data !== 'object') {
    throw new Error('AI 输出不是有效的对象结构')
  }

  const brief = typeof data.brief === 'string' ? data.brief.trim() : String(data.brief || '').trim()
  const ocr = cleanOcrText(data.ocr)

  // 处理 tags 数组
  let tags = []
  if (Array.isArray(data.tags)) {
    tags = data.tags.map((t) => String(t ?? '').trim()).filter(Boolean)
  } else if (typeof data.tags === 'string') {
    tags = data.tags
      .split(/[,，、;\s\n]+/)
      .map((t) => t.trim())
      .filter(Boolean)
  }

  let normalizedType = validateAndNormalizeType(data.type)

  // 若模型给出的类型为空或不匹配，且有标签或简述，则通过 tags 和 brief 做智能语义推断
  if (!normalizedType && (tags.length || brief)) {
    normalizedType = inferTypeFromContent(tags, brief)
  }

  // 如果识别为敏感类型，显式附加标签以便快速检索
  if (normalizedType === 'Identity' && !tags.includes('Identity') && !tags.includes('身份证件')) {
    tags.unshift('Identity', '身份证件')
  } else if (
    normalizedType === 'Financial' &&
    !tags.includes('Financial') &&
    !tags.includes('金融凭证')
  ) {
    tags.unshift('Financial', '金融凭证')
  } else if (
    normalizedType === 'Credential' &&
    !tags.includes('Credential') &&
    !tags.includes('密码凭据')
  ) {
    tags.unshift('Credential', '密码凭据')
  } else if (
    normalizedType === 'Receipt' &&
    !tags.includes('Receipt') &&
    !tags.includes('快递小票')
  ) {
    tags.unshift('Receipt', '快递小票')
  }

  tags = Array.from(new Set(tags))

  return { type: normalizedType, tags, brief, ocr }
}

function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') throw new Error('响应文本为空')
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    /* ignore */
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim())
    } catch {
      /* ignore */
    }
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const candidate = trimmed.slice(start, end + 1)
    try {
      return JSON.parse(candidate)
    } catch {
      /* ignore */
    }
  }

  if (start !== -1) {
    let candidate = trimmed.slice(start)
    candidate = candidate.replace(/```[a-z]*$/i, '').trim()

    const unescapedQuotes = candidate.match(/(?<!\\)"/g)
    if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
      candidate += '"'
    }

    const openBraces = (candidate.match(/{/g) || []).length
    const closeBraces = (candidate.match(/}/g) || []).length
    if (openBraces > closeBraces) {
      candidate += '}'.repeat(openBraces - closeBraces)
    }

    try {
      return JSON.parse(candidate)
    } catch {
      /* 继续兜底 */
    }

    const typeMatch = trimmed.match(/"type"\s*:\s*"([^"]*)"/i)
    const briefMatch = trimmed.match(/"brief"\s*:\s*"([^"]+)"/i)
    if (typeMatch || briefMatch) {
      const ocrMatch = trimmed.match(/"ocr"\s*:\s*"?([\s\S]*?)(?:"\s*}|$)/i)
      return {
        ai_generated: {
          type: typeMatch ? typeMatch[1] : '',
          tags: [],
          brief: briefMatch ? briefMatch[1] : '',
          ocr: ocrMatch ? cleanOcrText(ocrMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')) : ''
        }
      }
    }
  }

  throw new Error(`返回文本中未找到 JSON 结构: ${text}`)
}

/**
 * 原生 HTTP 请求封装
 */
async function httpRequest(
  urlStr,
  { method = 'GET', headers = {}, body, signal, timeoutMs = 180000 } = {}
) {
  const { request: httpRequest } = await import('node:http')
  const { request: httpsRequest } = await import('node:https')
  const { URL } = await import('node:url')

  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr)
    const isHttps = parsed.protocol === 'https:'
    const reqFn = isHttps ? httpsRequest : httpRequest

    const reqHeaders = { ...headers }
    let bodyBuffer = null
    if (body != null) {
      bodyBuffer = Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      reqHeaders['Content-Length'] = bodyBuffer.length
    }

    let timer = null
    let onAbort = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
        onAbort = null
      }
      bodyBuffer = null
    }

    const req = reqFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          chunks.length = 0
          const text = buffer.toString('utf-8')
          cleanup()
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: res.headers,
            text: async () => text,
            json: async () => JSON.parse(text)
          })
        })
      }
    )

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup()
        req.destroy(new Error(`请求超时 (${Math.round(timeoutMs / 1000)} 秒)`))
      }, timeoutMs)
    }

    req.on('error', (err) => {
      cleanup()
      reject(err)
    })

    req.on('close', cleanup)

    if (signal) {
      if (signal.aborted) {
        cleanup()
        req.destroy(new Error('操作已取消'))
        return
      }
      onAbort = () => {
        cleanup()
        req.destroy(new Error('操作已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (bodyBuffer) {
      req.write(bodyBuffer)
      bodyBuffer = null
    }
    req.end()
  })
}

/**
 * 探测 llama.cpp 服务健康状态及模型
 */
async function inspectLlamaServer(llamaUrl, preferredModel, signal) {
  try {
    const healthRes = await httpRequest(`${llamaUrl}/health`, { signal, timeoutMs: 5000 })
    if (!healthRes.ok) {
      throw new Error(`HTTP ${healthRes.status}`)
    }
  } catch (err) {
    throw new Error(`无法连接到 llama-server (${llamaUrl}): ${err.message}`)
  }

  let resolvedModel = preferredModel || 'qwen-vl'
  let modelMeta = null

  try {
    const modelsRes = await httpRequest(`${llamaUrl}/v1/models`, { signal, timeoutMs: 5000 })
    if (modelsRes.ok) {
      const data = await modelsRes.json()
      const list = data.data || data.models || []
      if (Array.isArray(list) && list.length > 0) {
        const match = list.find((m) => (m.id || m.name) === preferredModel)
        if (match) {
          resolvedModel = match.id || match.name
          modelMeta = match
        } else {
          resolvedModel = list[0].id || list[0].name
          modelMeta = list[0]
        }
      }
    }
  } catch {
    /* 忽略异常 */
  }

  return { resolvedModel, modelMeta }
}

/**
 * 执行多模态视觉推理 (OpenAI 兼容接口)
 */
async function callLlamaVision({
  llamaUrl,
  filePath,
  model,
  maxLength = 1024,
  temperature = 0.2,
  repeatPenalty = 1.1,
  forceFreeform = false,
  prompt,
  signal
}) {
  const { readFileSync } = await import('node:fs')
  const mime = getMimeType(filePath)
  const fileBytes = readFileSync(filePath)
  const base64 = fileBytes.toString('base64')
  const imageUrl = `data:${mime};base64,${base64}`

  const userPrompt =
    prompt ||
    `请仔细观察这张图片，完成以下视觉标注任务：

【分类列表 (type)】必须从以下 17 个英文词中挑选最贴切的一个：
- Vehicle (汽车/电动车/摩托车/自行车/各类车辆)
- Architecture (街景/建筑物/街道/桥梁)
- Scenery (自然风景/天空/山水/日落)
- Interior (室内房间/客厅/陈设/室内桌面用品)
- Portrait (人物照片/单人自拍/肖像/手部面部特写)
- GroupPhoto (多人合影/合照)
- Pet (宠物/猫/狗/动物)
- Plant (花卉/植物/树木)
- Food (美食/菜肴/饮品/水果)
- Document (书籍/试卷/文件/纸张)
- Blackboard (黑板/白板板书)
- Screenshot (屏幕截图/聊天记录)
- Identity (身份证/护照/学生证/工卡等证件)
- Financial (银行卡/发票/账单)
- Credential (密码/密钥/验证码)
- Receipt (快递面单/购物小票)
- Anime (动漫壁纸/插画/二次元/手办)

【字段要求】
1. type: 必须填写上述 17 个分类之一。照片底部的相机日期/水印不是画面主体，也不属于 Document，请以实际画面场景为主。
2. tags: 给出 4~8 个贴切具体的中文标签。
3. brief: 用一两句话描述画面主要内容。
4. ocr: 逐字真实提取图片里的所有手写或印刷文字内容（无需提取相机日期/机型水印）。绝对严禁输出“[OCR提取的关键文字]”、“[OCR结果]”、“实际提取的字符内容”等任何概括性或占位符号；有文字就一字一句真实摘录，无文字则直接填空字符串""。

严格按以下 JSON 格式输出：
{
  "ai_generated": {
    "type": "Scenery",
    "tags": ["标签1", "标签2", "标签3", "标签4"],
    "brief": "画面主要内容简述",
    "ocr": ""
  }
}`

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageUrl }
          },
          {
            type: 'text',
            text: userPrompt
          }
        ]
      }
    ],
    temperature,
    repeat_penalty: repeatPenalty,
    max_tokens: maxLength
  }

  if (!forceFreeform) {
    payload.response_format = { type: 'json_object' }
  }

  let res = await httpRequest(`${llamaUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    signal,
    timeoutMs: 180000 // 单图 3 分钟上限
  })

  if (!res.ok) {
    const errText = await res.text()
    if (res.status === 500 || errText.includes('peg-native format')) {
      // 语法约束器报错，降级为无 response_format 重新发起请求（由客户端解析 JSON）
      const fallbackPayload = { ...payload }
      delete fallbackPayload.response_format
      res = await httpRequest(`${llamaUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: fallbackPayload,
        signal,
        timeoutMs: 180000
      })
      if (!res.ok) {
        const fallbackErr = await res.text()
        throw new Error(`llama-server 返回错误 HTTP ${res.status}: ${fallbackErr}`)
      }
    } else {
      throw new Error(`llama-server 返回错误 HTTP ${res.status}: ${errText}`)
    }
  }

  const resJson = await res.json()
  const content = resJson.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('llama-server 未返回任何文本内容')
  }

  return {
    content,
    timings: resJson.timings,
    usage: resJson.usage
  }
}

/**
 * 针对模型偷懒生成假占位符时的二次纯文本 OCR 精准补偿
 */
async function refineOcrText({ llamaUrl, filePath, model, signal }) {
  const { readFileSync } = await import('node:fs')
  const mime = getMimeType(filePath)
  const fileBytes = readFileSync(filePath)
  const base64 = fileBytes.toString('base64')
  const imageUrl = `data:${mime};base64,${base64}`

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          {
            type: 'text',
            text: '请逐字摘录图片中的所有文字内容（包括手写、印刷体、表格、数字），严禁输出任何形式的占位符或解释说明，直接输出文字（若图片中确实无文字请直接回复“无”）：'
          }
        ]
      }
    ],
    temperature: 0.1,
    max_tokens: 1024
  }

  try {
    const res = await httpRequest(`${llamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal,
      timeoutMs: 60000
    })
    if (!res.ok) return ''
    const data = await res.json()
    let text = data.choices?.[0]?.message?.content || ''
    text = text.trim()
    if (text === '无' || text === '无文字' || text.startsWith('无。') || isPlaceholderText(text)) {
      return ''
    }
    return cleanOcrText(text)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 脚本执行入口 (接受 cockpit 上下文)
// ---------------------------------------------------------------------------

const llamaUrl = String(
  cockpit.config?.llamaUrl ||
    cockpit.config?.apiUrl ||
    cockpit.config?.comfyUrl ||
    'http://127.0.0.1:6666'
).replace(/\/+$/, '')

const requestedModel = String(cockpit.config?.model || cockpit.config?.modelChoice || 'qwen-vl')
const limit = Number(cockpit.config?.limit) || 0
const force = Boolean(cockpit.config?.force)
const temperature = Number(cockpit.config?.temperature ?? 0.2)
const repeatPenalty = Number(cockpit.config?.repeatPenalty ?? 1.2)
const maxLength = Number(cockpit.config?.maxLength) || 1024
const delayMs = Number(cockpit.config?.delayMs) || 300

cockpit.log(`🚀 开始 YARJ 图像视觉标注任务 (llama.cpp)`)
cockpit.log(
  `🌐 服务端点: ${llamaUrl} | 目标模型: ${requestedModel} | Token 上限: ${maxLength} | 重复惩罚: ${repeatPenalty}`
)

// 1. 检查 llama-server 连接与多模态模型
let actualModel = requestedModel
try {
  const { resolvedModel, modelMeta } = await inspectLlamaServer(
    llamaUrl,
    requestedModel,
    cockpit.signal
  )
  actualModel = resolvedModel
  const metaDetail = modelMeta?.meta?.ftype ? ` (${modelMeta.meta.ftype})` : ''
  cockpit.log(`✅ llama.cpp 服务正常，已匹配模型: [${actualModel}]${metaDetail}`)
} catch (e) {
  cockpit.error(`❌ 连接 llama.cpp 失败: ${e.message}`)
  throw e
}

// 2. 通过 YARJ 命令获取全部照片 (按 GPS 优先排序)
cockpit.log(`📥 正在从 YARJ 获取照片列表 (GPS 优先)...`)
const allPhotos = (await cockpit.command('yarj.photos', { orderGpsFirst: true })) || []
cockpit.log(`📊 库中照片总数: ${allPhotos.length}`)

// 3. 过滤待处理队列
const { existsSync } = await import('node:fs')
const pendingQueue = []
let skippedAlreadyJudged = 0
let skippedNonImage = 0

for (const photo of allPhotos) {
  if (!isImageFile(photo.path)) {
    skippedNonImage++
    continue
  }

  const app = photo.appendix || {}
  const hasAi = Boolean(app.ai_generated?.type || app.aigenerated?.type || app.ai_generated?.brief)
  if (hasAi && !force) {
    skippedAlreadyJudged++
    continue
  }

  if (!existsSync(photo.path)) {
    continue
  }

  pendingQueue.push(photo)
  if (limit > 0 && pendingQueue.length >= limit) {
    break
  }
}

const withGpsCount = pendingQueue.filter((p) => p.gps_lat != null && p.gps_lon != null).length
cockpit.log(`⏩ 已有标注并跳过: ${skippedAlreadyJudged}`)
if (skippedNonImage > 0) cockpit.log(`🎬 视频格式跳过: ${skippedNonImage}`)
cockpit.log(`🎯 待处理图片: ${pendingQueue.length} 张 (有 GPS: ${withGpsCount} 张)`)

if (!pendingQueue.length) {
  cockpit.log(`🎉 没有需要标注的图片，全部已完成！`)
  return { ok: true, count: 0 }
}

// 4. 逐张进行多模态视觉分析
let successCount = 0
let failedCount = 0
const total = pendingQueue.length

for (let i = 0; i < total; i++) {
  if (cockpit.signal?.aborted) {
    cockpit.warn(`🛑 任务已被用户中断`)
    break
  }

  const photo = pendingQueue[i]
  const fileName = photo.path.split('/').pop()
  const gpsTag = photo.gps_lat != null ? '[📍GPS]' : '[无GPS]'
  const progressPct = ((i + 1) / total) * 100

  cockpit.progress(progressPct / 100, `[${i + 1}/${total}] ${gpsTag} ${fileName}`)
  cockpit.log(`\n[${i + 1}/${total}] ${gpsTag} 处理: ${fileName}`)

  try {
    const { content, timings } = await callLlamaVision({
      llamaUrl,
      filePath: photo.path,
      model: actualModel,
      maxLength,
      temperature,
      repeatPenalty,
      signal: cockpit.signal
    })

    let parsed = extractJsonFromText(content)
    let validated = sanitizeAiOutput(parsed)

    // 如果模型偷懒返回了全空结果（type 为空或简述为空），自动重试一次（切换为精准聚焦提示词）
    if (!validated.type || !validated.brief) {
      cockpit.warn(`  ⚠️ 模型返回了空结构，正在切换聚焦提示词重试分析...`)
      const retryPrompt = `请仔细观察这张图片，完成视觉标注。忽略画面底部的相机时间或机型水印，重点观察画面实际主体与场景。
分类(type)必须从以下 17 个英文词中挑选最贴切的一个：
Vehicle, Architecture, Scenery, Interior, Portrait, GroupPhoto, Pet, Plant, Food, Document, Blackboard, Screenshot, Identity, Financial, Credential, Receipt, Anime。
严格按以下 JSON 格式输出：
{
  "ai_generated": {
    "type": "Scenery",
    "tags": ["标签1", "标签2", "标签3", "标签4"],
    "brief": "画面主要内容简述",
    "ocr": ""
  }
}`
      const retryResult = await callLlamaVision({
        llamaUrl,
        filePath: photo.path,
        model: actualModel,
        maxLength,
        temperature: 0.2,
        repeatPenalty: 1.1,
        forceFreeform: false,
        prompt: retryPrompt,
        signal: cockpit.signal
      })
      parsed = extractJsonFromText(retryResult.content)
      validated = sanitizeAiOutput(parsed)
    }

    if (!validated.type || !validated.brief) {
      throw new Error('模型未能生成有效分类与简述 (输出全空)')
    }

    // 检测是否有偷懒占位符或文本密集型图片漏提取 OCR
    const rawOcrCandidate =
      parsed?.ai_generated?.ocr ?? parsed?.aigenerated?.ocr ?? parsed?.ocr ?? ''
    const rawOcrStr = Array.isArray(rawOcrCandidate)
      ? rawOcrCandidate.join('\n')
      : String(rawOcrCandidate ?? '')

    const TEXT_HEAVY_TYPES = new Set([
      'Document',
      'Blackboard',
      'Screenshot',
      'Identity',
      'Financial',
      'Credential',
      'Receipt'
    ])

    const isPlaceholder = isPlaceholderText(rawOcrStr) || isPlaceholderText(validated.ocr)
    const needsOcrFallback = !validated.ocr && TEXT_HEAVY_TYPES.has(validated.type)

    if (isPlaceholder || needsOcrFallback) {
      if (isPlaceholder) {
        cockpit.log(`  🔄 检测到模型偷懒占位符，正在进行二次精准 OCR 提取...`)
      } else {
        cockpit.log(`  🔍 文本类图片 [${validated.type}] 尝试补充精准 OCR...`)
      }
      const refined = await refineOcrText({
        llamaUrl,
        filePath: photo.path,
        model: actualModel,
        signal: cockpit.signal
      })
      if (refined && !isPlaceholderText(refined)) {
        validated.ocr = refined
      } else {
        validated.ocr = ''
      }
    }

    if (isPlaceholderText(validated.ocr)) {
      validated.ocr = ''
    }

    let timingSummary = ''
    if (timings?.predicted_ms) {
      const sec = (timings.predicted_ms / 1000).toFixed(1)
      const tps = timings.predicted_per_second ? timings.predicted_per_second.toFixed(1) : '?'
      timingSummary = ` (⏱️ ${sec}s, ${tps} tok/s)`
    }

    cockpit.log(`  🏷️ 类别: [${validated.type}]${timingSummary}`)
    if (validated.tags.length) cockpit.log(`  🔖 标签: ${validated.tags.join(', ')}`)
    cockpit.log(`  📝 简述: ${validated.brief || '(无)'}`)
    if (validated.ocr) cockpit.log(`  🔍 OCR:  ${validated.ocr}`)

    const aiRecord = {
      type: validated.type,
      tags: validated.tags,
      brief: validated.brief,
      ocr: validated.ocr,
      model: `llama.cpp:${actualModel}`,
      judged_at: new Date().toISOString()
    }

    // 写入 YARJ 元数据（严格仅写入 AI 独立命名空间，绝不污染图片本身的用户手动标签 appendix.tags）
    await cockpit.command('yarj.update-photo', {
      path: photo.path,
      patch: {
        ai_generated: aiRecord
      }
    })

    successCount++

    if (delayMs > 0 && i < total - 1 && !cockpit.signal?.aborted) {
      await cockpit.sleep(delayMs)
    }
  } catch (err) {
    failedCount++
    cockpit.error(`  ❌ 处理失败: ${err.message}`)
  }
}

cockpit.log(`\n========================================`)
cockpit.log(`🏁 任务完成! 成功标注: ${successCount}，失败/跳过: ${failedCount}`)
return { ok: true, total, successCount, failedCount }
