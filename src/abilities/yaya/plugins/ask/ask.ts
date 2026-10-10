/**
 * ask 插件的纯逻辑：问题规范化、回答校验、给模型的回答文本，以及挂起中的提问表。
 *
 * 一次 `ask_user` 调用 = 1~4 个问题；每个问题可带 2~6 个选项（单选 / 多选），
 * 用户总能写一句「其他」补充，也可以跳过某个问题或整组不答。
 * 工具在主进程里挂起等待，用户在卡片上提交后经 `yaya.ask-answer` 命令放行。
 */

export const MAX_QUESTIONS = 4
export const MAX_OPTIONS = 6
const MAX_TEXT = 500
const MAX_NOTE = 2000

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  /** 很短的标签（如「方案」「语言」），卡片上显示成小标题 */
  header?: string
  options: AskOption[]
  multiSelect: boolean
}

export interface AskAnswer {
  /** 选中的选项 label（按选项顺序） */
  selected: string[]
  /** 用户自己写的补充 / 其他答案 */
  note?: string
  /** 用户跳过了这一题 */
  skipped?: boolean
}

/** 卡片提交的内容；dismissed = 整组不答 */
export interface AskResponse {
  answers: AskAnswer[]
  dismissed?: boolean
}

/** 工具结果里给界面的部分（toolCall.result） */
export interface AskDisplay {
  questions: AskQuestion[]
  answers: AskAnswer[]
  dismissed?: boolean
}

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 模型给的参数 → 规范化的问题表；不合法抛错（错误会交给模型，让它改参数重试） */
export function normalizeQuestions(args: Record<string, unknown>): AskQuestion[] {
  let raw = args.questions
  // 兼容只问一题时直接把 question / options 写在顶层
  if (raw === undefined && typeof args.question === 'string') raw = [args]
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      /* 下面统一报错 */
    }
  }
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error('questions must be a non-empty array')
  if (raw.length > MAX_QUESTIONS)
    throw new Error(`ask at most ${MAX_QUESTIONS} questions at a time`)
  return raw.map((q, i) => {
    const item = (q && typeof q === 'object' ? q : { question: q }) as Record<string, unknown>
    const question = text(item.question)
    if (!question) throw new Error(`questions[${i}].question is empty`)
    const seen = new Set<string>()
    const options: AskOption[] = []
    const rawOptions = Array.isArray(item.options) ? item.options : []
    for (const o of rawOptions) {
      const opt = (o && typeof o === 'object' ? o : { label: o }) as Record<string, unknown>
      const label = text(opt.label, 120)
      if (!label || seen.has(label)) continue
      seen.add(label)
      const description = text(opt.description)
      options.push(description ? { label, description } : { label })
    }
    if (options.length > MAX_OPTIONS)
      throw new Error(`questions[${i}] has more than ${MAX_OPTIONS} options`)
    if (options.length === 1)
      throw new Error(`questions[${i}] needs at least 2 options (or none for a free-text answer)`)
    const header = text(item.header, 24)
    return {
      question,
      ...(header ? { header } : {}),
      options,
      multiSelect: item.multiSelect === true && options.length > 0
    }
  })
}

/** 卡片提交的回答 → 按问题校验、裁剪（未知选项丢掉，单选只留一个） */
export function normalizeResponse(questions: AskQuestion[], input: unknown): AskResponse {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (obj.dismissed === true)
    return { answers: questions.map(() => ({ selected: [], skipped: true })), dismissed: true }
  const list = Array.isArray(obj.answers) ? obj.answers : []
  const answers = questions.map((q, i): AskAnswer => {
    const a = (list[i] && typeof list[i] === 'object' ? list[i] : {}) as Record<string, unknown>
    const picked = Array.isArray(a.selected) ? a.selected.map(String) : []
    let selected = q.options.map((o) => o.label).filter((l) => picked.includes(l))
    if (!q.multiSelect) selected = selected.slice(0, 1)
    const note = text(a.note, MAX_NOTE)
    if (a.skipped === true || (!selected.length && !note)) return { selected: [], skipped: true }
    return note ? { selected, note } : { selected }
  })
  return answers.every((a) => a.skipped) ? { answers, dismissed: true } : { answers }
}

/** 交给模型的回答文本 */
export function answerText(questions: AskQuestion[], res: AskResponse): string {
  if (res.dismissed)
    return [
      'The user closed the question card without answering.',
      'Do not ask the same thing again right away: continue with your best judgement and state the assumptions you made.'
    ].join(' ')
  const lines = ['The user answered:']
  questions.forEach((q, i) => {
    const a = res.answers[i]
    lines.push(`${i + 1}. ${q.question}`)
    if (!a || a.skipped) {
      lines.push('   (skipped — decide yourself and mention the assumption)')
      return
    }
    if (a.selected.length) lines.push(`   Answer: ${a.selected.join('; ')}`)
    if (a.note) lines.push(`   ${a.selected.length ? 'Note' : 'Answer'}: ${a.note}`)
  })
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 挂起中的提问（主进程内存；应用重启后自然失效，卡片显示「已失效」）
// ---------------------------------------------------------------------------

interface Pending {
  sessionId: string
  callId: string
  questions: AskQuestion[]
  resolve: (res: AskResponse) => void
}

const pending = new Map<string, Pending>()

function key(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`
}

/** 登记一次提问，返回等待回答的 Promise；signal 中止时拒绝并清掉登记 */
export function waitForAnswer(
  sessionId: string,
  callId: string,
  questions: AskQuestion[],
  signal?: AbortSignal
): Promise<AskResponse> {
  return new Promise<AskResponse>((resolve, reject) => {
    const k = key(sessionId, callId)
    const onAbort = (): void => {
      if (pending.get(k)?.resolve === done) pending.delete(k)
      reject(signal?.reason ?? new Error('aborted'))
    }
    const done = (res: AskResponse): void => {
      signal?.removeEventListener('abort', onAbort)
      pending.delete(k)
      resolve(res)
    }
    if (signal?.aborted) return onAbort()
    pending.set(k, { sessionId, callId, questions, resolve: done })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 用户提交回答。callId 对不上时（没有调用 id 的子 Agent 等），会话里只有一个挂起提问就答它。
 * 返回 false = 没有对应的挂起提问（运行已结束 / 应用重启过）。
 */
export function submitAnswer(sessionId: string, callId: string, input: unknown): boolean {
  let p = pending.get(key(sessionId, callId))
  if (!p) {
    const mine = [...pending.values()].filter((x) => x.sessionId === sessionId)
    if (mine.length !== 1) return false
    p = mine[0]
  }
  p.resolve(normalizeResponse(p.questions, input))
  return true
}

/** 会话里正在等待回答的调用 id */
export function pendingCalls(sessionId: string): string[] {
  return [...pending.values()].filter((p) => p.sessionId === sessionId).map((p) => p.callId)
}
