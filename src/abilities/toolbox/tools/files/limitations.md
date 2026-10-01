# 文档与媒体工具的范围

本工具箱只提供离线处理。网易云/短视频/公众号解析、在线归属地查询、云端 AI、账号功能均不纳入工具箱。屏幕录制需要专用界面与系统捕获权限，本次不包含。

- HTML→Word、PDF→HTML、Word→Markdown 保留文本与基础块结构，不能保证字体、图片、页眉页脚及复杂版式；HTML→Word 不保留行内粗体等样式。
- 表格转换输出缓存值与静态数据，不计算公式。扫描 PDF 需要先转图片再 OCR；缺少本机 OCR 语言包会明确报错。
- LibreOffice 转换接受 DOCX、ODT、XLSX、PPTX。旧版 DOC/XLS/PPT、宏、嵌入对象和外部引用拒绝处理；需先自行另存为无宏且资源内嵌的文档。
- 视频区域修补使用 ffmpeg delogo，只做邻域填补，复杂背景可能留下模糊块。
- 单文件最多 64 MiB，多文件共 128 MiB；附件输出共 100 MiB，最多 40 个。外部程序执行超时为 2 分钟，临时目录随任务结束清理。
- 依赖本机程序：LibreOffice、ffmpeg/ffprobe、qpdf、Poppler（pdftotext/pdftoppm）、Tesseract。缺失时只有相应工具不可用，不会转用在线服务。
