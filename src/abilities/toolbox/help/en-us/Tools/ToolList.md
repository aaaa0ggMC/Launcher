# Tool List

> Last updated: 2026-10-01

The toolbox ships 80 tools, all computed locally except Currency Converter, which queries public rate APIs. This page lists them by the
six categories shown in the UI (Chinese name / English name / what it solves). To jump straight in,
search the Chinese name, English name or a keyword (epoch, JSON, QR…) in the page's search box and
press Enter to open the first match.

**Usage note**: tools marked "Requires local installation" depend on an external program (ffmpeg,
qpdf, LibreOffice, poppler, tesseract); when it is missing the tool reports a clear error — install it
and try again. Everything else works out of the box.

## Date and time (8)

| Tool               | English name          | What it does                                                                                                                 |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Epoch 时间戳转换   | Epoch Converter       | Convert seconds / ms / µs / ns to dates and back with sub-millisecond precision; a live "current UNIX time" card sits on top |
| 批量时间戳转换     | Batch Epoch Converter | One timestamp per line, reporting errors per line                                                                            |
| 日期差值           | Date Difference       | Actual elapsed time between two explicit dates                                                                               |
| 日期加减           | Date Calculator       | Add or subtract seconds / minutes / hours / 24-hour days                                                                     |
| 年／月／日时间范围 | Period Boundaries     | Day / month / year boundaries in a chosen zone, DST-aware                                                                    |
| 秒数与时长转换     | Duration Converter    | Seconds to d/h/m/s and an ISO 8601 duration                                                                                  |
| 特殊时间戳转换     | Timestamp Formats     | Windows FILETIME, .NET ticks, WebKit, Excel OADate, Discord Snowflake, hex Unix time                                         |
| 世界时钟           | World Clock           | The same instant across multiple IANA zones                                                                                  |
| 汇率换算           | Currency Converter    | Convert amounts with live public rates, several targets at once (the only online tool; rates cached 1 hour)                  |

## Developer (20)

| Tool             | English name             | What it does                                                    |
| ---------------- | ------------------------ | --------------------------------------------------------------- |
| JSON 格式化      | JSON Formatter           | Format / minify / sort keys, with specific syntax errors        |
| JSON 字符串转义  | JSON String Escape       | Strict conversion between plain text and JSON string literals   |
| 配置格式转换     | Config Converter         | JSON / YAML / TOML / Properties both ways                       |
| 代码格式化       | Code Formatter           | Format JS / TS / HTML / CSS with prettier                       |
| JS 压缩          | JS Minify                | terser minification, optional name mangling                     |
| CSS 格式化压缩   | CSS Formatter            | Beautify or minify CSS without touching strings or url()        |
| HTML 格式化压缩  | HTML Formatter           | Beautify or conservatively minify, keeping pre / script / style |
| SQL 格式化       | SQL Formatter            | Format SQL per dialect with consistent keyword case             |
| 正则测试         | Regex Tester             | Isolated worker with a timeout to prevent ReDoS                 |
| UUID 生成        | UUID Generator           | Batch UUID v4, uppercase and dash-free options                  |
| Mock 数据生成    | Mock Data Generator      | Fake user / product / order rows as JSON / CSV / SQL            |
| Cron 表达式      | Cron Expression          | Parse a 5-field cron, explain each field and list upcoming runs |
| Markdown 转 HTML | Markdown to HTML         | Convert to a downloadable .html (no v-html preview)             |
| JSON 结构树      | JSON Tree                | Indented tree of types and values                               |
| Base64 编解码    | Base64 Codec             | Strict UTF-8 text ↔ Base64                                      |
| URL 编解码       | URL Codec                | encodeURIComponent / encodeURI and the reverse                  |
| 哈希摘要         | Hash / Digest            | SHA-256 / SHA-512 / MD5 of text or files (inputs never logged)  |
| 进制转换         | Radix Converter          | BigInt conversion across 2 / 8 / 10 / 16, negatives included    |
| 颜色转换         | Color Converter          | HEX / RGB / HSL (with alpha) both ways, auto-detects input      |
| Linux 命令词典   | Linux Command Dictionary | Offline docs for common commands; nothing is ever executed      |

## Text and utilities (15)

| Tool           | English name              | What it does                                                            |
| -------------- | ------------------------- | ----------------------------------------------------------------------- |
| 字符统计       | Character Statistics      | Code points, Han characters, letters, digits, whitespace, words, lines  |
| 文本对比       | Text Diff                 | Line-by-line jsdiff with structured JSON and a +/- view                 |
| 文本清理       | Text Cleanup              | Trim lines, drop empties, deduplicate, sort                             |
| 汉字转拼音     | Chinese Pinyin            | Full / toneless / numeric tones, initials, shengmu, polyphonic readings |
| 中文分词       | Chinese Word Segmentation | Built-in Intl.Segmenter by word / grapheme / sentence                   |
| 简繁体转换     | Simplified ⇄ Traditional  | opencc-js between Simplified and Taiwan / Hong Kong variants            |
| ASCII 艺术字   | ASCII Art (FIGlet)        | FIGlet banners in 12 selectable fonts                                   |
| 人民币金额大写 | RMB Amount in Words       | Exact cents with jiao/fen, zeros and negatives                          |
| 随机选择       | Random Choice             | CSPRNG draws with count and uniqueness options                          |
| 二维码生成     | QR Code Generator         | Local SVG / PNG with selectable error correction                        |
| 密码生成器     | Password Generator        | CSPRNG passwords with length, charset and count                         |
| 亲戚称谓计算   | Kinship Calculator        | Resolve kin terms from a relation chain; ambiguous chains error out     |
| 签名生成       | Signature Generator       | Handwriting-style vector signature SVG                                  |
| 印章生成       | Stamp Generator           | Circle / ellipse / square seal SVGs (layout demos only)                 |
| 文字图标生成   | Letter Icon Generator     | 1-4 characters into a rounded-square icon SVG                           |

## Images (11)

| Tool        | English name            | What it does                                                                                |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| 图片压缩    | Image Compress          | Proportional downscale and re-encode with a before/after size report; PNG transparency kept |
| 图片裁剪    | Image Crop              | Crop by origin and size, rotate 90/180/270                                                  |
| 图片滤镜    | Image Filters           | Greyscale, invert, brightness, contrast, pixelate, comic (deterministic pixel math)         |
| 纯色去底    | Solid Background Remove | Tolerance-based flood-fill removal or recolor (not portrait matting)                        |
| Base64 转换 | Base64 Converter        | Image → data URL, or data URL → image                                                       |
| ICO 图标    | ICO Icon Builder        | Standards-compliant multi-size (16–256 px) ICO                                              |
| 图片切图    | Image Splitter          | 2x2 / 3x3 / 2x3 / 3x2 grid, one attachment per tile                                         |
| 字符画      | ASCII Art               | Luminance-sampled monospaced art, optionally inverted                                       |
| 文字水印    | Text Watermark          | Text watermark exported as SVG with position, size, color, opacity, rotation                |
| 词云图      | Word Cloud              | Word frequency laid out on a deterministic spiral as SVG                                    |
| 图片叠加    | Image Montage           | Alpha-blend two images: positioned overlay, full blend or scaled badge                      |

## Documents and media (24)

This group launches local external programs and always runs as a **background task**: after clicking
**Run tool** you can keep using other pages, watch progress in the sidebar's Background Tasks panel
and **Stop job** at any time; results come back to the tool page.

| Tool             | English name           | Dependency    | What it does                                           |
| ---------------- | ---------------------- | ------------- | ------------------------------------------------------ |
| Word 转文本      | Word to Text           | —             | Extract plain text from a DOCX                         |
| Word 转 HTML     | Word to HTML           | —             | DOCX to structured HTML                                |
| 文本转 Word      | Text to Word           | —             | Multi-line text into a .docx                           |
| Word 转 Markdown | Word to Markdown       | —             | DOCX to Markdown (headings / lists / tables)           |
| HTML 转 Word     | HTML to Word           | —             | HTML text and structure into a .docx                   |
| Swagger 转 Word  | Swagger to Word        | —             | Local OpenAPI JSON/YAML into an API list DOCX          |
| 表格格式转换     | Spreadsheet Convert    | —             | XLSX / CSV to CSV/XLSX/HTML/MD/JSON                    |
| 多表合并         | Merge Spreadsheets     | —             | Merge several XLSX/CSV files into one                  |
| 图片转 PDF       | Images to PDF          | —             | PNG/JPEG into one PDF, optionally fitted to A4         |
| PDF 合并         | Merge PDF              | —             | Merge PDFs in order                                    |
| PDF 拆分         | Split PDF              | —             | Split by page ranges or one file per page              |
| PDF 加密         | Encrypt PDF            | qpdf          | AES-256 user / owner passwords                         |
| PDF 解密         | Decrypt PDF            | qpdf          | Remove a PDF password                                  |
| PDF 转文本       | PDF to Text            | poppler-utils | pdftotext extraction                                   |
| PDF 转图片       | PDF to Images          | poppler-utils | pdftoppm renders pages to PNG                          |
| PDF 转 HTML      | PDF to HTML            | poppler-utils | Escaped text into safe HTML                            |
| 文档格式转换     | Document Convert       | LibreOffice   | Local DOC/DOCX/ODT/XLS/XLSX/PPT/PPTX conversion        |
| 音视频格式转换   | Media Convert          | ffmpeg        | Transcoding across a whitelist of formats and encoders |
| 视频转 GIF       | Video to GIF           | ffmpeg        | Palette-based conversion keeping animation and color   |
| GIF 抽帧         | GIF Frames             | ffmpeg        | Export every GIF frame as PNG                          |
| GIF 压缩         | Compress GIF           | ffmpeg        | Re-encode with a palette to shrink                     |
| 媒体信息         | Media Info             | ffmpeg        | ffprobe container / stream info (JSON)                 |
| 视频去水印       | Remove Video Watermark | ffmpeg        | delogo region fill (small areas, not AI)               |
| 图片文字识别     | Image OCR              | tesseract     | Local OCR with English / Chinese / Japanese options    |

## Productivity (1)

| Tool   | English name   | What it does                                                                                 |
| ------ | -------------- | -------------------------------------------------------------------------------------------- |
| 番茄钟 | Pomodoro Timer | Focus/break cycles with pause, resume, reset and completion stats; offline, no notifications |

## Common limits

- Images support PNG / JPEG / GIF (first frame) / BMP, with a pixel ceiling checked before decoding.
  Solid background removal suits even backgrounds only, and watermark / word-cloud outputs are SVG.
- Document tools are not a full layout engine: formatting such as styles, watermarks and page numbers
  is not preserved.
- File tools accept up to 64 MiB per file and 128 MiB per batch; at most two conversion jobs run at
  once, and the result cache holds at most 12 entries / 192 MiB.
- Temp files from conversions are cleaned up when a job ends; inputs and results are never logged.

## Next

- [Back to Local Toolbox](../main.md)
