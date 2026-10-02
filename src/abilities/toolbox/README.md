# 本地工具箱

一个 `toolbox` ability，内部使用可扩展工具模块。侧栏只占一个入口；80 个工具分别注入全局快启动，并拥有 `toolbox.<id>` 命令。搜索中文名称、英文名称或关键词，回车打开工具。工具页支持分类、搜索、收藏、最近使用、复制与保存。

| 分组             | 工具                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日期时间（9）    | EpochConverter（秒/毫秒/微秒/纳秒）、批量时间戳、日期差、日期加减、日/月/年边界、时长、特殊纪元、世界时钟、汇率换算（联网）                                                                   |
| 开发（20）       | JSON 格式化/转义/树、JSON/YAML/TOML/Properties、代码/CSS/HTML/SQL 格式化、JS 压缩、正则、UUID、测试数据、Cron、Markdown、Base64、URL 编码、哈希、进制、颜色、Linux 命令词典 |
| 文本与实用（15） | 字符统计、对比、清理、拼音、分词、简繁、ASCII banner、人民币大写、随机选择、二维码、密码生成、亲戚称谓、签名/印章/图标 SVG                                                  |
| 图片（11）       | 压缩、裁剪旋转、滤镜、纯色去底、Base64、ICO、切图、字符画、水印、词云、叠加                                                                                                 |
| 文档与媒体（24） | Word/HTML/Markdown/接口文档、表格转换合并、图片转 PDF、PDF 合并拆分/加解密/文本/图片/HTML、Office 转换、音视频转码、视频转 GIF、GIF 拆帧压缩、媒体信息、区域修补、OCR       |
| 专注（1）        | 番茄钟（离开页面暂停，仅保存完成次数）                                                                                                                                      |

## 离线与隐私

除「汇率换算」外，工具不发送网络请求，不含账号功能、语录或娱乐生成器。汇率换算仅向公开汇率接口（open.er-api.com，失败回退 jsDelivr 上的 fawazahmed0/currency-api）发送货币代码，不发送金额，结果内存缓存 1 小时。只保存收藏/最近工具的 ID 和番茄钟完成次数；输入与结果不落日志。结果在内存中，文件任务最多并行两个，结果缓存最多 12 项/192 MiB。文件任务接入全局后台面板，可停止；后台只显示工具名和通用状态，内容从受隐私 SDK 保护的接口读取。

输入、输出及错误视图标记 `toolbox.content` 敏感 scope。密码输入禁止 agent 操作，PDF 密码功能和密码生成禁止 agent 调用，生成密码的结果标记 `secret`。外部转换在随机临时目录内以固定参数数组执行；qpdf 密码经 stdin 而非进程参数；ffmpeg/ffprobe 仅允许 file/pipe 协议。Office 包打开前检查宏/外部引用，使用隔离配置禁宏和外部链接更新。退出时终止所启动的进程组。

图片支持 PNG/JPEG/GIF 首帧/BMP，解码前检查像素上限。图片去底限于纯色，水印输出 SVG。文档不是完整排版引擎，详情见 [文档/媒体范围](tools/files/limitations.md) 与 [图片范围](tools/image/limitations.md)。部分转换需要本机安装 LibreOffice、ffmpeg、qpdf、Poppler 或 Tesseract；缺依赖会明确报错。

## 扩展与命令

`types.ts` 定义纯数据契约；各分组的 `definitions.ts` 只放元数据，`service.ts` 在主进程处理。`registry.ts` 聚合分组并验证 ID，`commands.ts` 懒加载执行器，`index.ts` 注入快启动，`ToolRunner.vue` 按字段渲染表单。增加同类工具仅修改对应分组；新分组还需接入 registry 和 handlers，无需增添侧栏能力或维护一套外部插件安装器。第三方依赖全部归本 ability 的 package.json。

```text
 toolbox.list
 toolbox.epoch-converter --timestamp 1700000000 --unit s --zone Asia/Shanghai
 toolbox.hash --input hello --algorithm sha256
```

文件与结构化参数适合使用 `window.cockpit.command`，传入普通对象（不能传 Vue proxy）。`toolbox.start` 启动文件任务，`toolbox.task` 读取状态/结果，`toolbox.cancel` 取消，`toolbox.export` 保存用户指定文件。工具计算与界面共用相同 handler。

离线回归测试使用临时 HOME：

```bash
HOME=/tmp/toolbox-test-home XDG_CONFIG_HOME=/tmp/toolbox-test-home/config node --import tsx --test --test-isolation=none src/abilities/toolbox/**/*.test.ts
```
