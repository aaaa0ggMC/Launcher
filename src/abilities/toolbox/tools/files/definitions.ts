/**
 * `files` tool group — local document & media conversion.
 *
 * Pure data only: no node/service imports (the renderer imports this file to
 * render forms and search). Execution lives in ./service.ts, defaults there.
 */
import type { ToolDefinition } from '../../types'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const OFFICE_ZIP_ACCEPT =
  '.docx,.odt,.xlsx,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation'
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,image/png,image/jpeg'

export const definitions: ToolDefinition[] = [
  {
    id: 'word-to-text',
    title: 'Word 转文本',
    titleEn: 'Word to Text',
    description: '提取 DOCX 中的纯文本（本地解析，不上传文件）',
    descriptionEn: 'Extract plain text from a local DOCX file',
    category: 'files',
    icon: 'default/9-media/document/padding',
    keywords: ['word', 'docx', '文本', '提取', 'text', 'extract'],
    fields: [
      {
        key: 'file',
        label: 'Word 文档',
        labelEn: 'Word document',
        type: 'file',
        required: true,
        accept: '.docx,' + DOCX_MIME,
        hint: '仅支持 .docx（旧版 .doc 请先用「文档格式转换」转为 .docx）'
      }
    ]
  },
  {
    id: 'word-to-html',
    title: 'Word 转 HTML',
    titleEn: 'Word to HTML',
    description: '把 DOCX 转成带基础结构的 HTML（段落/表格/列表）',
    descriptionEn: 'Convert DOCX to structured HTML',
    category: 'files',
    icon: 'default/9-media/code/padding',
    keywords: ['word', 'docx', 'html', '转换', 'convert'],
    fields: [
      {
        key: 'file',
        label: 'Word 文档',
        labelEn: 'Word document',
        type: 'file',
        required: true,
        accept: '.docx,' + DOCX_MIME,
        hint: '仅支持 .docx'
      }
    ]
  },
  {
    id: 'text-to-word',
    title: '文本转 Word',
    titleEn: 'Text to Word',
    description: '把多行文本（UTF-8）生成 .docx，每行一个段落',
    descriptionEn: 'Build a UTF-8 .docx from multi-line text',
    category: 'files',
    icon: 'default/10-editing/text/padding',
    keywords: ['word', 'docx', '文本', '生成', 'text', 'document'],
    fields: [
      {
        key: 'text',
        label: '文本内容',
        labelEn: 'Text content',
        type: 'textarea',
        required: true,
        placeholder: '每行转换为一个段落…',
        hint: '保留换行；UTF-8 中文可直接使用'
      }
    ]
  },
  {
    id: 'word-to-markdown',
    title: 'Word 转 Markdown',
    titleEn: 'Word to Markdown',
    description: '把 DOCX 转成 Markdown（标题/列表/表格/强调）',
    descriptionEn: 'Convert DOCX to Markdown',
    category: 'files',
    icon: 'default/10-editing/pencil/padding',
    keywords: ['word', 'docx', 'markdown', 'md', '转换'],
    fields: [
      {
        key: 'file',
        label: 'Word 文档',
        labelEn: 'Word document',
        type: 'file',
        required: true,
        accept: '.docx,' + DOCX_MIME,
        hint: '仅支持 .docx；样式/水印/页码等版式信息不会保留'
      }
    ]
  },
  {
    id: 'html-to-word',
    title: 'HTML 转 Word',
    titleEn: 'HTML to Word',
    description: '提取 HTML 的文本与基本结构生成 .docx',
    descriptionEn: 'Extract text/basic structure from HTML into .docx',
    category: 'files',
    icon: 'default/9-media/paper/padding',
    keywords: ['html', 'word', 'docx', '转换', 'convert'],
    fields: [
      {
        key: 'html',
        label: 'HTML 内容',
        labelEn: 'HTML content',
        type: 'textarea',
        required: true,
        placeholder: '<h1>标题</h1><p>正文…</p>',
        hint: '保留标题/段落/列表/表格/引用结构；CSS、脚本、iframe 会被忽略'
      }
    ]
  },
  {
    id: 'swagger-to-word',
    title: 'Swagger 转 Word',
    titleEn: 'Swagger to Word',
    description: '读取 OpenAPI JSON/YAML，本地生成接口清单 DOCX（不联网）',
    descriptionEn: 'Generate an API list DOCX from a local OpenAPI spec',
    category: 'files',
    icon: 'default/9-media/connection/padding',
    keywords: ['swagger', 'openapi', 'api', '接口', '文档', 'word', 'docx'],
    fields: [
      {
        key: 'file',
        label: 'OpenAPI 文件',
        labelEn: 'OpenAPI file',
        type: 'file',
        accept: '.json,.yaml,.yml,application/json',
        hint: '与下方内容二选一；优先使用文件'
      },
      {
        key: 'spec',
        label: '或粘贴 JSON / YAML',
        labelEn: '…or paste JSON / YAML',
        type: 'textarea',
        placeholder: '{ "openapi": "3.0.0", "paths": { … } }'
      },
      {
        key: 'maxEndpoints',
        label: '最多接口数',
        labelEn: 'Max endpoints',
        type: 'number',
        default: 100,
        min: 1,
        max: 500,
        hint: '超出部分会被忽略，避免生成超大文档'
      }
    ]
  },
  {
    id: 'sheet-convert',
    title: '表格格式转换',
    titleEn: 'Spreadsheet Convert',
    description: 'XLSX/CSV 互转，可导出 CSV/XLSX/HTML/Markdown/JSON',
    descriptionEn: 'Convert XLSX/CSV to CSV/XLSX/HTML/Markdown/JSON',
    category: 'files',
    icon: 'default/8-ui/change/padding',
    keywords: ['excel', 'csv', 'xlsx', '表格', '转换', 'json', 'markdown', 'html'],
    fields: [
      {
        key: 'file',
        label: '表格文件',
        labelEn: 'Spreadsheet file',
        type: 'file',
        required: true,
        accept: '.xlsx,.xls,.csv,' + XLSX_MIME,
        hint: '支持 .xlsx / .xls / .csv'
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Output format',
        type: 'select',
        default: 'csv',
        options: [
          { title: 'CSV', value: 'csv' },
          { title: 'XLSX', value: 'xlsx' },
          { title: 'HTML', value: 'html' },
          { title: 'Markdown', value: 'md' },
          { title: 'JSON', value: 'json' }
        ]
      },
      {
        key: 'delimiter',
        label: 'CSV 分隔符',
        labelEn: 'CSV delimiter',
        type: 'select',
        default: 'comma',
        options: [
          { title: '逗号 ,', value: 'comma' },
          { title: '分号 ;', value: 'semicolon' },
          { title: '制表符 Tab', value: 'tab' }
        ],
        hint: '仅输出 CSV 时生效'
      },
      {
        key: 'maxRows',
        label: '每表最多行数',
        labelEn: 'Max rows per sheet',
        type: 'number',
        default: 20000,
        min: 1,
        max: 200000,
        hint: '公式单元格输出为计算后的静态值'
      }
    ]
  },
  {
    id: 'sheet-merge',
    title: '多表合并',
    titleEn: 'Merge Spreadsheets',
    description: '把多个 XLSX/CSV 合并为一张 CSV 或 XLSX',
    descriptionEn: 'Merge multiple XLSX/CSV files into one output',
    category: 'files',
    icon: 'default/9-media/branch/padding',
    keywords: ['excel', 'csv', 'xlsx', '合并', 'merge', '表格'],
    fields: [
      {
        key: 'files',
        label: '表格文件（多个）',
        labelEn: 'Spreadsheet files',
        type: 'files',
        required: true,
        accept: '.xlsx,.xls,.csv',
        hint: '按上传顺序纵向拼接，列名取第一个文件并补齐'
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Output format',
        type: 'select',
        default: 'csv',
        options: [
          { title: 'CSV', value: 'csv' },
          { title: 'XLSX', value: 'xlsx' }
        ]
      },
      {
        key: 'delimiter',
        label: 'CSV 分隔符',
        labelEn: 'CSV delimiter',
        type: 'select',
        default: 'comma',
        options: [
          { title: '逗号 ,', value: 'comma' },
          { title: '分号 ;', value: 'semicolon' },
          { title: '制表符 Tab', value: 'tab' }
        ]
      },
      {
        key: 'maxRows',
        label: '最多总行数',
        labelEn: 'Max total rows',
        type: 'number',
        default: 50000,
        min: 1,
        max: 500000
      }
    ]
  },
  {
    id: 'images-to-pdf',
    title: '图片转 PDF',
    titleEn: 'Images to PDF',
    description: '把 PNG/JPEG 合成一个 PDF（本地 pdf-lib，无压缩）',
    descriptionEn: 'Combine PNG/JPEG into a PDF locally',
    category: 'files',
    icon: 'default/9-media/image/padding',
    keywords: ['pdf', '图片', 'png', 'jpg', '合并', 'image'],
    fields: [
      {
        key: 'files',
        label: '图片（多个）',
        labelEn: 'Images',
        type: 'files',
        required: true,
        accept: IMAGE_ACCEPT,
        hint: '每张图一页，保持原始像素尺寸'
      },
      {
        key: 'fit',
        label: '缩放到 A4',
        labelEn: 'Fit to A4',
        type: 'boolean',
        default: false,
        hint: '关闭时按图片原尺寸放页'
      }
    ]
  },
  {
    id: 'pdf-merge',
    title: 'PDF 合并',
    titleEn: 'Merge PDF',
    description: '把多个 PDF 按顺序合并为一个文件',
    descriptionEn: 'Merge multiple PDFs into one',
    category: 'files',
    icon: 'default/9-media/branch/padding',
    keywords: ['pdf', '合并', 'merge', '文档'],
    fields: [
      {
        key: 'files',
        label: 'PDF 文件（多个）',
        labelEn: 'PDF files',
        type: 'files',
        required: true,
        accept: '.pdf,application/pdf',
        hint: '按上传顺序合并；加密 PDF 需先「PDF 解密」'
      }
    ]
  },
  {
    id: 'pdf-split',
    title: 'PDF 拆分',
    titleEn: 'Split PDF',
    description: '按页码范围拆分 PDF，或导出每一页',
    descriptionEn: 'Split a PDF by page ranges or per page',
    category: 'files',
    icon: 'default/10-editing/split/padding',
    keywords: ['pdf', '拆分', 'split', '页面', '提取'],
    fields: [
      {
        key: 'file',
        label: 'PDF 文件',
        labelEn: 'PDF file',
        type: 'file',
        required: true,
        accept: '.pdf,application/pdf'
      },
      {
        key: 'mode',
        label: '拆分方式',
        labelEn: 'Split mode',
        type: 'select',
        default: 'range',
        options: [
          { title: '指定页码范围（单文件）', value: 'range' },
          { title: '每页一个文件', value: 'each' }
        ]
      },
      {
        key: 'range',
        label: '页码范围',
        labelEn: 'Page ranges',
        type: 'text',
        default: '1-3',
        placeholder: '如 1-3,5,8-',
        hint: '留空表示全部；mode=range 时生效'
      },
      {
        key: 'maxPages',
        label: '每页模式最多页数',
        labelEn: 'Max pages (each mode)',
        type: 'number',
        default: 30,
        min: 1,
        max: 30,
        hint: 'mode=each 时导出前 N 页，避免附件过多'
      }
    ]
  },
  {
    id: 'pdf-encrypt',
    title: 'PDF 加密',
    titleEn: 'Encrypt PDF',
    description: '用 qpdf 为 PDF 添加打开密码（256 位 AES）',
    descriptionEn: 'Password-protect a PDF with qpdf (AES-256)',
    category: 'files',
    icon: 'default/8-ui/lock/padding',
    keywords: ['pdf', '加密', '密码', 'encrypt', 'password'],
    dependency: 'qpdf',
    agentDenied: true,
    fields: [
      {
        key: 'file',
        label: 'PDF 文件',
        labelEn: 'PDF file',
        type: 'file',
        required: true,
        accept: '.pdf,application/pdf'
      },
      {
        key: 'password',
        label: '打开密码',
        labelEn: 'User password',
        type: 'password',
        required: true,
        hint: '密码仅在本地通过 stdin 传给 qpdf，不进入命令行参数，也不写入日志'
      },
      {
        key: 'ownerPassword',
        label: '权限密码（可选）',
        labelEn: 'Owner password (optional)',
        type: 'password',
        hint: '留空则与打开密码相同'
      }
    ]
  },
  {
    id: 'pdf-decrypt',
    title: 'PDF 解密',
    titleEn: 'Decrypt PDF',
    description: '用 qpdf 移除 PDF 的打开密码（需原密码）',
    descriptionEn: 'Remove a PDF password with qpdf',
    category: 'files',
    icon: 'default/8-ui/unlock/padding',
    keywords: ['pdf', '解密', '密码', 'decrypt', 'password'],
    dependency: 'qpdf',
    agentDenied: true,
    fields: [
      {
        key: 'file',
        label: 'PDF 文件',
        labelEn: 'PDF file',
        type: 'file',
        required: true,
        accept: '.pdf,application/pdf'
      },
      {
        key: 'password',
        label: '原打开密码',
        labelEn: 'Current password',
        type: 'password',
        required: true,
        hint: '通过临时 stdin 通道传给 qpdf，不经过命令行参数或日志'
      }
    ]
  },
  {
    id: 'pdf-to-text',
    title: 'PDF 转文本',
    titleEn: 'PDF to Text',
    description: '调用 pdftotext 提取文本（保持版面）',
    descriptionEn: 'Extract PDF text with pdftotext',
    category: 'files',
    icon: 'default/9-media/scan/padding',
    keywords: ['pdf', '文本', 'txt', '提取', 'text', 'extract'],
    dependency: 'poppler-utils (pdftotext)',
    fields: [
      {
        key: 'file',
        label: 'PDF 文件',
        labelEn: 'PDF file',
        type: 'file',
        required: true,
        accept: '.pdf,application/pdf'
      }
    ]
  },
  {
    id: 'pdf-to-images',
    title: 'PDF 转图片',
    titleEn: 'PDF to Images',
    description: '调用 pdftoppm 把 PDF 页面渲染为 PNG',
    descriptionEn: 'Render PDF pages to PNG with pdftoppm',
    category: 'files',
    icon: 'default/9-media/camera/padding',
    keywords: ['pdf', '图片', 'png', '渲染', 'image', 'render'],
    dependency: 'poppler-utils (pdftoppm)',
    fields: [
      {
        key: 'file',
        label: 'PDF 文件',
        labelEn: 'PDF file',
        type: 'file',
        required: true,
        accept: '.pdf,application/pdf'
      },
      {
        key: 'dpi',
        label: '分辨率 DPI',
        labelEn: 'DPI',
        type: 'number',
        default: 150,
        min: 72,
        max: 300,
        hint: '越大越清晰，文件也越大'
      },
      {
        key: 'maxPages',
        label: '最多页数',
        labelEn: 'Max pages',
        type: 'number',
        default: 10,
        min: 1,
        max: 30,
        hint: '默认渲染前 10 页，避免附件过大'
      }
    ]
  },
  {
    id: 'pdf-to-html',
    title: 'PDF 转 HTML',
    titleEn: 'PDF to HTML',
    description: '提取 PDF 文本并生成安全的 HTML（不还原原版式）',
    descriptionEn: 'Escape PDF text into safe HTML (not layout-accurate)',
    category: 'files',
    icon: 'default/9-media/internet/padding',
    keywords: ['pdf', 'html', '转换', 'convert'],
    dependency: 'poppler-utils (pdftotext)',
    fields: [
      {
        key: 'file',
        label: 'PDF 文件',
        labelEn: 'PDF file',
        type: 'file',
        required: true,
        accept: '.pdf,application/pdf',
        hint: '按文本块对齐生成段落，非所见即所得版式'
      }
    ]
  },
  {
    id: 'document-convert',
    title: '文档格式转换',
    titleEn: 'Document Convert',
    description: 'LibreOffice 本地转换 DOC/DOCX/ODT/XLS/XLSX/PPT/PPTX',
    descriptionEn: 'Convert office documents locally via LibreOffice',
    category: 'files',
    icon: 'default/8-ui/refresh/padding',
    keywords: [
      'pdf',
      'docx',
      'doc',
      'odt',
      'xlsx',
      'ppt',
      '转换',
      'convert',
      'libreoffice',
      'office'
    ],
    dependency: 'libreoffice (soffice)',
    fields: [
      {
        key: 'file',
        label: '文档',
        labelEn: 'Document',
        type: 'file',
        required: true,
        accept: OFFICE_ZIP_ACCEPT,
        hint: 'DOC/DOCX/ODT/XLS/XLSX/PPT/PPTX'
      },
      {
        key: 'target',
        label: '目标格式',
        labelEn: 'Target format',
        type: 'select',
        default: 'pdf',
        options: [
          { title: 'PDF', value: 'pdf' },
          { title: 'DOCX', value: 'docx' },
          { title: 'ODT', value: 'odt' },
          { title: 'HTML', value: 'html' },
          { title: 'TXT', value: 'txt' },
          { title: 'XLSX', value: 'xlsx' }
        ],
        hint: '部分源/目标组合不被 LibreOffice 支持，会在提交前提示'
      }
    ]
  },
  {
    id: 'media-convert',
    title: '音视频格式转换',
    titleEn: 'Media Convert',
    description: 'ffmpeg 本地转码音频/视频（白名单格式与编码）',
    descriptionEn: 'Transcode audio/video locally with ffmpeg',
    category: 'files',
    icon: 'default/8-ui/switch/padding',
    keywords: ['ffmpeg', '视频', '音频', '转码', 'mp4', 'mp3', 'convert', 'media'],
    dependency: 'ffmpeg',
    fields: [
      {
        key: 'file',
        label: '音视频文件',
        labelEn: 'Media file',
        type: 'file',
        required: true,
        accept:
          '.mp4,.mov,.mkv,.webm,.avi,.ts,.flv,.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus,.wma,video/*,audio/*'
      },
      {
        key: 'format',
        label: '目标格式',
        labelEn: 'Target format',
        type: 'select',
        default: 'mp4',
        options: [
          { title: 'MP4 视频 (H.264 + AAC)', value: 'mp4' },
          { title: 'WebM 视频 (VP9 + Opus)', value: 'webm' },
          { title: 'MKV 视频 (H.264 + AAC)', value: 'mkv' },
          { title: 'MP3 音频', value: 'mp3' },
          { title: 'WAV 音频 (PCM)', value: 'wav' },
          { title: 'OGG 音频 (Vorbis)', value: 'ogg' }
        ]
      },
      {
        key: 'scale',
        label: '分辨率上限',
        labelEn: 'Resolution cap',
        type: 'select',
        default: 'source',
        options: [
          { title: '保持原始', value: 'source' },
          { title: '1080p', value: '1080' },
          { title: '720p', value: '720' },
          { title: '480p', value: '480' }
        ],
        hint: '仅视频输出生效'
      }
    ]
  },
  {
    id: 'video-to-gif',
    title: '视频转 GIF',
    titleEn: 'Video to GIF',
    description: 'ffmpeg 调色板转换，保留动画与颜色',
    descriptionEn: 'Convert video to animated GIF with a palette',
    category: 'files',
    icon: 'default/9-media/film/padding',
    keywords: ['gif', '动图', '视频', '转换', 'ffmpeg'],
    dependency: 'ffmpeg',
    fields: [
      {
        key: 'file',
        label: '视频文件',
        labelEn: 'Video file',
        type: 'file',
        required: true,
        accept: 'video/*,.mp4,.mov,.mkv,.webm,.avi,.ts,.flv,.gif'
      },
      {
        key: 'fps',
        label: '帧率 FPS',
        labelEn: 'FPS',
        type: 'number',
        default: 12,
        min: 1,
        max: 30
      },
      {
        key: 'width',
        label: '宽度（像素）',
        labelEn: 'Width (px)',
        type: 'number',
        default: 480,
        min: 80,
        max: 1280,
        hint: '高度按比例缩放'
      },
      {
        key: 'start',
        label: '起始秒',
        labelEn: 'Start (s)',
        type: 'number',
        default: 0,
        min: 0,
        max: 3600
      },
      {
        key: 'duration',
        label: '时长秒（0=到结尾）',
        labelEn: 'Duration (s, 0 = to end)',
        type: 'number',
        default: 0,
        min: 0,
        max: 300
      }
    ]
  },
  {
    id: 'gif-frames',
    title: 'GIF 抽帧',
    titleEn: 'GIF Frames',
    description: '把 GIF 每一帧导出为 PNG',
    descriptionEn: 'Export every GIF frame as PNG',
    category: 'files',
    icon: 'default/9-media/previous-frame/padding',
    keywords: ['gif', '帧', 'png', '提取', 'frames', 'extract'],
    dependency: 'ffmpeg',
    fields: [
      {
        key: 'file',
        label: 'GIF 文件',
        labelEn: 'GIF file',
        type: 'file',
        required: true,
        accept: '.gif,image/gif'
      },
      {
        key: 'maxFrames',
        label: '最多帧数',
        labelEn: 'Max frames',
        type: 'number',
        default: 20,
        min: 1,
        max: 120
      }
    ]
  },
  {
    id: 'gif-compress',
    title: 'GIF 压缩',
    titleEn: 'Compress GIF',
    description: '重新调色板编码压缩 GIF，保留动画',
    descriptionEn: 'Re-encode a GIF with a palette to shrink it',
    category: 'files',
    icon: 'default/2-items/funnel/padding',
    keywords: ['gif', '压缩', 'compress', '体积'],
    dependency: 'ffmpeg',
    fields: [
      {
        key: 'file',
        label: 'GIF 文件',
        labelEn: 'GIF file',
        type: 'file',
        required: true,
        accept: '.gif,image/gif'
      },
      {
        key: 'width',
        label: '宽度（像素）',
        labelEn: 'Width (px)',
        type: 'number',
        default: 480,
        min: 80,
        max: 1280
      },
      {
        key: 'fps',
        label: '帧率 FPS',
        labelEn: 'FPS',
        type: 'number',
        default: 12,
        min: 1,
        max: 30
      },
      {
        key: 'colors',
        label: '颜色数',
        labelEn: 'Colors',
        type: 'number',
        default: 128,
        min: 8,
        max: 256,
        hint: '颜色越少体积越小'
      }
    ]
  },
  {
    id: 'media-info',
    title: '媒体信息',
    titleEn: 'Media Info',
    description: 'ffprobe 读取容器/流信息（JSON）',
    descriptionEn: 'Read container/stream info with ffprobe',
    category: 'files',
    icon: 'default/8-ui/info/padding',
    keywords: ['ffprobe', '视频', '音频', '信息', 'info', 'metadata'],
    dependency: 'ffmpeg (ffprobe)',
    fields: [
      {
        key: 'file',
        label: '音视频文件',
        labelEn: 'Media file',
        type: 'file',
        required: true,
        accept:
          'video/*,audio/*,.mp4,.mov,.mkv,.webm,.avi,.ts,.flv,.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus'
      }
    ]
  },
  {
    id: 'video-remove-watermark',
    title: '视频去水印',
    titleEn: 'Remove Video Watermark',
    description: 'ffmpeg delogo 区域填补（小范围修补，非 AI 修复）',
    descriptionEn: 'Cover a small watermark region with ffmpeg delogo',
    category: 'files',
    icon: 'default/10-editing/eraser/padding',
    keywords: ['水印', '去水印', 'delogo', 'ffmpeg', 'watermark', 'remove'],
    dependency: 'ffmpeg',
    fields: [
      {
        key: 'file',
        label: '视频文件',
        labelEn: 'Video file',
        type: 'file',
        required: true,
        accept: 'video/*,.mp4,.mov,.mkv,.webm,.avi,.ts,.flv,.gif'
      },
      {
        key: 'x',
        label: '水印左上角 X',
        labelEn: 'Watermark X',
        type: 'number',
        default: 10,
        min: 0,
        required: true
      },
      {
        key: 'y',
        label: '水印左上角 Y',
        labelEn: 'Watermark Y',
        type: 'number',
        default: 10,
        min: 0,
        required: true
      },
      {
        key: 'w',
        label: '宽度',
        labelEn: 'Width',
        type: 'number',
        default: 120,
        min: 1,
        required: true
      },
      {
        key: 'h',
        label: '高度',
        labelEn: 'Height',
        type: 'number',
        default: 40,
        min: 1,
        required: true
      }
    ]
  },
  {
    id: 'ocr',
    title: '图片文字识别',
    titleEn: 'Image OCR',
    description: '本机 tesseract 识别图片中的文字',
    descriptionEn: 'Recognize text in an image with local tesseract',
    category: 'files',
    icon: 'default/9-media/scan/padding',
    keywords: ['ocr', '文字识别', 'tesseract', '识别', 'text', 'recognition'],
    dependency: 'tesseract',
    fields: [
      {
        key: 'file',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        required: true,
        accept: IMAGE_ACCEPT
      },
      {
        key: 'lang',
        label: '语言',
        labelEn: 'Language',
        type: 'select',
        default: 'eng',
        options: [
          { title: '英文 eng', value: 'eng' },
          { title: '简体中文 chi_sim', value: 'chi_sim' },
          { title: '繁体中文 chi_tra', value: 'chi_tra' },
          { title: '英文 + 简体中文', value: 'eng+chi_sim' },
          { title: '日文 jpn', value: 'jpn' }
        ],
        hint: '需系统已安装对应 tesseract 语言包'
      }
    ]
  }
]

export const FILE_TOOL_IDS = definitions.map((d) => d.id)
