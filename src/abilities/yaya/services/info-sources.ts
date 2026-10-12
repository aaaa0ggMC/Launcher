/**
 * 信息源的纯逻辑：**类型注册表**（type + URL 模板 + 抽取函数）与实例的模板渲染 / 筛选 / 结果排版。
 *
 * 与 GenericSearch 的分工：那边是「一个查询 → 网页搜索引擎」，这边是「结构化公开数据渠道」——
 * 用户按类型建**多个实例**（可各自改模板、加参数、单独停用），AI 一条 `fetch_info` 里可以点名
 * 一个或多个渠道。取舍与调研见 PLAN.md §7（全部为免 key 的公开 API）。
 *
 * **本模块必须保持无 node / electron 依赖**：主进程的取数实现在
 * `plugins/infosource/fetch.ts`，测试只测这里。
 */
export interface InfoItem {
  title: string
  text: string
  url?: string
}

export interface SourceType {
  /** 稳定 id：实例按它选类型，AI 的 `sources` 也能用它点名 */
  id: string
  label: string
  labelKey?: string
  /** 一句话说明（编辑器与 AI 目录里显示） */
  hint: string
  /** 默认 URL 模板：`{query}` 占位（会被 URL 编码） */
  template: string
  /** 追加的固定查询参数（实例参数可以覆盖同名项） */
  params?: Record<string, string>
  as: 'json' | 'text'
  /** 从响应里抽条目（越界 / 缺字段一律跳过，绝不抛） */
  extract: (data: unknown, ctx: { query: string }) => InfoItem[]
}

/** 一个信息源实例（存插件配置的 `instances` JSON 里） */
export interface InfoInstance {
  name: string
  /** 指向 `SOURCE_TYPES` 里的类型 id；未知类型 = 该实例不可用 */
  type: string
  /** 覆盖类型默认模板（留空用类型自带的）——于是任何 GET + `{query}` 的 JSON 接口都能接进来 */
  template?: string
  /** 额外查询参数，`a=1&b=2` 形式 */
  params?: string
  /** 说明（可选，目录里显示给 AI） */
  note?: string
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

function pick(o: unknown, keys: string[]): string {
  if (!o || typeof o !== 'object') return ''
  const rec = o as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (Array.isArray(v)) {
      const first = v.map(str).filter(Boolean).join('、')
      if (first) return first
    }
  }
  return ''
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取正则第一捕获组，没匹配返回空串（Atom / XML 的粗解析用） */
function field(text: string, re: RegExp): string {
  return re.exec(text)?.[1] ?? ''
}

// ---------------------------------------------------------------------------
// 类型注册表（全部为免 key 公开 API；限流见各自文档）
// ---------------------------------------------------------------------------

export const SOURCE_TYPES: SourceType[] = [
  {
    id: 'wikipedia',
    label: 'Wikipedia 概要',
    labelKey: 'yaya.info.t_wikipedia',
    hint: '条目搜索 + 开头摘要（en.wikipedia，免 key）',
    template:
      'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch={query}&gsrlimit=3&gsrnamespace=0&prop=extracts&exintro=1&explaintext=1&exsentences=3',
    as: 'json',
    extract: (data) => {
      const pages = (data as { query?: { pages?: Record<string, unknown> } })?.query?.pages
      if (!pages || typeof pages !== 'object') return []
      return Object.values(pages)
        .sort(
          (a, b) =>
            Number((a as { index?: number }).index ?? 0) -
            Number((b as { index?: number }).index ?? 0)
        )
        .slice(0, 3)
        .map((p) => {
          const rec = p as Record<string, unknown>
          const title = pick(rec, ['title'])
          if (!title) return null
          const id = str(rec.pageid)
          return {
            title,
            text: stripTags(str(rec.extract)).slice(0, 500),
            url: id
              ? `https://en.wikipedia.org/?curid=${id}`
              : `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`
          } as InfoItem
        })
        .filter((x): x is InfoItem => !!x && !!x.text)
    }
  },
  {
    id: 'wiktionary',
    label: 'Wiktionary 释义',
    labelKey: 'yaya.info.t_wiktionary',
    hint: '单词的词性与释义（en.wiktionary，免 key）',
    template: 'https://en.wiktionary.org/api/rest_v1/page/definition/{query}',
    as: 'json',
    extract: (data, ctx) => {
      if (!data || typeof data !== 'object') return []
      const out: InfoItem[] = []
      for (const [lang, defs] of Object.entries(data as Record<string, unknown>)) {
        for (const d of list(defs).slice(0, 2)) {
          const rec = d as Record<string, unknown>
          const meaning = stripTags(str(rec.definition))
          if (!meaning) continue
          out.push({
            title: `${ctx.query} · ${lang} · ${pick(rec, ['partOfSpeech']) || '释义'}`,
            text: meaning.slice(0, 300)
          })
        }
        if (out.length >= 3) break
      }
      return out
    }
  },
  {
    id: 'openalex',
    label: 'OpenAlex 学术文献',
    labelKey: 'yaya.info.t_openalex',
    hint: '2.5 亿+ 学术作品（题名 / 年份 / 被引 / DOI），免 key、10 req/s',
    template: 'https://api.openalex.org/works?search={query}&per-page=5',
    as: 'json',
    extract: (data) =>
      list((data as { results?: unknown[] })?.results)
        .slice(0, 5)
        .map((r) => {
          const rec = r as Record<string, unknown>
          const title = pick(rec, ['display_name', 'title'])
          if (!title) return null
          const bits = [str(rec.publication_year)]
          const cited = Number(rec.cited_by_count)
          if (Number.isFinite(cited)) bits.push(`被引 ${cited}`)
          const doi = str(rec.doi)
          if (doi) bits.push(doi)
          const loc = rec.primary_location as { landing_page_url?: string } | undefined
          return {
            title,
            text: bits.filter(Boolean).join(' · '),
            url: doi || loc?.landing_page_url || undefined
          } as InfoItem
        })
        .filter((x): x is InfoItem => !!x)
  },
  {
    id: 'crossref',
    label: 'Crossref DOI',
    labelKey: 'yaya.info.t_crossref',
    hint: '1.3 亿+ 学术作品的 DOI 元数据，免 key、50 req/s',
    template: 'https://api.crossref.org/works?query={query}&rows=5',
    as: 'json',
    extract: (data) => {
      const items = list((data as { message?: { items?: unknown[] } })?.message?.items)
      return items
        .slice(0, 5)
        .map((r) => {
          const rec = r as Record<string, unknown>
          const title = pick(rec, ['title'])
          if (!title) return null
          const issued = rec.issued as { 'date-parts'?: number[][] } | undefined
          const year = issued?.['date-parts']?.[0]?.[0]
          const bits = [pick(rec, ['container-title']), year ? String(year) : '', str(rec.DOI)]
          return {
            title,
            text: bits.filter(Boolean).join(' · '),
            url: str(rec.URL) || undefined
          } as InfoItem
        })
        .filter((x): x is InfoItem => !!x)
    }
  },
  {
    id: 'arxiv',
    label: 'arXiv 预印本',
    labelKey: 'yaya.info.t_arxiv',
    hint: 'arXiv 论文（Atom XML，3 req/s）',
    template:
      'http://export.arxiv.org/api/query?search_query=all:{query}&max_results=5&sortBy=relevance',
    as: 'text',
    extract: (data) => {
      const xml = typeof data === 'string' ? data : ''
      const out: InfoItem[] = []
      const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
      for (const e of entries.slice(0, 5)) {
        const title = stripTags(field(e, /<title>([\s\S]*?)<\/title>/))
        const summary = stripTags(field(e, /<summary>([\s\S]*?)<\/summary>/))
        const id = field(e, /<id>([\s\S]*?)<\/id>/).trim()
        const published = field(e, /<published>([\s\S]*?)<\/published>/)
          .trim()
          .slice(0, 10)
        if (!title) continue
        out.push({
          title,
          text: [published, summary.slice(0, 260)].filter(Boolean).join(' · '),
          url: id || undefined
        })
      }
      return out
    }
  },
  {
    id: 'hackernews',
    label: 'Hacker News',
    labelKey: 'yaya.info.t_hackernews',
    hint: 'HN 文章与讨论（Algolia，1 万次/小时）',
    template: 'https://hn.algolia.com/api/v1/search?query={query}&hitsPerPage=5',
    as: 'json',
    extract: (data) =>
      list((data as { hits?: unknown[] })?.hits)
        .slice(0, 5)
        .map((h) => {
          const rec = h as Record<string, unknown>
          const title = pick(rec, ['title', 'story_title'])
          if (!title) return null
          const bits = [`▲${pick(rec, ['points']) || 0}`, str(rec.created_at).slice(0, 10)]
          const link = str(rec.url)
          return {
            title,
            text: bits.filter(Boolean).join(' · '),
            url: link || `https://news.ycombinator.com/item?id=${str(rec.objectID)}`
          } as InfoItem
        })
        .filter((x): x is InfoItem => !!x)
  },
  {
    id: 'geocoding',
    label: '地名 / 坐标（Open-Meteo）',
    labelKey: 'yaya.info.t_geocoding',
    hint: '地名检索经纬度与人口（免 key）',
    template: 'https://geocoding-api.open-meteo.com/v1/search?name={query}&count=5&language=zh',
    as: 'json',
    extract: (data) =>
      list((data as { results?: unknown[] })?.results)
        .slice(0, 5)
        .map((r) => {
          const rec = r as Record<string, unknown>
          const name = pick(rec, ['name'])
          if (!name) return null
          const bits = [pick(rec, ['country', 'country_code']), pick(rec, ['admin1'])]
          const pop = pick(rec, ['population'])
          if (pop) bits.push(`人口 ${pop}`)
          bits.push(`${pick(rec, ['latitude'])},${pick(rec, ['longitude'])}`)
          return { title: name, text: bits.filter(Boolean).join(' · ') } as InfoItem
        })
        .filter((x): x is InfoItem => !!x)
  },
  {
    id: 'countries',
    label: '国家资料（REST Countries）',
    labelKey: 'yaya.info.t_countries',
    hint: '首都 / 地区 / 人口 / 货币 / 语言（免 key）',
    template:
      'https://restcountries.com/v3.1/name/{query}?fields=name,capital,region,subregion,population,currencies,languages',
    as: 'json',
    extract: (data) =>
      list(data)
        .slice(0, 4)
        .map((r) => {
          const rec = r as Record<string, unknown>
          const name = (rec.name as { common?: string })?.common ?? ''
          if (!name) return null
          const capital = list(rec.capital).map(str).filter(Boolean).join('、')
          const currencies = Array.isArray(rec.currencies)
            ? (rec.currencies as { name?: string }[])
            : []
          const cur = currencies
            .map((c) => str(c?.name))
            .filter(Boolean)
            .slice(0, 2)
            .join('、')
          const lang = Object.values((rec.languages as Record<string, string>) ?? {})
            .slice(0, 4)
            .join('、')
          const bits = [
            capital ? `首都 ${capital}` : '',
            [str(rec.region), str(rec.subregion)].filter(Boolean).join('/'),
            pick(rec, ['population']) ? `人口 ${pick(rec, ['population'])}` : '',
            cur ? `货币 ${cur}` : '',
            lang ? `语言 ${lang}` : ''
          ].filter(Boolean)
          return { title: name, text: bits.join(' · ') } as InfoItem
        })
        .filter((x): x is InfoItem => !!x)
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo 即时回答',
    labelKey: 'yaya.info.t_ddg',
    hint: '摘要 / 定义 / 相关主题（免 key，不是网页搜索）',
    template: 'https://api.duckduckgo.com/?q={query}&format=json&no_html=1&skip_disambig=1',
    as: 'json',
    extract: (data) => {
      const rec = (data ?? {}) as Record<string, unknown>
      const head = [str(rec.Answer), str(rec.AbstractText), str(rec.Definition)]
        .filter(Boolean)
        .join('\n')
        .slice(0, 500)
      const out: InfoItem[] = []
      const title = str(rec.Heading) || str(rec.AbstractSource)
      if (head)
        out.push({ title: title || '即时回答', text: head, url: str(rec.AbstractURL) || undefined })
      if (out.length < 3)
        for (const t of list(rec.RelatedTopics).slice(0, 3)) {
          const text = stripTags(pick(t, ['Text', 'Result']))
          if (text) out.push({ title: text.split(' - ')[0] ?? text, text: text.slice(0, 220) })
        }
      return out
    }
  },
  {
    id: 'github',
    label: 'GitHub 仓库',
    labelKey: 'yaya.info.t_github',
    hint: '按名字搜仓库（免 key，60 次/小时/IP）',
    template: 'https://api.github.com/search/repositories?q={query}&per_page=5',
    as: 'json',
    extract: (data) =>
      list((data as { items?: unknown[] })?.items)
        .slice(0, 5)
        .map((r) => {
          const rec = r as Record<string, unknown>
          const title = pick(rec, ['full_name'])
          if (!title) return null
          const bits = [`★${pick(rec, ['stargazers_count']) || 0}`, pick(rec, ['language'])]
          const desc = str(rec.description)
          if (desc) bits.push(desc.slice(0, 160))
          return {
            title,
            text: bits.filter(Boolean).join(' · '),
            url: str(rec.html_url) || undefined
          } as InfoItem
        })
        .filter((x): x is InfoItem => !!x)
  },
  {
    id: 'generic',
    label: '自定义模板（任意 GET 接口）',
    labelKey: 'yaya.info.t_generic',
    hint: '填带 {query} 的 URL 模板，按通用启发式抽字段（title / description / url …）',
    template: '',
    as: 'json',
    extract: (data) => genericExtract(data)
  }
]

/** 通用启发式抽取：数组逐条、对象当一条；挑常见字段 */
function genericExtract(data: unknown): InfoItem[] {
  const rows = Array.isArray(data) ? data.slice(0, 5) : [data]
  const out: InfoItem[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const rec = r as Record<string, unknown>
    const title = pick(rec, ['title', 'name', 'display_name', 'heading', 'label', 'id']) || ''
    const text = pick(rec, [
      'description',
      'text',
      'summary',
      'extract',
      'abstract',
      'content',
      'body',
      'answer',
      'definition'
    ])
    const url = pick(rec, ['url', 'html_url', 'link', 'homepage', 'uri'])
    if (!title && !text) continue
    out.push({
      title: title || '(无标题)',
      text: (text || JSON.stringify(rec).slice(0, 240)).slice(0, 320),
      url: url || undefined
    })
  }
  return out
}

export function sourceType(id: string): SourceType | null {
  return SOURCE_TYPES.find((t) => t.id === id) ?? null
}

// ---------------------------------------------------------------------------
// 实例 → URL / 执行计划
// ---------------------------------------------------------------------------

/** `a=1&b=2` → 记录（坏项忽略） */
export function parseParams(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof raw !== 'string') return out
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const k = pair.slice(0, eq).trim()
    const v = pair.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

/** 渲染 URL：`{query}` 编码替换 + 合并参数（类型默认 ← 实例覆盖） */
export function buildUrl(instance: InfoInstance, type: SourceType, query: string): string {
  const template = (instance.template?.trim() || type.template).replace(/\{query\}/g, () =>
    encodeURIComponent(query)
  )
  const params = { ...(type.params ?? {}), ...parseParams(instance.params) }
  const parts = Object.entries(params).map(
    ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
  )
  if (!parts.length) return template
  return `${template}${template.includes('?') ? '&' : '?'}${parts.join('&')}`
}

/**
 * 挑实例：只取启用的；给了 `sources` 就按「实例名 / 类型 id」（不区分大小写）点名，
 * 返回未命中的名字让工具提示可用渠道。
 */
export function selectInstances(
  instances: InfoInstance[],
  sources?: string[]
): { picked: InfoInstance[]; notFound: string[] } {
  const enabled = instances.filter((i) => i.enabled !== false && sourceType(i.type))
  if (!sources || !sources.length) return { picked: enabled, notFound: [] }
  const wanted = sources.map((s) => s.trim().toLowerCase()).filter(Boolean)
  const picked: InfoInstance[] = []
  const notFound: string[] = []
  for (const w of wanted) {
    const hit = enabled.filter((i) => i.name.toLowerCase() === w || i.type.toLowerCase() === w)
    if (hit.length) picked.push(...hit)
    else notFound.push(w)
  }
  return { picked: [...new Map(picked.map((p) => [p.name, p])).values()], notFound }
}

/** 结果排版给模型看：每渠道一小节，条目数 / 长度封顶 */
export function formatInfo(
  sections: { instance: InfoInstance; type: SourceType; items?: InfoItem[]; error?: string }[],
  opts: { maxItems?: number; maxChars?: number } = {}
): string {
  const maxItems = opts.maxItems ?? 5
  const maxChars = opts.maxChars ?? 12_000
  const out: string[] = []
  for (const s of sections) {
    out.push(`### ${s.instance.name}（${s.type.label}）`)
    if (s.error) {
      out.push(`- 取数失败：${s.error}`)
      continue
    }
    const items = (s.items ?? []).slice(0, maxItems)
    if (!items.length) {
      out.push('- 没有命中（换个说法或换个渠道）')
      continue
    }
    for (const it of items) {
      const text = it.text.replace(/\s+/g, ' ').slice(0, 320)
      out.push(`- **${it.title}** — ${text}${it.url ? `（${it.url}）` : ''}`)
    }
  }
  const text = out.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（超长已截断）` : text
}

/** 首次使用的种子实例（配置里还没有 `instances` 时，主进程与渲染端都回落到它） */
export const DEFAULT_INSTANCES: InfoInstance[] = [
  { name: '维基百科', type: 'wikipedia', enabled: true },
  { name: 'OpenAlex 学术', type: 'openalex', enabled: true },
  { name: 'Hacker News', type: 'hackernews', enabled: true },
  { name: '地名坐标', type: 'geocoding', enabled: true },
  { name: '国家资料', type: 'countries', enabled: false }
]

/**
 * 解析实例列表（插件配置里的 JSON 字符串）：没配 / 解析不了 → 回落种子实例；
 * 显式的 `[]` = 用户清空了，尊重它（返回空）。脏条目丢弃。
 */
export function instancesOf(raw: unknown): InfoInstance[] {
  let parsed: unknown = raw
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim()))
    return DEFAULT_INSTANCES.map((i) => ({ ...i }))
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return DEFAULT_INSTANCES.map((i) => ({ ...i }))
    }
  }
  if (!Array.isArray(parsed)) return DEFAULT_INSTANCES.map((i) => ({ ...i }))
  const out: InfoInstance[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const type = typeof r.type === 'string' ? r.type.trim() : ''
    if (!name || !type) continue
    out.push({
      name,
      type,
      template: typeof r.template === 'string' && r.template.trim() ? r.template.trim() : undefined,
      params: typeof r.params === 'string' && r.params.trim() ? r.params.trim() : undefined,
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined,
      enabled: r.enabled !== false
    })
  }
  return out
}

/** AI 目录（`fetch_info` 不带 query 时返回）：让模型知道有哪些渠道可点 */
export function formatCatalog(instances: InfoInstance[]): string {
  const rows = instances
    .filter((i) => i.enabled !== false && sourceType(i.type))
    .map((i) => {
      const t = sourceType(i.type)!
      return `- id: \`${i.name}\`（类型 \`${i.type}\`，${t.label}）${i.note ? ` — ${i.note}` : ''}`
    })
  if (!rows.length) return '（还没有配置任何信息源渠道）'
  return [
    '可用信息源渠道（fetch_info 的 sources 可点名其中任意几个；留空 = 全部启用的渠道）：',
    ...rows
  ].join('\n')
}
