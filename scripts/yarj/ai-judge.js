/**
 * YARJ ComfyUI 图像视觉分析与元数据标注脚本 (Cockpit Script)
 *
 * 适用于 Linux Cockpit 脚本中心直接执行：
 * - 自动通过 YARJ 通用插槽获取全部图片 (按有 GPS 优先排序)
 * - 严格 1 并发调用本地 ComfyUI API
 * - 校验 12 类枚举白名单与清洗
 * - 通过 yarj.update-photo 写入元数据
 * - 具备图形化参数配置、断点续写、进度回报与安全中断
 */

/* global cockpit */
/* eslint-disable @typescript-eslint/explicit-function-return-type */

export const config = {
  comfyUrl: {
    type: 'string',
    label: 'ComfyUI 接口地址',
    default: 'http://127.0.0.1:8188',
    description: '本地 ComfyUI 服务地址'
  },
  modelChoice: {
    type: 'select',
    label: '选择视觉模型',
    default: '7b',
    options: [
      { label: 'Qwen2.5-VL-7B-AWQ (默认推荐)', value: '7b' },
      { label: 'Qwen2.5-VL-3B-AWQ (显存较紧时选用)', value: '3b' }
    ]
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
  maxLength: {
    type: 'number',
    label: '最大生成长度 (token)',
    default: 2048,
    description: '单张图片输出 token 上限，长文本/试卷/公式建议 2048'
  },
  delayMs: {
    type: 'number',
    label: '每张冷却间隔 (毫秒)',
    default: 300,
    description: '处理完一张后的缓冲时间，降低 GPU 压力'
  }
}

// 允许的类型白名单
const ALLOWED_TYPES = [
  'Document',
  'Blackboard',
  'Screenshot',
  'Portrait',
  'GroupPhoto',
  'Scenery',
  'Architecture',
  'Food',
  'Pet',
  'Object',
  'Interior',
  'Activity'
]

const TYPE_LOOKUP = new Map()
for (const t of ALLOWED_TYPES) {
  TYPE_LOOKUP.set(t.toLowerCase(), t)
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

function isImageFile(filePath) {
  if (!filePath) return false
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(filePath.slice(dot).toLowerCase())
}

function validateAndNormalizeType(rawType) {
  if (!rawType || typeof rawType !== 'string') return 'Object'
  const clean = rawType.trim()
  if (TYPE_LOOKUP.has(clean.toLowerCase())) {
    return TYPE_LOOKUP.get(clean.toLowerCase())
  }
  for (const t of ALLOWED_TYPES) {
    const regex = new RegExp(`\\b${t}\\b`, 'i')
    if (regex.test(clean)) return t
  }
  return 'Object'
}

function sanitizeAiOutput(rawJson) {
  let data = rawJson
  if (data && typeof data === 'object' && data.ai_generated) {
    data = data.ai_generated
  } else if (data && typeof data === 'object' && data.aigenerated) {
    data = data.aigenerated
  }

  if (!data || typeof data !== 'object') {
    throw new Error('AI 输出不是有效的对象结构')
  }

  const normalizedType = validateAndNormalizeType(data.type)
  const brief = typeof data.brief === 'string' ? data.brief.trim() : String(data.brief || '').trim()
  const ocr = typeof data.ocr === 'string' ? data.ocr.trim() : String(data.ocr || '').trim()

  return { type: normalizedType, brief, ocr }
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

  // 尝试拯救被截断的 JSON (例如达到 token 上限末尾缺失闭合引号与花括号)
  if (start !== -1) {
    let candidate = trimmed.slice(start)
    // 移除尾部未闭合的代码块标记
    candidate = candidate.replace(/```[a-z]*$/i, '').trim()

    // 1. 如果有奇数个未转义双引号，先补齐引号
    const unescapedQuotes = candidate.match(/(?<!\\)"/g)
    if (unescapedQuotes && unescapedQuotes.length % 2 !== 0) {
      candidate += '"'
    }

    // 2. 统计并补齐缺失的闭花括号
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

    // 3. 正则直接提取核心字段兜底 (即使 JSON 结构损坏严重也能抢救)
    const typeMatch = trimmed.match(/"type"\s*:\s*"([^"]+)"/i)
    const briefMatch = trimmed.match(/"brief"\s*:\s*"([^"]+)"/i)
    if (typeMatch) {
      const ocrMatch = trimmed.match(/"ocr"\s*:\s*"([\s\S]*?)(?:"\s*}|$)/i)
      return {
        ai_generated: {
          type: typeMatch[1],
          brief: briefMatch ? briefMatch[1] : '',
          ocr: ocrMatch ? ocrMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : ''
        }
      }
    }
  }

  throw new Error(`返回文本中未找到 JSON 结构: ${text}`)
}

function buildComfyPrompt({ imageName, modelChoice, maxLength = 2048 }) {
  const modelNodeId = modelChoice === '3b' ? '11' : '9'
  return {
    1: {
      inputs: { image: imageName },
      class_type: 'LoadImage',
      _meta: { title: '加载图像' }
    },
    2: {
      inputs: { source: ['3', 0] },
      class_type: 'PreviewAny',
      _meta: { title: '预览任意' }
    },
    3: {
      inputs: {
        system_prompt:
          '请识别这张图片，从以下类型中挑选最符合的一项：[Document, Blackboard, Screenshot, Portrait, GroupPhoto, Scenery, Architecture, Food, Pet, Object, Interior, Activity]\n\n严格按以下 JSON 格式输出：\n{\n  "ai_generated": {\n    "type": "<类型名称>",\n    "brief": "<内容介绍>",\n    "ocr" : "<文本识别内容>"\n  }\n}',
        user_prompt: '',
        model_type: 'VLM(qwen-vl)',
        temperature: 0.7,
        max_length: maxLength,
        is_memory: 'disable',
        is_locked: 'disable',
        main_brain: 'enable',
        conversation_rounds: 100,
        historical_record: '',
        is_enable: true,
        is_enable_system_role: 'enable',
        model: [modelNodeId, 0],
        tokenizer: [modelNodeId, 1],
        image: ['1', 0]
      },
      class_type: 'LLM_local',
      _meta: { title: '🖥️本地LLM通用链路' }
    },
    9: {
      inputs: {
        model_name_or_path: '/home/aaaa0ggmc/Apps/ComfyUI/models/LLM/Qwen2.5-VL-7B-Instruct-AWQ',
        device: 'auto',
        dtype: 'auto',
        is_locked: true,
        type: 'qwen-vl'
      },
      class_type: 'vlmLoader',
      _meta: { title: '🖥️VLM local Loader (7B)' }
    },
    11: {
      inputs: {
        model_name_or_path: '/home/aaaa0ggmc/Apps/ComfyUI/models/LLM/Qwen2.5-VL-3B-Instruct-AWQ/',
        device: 'auto',
        dtype: 'auto',
        is_locked: true,
        type: 'qwen-vl'
      },
      class_type: 'vlmLoader',
      _meta: { title: '🖥️VLM local Loader (3B)' }
    }
  }
}

async function uploadImageToComfy(comfyUrl, filePath, targetName) {
  const { readFileSync } = await import('node:fs')
  const fileBytes = readFileSync(filePath)
  const blob = new Blob([fileBytes])
  const formData = new FormData()
  formData.append('image', blob, targetName)
  formData.append('overwrite', 'true')

  const res = await fetch(`${comfyUrl}/upload/image`, {
    method: 'POST',
    body: formData
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`上传图片失败 HTTP ${res.status}: ${errText}`)
  }

  const json = await res.json()
  return json.name
}

async function executePrompt(comfyUrl, workflow, signal, timeoutSec = 180) {
  const promptRes = await fetch(`${comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal
  })

  if (!promptRes.ok) {
    const errText = await promptRes.text()
    throw new Error(`提交 Prompt 失败 HTTP ${promptRes.status}: ${errText}`)
  }

  const promptData = await promptRes.json()
  const promptId = promptData.prompt_id
  if (!promptId) throw new Error('未返回 prompt_id')

  const startTime = Date.now()
  const maxWaitMs = timeoutSec * 1000

  while (Date.now() - startTime < maxWaitMs) {
    if (signal?.aborted) throw new Error('操作已取消')
    await new Promise((r) => setTimeout(r, 1000))

    const historyRes = await fetch(`${comfyUrl}/history/${promptId}`, { signal })
    if (!historyRes.ok) continue

    const historyData = await historyRes.json()
    const entry = historyData[promptId]
    if (entry) {
      if (entry.status?.status_str === 'error') {
        throw new Error(`ComfyUI 报错: ${JSON.stringify(entry.status.messages || [])}`)
      }

      const node2 = entry.outputs?.['2']
      if (node2?.text?.length) return node2.text[0]
      if (node2?.string?.length) return node2.string[0]

      const node3 = entry.outputs?.['3']
      if (node3?.assistant_response) {
        return Array.isArray(node3.assistant_response)
          ? node3.assistant_response[0]
          : node3.assistant_response
      }

      throw new Error('未找到输出文本')
    }
  }

  throw new Error(`推理超时 (超过 ${timeoutSec} 秒)`)
}

// ---------------------------------------------------------------------------
// 脚本执行入口 (接受 cockpit 上下文)
// ---------------------------------------------------------------------------

const comfyUrl = String(cockpit.config?.comfyUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const modelChoice = String(cockpit.config?.modelChoice || '7b').toLowerCase() === '3b' ? '3b' : '7b'
const limit = Number(cockpit.config?.limit) || 0
const force = Boolean(cockpit.config?.force)
const maxLength = Number(cockpit.config?.maxLength) || 2048
const delayMs = Number(cockpit.config?.delayMs) || 300

cockpit.log(`🚀 开始 YARJ 图像视觉标注任务`)
cockpit.log(
  `🌐 ComfyUI: ${comfyUrl} | 模型: Qwen2.5-VL-${modelChoice.toUpperCase()} | Token上限: ${maxLength}`
)

// 1. 测试 ComfyUI 连接
try {
  const ping = await fetch(`${comfyUrl}/system_stats`, { signal: cockpit.signal })
  if (!ping.ok) throw new Error(`HTTP ${ping.status}`)
  const stats = await ping.json()
  const device = stats.devices?.[0]?.name || 'Auto'
  cockpit.log(`✅ ComfyUI 连接正常 (设备: ${device})`)
} catch (e) {
  cockpit.error(`❌ 无法连接到 ComfyUI: ${e.message}`)
  throw e
}

// 2. 通过 YARJ 命令获取全部照片 (已按有 GPS 优先排序)
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
cockpit.log(`🎯 待处理图片: ${pendingQueue.length} 张 (有GPS: ${withGpsCount} 张)`)

if (!pendingQueue.length) {
  cockpit.log(`🎉 没有需要标注的图片，全部已完成！`)
  return { ok: true, count: 0 }
}

// 4. 逐张处理
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
    const uploadName = `yarj_${photo.id}_${fileName}`
    const serverImageName = await uploadImageToComfy(comfyUrl, photo.path, uploadName)

    const workflow = buildComfyPrompt({
      imageName: serverImageName,
      modelChoice,
      maxLength
    })
    const rawOutput = await executePrompt(comfyUrl, workflow, cockpit.signal)

    const parsed = extractJsonFromText(rawOutput)
    const validated = sanitizeAiOutput(parsed)

    cockpit.log(`  🏷️ 类别: [${validated.type}]`)
    cockpit.log(`  📝 简述: ${validated.brief || '(无)'}`)
    if (validated.ocr) cockpit.log(`  🔍 OCR:  ${validated.ocr}`)

    const aiRecord = {
      type: validated.type,
      brief: validated.brief,
      ocr: validated.ocr,
      model: `Qwen2.5-VL-${modelChoice.toUpperCase()}-Instruct-AWQ`,
      judged_at: new Date().toISOString()
    }

    // 写入 YARJ 元数据
    await cockpit.command('yarj.update-photo', {
      path: photo.path,
      patch: {
        ai_generated: aiRecord,
        aigenerated: aiRecord
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
