import type { ToolDefinition } from '../../types'

/**
 * 图片分组：纯数据声明，供共享界面渲染表单。
 * 实际计算全部在 service.ts；本文件不得 import node / service。
 */
export const definitions: ToolDefinition[] = [
  {
    id: 'image-compress',
    title: '图片压缩',
    titleEn: 'Image Compress',
    description:
      '等比缩小尺寸并重新编码，支持 JPEG 质量与 PNG 透明保留，输出压缩后的文件与前后体积对比。',
    descriptionEn:
      'Downscale proportionally and re-encode with JPEG quality or PNG transparency kept; reports before/after size.',
    category: 'image',
    icon: 'default/funnel',
    keywords: ['压缩', '图片', '体积', '瘦身', '缩放', 'compress', 'resize', 'image', 'quality'],
    fields: [
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        required: true,
        hint: '支持 PNG / JPEG / GIF（首帧）/ BMP'
      },
      {
        key: 'maxWidth',
        label: '最大宽度',
        labelEn: 'Max width',
        type: 'number',
        default: 1920,
        min: 16,
        max: 8192,
        hint: '超过才缩小，不会放大'
      },
      {
        key: 'maxHeight',
        label: '最大高度',
        labelEn: 'Max height',
        type: 'number',
        default: 1920,
        min: 16,
        max: 8192,
        hint: '超过才缩小，不会放大'
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Format',
        type: 'select',
        default: 'auto',
        options: [
          { title: '保持原格式', value: 'auto' },
          { title: 'PNG（保留透明）', value: 'png' },
          { title: 'JPEG（体积更小）', value: 'jpeg' }
        ]
      },
      {
        key: 'quality',
        label: 'JPEG 质量',
        labelEn: 'JPEG quality',
        type: 'number',
        default: 80,
        min: 10,
        max: 100,
        hint: '仅在输出 JPEG 时生效'
      },
      {
        key: 'flatten',
        label: '透明填充色',
        labelEn: 'Flatten color',
        type: 'color',
        default: '#ffffff',
        hint: '输出 JPEG 时透明区域的填充颜色'
      }
    ]
  },
  {
    id: 'image-crop',
    title: '图片裁剪',
    titleEn: 'Image Crop',
    description: '按左上角坐标与宽高裁剪图片，可选择旋转 90/180/270 度。',
    descriptionEn: 'Crop by origin and size, optionally rotate by 90/180/270 degrees.',
    category: 'image',
    icon: 'default/scissors',
    keywords: ['裁剪', '截图', '旋转', '尺寸', 'crop', 'trim', 'rotate', 'image'],
    fields: [
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      { key: 'x', label: '起点 X', labelEn: 'X', type: 'number', default: 0, min: 0, max: 8191 },
      { key: 'y', label: '起点 Y', labelEn: 'Y', type: 'number', default: 0, min: 0, max: 8191 },
      {
        key: 'w',
        label: '宽度',
        labelEn: 'Width',
        type: 'number',
        default: 100,
        min: 1,
        max: 8192
      },
      {
        key: 'h',
        label: '高度',
        labelEn: 'Height',
        type: 'number',
        default: 100,
        min: 1,
        max: 8192
      },
      {
        key: 'rotate',
        label: '旋转',
        labelEn: 'Rotate',
        type: 'select',
        default: 0,
        options: [
          { title: '不旋转', value: 0 },
          { title: '顺时针 90°', value: 90 },
          { title: '180°', value: 180 },
          { title: '顺时针 270°', value: 270 }
        ]
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Format',
        type: 'select',
        default: 'auto',
        options: [
          { title: '保持原格式', value: 'auto' },
          { title: 'PNG', value: 'png' },
          { title: 'JPEG', value: 'jpeg' }
        ]
      },
      {
        key: 'quality',
        label: 'JPEG 质量',
        labelEn: 'JPEG quality',
        type: 'number',
        default: 90,
        min: 10,
        max: 100
      }
    ]
  },
  {
    id: 'image-filter',
    title: '图片滤镜',
    titleEn: 'Image Filters',
    description:
      '本地滤镜：灰度、反色、亮度、对比度、像素化与漫画风（色阶+对比度+饱和度增强）。全部为确定性像素运算，非 AI 生成。',
    descriptionEn:
      'Local deterministic filters: greyscale, invert, brightness, contrast, pixelate and a comic look. No AI involved.',
    category: 'image',
    icon: 'default/adjustment',
    keywords: [
      '滤镜',
      '灰度',
      '反色',
      '亮度',
      '对比度',
      '像素化',
      '漫画',
      'filter',
      'greyscale',
      'brightness'
    ],
    fields: [
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      {
        key: 'filter',
        label: '滤镜',
        labelEn: 'Filter',
        type: 'select',
        default: 'greyscale',
        options: [
          { title: '灰度', value: 'greyscale' },
          { title: '反色', value: 'invert' },
          { title: '亮度', value: 'brightness' },
          { title: '对比度', value: 'contrast' },
          { title: '像素化', value: 'pixelate' },
          { title: '漫画风（非 AI）', value: 'comic' }
        ]
      },
      {
        key: 'strength',
        label: '强度',
        labelEn: 'Strength',
        type: 'number',
        default: 20,
        min: -100,
        max: 100,
        hint: '亮度 / 对比度使用，范围 -100 ~ 100'
      },
      {
        key: 'blockSize',
        label: '像素块大小',
        labelEn: 'Block size',
        type: 'number',
        default: 8,
        min: 2,
        max: 48,
        hint: '仅像素化使用，单位像素'
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Format',
        type: 'select',
        default: 'auto',
        options: [
          { title: '保持原格式', value: 'auto' },
          { title: 'PNG', value: 'png' },
          { title: 'JPEG', value: 'jpeg' }
        ]
      },
      {
        key: 'quality',
        label: 'JPEG 质量',
        labelEn: 'JPEG quality',
        type: 'number',
        default: 90,
        min: 10,
        max: 100
      }
    ]
  },
  {
    id: 'image-background',
    title: '纯色去底',
    titleEn: 'Solid Background Remove',
    description:
      '对接近纯色的背景按颜色容差做连通去底或替换底色。只适用于背景色均匀的图片，不做人像抠图、发丝边缘或半透明混合。',
    descriptionEn:
      'Flood-fill remove or recolor a near-solid background by tolerance. Not a portrait matting / AI cutout tool.',
    category: 'image',
    icon: 'default/fill',
    keywords: [
      '去底',
      '抠图',
      '背景',
      '透明',
      '替换底色',
      'background',
      'remove',
      'transparent',
      'flood'
    ],
    fields: [
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      {
        key: 'mode',
        label: '模式',
        labelEn: 'Mode',
        type: 'select',
        default: 'transparent',
        options: [
          { title: '去底为透明', value: 'transparent' },
          { title: '替换底色', value: 'replace' }
        ]
      },
      {
        key: 'bgColor',
        label: '背景色',
        labelEn: 'Background color',
        type: 'color',
        default: '#ffffff',
        hint: '留空则自动取图片边缘的主色'
      },
      {
        key: 'newColor',
        label: '替换后的颜色',
        labelEn: 'New color',
        type: 'color',
        default: '#ff0000',
        hint: '仅「替换底色」模式使用'
      },
      {
        key: 'tolerance',
        label: '颜色容差',
        labelEn: 'Tolerance',
        type: 'number',
        default: 12,
        min: 0,
        max: 100,
        hint: '容差越大，被去除的颜色范围越广'
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Format',
        type: 'select',
        default: 'auto',
        options: [
          { title: '自动（去底为 PNG）', value: 'auto' },
          { title: 'PNG', value: 'png' },
          { title: 'JPEG', value: 'jpeg' }
        ]
      }
    ]
  },
  {
    id: 'image-base64',
    title: 'Base64 转换',
    titleEn: 'Base64 Converter',
    description:
      '图片转 dataURL（data:mime;base64,…），或把 dataURL 解码还原为图片附件，解码时校验格式与可解码性。',
    descriptionEn:
      'Encode an image to a data URL, or decode a data URL back into an image attachment with format validation.',
    category: 'image',
    icon: 'default/code',
    keywords: ['base64', 'dataurl', '编码', '解码', '图片', 'encode', 'decode', 'image'],
    fields: [
      {
        key: 'mode',
        label: '方向',
        labelEn: 'Direction',
        type: 'select',
        default: 'encode',
        options: [
          { title: '图片 → dataURL', value: 'encode' },
          { title: 'dataURL → 图片附件', value: 'decode' }
        ]
      },
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        hint: '「图片 → dataURL」时使用'
      },
      {
        key: 'dataUrl',
        label: 'dataURL',
        labelEn: 'data URL',
        type: 'textarea',
        placeholder: 'data:image/png;base64,iVBORw0KGgo…',
        hint: '「dataURL → 图片附件」时使用'
      },
      {
        key: 'format',
        label: '编码输出格式',
        labelEn: 'Output format',
        type: 'select',
        default: 'auto',
        options: [
          { title: '保持原格式', value: 'auto' },
          { title: 'PNG', value: 'png' },
          { title: 'JPEG', value: 'jpeg' }
        ]
      },
      {
        key: 'quality',
        label: 'JPEG 质量',
        labelEn: 'JPEG quality',
        type: 'number',
        default: 90,
        min: 10,
        max: 100
      }
    ]
  },
  {
    id: 'image-ico',
    title: 'ICO 图标',
    titleEn: 'ICO Icon Builder',
    description:
      '生成标准 ICO 文件：目录 + 多个内嵌 PNG 条目，支持 16–256 像素多尺寸，IE6 以后的 Windows 与现代浏览器均可识别。',
    descriptionEn:
      'Build a standards-compliant ICO file with a directory and embedded PNG entries at multiple sizes (16–256 px).',
    category: 'image',
    icon: 'default/frame',
    keywords: ['ico', '图标', 'icon', 'favicon', 'windows', '尺寸', '多尺寸'],
    fields: [
      {
        key: 'image',
        label: '源图片',
        labelEn: 'Source image',
        type: 'file',
        accept: 'image/*',
        required: true,
        hint: '建议提供方形图，非方形会自动居中裁切'
      },
      {
        key: 'sizes',
        label: '尺寸列表',
        labelEn: 'Sizes',
        type: 'text',
        default: '16,32,48',
        placeholder: '16,32,48',
        hint: '可用 16/24/32/48/64/128/256，逗号分隔，最多 6 个'
      }
    ]
  },
  {
    id: 'image-grid',
    title: '图片切图',
    titleEn: 'Image Splitter',
    description: '按 2×2、3×3、2×3、3×2 网格把图片切成多个小图，分别作为附件输出。',
    descriptionEn:
      'Split an image into tiles on a 2x2 / 3x3 / 2x3 / 3x2 grid; each tile becomes an attachment.',
    category: 'image',
    icon: 'default/grid',
    keywords: ['切图', '九宫格', '分割', '网格', 'split', 'grid', 'tiles', 'image'],
    fields: [
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      {
        key: 'grid',
        label: '网格',
        labelEn: 'Grid',
        type: 'select',
        default: '3x3',
        options: [
          { title: '2 × 2', value: '2x2' },
          { title: '3 × 3（九宫格）', value: '3x3' },
          { title: '2 列 × 3 行', value: '2x3' },
          { title: '3 列 × 2 行', value: '3x2' }
        ]
      },
      {
        key: 'format',
        label: '输出格式',
        labelEn: 'Format',
        type: 'select',
        default: 'png',
        options: [
          { title: 'PNG', value: 'png' },
          { title: 'JPEG', value: 'jpeg' }
        ]
      },
      {
        key: 'quality',
        label: 'JPEG 质量',
        labelEn: 'JPEG quality',
        type: 'number',
        default: 90,
        min: 10,
        max: 100
      }
    ]
  },
  {
    id: 'image-ascii',
    title: '字符画',
    titleEn: 'ASCII Art',
    description: '对图片采样亮度，用字符密度表现明暗，输出等宽字符画文本。',
    descriptionEn: 'Sample image luminance and render it as monospaced ASCII art.',
    category: 'image',
    icon: 'default/text',
    keywords: ['字符画', 'ascii', '文本', '亮度', '艺术字', 'art', 'text'],
    fields: [
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      {
        key: 'columns',
        label: '字符列数',
        labelEn: 'Columns',
        type: 'number',
        default: 80,
        min: 8,
        max: 240,
        hint: '行数按图片比例与字符宽高比自动计算'
      },
      {
        key: 'charset',
        label: '字符集',
        labelEn: 'Charset',
        type: 'select',
        default: 'standard',
        options: [
          { title: '标准（. : = + * # % @）', value: 'standard' },
          { title: '方块（░ ▒ ▓ █）', value: 'blocks' },
          { title: '简洁（. o O @）', value: 'simple' }
        ]
      },
      {
        key: 'invert',
        label: '明暗反转',
        labelEn: 'Invert',
        type: 'boolean',
        default: false,
        hint: '暗背景图片可开启'
      }
    ]
  },
  {
    id: 'image-watermark',
    title: '文字水印',
    titleEn: 'Text Watermark',
    description:
      '在图片上叠加文字水印，输出 SVG（内嵌原图、文字已转义，可调位置、大小、颜色、透明度与旋转）。中文依赖查看环境的字体。',
    descriptionEn:
      'Add a text watermark and export an SVG that embeds the image, with escaped text, position, opacity and rotation. CJK needs a local font in the viewer.',
    category: 'image',
    icon: 'default/paintbrush',
    keywords: ['水印', '文字', '叠加', '版权', 'watermark', 'text', 'overlay', 'svg'],
    fields: [
      {
        key: 'image',
        label: '图片',
        labelEn: 'Image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      {
        key: 'text',
        label: '水印文字',
        labelEn: 'Watermark text',
        type: 'textarea',
        default: 'Cockpit',
        placeholder: '输入水印文字（可含 & < > " 等字符）',
        required: true
      },
      {
        key: 'fontSize',
        label: '字号',
        labelEn: 'Font size',
        type: 'number',
        default: 32,
        min: 8,
        max: 200
      },
      {
        key: 'fontFamily',
        label: '字体',
        labelEn: 'Font family',
        type: 'text',
        default: 'sans-serif',
        hint: '使用查看环境本地字体，不加载外部字体文件'
      },
      { key: 'color', label: '颜色', labelEn: 'Color', type: 'color', default: '#ffffff' },
      {
        key: 'opacity',
        label: '不透明度',
        labelEn: 'Opacity',
        type: 'number',
        default: 45,
        min: 0,
        max: 100
      },
      {
        key: 'position',
        label: '位置',
        labelEn: 'Position',
        type: 'select',
        default: 'br',
        options: [
          { title: '左上', value: 'tl' },
          { title: '顶部居中', value: 'tc' },
          { title: '右上', value: 'tr' },
          { title: '左侧居中', value: 'ml' },
          { title: '正中间', value: 'mc' },
          { title: '右侧居中', value: 'mr' },
          { title: '左下', value: 'bl' },
          { title: '底部居中', value: 'bc' },
          { title: '右下', value: 'br' },
          { title: '平铺', value: 'tile' }
        ]
      },
      {
        key: 'margin',
        label: '边距',
        labelEn: 'Margin',
        type: 'number',
        default: 16,
        min: 0,
        max: 400
      },
      {
        key: 'rotation',
        label: '旋转角度',
        labelEn: 'Rotation',
        type: 'number',
        default: 0,
        min: -45,
        max: 45,
        hint: '度，围绕各自位置旋转'
      }
    ]
  },
  {
    id: 'word-cloud',
    title: '词云图',
    titleEn: 'Word Cloud',
    description:
      '统计文本词频（中文按单字、英文按单词，未做分词），按确定性螺旋排布生成词云 SVG，尽量避免重叠，放不下的词会跳过。',
    descriptionEn:
      'Count word frequency (CJK per character, Latin per word — no segmentation) and lay out a deterministic spiral word-cloud SVG.',
    category: 'image',
    icon: 'default/cloud',
    keywords: ['词云', '词频', '统计', '文本', 'svg', 'word cloud', 'frequency', 'intl'],
    fields: [
      {
        key: 'text',
        label: '文本',
        labelEn: 'Text',
        type: 'textarea',
        placeholder: '粘贴需要统计的文本',
        required: true
      },
      {
        key: 'maxWords',
        label: '最多词数',
        labelEn: 'Max words',
        type: 'number',
        default: 80,
        min: 10,
        max: 300
      },
      {
        key: 'fontSizeMin',
        label: '最小字号',
        labelEn: 'Min font size',
        type: 'number',
        default: 12,
        min: 8,
        max: 32
      },
      {
        key: 'fontSizeMax',
        label: '最大字号',
        labelEn: 'Max font size',
        type: 'number',
        default: 56,
        min: 28,
        max: 120
      },
      {
        key: 'colorMode',
        label: '配色',
        labelEn: 'Palette',
        type: 'select',
        default: 'mono',
        options: [
          { title: '单色', value: 'mono' },
          { title: '按频次上色', value: 'colorful' }
        ]
      },
      {
        key: 'inkColor',
        label: '文字颜色',
        labelEn: 'Ink color',
        type: 'color',
        default: '#334155'
      }
    ]
  },
  {
    id: 'image-montage',
    title: '图片叠加',
    titleEn: 'Image Montage',
    description:
      '把两张图按 alpha 通道简单叠合：定点叠加、整幅混合或按比例做角标。仅做透明度混合，不做 AI 人脸合成。',
    descriptionEn:
      'Alpha-blend two images: positioned overlay, full blend or scaled corner badge. No AI face compositing.',
    category: 'image',
    icon: 'default/paste',
    keywords: ['叠加', '合成', '混合', '角标', 'montage', 'blend', 'overlay', 'composite'],
    fields: [
      {
        key: 'base',
        label: '底图',
        labelEn: 'Base image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      {
        key: 'overlay',
        label: '叠加图',
        labelEn: 'Overlay image',
        type: 'file',
        accept: 'image/*',
        required: true
      },
      {
        key: 'mode',
        label: '模式',
        labelEn: 'Mode',
        type: 'select',
        default: 'overlay',
        options: [
          { title: '定点叠加', value: 'overlay' },
          { title: '整幅混合', value: 'blend' },
          { title: '角标（缩放后贴角）', value: 'badge' }
        ]
      },
      {
        key: 'x',
        label: '叠加位置 X',
        labelEn: 'X',
        type: 'number',
        default: 0,
        min: -8192,
        max: 8192
      },
      {
        key: 'y',
        label: '叠加位置 Y',
        labelEn: 'Y',
        type: 'number',
        default: 0,
        min: -8192,
        max: 8192
      },
      {
        key: 'opacity',
        label: '叠加图不透明度',
        labelEn: 'Overlay opacity',
        type: 'number',
        default: 100,
        min: 0,
        max: 100
      },
      {
        key: 'scale',
        label: '角标宽度比例',
        labelEn: 'Badge width %',
        type: 'number',
        default: 25,
        min: 1,
        max: 100,
        hint: '仅角标模式使用，占底图宽度百分比'
      },
      {
        key: 'corner',
        label: '角标位置',
        labelEn: 'Badge corner',
        type: 'select',
        default: 'br',
        options: [
          { title: '左上', value: 'tl' },
          { title: '右上', value: 'tr' },
          { title: '左下', value: 'bl' },
          { title: '右下', value: 'br' }
        ]
      }
    ]
  }
]
