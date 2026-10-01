/**
 * 文本类工具定义（纯数据，渲染端可直接导入）。
 *
 * 这里只放 metadata：执行逻辑在 ./service.ts。所有条目都是本地计算，
 * 不联网、不保存用户输入、不调用外部程序。用户可见标题/说明均为中英双语，
 * 关键词同时收录中文与英文（含拼音缩写），供搜索命中。
 */
import type { ToolDefinition, ToolField } from '../../types'

/** 通用「一段文本」输入，多个工具共用（key 固定为 text，CLI 兜底一致）。 */
const TEXT_INPUT: ToolField = {
  key: 'text',
  label: '文本',
  labelEn: 'Text',
  type: 'textarea',
  required: true,
  placeholder: '在此输入或粘贴文本'
}

function tool(
  id: string,
  title: string,
  titleEn: string,
  description: string,
  descriptionEn: string,
  icon: string,
  fields: ToolField[],
  keywords: string[],
  agentDenied = false
): ToolDefinition {
  return {
    id,
    title,
    titleEn,
    description,
    descriptionEn,
    category: 'text',
    icon,
    fields,
    keywords,
    ...(agentDenied ? { agentDenied: true } : {})
  }
}

export const definitions: ToolDefinition[] = [
  tool(
    'char-statistics',
    '字符统计',
    'Character Statistics',
    '统计文本的 Unicode 码位、汉字、英文、数字、空白、单词与行数；纯本地计算。',
    'Count code points, Han characters, Latin letters, digits, whitespace, words and lines. Runs fully offline.',
    'mdi-counter',
    [TEXT_INPUT],
    ['char', 'count', 'statistics', '字数', '统计', '字符', '汉字', '码位', '行数', '单词']
  ),
  tool(
    'text-diff',
    '文本对比',
    'Text Diff',
    '用 jsdiff 按行比较两段文本，输出逐行差异 JSON 与 +/- 文本视图。',
    'Line-by-line diff (jsdiff) of two texts with structured JSON and a unified +/- text view.',
    'mdi-file-compare',
    [
      {
        ...TEXT_INPUT,
        key: 'original',
        label: '原文',
        labelEn: 'Original',
        placeholder: '原始文本'
      },
      {
        ...TEXT_INPUT,
        key: 'modified',
        label: '改后文本',
        labelEn: 'Modified',
        placeholder: '修改后的文本'
      }
    ],
    ['diff', 'compare', '对比', '差异', '文本', 'jsdiff']
  ),
  tool(
    'text-clean',
    '文本清理',
    'Text Cleanup',
    '按行去首尾空白、删除空行、去重与排序；逐行处理，不改动其他字符。',
    'Trim each line, drop empty lines, deduplicate and sort lines. Only whitespace handling, no rewriting.',
    'mdi-broom',
    [
      TEXT_INPUT,
      {
        key: 'trimLines',
        label: '去除每行首尾空白',
        labelEn: 'Trim each line',
        type: 'boolean',
        default: true
      },
      {
        key: 'dropEmpty',
        label: '删除空行',
        labelEn: 'Drop empty lines',
        type: 'boolean',
        default: true
      },
      {
        key: 'dedupe',
        label: '去除重复行（保留首次出现）',
        labelEn: 'Remove duplicates',
        type: 'boolean',
        default: false
      },
      {
        key: 'sort',
        label: '排序',
        labelEn: 'Sort',
        type: 'select',
        default: 'none',
        options: [
          { title: '不排序 / Keep order', value: 'none' },
          { title: '升序 / A→Z', value: 'asc' },
          { title: '降序 / Z→A', value: 'desc' }
        ]
      }
    ],
    ['clean', 'dedupe', 'sort', 'trim', '清理', '去重', '排序', '去空白', '空行']
  ),
  tool(
    'chinese-pinyin',
    '汉字转拼音',
    'Chinese Pinyin',
    '基于 pinyin-pro：完整拼音、无声调、数字声调、首字母与声母，可切换大小写并标注多音字。',
    'pinyin-pro based: full/toneless/numeric pinyin, initials and shengmu, case switch and polyphonic readings.',
    'mdi-alphabetical',
    [
      TEXT_INPUT,
      {
        key: 'mode',
        label: '输出方式',
        labelEn: 'Output mode',
        type: 'select',
        default: 'full',
        options: [
          { title: '完整拼音（带声调）/ Full pinyin', value: 'full' },
          { title: '完整拼音（无声调）/ Toneless', value: 'plain' },
          { title: '数字声调 / Numeric tones', value: 'numeric' },
          { title: '首字母 / First letters', value: 'first' },
          { title: '声母 / Initials (shengmu)', value: 'initial' }
        ]
      },
      { key: 'separator', label: '分隔符', labelEn: 'Separator', type: 'text', default: ' ' },
      {
        key: 'letterCase',
        label: '大小写',
        labelEn: 'Case',
        type: 'select',
        default: 'lower',
        options: [
          { title: '小写 / lower', value: 'lower' },
          { title: '大写 / UPPER', value: 'upper' }
        ]
      },
      {
        key: 'multiple',
        label: '标注多音字全部读音',
        labelEn: 'Show all polyphonic readings',
        type: 'boolean',
        default: false
      }
    ],
    ['pinyin', '拼音', '汉字', '声调', '首字母', '声母', '多音字', 'zhuyin']
  ),
  tool(
    'chinese-segment',
    '中文分词',
    'Chinese Word Segmentation',
    '用浏览器/Node 内置的 Intl.Segmenter（ICU）切分中文：按词、字或句子输出。',
    'Split Chinese text with the built-in Intl.Segmenter (ICU) at word, grapheme or sentence granularity.',
    'mdi-call-split',
    [
      TEXT_INPUT,
      {
        key: 'granularity',
        label: '切分粒度',
        labelEn: 'Granularity',
        type: 'select',
        default: 'word',
        options: [
          { title: '按词 / Word', value: 'word' },
          { title: '按字 / Grapheme', value: 'grapheme' },
          { title: '按句 / Sentence', value: 'sentence' }
        ]
      },
      {
        key: 'keepPunct',
        label: '保留标点与空白',
        labelEn: 'Keep punctuation & spaces',
        type: 'boolean',
        default: false
      }
    ],
    ['segment', '分词', '中文', 'ICU', 'Intl', '切分', 'nlp']
  ),
  tool(
    'chinese-convert',
    '简繁体转换',
    'Simplified ⇄ Traditional Chinese',
    '基于 opencc-js：简体与台湾繁体、香港繁体互转，词汇级转换。',
    'opencc-js conversion between Simplified Chinese and Taiwan/Hong Kong Traditional variants.',
    'mdi-translate',
    [
      TEXT_INPUT,
      {
        key: 'target',
        label: '转换方向',
        labelEn: 'Direction',
        type: 'select',
        default: 's2t',
        options: [
          { title: '简体 → 繁体（台湾）/ S → TW', value: 's2t' },
          { title: '简体 → 繁体（香港）/ S → HK', value: 's2h' },
          { title: '繁体（台湾）→ 简体 / TW → S', value: 't2s' },
          { title: '繁体（香港）→ 简体 / HK → S', value: 'h2s' }
        ]
      }
    ],
    ['opencc', '简繁', '繁體', '转换', 'chinese', 'traditional', 'simplified', '台湾', '香港']
  ),
  tool(
    'ascii-art',
    'ASCII 艺术字',
    'ASCII Art (FIGlet)',
    '用 FIGlet 字体把 ASCII 文本渲染成艺术字，多种字体可选，纯本地渲染。',
    'Render ASCII text into FIGlet banner art with selectable fonts. Fully offline.',
    'mdi-drawing-box',
    [
      { ...TEXT_INPUT, label: 'ASCII 文本', labelEn: 'ASCII text', placeholder: 'Hello' },
      {
        key: 'font',
        label: '字体',
        labelEn: 'Font',
        type: 'select',
        default: 'Standard',
        options: [
          { title: 'Standard', value: 'Standard' },
          { title: 'Big', value: 'Big' },
          { title: 'Small', value: 'Small' },
          { title: 'Banner', value: 'Banner' },
          { title: 'Ghost', value: 'Ghost' },
          { title: 'Slant', value: 'Slant' },
          { title: 'Shadow', value: 'Shadow' },
          { title: 'Block', value: 'Block' },
          { title: 'Lean', value: 'Lean' },
          { title: 'Mini', value: 'Mini' },
          { title: 'Script', value: 'Script' },
          { title: 'Digital', value: 'Digital' }
        ]
      }
    ],
    ['ascii', 'art', 'figlet', '艺术字', '字符画', 'banner', 'font']
  ),
  tool(
    'rmb-uppercase',
    '人民币金额大写',
    'RMB Amount in Words',
    '把金额转换为人民币大写：字符串/BigInt 精确到分，正确处理角、分、零与负数。',
    'Convert an amount to Chinese RMB uppercase with exact string/BigInt cents, jiao/fen, zeros and negatives.',
    'mdi-currency-cny',
    [
      {
        key: 'amount',
        label: '金额',
        labelEn: 'Amount',
        type: 'text',
        default: '1234.56',
        placeholder: '¥1,234.56',
        hint: '支持 ± 号、千分位与 ¥/￥ 前缀；最多两位小数'
      }
    ],
    ['rmb', '大写', '金额', '人民币', '财务', 'money', 'uppercase', '支票']
  ),
  tool(
    'choice',
    '随机选择',
    'Random Choice',
    '从每行一个的选项里随机抽取，使用系统加密随机数，可设置抽取数量与是否去重。',
    'Draw random picks from one-per-line options using the system CSPRNG, with count and uniqueness options.',
    'mdi-dice-multiple',
    [
      {
        key: 'options',
        label: '选项（每行一个）',
        labelEn: 'Options (one per line)',
        type: 'textarea',
        required: true
      },
      {
        key: 'count',
        label: '抽取数量',
        labelEn: 'How many',
        type: 'number',
        default: 1,
        min: 1,
        max: 100
      },
      {
        key: 'unique',
        label: '不重复抽取',
        labelEn: 'Unique picks',
        type: 'boolean',
        default: true
      }
    ],
    ['random', 'choice', '随机', '抽签', '选择', '抽奖', 'dice', 'pick']
  ),
  tool(
    'qrcode',
    '二维码生成',
    'QR Code Generator',
    '本地生成二维码，输出 SVG 或 PNG 附件；可调容错级别，不联网。',
    'Generate QR codes locally as SVG or PNG attachments with selectable error correction. No network.',
    'mdi-qrcode',
    [
      {
        ...TEXT_INPUT,
        key: 'content',
        label: '二维码内容',
        labelEn: 'Content',
        placeholder: 'https://example.com'
      },
      {
        key: 'format',
        label: '格式',
        labelEn: 'Format',
        type: 'select',
        default: 'svg',
        options: [
          { title: 'SVG（矢量）', value: 'svg' },
          { title: 'PNG（位图）', value: 'png' }
        ]
      },
      {
        key: 'level',
        label: '容错级别',
        labelEn: 'Error correction',
        type: 'select',
        default: 'M',
        options: [
          { title: 'L（约 7%）', value: 'L' },
          { title: 'M（约 15%）', value: 'M' },
          { title: 'Q（约 25%）', value: 'Q' },
          { title: 'H（约 30%）', value: 'H' }
        ]
      },
      {
        key: 'size',
        label: 'PNG 像素宽',
        labelEn: 'PNG width',
        type: 'number',
        default: 320,
        min: 64,
        max: 2048
      }
    ],
    ['qrcode', '二维码', 'qr', '生成', 'svg', 'png']
  ),
  tool(
    'password-generator',
    '密码生成器',
    'Password Generator',
    '用系统加密随机数生成随机密码：可设长度、字符集与数量；不保存、不记录日志。',
    'Generate random passwords with the system CSPRNG. Nothing is saved or logged.',
    'mdi-key-variant',
    [
      {
        key: 'length',
        label: '长度',
        labelEn: 'Length',
        type: 'number',
        default: 16,
        min: 4,
        max: 128
      },
      {
        key: 'upper',
        label: '含大写字母 A-Z',
        labelEn: 'Uppercase A-Z',
        type: 'boolean',
        default: true
      },
      {
        key: 'lower',
        label: '含小写字母 a-z',
        labelEn: 'Lowercase a-z',
        type: 'boolean',
        default: true
      },
      { key: 'digits', label: '含数字 0-9', labelEn: 'Digits 0-9', type: 'boolean', default: true },
      {
        key: 'symbols',
        label: '含符号 !@#$…',
        labelEn: 'Symbols !@#$…',
        type: 'boolean',
        default: false
      },
      {
        key: 'count',
        label: '生成数量',
        labelEn: 'How many',
        type: 'number',
        default: 1,
        min: 1,
        max: 10
      },
      {
        key: 'excludeAmbiguous',
        label: '排除易混字符（l/I/O/0/1）',
        labelEn: 'Exclude ambiguous chars',
        type: 'boolean',
        default: false
      }
    ],
    ['password', '密码', '随机', '生成', 'random', 'generator', 'strong'],
    true
  ),
  tool(
    'kinship',
    '亲戚称谓计算',
    'Kinship Calculator',
    '按常见关系链（父母、子女、配偶、兄弟姐妹等）推算称呼；无法唯一确定的组合会明确报错。',
    'Resolve Chinese kin terms from common relation chains; ambiguous combinations fail with a specific reason.',
    'mdi-family-tree',
    [
      {
        key: 'chain',
        label: '关系链',
        labelEn: 'Relation chain',
        type: 'text',
        placeholder: '妈妈的哥哥',
        hint: '用「的」连接，如：爸爸的妈妈的哥哥'
      }
    ],
    ['kinship', '亲戚', '称呼', '称谓', '关系', 'family', 'relative', '辈分']
  ),
  tool(
    'signature',
    '签名生成',
    'Signature Generator',
    '把文字渲染成手写风格字体的矢量签名（SVG）；效果取决于本机安装的字体。',
    'Render text as a vector signature in handwriting-style fonts (SVG). Appearance depends on locally installed fonts.',
    'mdi-signature',
    [
      { ...TEXT_INPUT, label: '签名文字', labelEn: 'Signature text', placeholder: '张三' },
      {
        key: 'font',
        label: '字体风格',
        labelEn: 'Font style',
        type: 'select',
        default: 'kai',
        options: [
          { title: '楷体 / KaiTi', value: 'kai' },
          { title: '行楷 / Xingkai', value: 'xingkai' },
          { title: '隶书 / LiSu', value: 'lishu' },
          { title: '手写花体 / Script', value: 'script' },
          { title: '手写 Comic', value: 'comic' }
        ]
      },
      { key: 'color', label: '颜色', labelEn: 'Color', type: 'color', default: '#1a1a1a' },
      {
        key: 'size',
        label: '字号',
        labelEn: 'Font size',
        type: 'number',
        default: 72,
        min: 16,
        max: 160
      },
      { key: 'tilt', label: '轻微倾斜', labelEn: 'Slight tilt', type: 'boolean', default: true }
    ],
    ['signature', '签名', '手写', '设计', 'svg', 'handwriting']
  ),
  tool(
    'stamp-generator',
    '印章生成',
    'Stamp Generator',
    '生成圆形/椭圆/方形印章风格 SVG：弧形排字、中心文字，颜色可调。',
    'Generate circle/ellipse/square style seal SVGs with arc text and center text. For layout demos only.',
    'mdi-stamper',
    [
      {
        key: 'top',
        label: '顶部弧形文字',
        labelEn: 'Top arc text',
        type: 'text',
        placeholder: '示例科技有限公司'
      },
      {
        key: 'center',
        label: '中心文字',
        labelEn: 'Center text',
        type: 'text',
        placeholder: '发票专用章'
      },
      {
        key: 'bottom',
        label: '底部弧形文字',
        labelEn: 'Bottom arc text',
        type: 'text',
        placeholder: '12345678'
      },
      {
        key: 'shape',
        label: '形状',
        labelEn: 'Shape',
        type: 'select',
        default: 'circle',
        options: [
          { title: '圆形 / Circle', value: 'circle' },
          { title: '椭圆 / Ellipse', value: 'ellipse' },
          { title: '方形 / Square', value: 'square' }
        ]
      },
      { key: 'color', label: '印色', labelEn: 'Ink color', type: 'color', default: '#b3261e' }
    ],
    ['stamp', 'seal', '印章', '公章', 'svg', 'round']
  ),
  tool(
    'icon-generator',
    '文字图标生成',
    'Letter Icon Generator',
    '把 1-4 个文字（字母/汉字）渲染成圆角方形应用图标 SVG，颜色与尺寸可调。',
    'Render 1-4 characters into a rounded-square app-icon SVG with adjustable colors and size.',
    'mdi-shape-square-rounded-plus',
    [
      {
        key: 'text',
        label: '文字（1-4 个字符）',
        labelEn: 'Text (1-4 chars)',
        type: 'text',
        placeholder: '汉'
      },
      { key: 'bg', label: '背景色', labelEn: 'Background', type: 'color', default: '#4f46e5' },
      { key: 'fg', label: '文字色', labelEn: 'Text color', type: 'color', default: '#ffffff' },
      {
        key: 'size',
        label: '尺寸（像素）',
        labelEn: 'Size (px)',
        type: 'number',
        default: 128,
        min: 32,
        max: 512
      },
      {
        key: 'radius',
        label: '圆角（%）',
        labelEn: 'Corner radius (%)',
        type: 'number',
        default: 24,
        min: 0,
        max: 50
      }
    ],
    ['icon', '图标', '文字', '圆角', '生成', 'logo', 'letter', 'avatar']
  )
]
