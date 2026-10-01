import type { ToolDefinition } from '../../types'

/**
 * Developer tools — pure data so the renderer can import this file directly.
 * Execution lives in service.ts (main process only); never import it from here.
 */
export const definitions: ToolDefinition[] = [
  {
    id: 'json-format',
    title: 'JSON 格式化',
    titleEn: 'JSON Formatter',
    description: '格式化 / 压缩 JSON，支持按键名排序，语法错误给出具体原因。',
    descriptionEn: 'Format, minify and sort JSON with clear syntax errors.',
    category: 'developer',
    icon: 'default/text',
    keywords: ['json', '格式化', '美化', '压缩', '排序', 'format', 'beautify', 'minify', 'sort'],
    fields: [
      {
        key: 'input',
        label: 'JSON 内容',
        labelEn: 'JSON input',
        type: 'textarea',
        required: true,
        placeholder: '{"name":"Linux Cockpit"}',
        default:
          '{\n  "name": "Linux Cockpit",\n  "version": 1,\n  "tags": ["shell", "tools"],\n  "window": { "width": 1280, "height": 800 }\n}'
      },
      {
        key: 'indent',
        label: '缩进',
        labelEn: 'Indent',
        type: 'select',
        default: '2',
        options: [
          { title: '2 空格', value: '2' },
          { title: '4 空格', value: '4' },
          { title: 'Tab', value: 'tab' }
        ]
      },
      {
        key: 'compact',
        label: '压缩为一行',
        labelEn: 'Minify to one line',
        type: 'boolean',
        default: false
      },
      {
        key: 'sortKeys',
        label: '按键名排序',
        labelEn: 'Sort keys',
        type: 'boolean',
        default: false
      }
    ]
  },
  {
    id: 'json-escape',
    title: 'JSON 字符串转义',
    titleEn: 'JSON String Escape',
    description: '在普通文本与 JSON 字符串字面量之间严格互转（unescape 只接受合法 JSON 字符串）。',
    descriptionEn: 'Strict conversion between plain text and JSON string literals.',
    category: 'developer',
    icon: 'default/clipboard',
    keywords: ['json', '转义', 'escape', 'unescape', '字符串', 'string', '引号', 'quote'],
    fields: [
      {
        key: 'input',
        label: '内容',
        labelEn: 'Input',
        type: 'textarea',
        required: true,
        placeholder: '他说 "你好"\n第二行',
        default: '他说 "你好"\n第二行 <b>html</b>'
      },
      {
        key: 'mode',
        label: '方向',
        labelEn: 'Direction',
        type: 'select',
        default: 'escape',
        options: [
          { title: '转义为 JSON 字符串', value: 'escape' },
          { title: '反转义为普通文本', value: 'unescape' }
        ]
      }
    ]
  },
  {
    id: 'config-convert',
    title: '配置格式转换',
    titleEn: 'Config Converter',
    description: 'JSON / YAML / TOML / Properties 四种配置格式互转，防 __proto__ 原型污染。',
    descriptionEn: 'Convert between JSON, YAML, TOML and Properties without prototype pollution.',
    category: 'developer',
    icon: 'default/frame',
    keywords: ['json', 'yaml', 'yml', 'toml', 'properties', '配置', '转换', 'convert', 'config'],
    fields: [
      {
        key: 'input',
        label: '配置内容',
        labelEn: 'Config input',
        type: 'textarea',
        required: true,
        default:
          '{\n  "name": "linux-cockpit",\n  "port": 8080,\n  "debug": true,\n  "tags": ["shell", "tools"]\n}'
      },
      {
        key: 'from',
        label: '源格式',
        labelEn: 'From',
        type: 'select',
        default: 'json',
        options: [
          { title: 'JSON', value: 'json' },
          { title: 'YAML', value: 'yaml' },
          { title: 'TOML', value: 'toml' },
          { title: 'Properties', value: 'properties' }
        ]
      },
      {
        key: 'to',
        label: '目标格式',
        labelEn: 'To',
        type: 'select',
        default: 'yaml',
        options: [
          { title: 'JSON', value: 'json' },
          { title: 'YAML', value: 'yaml' },
          { title: 'TOML', value: 'toml' },
          { title: 'Properties', value: 'properties' }
        ]
      }
    ]
  },
  {
    id: 'code-format',
    title: '代码格式化',
    titleEn: 'Code Formatter',
    description: '用 prettier 格式化 JavaScript / TypeScript / HTML / CSS，与仓库风格一致。',
    descriptionEn: 'Format JavaScript, TypeScript, HTML and CSS with prettier.',
    category: 'developer',
    icon: 'default/code',
    keywords: ['prettier', '格式', 'format', 'javascript', 'typescript', 'html', 'css', '缩进'],
    fields: [
      {
        key: 'input',
        label: '代码',
        labelEn: 'Code',
        type: 'textarea',
        required: true,
        default: 'const a={b:1,c:[1,2,3]}\nfunction f(x){return x*2}\n'
      },
      {
        key: 'language',
        label: '语言',
        labelEn: 'Language',
        type: 'select',
        default: 'javascript',
        options: [
          { title: 'JavaScript', value: 'javascript' },
          { title: 'TypeScript', value: 'typescript' },
          { title: 'HTML', value: 'html' },
          { title: 'CSS', value: 'css' }
        ]
      }
    ]
  },
  {
    id: 'js-minify',
    title: 'JS 压缩',
    titleEn: 'JS Minify',
    description: '用 terser 压缩 JavaScript：混淆变量名、删除注释与空白，保持语义不变。',
    descriptionEn: 'Minify JavaScript with terser while keeping semantics.',
    category: 'developer',
    icon: 'default/funnel',
    keywords: ['terser', 'js', 'javascript', '压缩', 'minify', '混淆', 'uglify', '体积'],
    fields: [
      {
        key: 'input',
        label: 'JavaScript 代码',
        labelEn: 'JavaScript code',
        type: 'textarea',
        required: true,
        default:
          'function greet(name) {\n  // 拼接问候语\n  const msg = "Hello, " + name + "!";\n  return msg;\n}\nconsole.log(greet("world"));\n'
      },
      {
        key: 'mangle',
        label: '混淆局部变量名',
        labelEn: 'Mangle local names',
        type: 'boolean',
        default: true
      }
    ]
  },
  {
    id: 'css-format',
    title: 'CSS 格式化压缩',
    titleEn: 'CSS Formatter',
    description: 'CSS 美化或压缩；压缩保留字符串与 url() 内容，只去注释和冗余空白。',
    descriptionEn: 'Beautify or minify CSS without touching strings or url() contents.',
    category: 'developer',
    icon: 'default/fill',
    keywords: ['css', '样式', '格式化', '压缩', 'format', 'minify', 'stylesheet'],
    fields: [
      {
        key: 'input',
        label: 'CSS',
        labelEn: 'CSS',
        type: 'textarea',
        required: true,
        default:
          '.card{color:#333;margin:0 auto;padding:8px 12px}\n.card .title{font-weight:bold}\n'
      },
      {
        key: 'mode',
        label: '模式',
        labelEn: 'Mode',
        type: 'select',
        default: 'format',
        options: [
          { title: '格式化（美化）', value: 'format' },
          { title: '压缩', value: 'minify' }
        ]
      }
    ]
  },
  {
    id: 'html-format',
    title: 'HTML 格式化压缩',
    titleEn: 'HTML Formatter',
    description:
      'HTML 美化或保守压缩：保留全部空白与 pre / textarea / script / style、内联样式，仅移除注释。',
    descriptionEn:
      'Beautify HTML, or minify conservatively: whitespace, pre/textarea/script/style and inline styles stay untouched, only comments are dropped.',
    category: 'developer',
    icon: 'default/ui',
    keywords: ['html', '格式化', '压缩', 'format', 'minify', '网页', '标签'],
    fields: [
      {
        key: 'input',
        label: 'HTML',
        labelEn: 'HTML',
        type: 'textarea',
        required: true,
        default:
          '<div class="wrap">\n  <p>Hello <b>world</b></p>\n  <pre>  保留\n    换行</pre>\n  <script>const x = 1</script>\n</div>\n'
      },
      {
        key: 'mode',
        label: '模式',
        labelEn: 'Mode',
        type: 'select',
        default: 'format',
        options: [
          { title: '格式化（美化）', value: 'format' },
          { title: '压缩', value: 'minify' }
        ]
      }
    ]
  },
  {
    id: 'sql-format',
    title: 'SQL 格式化',
    titleEn: 'SQL Formatter',
    description:
      '按方言格式化 SQL（MySQL / PostgreSQL / SQL Server / SQLite 等），统一关键字大小写。',
    descriptionEn: 'Format SQL by dialect with consistent keyword casing.',
    category: 'developer',
    icon: 'default/document',
    keywords: [
      'sql',
      'sql-formatter',
      'mysql',
      'postgres',
      'sqlite',
      '格式化',
      'format',
      '美化',
      '数据库'
    ],
    fields: [
      {
        key: 'input',
        label: 'SQL',
        labelEn: 'SQL',
        type: 'textarea',
        required: true,
        default:
          'select id,name,age from users where age>18 and city in ("BJ","SH") order by id desc limit 10'
      },
      {
        key: 'dialect',
        label: '方言',
        labelEn: 'Dialect',
        type: 'select',
        default: 'sql',
        options: [
          { title: '标准 SQL', value: 'sql' },
          { title: 'MySQL', value: 'mysql' },
          { title: 'MariaDB', value: 'mariadb' },
          { title: 'PostgreSQL', value: 'postgresql' },
          { title: 'SQLite', value: 'sqlite' },
          { title: 'SQL Server (T-SQL)', value: 'tsql' },
          { title: 'Oracle (PL/SQL)', value: 'plsql' }
        ]
      },
      {
        key: 'keywordCase',
        label: '关键字大小写',
        labelEn: 'Keyword case',
        type: 'select',
        default: 'upper',
        options: [
          { title: '大写', value: 'upper' },
          { title: '小写', value: 'lower' },
          { title: '保持原样', value: 'preserve' }
        ]
      }
    ]
  },
  {
    id: 'regex-test',
    title: '正则测试',
    titleEn: 'Regex Tester',
    description: '在隔离开线程中执行正则并限时，防止灾难性回溯（ReDoS）卡死界面。',
    descriptionEn: 'Run regular expressions in an isolated worker with a timeout to avoid ReDoS.',
    category: 'developer',
    icon: 'default/function',
    keywords: ['regex', 'regexp', '正则', 'regular expression', '匹配', 'test', 'redos', 'regexr'],
    fields: [
      {
        key: 'pattern',
        label: '正则表达式',
        labelEn: 'Pattern',
        type: 'text',
        required: true,
        default: '(\\d{4})-(\\d{2})-(\\d{2})'
      },
      {
        key: 'flags',
        label: '修饰符',
        labelEn: 'Flags',
        type: 'text',
        default: 'g',
        placeholder: '如 g i m',
        hint: '允许 g、i、m、s、u、y、d、v'
      },
      {
        key: 'text',
        label: '测试文本',
        labelEn: 'Test text',
        type: 'textarea',
        required: true,
        default: '发布日期 2026-10-01，截止 2027-01-15，订单号 90012。'
      },
      {
        key: 'timeout',
        label: '超时（毫秒）',
        labelEn: 'Timeout (ms)',
        type: 'number',
        default: 1000,
        min: 100,
        max: 20000
      },
      {
        key: 'maxMatches',
        label: '最多显示匹配数',
        labelEn: 'Max matches',
        type: 'number',
        default: 50,
        min: 1,
        max: 500
      }
    ]
  },
  {
    id: 'uuid',
    title: 'UUID 生成',
    titleEn: 'UUID Generator',
    description: '批量生成 UUID v4（crypto.randomUUID），可选大写与去连字符。',
    descriptionEn: 'Generate UUID v4 values with crypto.randomUUID.',
    category: 'developer',
    icon: 'default/digit-0',
    keywords: ['uuid', 'guid', 'v4', 'random', '随机', '唯一标识', '生成器', 'generator'],
    fields: [
      {
        key: 'count',
        label: '数量',
        labelEn: 'Count',
        type: 'number',
        default: 1,
        min: 1,
        max: 100
      },
      { key: 'uppercase', label: '大写', labelEn: 'Uppercase', type: 'boolean', default: false },
      {
        key: 'compact',
        label: '去掉连字符',
        labelEn: 'Remove dashes',
        type: 'boolean',
        default: false
      }
    ]
  },
  {
    id: 'mock-data',
    title: 'Mock 数据生成',
    titleEn: 'Mock Data Generator',
    description: '生成本地虚构的用户 / 商品 / 订单数据，输出 JSON、CSV 或 SQL，均正确转义。',
    descriptionEn:
      'Generate fake user/product/order rows as JSON, CSV or SQL with proper escaping.',
    category: 'developer',
    icon: 'default/random-dice',
    keywords: [
      'mock',
      '假数据',
      '测试数据',
      'csv',
      'sql',
      'json',
      '生成器',
      'generator',
      'fixture'
    ],
    fields: [
      {
        key: 'type',
        label: '数据类型',
        labelEn: 'Dataset',
        type: 'select',
        default: 'user',
        options: [
          { title: '用户 user', value: 'user' },
          { title: '商品 product', value: 'product' },
          { title: '订单 order', value: 'order' },
          { title: '自定义字段 custom', value: 'custom' }
        ]
      },
      {
        key: 'count',
        label: '数量',
        labelEn: 'Count',
        type: 'number',
        default: 5,
        min: 1,
        max: 200
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Output',
        type: 'select',
        default: 'json',
        options: [
          { title: 'JSON', value: 'json' },
          { title: 'CSV', value: 'csv' },
          { title: 'SQL INSERT', value: 'sql' }
        ]
      },
      {
        key: 'fields',
        label: '自定义字段',
        labelEn: 'Custom fields',
        type: 'textarea',
        default: 'id,name,email,city',
        placeholder: '逗号或换行分隔，如 id,name,created_at',
        hint: '仅「自定义字段」类型使用；按字段名猜测生成合适的假值'
      }
    ]
  },
  {
    id: 'cron',
    title: 'Cron 表达式',
    titleEn: 'Cron Expression',
    description: '解析 5 段式 Cron 表达式，说明每段含义并推算接下来若干次执行时间（按本机时间）。',
    descriptionEn: 'Parse 5-field cron expressions, explain each field and list upcoming runs.',
    category: 'developer',
    icon: 'default/clock',
    keywords: ['cron', 'crontab', '定时任务', '计划任务', 'schedule', 'linux', '周期'],
    fields: [
      {
        key: 'preset',
        label: '常用预设',
        labelEn: 'Preset',
        type: 'select',
        default: '',
        options: [
          { title: '自定义', value: '' },
          { title: '每分钟', value: '* * * * *' },
          { title: '每 5 分钟', value: '*/5 * * * *' },
          { title: '每小时', value: '0 * * * *' },
          { title: '每天 0 点', value: '0 0 * * *' },
          { title: '每周一 0 点', value: '0 0 * * 1' },
          { title: '每月 1 号 0 点', value: '0 0 1 * *' }
        ]
      },
      {
        key: 'expression',
        label: '表达式（分 时 日 月 周）',
        labelEn: 'Expression (min hour dom month dow)',
        type: 'text',
        default: '*/30 * * * *',
        placeholder: '*/5 * * * *'
      },
      {
        key: 'nextCount',
        label: '推算次数',
        labelEn: 'Runs to preview',
        type: 'number',
        default: 5,
        min: 1,
        max: 20
      },
      {
        key: 'from',
        label: '起始时间（可选）',
        labelEn: 'Start time (optional)',
        type: 'text',
        default: '',
        placeholder: '留空为当前时间，如 2026-01-31T08:00:00'
      }
    ]
  },
  {
    id: 'markdown',
    title: 'Markdown 转 HTML',
    titleEn: 'Markdown to HTML',
    description: '用 marked 将 Markdown 转为 HTML，直接下载 .html 文件（界面不做 v-html 预览）。',
    descriptionEn: 'Convert Markdown to HTML with marked and download the .html file.',
    category: 'developer',
    icon: 'default/pencil',
    keywords: ['markdown', 'md', 'html', '转换', 'convert', 'marked', 'gfm', '文档'],
    fields: [
      {
        key: 'input',
        label: 'Markdown',
        labelEn: 'Markdown',
        type: 'textarea',
        required: true,
        default:
          '# Linux Cockpit\n\n**工具箱** 与 `代码`\n\n- 项目一\n- 项目二\n\n| 工具 | 用途 |\n| --- | --- |\n| JSON | 格式化 |\n'
      }
    ]
  },
  {
    id: 'json-tree',
    title: 'JSON 结构树',
    titleEn: 'JSON Tree',
    description: '把 JSON 渲染成缩进树，直观查看每层的类型与取值，可下载 JSON 文件。',
    descriptionEn: 'Render JSON as an indented tree of types and values.',
    category: 'developer',
    icon: 'default/branch',
    keywords: ['json', '树', 'tree', '结构', '可视化', 'visualize', '格式化'],
    fields: [
      {
        key: 'input',
        label: 'JSON',
        labelEn: 'JSON',
        type: 'textarea',
        required: true,
        default:
          '{\n  "name": "cockpit",\n  "version": 1,\n  "ok": true,\n  "nothing": null,\n  "tags": ["shell", "tools"],\n  "window": { "width": 1280, "height": 800, "list": [] }\n}'
      }
    ]
  },
  {
    id: 'base64',
    title: 'Base64 编解码',
    titleEn: 'Base64 Codec',
    description: 'UTF-8 文本与 Base64 互转，解码前严格校验字符集与长度。',
    descriptionEn: 'Strict UTF-8 text <-> Base64 conversion.',
    category: 'developer',
    icon: 'default/letter-abc-upper',
    keywords: ['base64', '编码', '解码', 'encode', 'decode', 'utf-8', '转码', 'codec'],
    fields: [
      {
        key: 'input',
        label: '内容',
        labelEn: 'Input',
        type: 'textarea',
        required: true,
        default: 'Hello, 世界 🛠'
      },
      {
        key: 'mode',
        label: '方向',
        labelEn: 'Direction',
        type: 'select',
        default: 'encode',
        options: [
          { title: '编码为 Base64', value: 'encode' },
          { title: '解码为文本', value: 'decode' }
        ]
      }
    ]
  },
  {
    id: 'url-codec',
    title: 'URL 编解码',
    titleEn: 'URL Codec',
    description: 'encodeURIComponent / encodeURI 及其反向解码，非法转义序列报错。',
    descriptionEn: 'encodeURIComponent / encodeURI and the reverse, rejecting invalid escapes.',
    category: 'developer',
    icon: 'default/link',
    keywords: ['url', 'uri', '编码', '解码', 'encode', 'decode', '百分号', 'percent', '转码'],
    fields: [
      {
        key: 'input',
        label: '内容',
        labelEn: 'Input',
        type: 'textarea',
        required: true,
        default: 'https://example.com/search?q=你好 world&tag=a b'
      },
      {
        key: 'mode',
        label: '方向',
        labelEn: 'Direction',
        type: 'select',
        default: 'encode',
        options: [
          { title: '编码', value: 'encode' },
          { title: '解码', value: 'decode' }
        ]
      },
      {
        key: 'kind',
        label: '函数',
        labelEn: 'Function',
        type: 'select',
        default: 'component',
        options: [
          { title: 'encodeURIComponent（组件）', value: 'component' },
          { title: 'encodeURI（整链接）', value: 'full' }
        ]
      }
    ]
  },
  {
    id: 'hash',
    title: '哈希摘要',
    titleEn: 'Hash / Digest',
    description: '计算文本或文件的 SHA-256 / SHA-512 / MD5 摘要；输入不会写入日志。',
    descriptionEn:
      'Compute SHA-256 / SHA-512 / MD5 digests for text or files. Inputs are never logged.',
    category: 'developer',
    icon: 'default/lock',
    agentDenied: true,
    keywords: ['hash', 'md5', 'sha256', 'sha512', '哈希', '摘要', '校验', 'checksum', 'digest'],
    fields: [
      {
        key: 'input',
        label: '文本',
        labelEn: 'Text',
        type: 'textarea',
        default: 'linux-cockpit',
        placeholder: '输入或选择文件（二选一）'
      },
      {
        key: 'file',
        label: '或选择文件',
        labelEn: 'Or pick a file',
        type: 'file',
        accept: '*/*',
        hint: '选择文件后改为计算文件内容摘要'
      },
      {
        key: 'algorithm',
        label: '算法',
        labelEn: 'Algorithm',
        type: 'select',
        default: 'sha256',
        options: [
          { title: 'SHA-256', value: 'sha256' },
          { title: 'SHA-512', value: 'sha512' },
          { title: 'MD5', value: 'md5' }
        ]
      },
      { key: 'uppercase', label: '大写输出', labelEn: 'Uppercase', type: 'boolean', default: false }
    ]
  },
  {
    id: 'radix',
    title: '进制转换',
    titleEn: 'Radix Converter',
    description: '用 BigInt 在二进制 / 八进制 / 十进制 / 十六进制间转换，支持负数与任意长度。',
    descriptionEn:
      'Convert between binary, octal, decimal and hex with BigInt (negatives allowed).',
    category: 'developer',
    icon: 'default/digits-123',
    keywords: [
      '进制',
      '转换',
      'binary',
      'octal',
      'decimal',
      'hex',
      'hexadecimal',
      'radix',
      'bigint'
    ],
    fields: [
      {
        key: 'input',
        label: '数值',
        labelEn: 'Value',
        type: 'text',
        required: true,
        default: '-255'
      },
      {
        key: 'from',
        label: '源进制',
        labelEn: 'From',
        type: 'select',
        default: '10',
        options: [
          { title: '二进制 (2)', value: '2' },
          { title: '八进制 (8)', value: '8' },
          { title: '十进制 (10)', value: '10' },
          { title: '十六进制 (16)', value: '16' }
        ]
      },
      {
        key: 'to',
        label: '目标进制',
        labelEn: 'To',
        type: 'select',
        default: '16',
        options: [
          { title: '二进制 (2)', value: '2' },
          { title: '八进制 (8)', value: '8' },
          { title: '十进制 (10)', value: '10' },
          { title: '十六进制 (16)', value: '16' }
        ]
      },
      {
        key: 'uppercase',
        label: '十六进制大写',
        labelEn: 'Uppercase hex',
        type: 'boolean',
        default: false
      }
    ]
  },
  {
    id: 'color',
    title: '颜色转换',
    titleEn: 'Color Converter',
    description: 'HEX / RGB / HSL 三种写法互相转换（含 Alpha），自动识别输入格式。',
    descriptionEn: 'Convert between HEX, RGB and HSL color notations including alpha.',
    category: 'developer',
    icon: 'default/palette',
    keywords: ['color', '颜色', 'hex', 'rgb', 'hsl', '转换', 'convert', '调色板', 'palette'],
    fields: [
      {
        key: 'input',
        label: '颜色',
        labelEn: 'Color',
        type: 'text',
        required: true,
        default: '#4A90D9',
        placeholder: '#4A90D9 / rgb(74,144,217) / hsl(210,65%,57%)'
      }
    ]
  },
  {
    id: 'linux-dictionary',
    title: 'Linux 命令词典',
    titleEn: 'Linux Command Dictionary',
    description: '离线检索常用 Linux 命令说明与示例（仅静态文本，不执行任何命令）。',
    descriptionEn: 'Search offline docs for common Linux commands. Nothing is ever executed.',
    category: 'developer',
    icon: 'default/book',
    keywords: [
      'linux',
      '命令',
      '词典',
      'dictionary',
      'cheatsheet',
      '手册',
      'man',
      'shell',
      '命令行',
      'cli'
    ],
    fields: [
      {
        key: 'query',
        label: '搜索命令',
        labelEn: 'Search',
        type: 'text',
        default: 'tar',
        placeholder: '如 tar、grep、systemctl，留空列出全部'
      }
    ]
  }
]
