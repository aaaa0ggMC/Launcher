# YAYA (Yet Another Yes Agent) 架构规划与实施进度白皮书

> **项目代号**：`yaya` (Yet Another Yes Agent)  
> **所属架构**：Linux System Cockpit 下游智能体应用 / 独立公开子项目  
> **设计基线**：Electron + Vue 3 + Vuetify 3 (Material 3) + TypeScript + SQLite  
> **当前状态**：Phase 1 基础工程已就绪，Phase 2 核心闭环演进中

---

## 一、 项目愿景与生态定位

### 1.1 为什么做 YAYA？与中游代理（如 codex-proxy-node）的本质区别

在当前的 AI Agent 生态中，存在两类典型分工：
1. **中游代理（Proxy / Router，如 `aaaa0ggMC/codex-proxy-node`）**：
   - 角色：位于下游客户端与上游大模型 API 之间的请求拦截与协议转译层。
   - 限制：中游代理由于缺乏用户交互界面与操作系统本地上下文，只能做“请求转发、模型重映射、鉴权管理、基础流式修饰”，其操作空间被死死限制在 HTTP/WebSocket 协议报文内，在面对多模态二次处理、本地系统命令审批、富媒体交互式渲染时往往“畏手畏脚”。
2. **下游终端系统（YAYA）**：
   - 角色：直接面向最终用户的生产力智能体中枢。
   - 优势：拥有对 **渲染层（Vue 3 / Vuetify 组件）**、**本地文件系统（Electron Node.js API）**、**本地系统提权通道（Cockpit pkexec helper）**、**本地数据库（SQLite DAG）** 以及 **全生命周期中间件** 的最高控制权。用户上传一个超大文件、或大模型想画一张拓扑图，YAYA 都能直接在终端完成拦截、拆解与富组件渲染。

### 1.2 借鉴市面标杆产品的“甜点区”融合 (Sweet Spot Synthesis)

| 产品 / 架构 | 核心优势借鉴 | YAYA 的吸收与融合策略 |
| :--- | :--- | :--- |
| **Hermes / OpenClaw** | 极强的本地工具自主调度与错误自愈（Self-Correction） | 引入内置系统工具集（文件读写、命令执行、Cockpit 注册命令调用），支持自主尝试、报错捕获与模型自我修正。 |
| **ClaudeCode** | 终端极简开发者体验、Thinking（深度推理）非侵入折叠、清晰的工具链状态展示 | 采用双轨折叠展示：思考过程（Reasoning）与工具调用（Tool Calls）均以紧凑胶囊卡片渲染，默认收起、点击展开，杜绝冗长 JSON 污染主视野。 |
| **Codex** | 灵活的 Multi-Provider 切换与动态端点抓取 | 支持动态 `/v1/models` 与 Ollama `/api/tags` 探测，提供全局与各 Provider 独立过滤，聊天过程中支持实时无缝切模。 |
| **DSH** | 结构化任务产物、可复现的工作流树 | 采用 SQLite 树状 DAG 消息拓扑，天然支持任意历史节点的分支重试（Branch Forking）与状态快照恢复。 |
| **AIDJ** | 胶囊输入框、磨砂玻璃拟态、后台任务无头托管机制 | 继承并重构 AIDJ 的优秀 UI 基因；将工作流挂载在主进程 Background Tasks，前端刷新或切换页面即时无损恢复。 |

---

## 二、 六大核心支柱架构详解

### 1. Loop 系统：Pipeline 中间件与生命周期驱动

#### 架构挑战
传统的 Agent Loop 通常是硬编码的单向循环：`用户输入 -> LLM 生成 -> 解析 Tool Calls -> 执行 Tool -> 回传结果 -> LLM 生成`。这种“毛胚房”模式下，一旦想加入“用户敏感操作审批”、“超长文本大纲转换”、“输出特定 DSL 转交互图表”等能力，就必须侵入性地修改核心循环。

#### YAYA 洋葱模型与生命周期 Hook
```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Loop Pipeline                        │
│                                                                 │
│  [用户输入] ──► 1. onInput (拦截多模态/超长文档/注入引用)          │
│                      │                                          │
│                2. onContextBuild (装配 SQLite 消息链/动态工具)   │
│                      │                                          │
│                3. onLLMRequest (流式调用/Token & 思考广播)      │
│                      │                                          │
│        ┌─────────────┴─────────────┐                            │
│        ▼                           ▼                            │
│  [文本输出完成]             [模型发起 Tool Call]                 │
│        │                           │                            │
│        │                     4. onToolCall (权限审批/执行/重试)   │
│        │                           │                            │
│        │                     [结果回写 tool 节点] ──► 回到 step 2 │
│        │                                                        │
│  5. onOutput (解析自定义组件/生成富文本状态)                     │
│        │                                                        │
│        ▼                                                        │
│   [完成工作流]                                                  │
└─────────────────────────────────────────────────────────────────┘
```

- **Headless 无头恢复**：工作流由主进程 `WorkflowRunner` 驱动，维护 `WorkflowSnapshot`（状态机：`idle` | `streaming` | `tool_executing` | `waiting_approval` | `interrupted` | `completed` | `error`）。渲染进程关闭或重新加载时，直接通过 `yaya.workflow-snapshot` 重建状态，不丢失上下文。
- **自愈与脏数据清洗**：在组装消息上下文时，自动清洗由于中断或报错导致的空 Assistant 节点（防止触发 OpenAI / DeepSeek 严格的 `400 Invalid assistant message: content or tool_calls must be set` 异常），并在重试时自动将父级指针回溯至正常节点。

---

### 2. Session 系统：从 JSONL 到 SQLite Tree 拓扑

#### 选型评判：JSONL vs SQLite DAG
- **AIDJ 原生 JSONL 方案**：
  - *优点*：轻量、天然追加日志（Append-only）、对单线顺序对话非常友好。
  - *缺点*：在通用 Agent 场景中，用户频繁需要 **Edit & Retry（编辑某条历史重新生成）** 或 **多分支比对**。在单线 JSONL 中表示树状分支极难维护指针，修改某节点时要么重写整个大文件，要么产生混乱的版本污染。
- **YAYA SQLite Tree 方案**：
  - 每条消息对应一行数据，核心字段：`id`（UUID）、`session_id`、`parent_id`（指向父消息 UUID）。
  - **分支遍历**：通过递归 CTE（Common Table Expression）单次查询即可拉取从当前活动叶节点（`active_leaf_id`）回溯到根节点的最优主干（`getMessageBranch`）。
  - **同级导航**：查询拥有相同 `parent_id` 的兄弟节点列表（`getMessageSiblings`），前端界面直接渲染 `< 1/3 >` 翻页器，实现随时切换分支。
  - **导出兼容**：对外依然提供一键平铺导出为通用 `JSONL` 或 `Markdown` 的能力，兼顾通用性。

---

### 3. 模型与多模态 Slot 系统 (Model & IO Slots)

#### 统一 Provider 抽象与动态探测
- 不捆绑单一厂商 SDK，通过统一的 `AIProvider` 抽象向下兼容：
  - OpenAI 官方端点 / 自建 Codex Proxy
  - DeepSeek API（天然支持 `reasoning_content` 思考流式解析）
  - 本地 Ollama（动态探测 `/api/tags`，支持纯本地离线推理）
  - 兼容 vLLM、One-API、New-API 等聚合网关
- **动态探测机制**：一键调用 `yaya.provider-fetch-models`，带超时熔断自动拉取最新可用模型清单。

#### 多模态输入 Slot (Input Interceptor)
- **直接处理**：图片类附件自动转为 Base64 塞入 OpenAI Vision 格式。
- **长文本/视频/代码库预处理 Slot**：
  - 当文件大小超过阈值（如 > 200KB 或 > 10,000 字）时，`LongDocumentPlugin` 拦截输入。
  - 将大文件存入本地缓存，并在系统提示词中注入元数据：  
    `<attachment id="doc_123" name="Linux_Kernel.pdf" summary="关于Linux内核调度器的详解..." />`
  - 自动向当前轮次注入专属检索工具 `search_document(doc_id, query)`，让 AI 按需索取上下文，避免 Token 瞬间被撑爆。

#### 多模态输出 Slot (Output Renderer)
- 大模型输出 Markdown 文本时，解析自定义组件标签或代码块（如 ````mermaid`、`yaya:widget` 等）。
- 客户端前端动态挂载为交互式 Vue 3 组件（流程图、表格筛选器、系统状态仪表盘），摆脱纯文本的死板表现。

---

### 4. UI 界面：契合 Launcher 哲学与 DESIGN.md 规范

#### 布局底线与滚动机制
- **视口定高**：根容器使用 `height: calc(var(--app-vh) - 96px); max-height: calc(var(--app-vh) - 96px); overflow: hidden;`，严格匹配 Cockpit 的 Appbar（64px）与容器 Padding（32px），**从根源消除多余的全局外壳滚动条**。
- **浮动置顶与置底**：
  - 顶部操作栏（TopBar）与底部药丸输入条（ChatInputBox）设置 `flex-shrink: 0`，固定在视口顶端与底端。
  - 仅有中间消息列表区（`.messages-scroll-area`）具备 `overflow-y: auto`，保障无论会话多长，头部状态与输入条始终触手可及。

#### Material 3 沉浸式视觉体验
- **呼吸留白**：文字按钮一律使用默认密度（`density="default"`），禁止使用 `size="small"` 导致文字挤贴边框。
- **优雅的状态反馈**：抛弃粗暴刺眼的粗红实色 `v-alert` 弹窗，改为沉浸式轻量卡片（`background: rgba(var(--v-theme-error), 0.08); border: 1px solid rgba(var(--v-theme-error), 0.22);`），配合 `mdi-alert-circle-outline` 图标与对齐留白，带来如 Claude/ChatGPT 般的细腻质感。
- **移动端全适配**：窄屏（≤ 720px）下，左侧会话列表自动转为滑动式抽屉（Drawer），顶栏按钮自动收敛为图标模式，主聊天气泡宽度自适应拉伸。
- **无彩色裸 Emoji**：所有侧栏与状态图标统一采用 Curated SVG 或 MDI 单色矢量图标，与主题色无缝融合。

---

### 5. 数据保存与多模态资产 (Persistence & Assets)

- **双轨制架构**：
  - 结构化关系数据（Session 元数据、Message 树节点、工具调用记录）保存在 `~/.config/LinuxCockpit/yaya/yaya.db`。
  - 多模态实体（用户上传的文件、图片、生成的图表、音频）保存在本地独立资产目录：  
    `~/.config/LinuxCockpit/yaya/assets/<session_id>/`
- **安全预览**：通过 Electron 主进程注册专用私有协议或通过 Base64 本地管道安全访问，杜绝把大型二进制直接塞进 SQLite 导致数据库体积膨胀变慢。

---

### 6. 数据备份与第三方平台导入 (Importers)

- **导入器抽象架构**：基于主进程 Background Tasks 异步运行，避免导入成百上千条会话时阻塞渲染进程。
- **支持导入源**：
  1. **OpenAI**：解析 `conversations.json`，还原 mapping 字典中的树状分支关系。
  2. **Claude**：解析 Anthropic 导出格式，映射为 YAYA 节点。
  3. **DeepSeek / Rikkahub**：解析标准导出会话格式。

---

## 三、 详细实施进度表 (Implementation Status)

### 状态图例说明
- `[x]` **已完成**：功能完整落地，经过 TypeScript 类型检查、ESLint 校验与实机运行验证。
- `[-]` **演进中 / 部分完成**：核心原型已跑通，正按照本规划进一步优化或重构。
- `[ ]` **待实施**：已完成技术方案设计，待下阶段排期实现。

---

### 阶段一：基础设施与核心会话系统 (Foundation & Sessions)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **项目基建** | 能力模块注册与元数据声明 | `[x]` | `src/abilities/yaya/index.ts`, `meta.ts`, `types.ts` |
| | 主进程命令集暴露 (`CommandSpec[]`) | `[x]` | `src/abilities/yaya/commands.ts` (注册 `yaya.*` 系列系统命令) |
| **SQLite 树库** | 初始化表结构 (`sessions`, `messages`) | `[x]` | `src/abilities/yaya/services/db.ts` (基于 better-sqlite3) |
| | 树状回溯与分支加载 (`getMessageBranch`) | `[x]` | `src/abilities/yaya/services/db.ts` (递归 parent_id 溯源) |
| | 同级兄弟节点查询与分支切换 | `[x]` | `src/abilities/yaya/services/db.ts` (`getMessageSiblings`, `switchBranch`) |
| | 会话创建/更新/删除/幽灵空会话清理 | `[x]` | `src/abilities/yaya/services/db.ts` (`cleanEmptySessions`, `updateSession`) |
| | 用户首句自动提炼会话标题 | `[x]` | `src/abilities/yaya/View.vue` (第一条消息自动截取前 24 字符提炼) |
| **数据导出** | 一键将会话导出为 Markdown 文本 | `[ ]` | 计划接入 `yaya.session-export-markdown` |
| | 一键平铺导出为 JSONL 标准格式 | `[ ]` | 计划接入 `yaya.session-export-jsonl` |

---

### 阶段二：多服务商管理与模型层 (Model Layer & Dynamic Providers)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **配置存储** | 多 Provider 配置读取与持久化 | `[x]` | `src/abilities/yaya/services/config.ts` (`~/.config/LinuxCockpit/yaya/config.json`) |
| **Provider 适配** | OpenAI 兼容接口实现 (含流式/思考流) | `[x]` | `src/abilities/yaya/services/providers/openai.ts` (原生支持 DeepSeek reasoning_content) |
| | 空节点与异常上下文拦截清洗 | `[x]` | `src/abilities/yaya/services/providers/openai.ts` (杜绝 400 content or tool_calls 错误) |
| | Ollama 本地模型直接探测与适配 | `[x]` | `src/abilities/yaya/services/models.ts` (`/api/tags` 探测) |
| | Anthropic / Google Gemini 原生 SDK Provider | `[ ]` | 后续通过原生接入或统一由 OpenAI 兼容中继处理 |
| **动态模型选择** | 服务端端点模型嗅探 (`v1/models`) | `[x]` | `src/abilities/yaya/services/models.ts` (`fetchModelsFromEndpoint`) |
| | 弹窗式多 Provider 独立/全局搜索选择器 | `[x]` | `src/abilities/yaya/components/ModelSelectDialog.vue` |
| | 聊天中途无感热切换大模型 | `[x]` | `src/abilities/yaya/View.vue` (实时更新 Session Provider & Model) |
| | 设置面板 Provider 动态增删改查与连通性测试 | `[x]` | `src/abilities/yaya/components/YayaSettingsSection.vue` |

---

### 阶段三：Agent Loop 与工具系统 (Agent Core & Tools)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **Loop 引擎** | 循环调度器 (`WorkflowRunner`) | `[x]` | `src/abilities/yaya/services/loop/runner.ts` (管理 Step/RingBuffer/Aborts) |
| | 任务管理器 (`WorkflowManager`) | `[x]` | `src/abilities/yaya/services/loop/manager.ts` (并发锁、单例任务托管) |
| | Headless 状态快照与无头断线重连 | `[x]` | `src/abilities/yaya/services/loop/manager.ts` (`getWorkflowSnapshot`) |
| | 洋葱模型中间件解耦 (Pipeline Hooks) | `[-]` | 当前为单函数循环，后续将拆解为标准的 Hook 中间件链 |
| **系统原生工具** | Cockpit 命令执行工具 (`run_cockpit_command`)| `[x]` | `src/abilities/yaya/services/loop/tools.ts` |
| | Bash 命令行执行工具 (`exec_shell_command`) | `[x]` | `src/abilities/yaya/services/loop/tools.ts` |
| | 文件读取与写入工具 (`read_file`, `write_file`)| `[x]` | `src/abilities/yaya/services/loop/tools.ts` |
| | 网络抓取工具 (`fetch_url`) | `[x]` | `src/abilities/yaya/services/loop/tools.ts` |
| **安全与授权** | 人类确认授权状态 (`waiting_approval`) | `[x]` | `src/abilities/yaya/services/loop/manager.ts`, `ChatMessageItem.vue` |
| **外部生态** | MCP (Model Context Protocol) 客户端集成 | `[ ]` | 支持动态添加 MCP Server，自动读取并挂载外部 Tool Schemas |

---

### 阶段四：多模态与插件 Slot 系统 (Multimodal Slots)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **附件管理** | 文件选择与附件拾取 (`pickFile`) | `[x]` | `src/abilities/yaya/components/ChatInputBox.vue` |
| | 附件数据持久化与图片 Vision 转换 | `[x]` | `src/abilities/yaya/services/assets.ts`, `services/providers/openai.ts` |
| | `yaya-asset://` 专用本地安全协议注册 | `[ ]` | 提升大图及视频本地渲染性能 |
| **输入预处理 Slot** | 超大文件自动摘要 + 文档检索工具化 | `[ ]` | 当输入超长文件时，拦截并转化为索引工具注入大模型 |
| **输出渲染 Slot** | Mermaid 流程图/时序图代码块动态渲染 | `[ ]` | 替换默认 pre 标签，直接挂载矢量流程图 |
| | SVG / HTML 实时交互式小部件渲染器 | `[ ]` | 安全沙箱中渲染 UI 小部件 |

---

### 阶段五：UI/UX 体验与移动端适配 (UI Refinement & DESIGN.md)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **排版规范** | 顶部栏与底部输入条固定，中间独立滚动 | `[x]` | `src/abilities/yaya/View.vue` (消除全局空滚动条) |
| | 文字按钮/Chip 采用默认密度与标准内边距 | `[x]` | 严格遵循 `DESIGN.md` §3 规范，杜绝挤压 |
| | 沉浸式轻量错误横幅与重新生成动作 | `[x]` | `src/abilities/yaya/components/ChatMessageItem.vue` (替换粗暴 v-alert) |
| | 思考过程折叠胶囊卡片 | `[x]` | `src/abilities/yaya/components/ChatMessageItem.vue` |
| | 工具调用入参与返回结果手风琴折叠 | `[x]` | `src/abilities/yaya/components/ChatMessageItem.vue` |
| | 树状分支翻页器 (`< 1/2 >`) | `[x]` | `src/abilities/yaya/components/ChatMessageItem.vue` |
| **移动端适配** | 窄屏下抽屉式会话列表展示 | `[x]` | `src/abilities/yaya/View.vue` (`v-navigation-drawer temporary`) |
| | 响应式顶栏按钮收缩与气泡自适应 | `[x]` | `src/abilities/yaya/View.vue` |
| **视觉规范** | 彻底移除彩色裸 Emoji，全单色 MDI/SVG 化 | `[x]` | 符合 Cockpit 10 套深色/浅色配色方案跟随规范 |

---

### 阶段六：生态连接与外部数据导入 (Importers & Ecosystem)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **OpenAI 导入** | 解析 `conversations.json` 并还原树状拓扑 | `[-]` | `src/abilities/yaya/services/importers/openai.ts` (已完成基础解析器，待接后台任务) |
| **Claude 导入** | 解析 Anthropic 官方导出对话记录 | `[ ]` | 映射为 YAYA Message 树 |
| **DeepSeek 导入** | 解析 DeepSeek 对话导出格式 | `[ ]` | 映射为 YAYA Message 树 |
| **Rikkahub 导入** | 解析 Rikkahub / 第三方客户端导出格式 | `[ ]` | 映射为 YAYA Message 树 |
| **后台任务运行** | 导入过程通过 Cockpit Background Tasks 执行 | `[ ]` | 提供导入进度条、吞吐量监控与取消能力 |

---

## 四、 后续开发路线与近期优先级 (Next Action Items)

1. **短期重点 (当前迭代)**：
   - 彻底验证并收尾 UI 视口定高与消息内部滚动逻辑，确保任何屏幕尺寸下输入框均悬浮在最底部。
   - 完善 SQLite 历史节点的脏数据自动容错机制，保证任意节点的“重新生成”零报错。
2. **中期规划 (下一迭代)**：
   - 实现 Markdown 导出与 JSONL 导出命令。
   - 启动 Phase 4 的输出渲染 Slot，让大模型输出的 Mermaid 代码块直接渲染为可视化图表。
   - 接入 MCP (Model Context Protocol) 外部客户端。
3. **长期愿景**：
   - 打造多平台聊天记录无损迁移工具（OpenAI / Claude / DeepSeek 一键搬家至本地私有 SQLite）。
