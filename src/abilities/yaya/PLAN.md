# YAYA (Yet Another Yes Agent) 架构规划与实施进度白皮书

> **项目代号**：`yaya` (Yet Another Yes Agent)  
> **所属架构**：Linux System Cockpit 下游智能体应用 / 独立公开子项目  
> **设计基线**：Electron + Vue 3 + Vuetify 3 (Material 3) + TypeScript + SQLite  
> **当前状态**：Phase 1–3 闭环可用（会话树 / 多服务商 / 工具循环 + 审批），Phase 4 附件已接通，输出 Slot 与 MCP 待做

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
- **铺满内容区**：根容器与 AIDJ 一致用 `position: absolute; inset: 0; overflow: hidden`，外壳不出滚动条，只有消息区滚动。
- **会话侧栏按容器宽度切换**（ResizeObserver，不看窗口断点）：≥ 900px 常驻可收起，< 900px 变为弹出抽屉 + 遮罩。
- **浮动置顶与置底**：
  - 顶部操作栏（TopBar）与底部药丸输入条（ChatInputBox）设置 `flex-shrink: 0`，固定在视口顶端与底端。
  - 仅有中间消息列表区（`.messages-scroll-area`）具备 `overflow-y: auto`，保障无论会话多长，头部状态与输入条始终触手可及。

#### Material 3 沉浸式视觉体验
- **呼吸留白**：文字按钮一律使用默认密度（`density="default"`），禁止使用 `size="small"` 导致文字挤贴边框。
- **优雅的状态反馈**：抛弃粗暴刺眼的粗红实色 `v-alert` 弹窗，改为沉浸式轻量卡片（`background: rgba(var(--v-theme-error), 0.08); border: 1px solid rgba(var(--v-theme-error), 0.22);`），配合 `mdi-alert-circle-outline` 图标与对齐留白，带来如 Claude/ChatGPT 般的细腻质感。
- **移动端全适配**：窄屏（≤ 720px）下顶栏只留菜单 / 模型 / 新对话 / 更多，消息去掉左侧缩进，工具调用参数摘要换行显示，弹窗全屏；触屏上回车换行、用发送按钮发送，悬停才出现的操作改为常显。
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
| **项目基建** | 能力模块注册与元数据声明 | `[x]` | `index.ts`, `meta.ts`, `types.ts` |
| | 主进程命令集 (`CommandSpec[]`) + 隐私声明 | `[x]` | `commands.ts`（工作流 / 资产导入 = `system.exec`；审批、改配置 = 仅用户） |
| **SQLite 树库** | 表结构 (`sessions`, `messages`) | `[x]` | `services/db.ts`（`node:sqlite` 内置，无原生依赖） |
| | 分支回溯 + 同级分支一次查询附带 | `[x]` | `getMessageBranchWithSiblings`（替代界面逐条请求 siblings） |
| | 切换分支自动走到该分支最新叶子 | `[x]` | `findLatestLeaf`（旧实现会截断该分支的后续对话） |
| | 会话增删改、删除时清理资产目录 | `[x]` | `db.ts` / `assets.ts` |
| | 新对话懒创建（首次发送 / 添加附件才建会话） | `[x]` | `View.vue`（不再产生空会话） |
| | 首句自动作为会话标题、会话重命名 | `[x]` | `View.vue`, `ChatSessionList.vue` |
| **数据导出** | 导出 Markdown（当前分支 / 整棵树） | `[x]` | `services/export.ts`，`yaya.session-export[-file] --format md` |
| | 导出 JSONL | `[x]` | 同上 `--format jsonl` |

---

### 阶段二：多服务商管理与模型层 (Model Layer & Dynamic Providers)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **配置存储** | 配置读写、密钥加密落盘 | `[x]` | `services/config.ts` |
| | 密钥不下发渲染端（`apiKeySet`），留空保存 = 保留 | `[x]` | `publicYayaConfig` / `mergeIncomingYayaConfig` |
| | 助手显示名 `assistantName`（默认 YAYA），提示词 `{name}` 占位 | `[x]` | 设置页「助手」，页面顶部 / 消息署名 / 导出都用它 |
| **Provider 适配** | OpenAI 兼容（流式 / reasoning_content / tool_calls） | `[x]` | `services/providers/openai.ts` |
| | 空节点清洗（防 400 content or tool_calls） | `[x]` | `runner.ts` `buildMessages` + provider |
| | Ollama / Codex Proxy（同走 OpenAI 兼容） | `[x]` | `services/models.ts`（`/api/tags` 探测） |
| | Anthropic / Gemini 原生 Provider | `[ ]` | 未实现，设置里已移除这两个选项（不装样子）；需要时先写 Provider 再开放 |
| **动态模型选择** | `/v1/models` 嗅探 | `[x]` | `fetchModelsFromEndpoint` |
| | 模型选择弹窗（全局搜索 + Provider 过滤，窄屏全屏） | `[x]` | `components/ModelSelectDialog.vue` |
| | 会话级模型切换（同时作为新对话默认） | `[x]` | `View.vue` |

---

### 阶段三：Agent Loop 与工具系统 (Agent Core & Tools)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **Loop 引擎** | `WorkflowRunner`：每步节点必落终态 | `[x]` | `services/loop/runner.ts`（修复：中止后被覆盖为 completed、步数上限留下悬空 streaming 节点） |
| | 流式内存缓冲 + 拉取时叠加，token 事件带 offset 去重 / 补洞 | `[x]` | `overlayLiveBuffer` + `View.vue` `applyChunk` |
| | 重新生成 = 新兄弟分支（不再复制一条用户消息） | `[x]` | `yaya.workflow-regenerate` |
| | 编辑用户消息并重发 = 新分支 | `[x]` | `UserMessage.vue` → `workflow-start --parent` |
| | 运行中会话广播（侧栏指示） | `[x]` | `cockpit:yaya-running` / `yaya.workflow-running` |
| **工作流** | 工作流注册表：runner 只做宿主（步骤节点 / 流式 / 工具与审批 / 子 Agent / 过程记录），流程由工作流描述 | `[x]` | `services/workflow/`（`registerWorkflow`，契约见 `types.ts` 文件头） |
| | 内置工作流：`agent` 工具循环 / `chat` 纯对话 / `plan-act` 规划子 Agent + 执行 | `[x]` | `workflow/builtin.ts`；会话级选择（输入框）+ 设置里的默认工作流 |
| | 过程记录持久化（每步 Agent / 耗时 / tokens / 子 Agent 输出） | `[x]` | `messages.meta.workflow`（挂在一次运行的第一个 assistant 节点上） |
| | 流式 usage（`stream_options.include_usage`，网关不支持时自动退回） | `[x]` | `providers/openai.ts` |
| | 更多工作流（审阅 / 多 Agent 并行等）、MCP 工具编排 | `[ ]` | 照 `builtin.ts` 注册即可 |
| **内置工具** | `get_system_time` / `cockpit_list_commands` / `cockpit_command` | `[x]` | `services/tools/registry.ts`；`cockpit_command` 对需授权的命令要求确认，禁止调用 `yaya.*` |
| | `read_file`（分段 / 目录列表）/ `write_file` / `run_bash` | `[x]` | 结果统一截断，`run_bash` 可被「停止」中断 |
| | `fetch_url`（HTML 去标签、超时） | `[x]` | 同上 |
| | 工具逐个启用 / 禁用 | `[x]` | `disabledTools` + `yaya.tools-list`，设置页「工具」 |
| | ~~`search_document`~~ | 移除 | 原为返回固定字符串的假工具；等长文档 Slot 真正实现再加 |
| **安全与授权** | 工具调用内联审批（参数预览 + 允许 / 拒绝） | `[x]` | `ToolCallRow.vue`；重启后挂起的审批收敛为中断 |
| **外部生态** | MCP 客户端 | `[ ]` | `mcpServers` 配置字段已有，客户端未实现 |

---

### 阶段四：多模态与插件 Slot 系统 (Multimodal Slots)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **附件** | 选文件 → 复制进会话资产目录 | `[x]` | `yaya.asset-import`（≤ 25MB，网页模式同样可用） |
| | 图片 → Vision；文本 ≤ 200KB 内联；其余给路径让模型用 `read_file` | `[x]` | `providers/openai.ts` `attachmentParts` |
| | 缩略图预览 | `[x]` | `yaya.asset-preview`（data URL，≤ 4MB） |
| | `yaya-asset://` 协议 | `[ ]` | 目前只做路径解析（已防 `../` 越界） |
| **输入预处理 Slot** | 超大文件摘要 + 检索工具 | `[ ]` | |
| **输出渲染 Slot** | Markdown 代码块高亮 + 复制 | `[x]` | `components/markdown.ts`（highlight.js 按需加载，配色跟主题） |
| | Mermaid 渲染 | `[ ]` | 需要新依赖，待定 |
| | SVG / HTML 小部件沙箱 | `[ ]` | |

---

### 阶段五：UI/UX (DESIGN.md)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **布局** | 铺满内容区、常驻 / 弹出式会话侧栏 | `[x]` | `View.vue` |
| **消息** | 按「轮次」渲染：中间步骤收进过程卡片，气泡只放最终回答 | `[x]` | `components/turns.ts`（含单测）+ `AssistantTurn.vue` + `WorkflowCard.vue` |
| | 气泡：助手玻璃底 + 边框，用户 primary 色调 + 边框 | `[x]` | |
| | 右键 / 长按菜单：复制、复制选中、复制 Markdown、编辑、重新生成、删除分支 | `[x]` | `MessageMenu.vue`；长按指令移到 `@ui/directives/long-press` 共用 |
| | 输入框展开 / 收起（展开态 Ctrl+Enter 发送、Esc 收起）+ 工作流选择 | `[x]` | `ChatInputBox.vue` |
| **设置** | 分层导航：宽屏左侧导航，窄屏逐层进入；工具搜索 / 筛选 / 批量开关；服务商列表 → 详情 | `[x]` | `YayaSettingsSection.vue` + `components/settings/` |
| | 用户消息：复制 / 编辑重发 / 分支翻页 / 图片缩略图 | `[x]` | `UserMessage.vue` |
| | 停止 = 安静的「已停止」，错误 / 重启中断才用提示条 | `[x]` | `AssistantTurn.vue` |
| | 贴底自动跟随、上翻后「回到底部」 | `[x]` | `View.vue` |
| **i18n** | 全部文案走翻译（zh / en-US） | `[x]` | `translations/` |
| **移动端** | 窄屏布局、触屏常显操作、弹窗全屏 | `[x]` | 各组件 `@media (max-width: 720px)` / `(hover: none)` |

---

### 阶段六：生态连接与外部数据导入 (Importers & Ecosystem)

| 模块 | 子功能 | 状态 | 当前实现位置 / 说明 |
| :--- | :--- | :---: | :--- |
| **OpenAI 导入** | `conversations.json` → 消息树（re-parent、current_node、去重、事务） | `[x]` | `services/importers/openai.ts` |
| | 后台任务运行（进度 / 停止） | `[x]` | `jobs.ts` `yaya.import-openai` |
| **Claude / DeepSeek / Rikkahub 导入** | | `[ ]` | |

---

## 四、 后续开发路线与近期优先级 (Next Action Items)

1. **短期**：实机走一遍（桌面 + 400px / 650px 窄屏），重点看流式输出、工具审批、分支切换、附件。
2. **中期**：MCP 客户端（stdio / SSE）→ 动态挂载外部工具（设置的工具页已按来源分组 + 搜索，可直接容纳）；长文档 Slot（摘要 + 检索工具）；更多工作流。
3. **长期**：Claude / DeepSeek 等导入器；输出小部件沙箱。


---

## 五、 第二阶段（Era 2）：Plugin 架构 —— 工具 / MCP / Skill 统一为插件

> 2026-10-04 立项。参考 `aaaa0ggMC/codex-proxy-node` 的插件分层（plugin = tools + instructions + fences + contribute），
> 但 YAYA 掌握对话存储与渲染端，所以「富文本变换」只发生在**显示层**：数据库永远存模型的原文，
> 发给模型的历史与上一次逐字节相同 → 提示词缓存不受影响，也不需要 codex-proxy 那套 restoreText。

### 5.1 概念

| 概念 | 含义 |
| :--- | :--- |
| **Plugin** | 前后端结合的扩展单元。后端：0..n 个 tools、`instructions`（拼进系统提示词的片段）、生命周期（连接 / 释放）；前端（可选）：代码块渲染器（fences）、工具结果视图（toolViews）。 |
| **Tool** | 属于某个插件。对模型暴露的名字 = wire name（内置 `system` 插件不加前缀以兼容旧会话；其余 `<插件>_<工具>`，超 64 字符截断 + 稳定哈希）。可单独开关、单独设置审批（ask / auto / 跟随提供方默认）。 |
| **MCP** | 一种动态插件：每个 MCP 服务器 = 一个插件，tools 来自 `tools/list`。传输 Streamable HTTP / SSE，可配置自定义 Header（值加密存储、不下发渲染端）。 |
| **Skill** | 一种动态插件：`~/.config/LinuxCockpit/yaya/skills/<名字>/SKILL.md`（frontmatter `name` / `description` + 正文，可带附属文件）。按「渐进披露」：系统提示词只列名字与描述，模型需要时调用 `skill_load` / `skill_read_file` 取正文与附件。 |
| **Cockpit 插件** | 内置插件，把 Cockpit 自己的 agent 工具表（`commands_list` / `command_run` / `ui_*` …）在进程内直接暴露给 YAYA，`ui_*` 直接操作当前界面；结果用专门的视图优雅展示（截图、命令表、无障碍树）。 |

### 5.2 安全边界（重要）

- YAYA 的工具调用此前继承 `ui` 来源，等于用户亲手操作，**绕过了隐私 SDK**。新增来源 `local-agent`（进程内 LLM agent，属于 agent 来源）：
  工具执行一律 `withOrigin({ kind: 'local-agent', session: 'yaya:<会话>', client: <助手名> })`，脱敏 / 授权窗口 / `agent: 'deny'` 自动生效。
- YAYA 运行工作流时注册为 agent 会话（`sessions.ts`，transport `local`）：标题栏 AgentBar 出现它的小动物头像，描边提示「AI 正在操作」。
- **人机共用界面时的中途叫停**：点击 YAYA 的头像 → 暂停 / 继续 / 停止。宿主在每步开始、每次工具调用前检查暂停闸门；另提供「暂停所有 AI 操作」全局快捷键（默认不绑定）。会话控制做成通用接口（`setSessionControl`），以后 MCP 会话也能用。

### 5.3 打断不回滚（steer）

运行中输入框保持可用：发送 = 停止当前运行（保留已生成的内容与已执行的工具结果）+ 以新消息继续。
宿主组装历史时修复悬空的 tool_calls（缺结果的调用补「已中断」结果），保证不触发 400。

### 5.4 工作包

| 包 | 内容 | 负责 |
| :--- | :--- | :--- |
| A1 | 插件 SDK 契约与注册表（后端）、内置 `system` 插件迁移、tool 结果规范化（文本 / 图片 → 资产）、`yaya.plugins-list` | 副总监 |
| A2 | `local-agent` 来源、agent 会话注册、会话控制（暂停 / 继续 / 停止）+ AgentBar 弹层、宿主暂停闸门 | 副总监 |
| A3 | 渲染端插件 UI 契约：`plugins/<id>/ui.ts`（fences / toolViews），Markdown 分段渲染 | 副总监 |
| A4 | 打断不回滚：历史修复 + 运行中可发送 | 副总监 |
| B1 | MCP 插件提供方（Streamable HTTP / SSE、Header、连接状态、测试 / 刷新命令） | Step |
| B2 | Skill 插件提供方（扫描、解析、`skill_load` / `skill_read_file`、导入） | Step |
| B3 | 设置 → 插件页（插件 / MCP / Skills 三个分页、插件详情含工具开关与审批、MCP 编辑器、Skill 列表） | Step |
| B4 | Cockpit 插件（包装 agent 工具表、zod → JSON Schema、截图 / 命令表 / 快照视图） | Step（依赖 A2） |

### 5.5 进度（2026-10-04 Era 2 第一阶段完成）

| 包 | 状态 | 说明 |
| :--- | :---: | :--- |
| A1 插件 SDK | `[x]` | `services/plugins/types.ts` / `registry.ts`；`plugins/system/`；`yaya.plugins-list` / `yaya.plugin-restart`；`pluginEnabled` / `skillsDir` / MCP 配置（header 加密、`headersSet`） |
| A2 安全与叫停 | `[x]` | `local-agent` 来源；transport `local` 会话 + `agent.control` / `agent.pause-all`；AgentBar 头像菜单；暂停闸门。agent 会话 id 每次运行独立（`yaya:<会话>:<锚点>`），YAYA 页面用 `yaya.workflow-control` / `yaya.workflow-abort` 控制 |
| A3 渲染端插件 UI | `[x]` | `plugin-ui.ts` / `plugin-ui-registry.ts`；`renderSegments`；工具结果专门视图与图片放大 |
| A4 打断不回滚 | `[x]` | `sanitizeHistory`；迟到结果不抢分支；运行中「打断并发送」 |
| B1 MCP 提供方 | `[x]` | `services/plugins/mcp/*`（Streamable HTTP / SSE、header、状态、失败不重放） |
| B2 Skill 提供方 | `[x]` | `services/plugins/skills/*`（扫描、`skill_load` / `skill_read_file`、导入、路径边界） |
| B3 设置 → 插件页 | `[x]` | `components/settings/Plugin*` / `McpServer*` / `SkillsPanel` |
| B4 Cockpit 插件 | `[x]` | `plugins/cockpit/*`（agent 工具表包装、zod → JSON Schema、截图 / 命令表 / 快照视图） |
| B5 headless 下的 `ui_*` | `[x]` | `src/main/process/browser-ui.ts` + `src/headless/browser-bridge.ts`：定向 SSE、8 个固定方法、隐私预检 → guard → 带令牌重试；页面串行执行 + 取消帧（排队丢弃、执行中中止、按键必松开）；agent 输入标记只由页面执行时打 |

**验证**（全部隔离 HOME）：`pnpm typecheck`（204 模板 0 错）、`pnpm lint` 0 问题、`pnpm test` 471 pass / 2 skip / 0 fail、`wf-selftest.mts` ALL PASS、Electron 构建 + `build:headless --only yaya` 通过。之前已做过：假服务联调 MCP（HTTP / SSE）、Skills 导入、Cockpit 命令 / 截图，1280 / 400 宽度插件界面无横向溢出，网页快照与 Vue 输入实测。

**待用户实测**：真实模型 + 真实 MCP 服务；AgentBar 暂停 / 继续与 YAYA 页面「继续」按钮；网页模式下 YAYA 操作界面中途点「停止」不再有迟到动作。

**下一步候选**：页面桥目前没有 DOM 环境的单测（无 jsdom），取消逻辑靠代码审查；无头宿主下隐私授权窗口不可用（`privacy.consent: none`），受保护动作（YAYA 系统工具 guard、页面隐私区操作）会挂起到授权请求超时后按拒绝处理——需要网页版授权弹层。


### 5.6 Era 2 第二阶段之后补上的（2026-10-05，已提交 `5f12169`）

悬浮窗 SDK（Outsider）与「AI 在场」悬浮窗、网页版隐私授权、授权四档、ref 点击遮挡检查、`fetch_url` 本机 / 局域网授权、会话级思考强度、AI 中途说的话与过程块交错显示、用量统计、工具审批范围（本次执行 / 本对话都允许）。说明见 AGENTS.md「悬浮窗（Outsider SDK）」与「YAYA 插件 SDK」。

**待用户实测**：悬浮窗拖动 / 收起 / AI 点击穿透；等待批准时展开参数；跳到 AI 正在操作的页面；跑完后「回到对话」；网页模式授权悬浮窗；DeepSeek「不思考」参数是否被接受；用量统计；新审批按钮。

---

## 六、 下一步计划（2026-10-05 记）

### 6.1 长会话滑动窗口加载（已做第一版，2026-10-05）

**已完成**：`yaya.messages-branch --limit N [--before id]`（`getMessageBranchWindow`：轻量查询走路径、按用户消息边界截窗口、只给窗口内节点查兄弟分支）；页面先加载最后 20 轮，滚到顶部 / 点「加载更早的消息」向上翻页并保持位置；运行中只刷新最后两轮（`refreshTail`），未变化的节点 / 轮次复用旧对象（`mergeNodes` / `buildTurnsReusing`）不重渲染；token 每 50ms 合并写入；Markdown 按顶层空行分块缓存（流式只重渲染最后一块）；轮次 `content-visibility: auto`；滚动按方向判断用户意图（上翻立即停止跟随）。网页版 SSE 断线自动重连 + 重连 / 回到前台 / 切回页面时重新同步。
**还没做**：搜索命中 / 用量统计跳转到窗口外的消息；工具图片缩略图懒加载。

原计划：

**现状**：`yaya.messages-branch` 每次返回整条分支，并对每个节点查兄弟分支（`getMessageBranchWithSiblings`）；View 渲染全部轮次；运行中多处 `loadMessages()` 整枝重载。几百步、带截图的长会话（如 GBA）会越来越卡。

**计划**：
- 后端：`yaya.messages-branch --limit <轮数> --before <messageId>`，按用户消息边界切（不拆开一轮回答），返回 `hasMore`；只给返回的节点查兄弟分支。
- 前端：先加载最后约 30 轮；滚到顶部加载上一窗口，保持滚动锚点不跳。
- DOM 窗口：先用 `content-visibility: auto` + `contain-intrinsic-size` 做廉价版；不够再做「视口外的轮次换成测量过高度的占位」。
- 运行中的增量：token / 循环事件只更新最后一轮，不整枝重载（排查 View 里的 `loadMessages()` 调用点）。
- 跳转：搜索命中、切分支、用量统计里点某次调用 → 加载目标附近的窗口再定位。
- 工具图片缩略图懒加载；导出仍然全量。
- 移动端：滚动加载与 `--app-vh` 外壳配合，键盘弹出时不跳。

### 6.2 边做插件边完善插件系统：「AI 无感、但深刻影响用户」的显示类插件

这类插件只改显示（数据库与发给模型的历史仍是原文），不加 instructions、不加工具，所以不影响提示词缓存。用真实插件把 SDK 的缺口逼出来。

**插件 A：mermaid → 渲染图**（`plugins/mermaid/ui.ts`，fences: `mermaid`）
- mermaid 作为 yaya 依赖，渲染端按需动态加载（代码分割，不进首屏）；`securityLevel: 'strict'`。
- 流式中只显示源码，代码块闭合（`streaming=false`）后才渲染；渲染失败回退显示源码与错误信息。
- 配色跟随主题（取 `--v-theme-*`）；工具栏：图 / 源码切换、复制源码、导出 SVG / PNG、点击放大全屏（移动端双指缩放）。
- 按源码哈希缓存渲染结果，重渲染 / 切分支不重复计算。

**插件 B：SVG 渲染**（fences: `svg` / `xml` 中的 `<svg>`，以及工具结果、附件里的 `.svg`）
- 模型输出是不可信内容：**不用 v-html 插原始 SVG**。净化（去 script / foreignObject / on* 事件 / 外部 href）后用 `<img src="data:image/svg+xml;…">` 显示，图片上下文里脚本本来就不执行。
- 源码切换、放大、导出；尺寸夹取，超大 SVG 只显示源码并提示。

**它们会逼出的 SDK 改进**：
- **纯前端插件**：目前插件以后端 `YayaPlugin` 注册为准，显示类插件要么注册一个 `tools: []` 的后端插件来拿到设置页开关，要么支持「仅 ui」插件登记。渲染端的 `fenceViewFor` / `toolViewFor` 要尊重插件的启用状态。
- **代码块接管的冲突**：同一语言多个插件时的优先级与逐插件禁用。
- **插件自己的设置**：插件声明设置项（如 mermaid 主题、最大尺寸），在插件详情页渲染。
- **公共查看组件** `components/plugin-kit/`：放大 / 全屏对话框、图 / 源码切换、复制 / 导出、错误回退，免得每个插件各写一遍。
- **流式约定**写进文档：重渲染只在 `streaming=false` 时做；渲染要可取消（快速切会话时）。
- **可选的「告诉 AI」开关**：默认 AI 无感；用户可开启让系统提示词多一句稳定的「可以用 mermaid 代码块画图」（一次性改变缓存，之后稳定）。
- **测试**：`renderSegments` 补未闭合 / 嵌套代码块用例；插件 ui 的单测脚手架。
- **安全**：所有显示类插件按不可信输入处理，遵守 CSP；结果视图里的隐私标签规范照旧。

### 6.3 Mention：输入 `@` 点名插件 / Skill / 工具

聊天输入框里随时输入 `@` 弹出候选框（插件、Skill、MCP 服务器、单个工具，可搜索），选中后插入一个提及标签，如 `@mermaid`。效果：**从这条消息起，本会话强制启用它**。

- **会话级覆盖**：记在 `session.meta.mentions`（插件 / Skill / 工具 id 列表），优先于全局的 `pluginEnabled` / `disabledTools`；会话菜单里能看到并撤销。全局被禁用的插件也能被点名临时启用（这是用户主动的选择），但隐私边界不变：工具内部的 guard、`agent: 'deny'` 照旧。
- **不破坏提示词缓存**：点名带来的说明不改系统提示词，而是**作为附注拼进这条用户消息**（如「用户启用了 mermaid：可以用 mermaid 代码块画图」），之前的前缀不变，缓存照常命中。点名新增的工具追加在工具表末尾，只影响之后的请求。
- **不同类型的效果**：
  - 显示类插件（mermaid / SVG）：让 AI 知道可以用对应代码块（即 6.2 的「告诉 AI」开关，但只对本会话、由用户点名触发）；
  - Skill：把该 Skill 的说明随这条消息加载（等价于替模型调了一次 `skill_load`）；
  - MCP / 工具类插件：本会话起加入工具表。
- **界面**：提及以标签显示在输入框和用户气泡里（可删除）；候选框键盘上下选、回车确认、Esc 关闭；移动端用底部弹层，并在工具栏放一个 `@` 按钮（触屏不方便打字时也能点）。数据库里的消息保存提及的结构化信息（id + 显示名），导出时还原为 `@名字`。
- **SDK（系统提供，三种来源共用）**：MCP / Skill / 内置插件在注册表里都是 `YayaPlugin`，提及是插件层的统一能力，不按来源各写一套：
  - 契约：`YayaPlugin.mention?: (ctx: { sessionId, toolName? }) => MentionEffect | Promise<MentionEffect>`，
    `MentionEffect = { note?: string; content?: ToolContentPart[]; enable?: 'plugin' | string[] }`，分别是拼进这条用户消息的附注、随消息加载的内容（文本 / 图片，走同一套结果规范化），以及本会话起启用整个插件还是指定工具。
  - 默认实现由来源提供，插件可覆盖：内置插件缺省 `enable: 'plugin'`；Skill 提供方缺省 `content = SKILL.md 正文`（等价一次 `skill_load`）；MCP 提供方缺省 `enable: 'plugin'` + 附注列出可用工具名；显示类插件缺省只给附注（「可以用 xx 代码块」）。
  - 宿主统一执行：候选列表来自注册表（`listPluginInfo` 的插件 + 工具两级，按类型分组：插件 / MCP / Skill），提及解析、`session.meta.mentions` 覆盖、附注与内容的拼接位置（只进新消息，不动前缀）、启用后的工具表追加顺序（稳定、只追加）都在 runner / registry 里做一次。新来源（以后的其它 provider）只要实现 `mention` 或沿用默认就自动可被 `@`。
  - 命令：`yaya.mention-candidates [--query]`（候选，给输入框）与 `yaya.session-mentions --id [--remove]`（查看 / 撤销）。

### 6.4 插件 SDK：插件自己的配置界面 + 子分组（以下几项共同需要）【已完成】

- **配置**：插件声明配置 schema（字段类型、默认值、`secret` 标记），缺省按 schema 自动生成表单；复杂的在 `plugins/<id>/ui.ts` 提供 `settingsView` 组件。值存 `pluginConfig[<插件 id>]`，`secret` 字段与 MCP 请求头同规则（加密落盘、页面只有 `xxxSet`、留空沿用、显式清除）。插件详情页加「配置」入口（窄屏一层层进入）。插件经 `ctx.config` 读取，配置变化触发 `refreshPlugins`。工具表 / instructions 不因配置变化而改变（如 GenericSearch 换引擎不改 `web_search` 的名字与描述）。
- **子分组**：插件可声明分组（id / 名称 / 状态 / 自己的开关与配置），工具挂在分组下；分组不可用时（如 Shizuku 没运行）整组工具不提供并说明原因。MCP 以后也可以按服务器能力分组。

**实际做法（2026-10 落地）**：

- `services/config.ts`：`pluginConfig[pid][key]` 的 secret 值以 `enc:v2:` 密文落盘；load 时凡是 `isEncryptedSecret(v)` 的字符串一律解密（不依赖 schema，插件可能还没加载）；save 时按「哪些 key 是 secret」加密明文。后者由 registry 注入 `setPluginSecretKeysResolver`（config.ts 不能 import registry：registry 要读 `loadYayaConfig`，反向依赖成环），于是 `yaya.config-save` / `provider-fetch-models` / 插件自己改配置等**所有**保存路径都自动加密，不会漏。`publicYayaConfig` 剥掉 secret 值（schema 标 secret 的 + 兜底密文识别）并生成 `pluginSecretsSet`；`mergeIncomingYayaConfig` 里 secret 空串沿用旧值、`pluginClearSecrets`（`<pid>/<key>`）删除、未知插件 / 未知 key 保留在内存配置里；`pluginSecretsSet` / `pluginClearSecrets` 两个仅传输字段不落盘。
- `services/plugins/registry.ts`：`pluginConfigValues`（默认值 + 用户值，数字夹 min/max、select 回落默认、boolean 归一）、`isGroupEnabled`（`pluginGroupEnabled['pid/gid']` ?? `defaultEnabled ?? true`）、`resolveTools` 过滤掉「分组被关 / 分组 status 非 ready」的工具（未知分组 = 无分组）、`runPluginTool` 把 `config: pluginConfigValues(plugin, loadYayaConfig())` 放进 `ToolRunContext`（调用方 runner 不用改）、`listPluginInfo` 填 `groups`（translated label/description/status/available）与 `config`（translated schema、非 secret 值、secretsSet）与 `tool.group`。工具表稳定性写在注释里：工具表只随启用态 / 分组可用性 / disabledTools 变，与配置取值无关。
- 命令：`yaya.plugin-config-get` / `yaya.plugin-config-set --values <JSON> [--clear k,k]`（按 schema 校验、未知 key 拒绝、secret 空串沿用；`logArgs: false` + `privacy: { agent: 'deny' }`）、`yaya.plugin-group-set`。保存后统一 `saveYayaConfig → refreshPlugins → 广播 cockpit:yaya-plugins-changed`。
- 设置页：`PluginDetail.vue` 的「分组」区（名称 / 说明 / 状态点 + 不可用原因 / 开关）与「配置」区；`PluginConfigForm.vue` 按 schema 生成表单（secret 走 `v-agent-forbidden` + 密码框 + 清除，保存按钮 + `SaveStatusText`，容器 <640px 转单列标签在上）；`PluginUi.settingsView` + `plugin-ui-registry.settingsViewFor` 让插件整块替换表单；`PluginToolsList.vue` 按 `tool.group` 分组小标题。
- 测试：`services/plugins/plugin-config.test.ts`（默认值 / 夹取、secret 密文落盘与解密、publicYayaConfig 只给 secretsSet、空串沿用与 clear、分组过滤、ctx.config）。

### 6.5 GenericSearch 插件（多引擎联合搜索，对模型只暴露一个 `web_search`）

- 引擎：Tavily / Bing / Brave / SearXNG / Grok（xAI，带引用的回答引擎）/ Google CSE …，各自密钥与参数在插件配置里（`secret` 加密）。
- 模式：指定单个引擎，或多引擎联合（并发，按 URL 去重合并，多引擎同时命中的排前，标注来源引擎；单个引擎失败不影响整体）。回答引擎归一成「摘要 + 引用列表」。
- 对模型固定 `web_search(query, max_results?)`，引擎选择对模型不可见，工具定义稳定。
- 网络走主进程 `net.fetch`（系统代理）；AIDJ 现有的 Tavily `web_search`（`aidj/agent/web-search.ts`）抽成共用模块，两边复用。

### 6.6 Android Controller 插件（安卓附加能力）

分层（**直接做成插件，不走 MCP**；全程进程内通信，无网络）：
```
Android 层（Java / Kotlin）：能力提供者 —— 应用自身权限 / Shizuku（adb 级）/ Termux:API
   │  经 nodejs-mobile 进程内消息通道的薄 RPC：
   │    describe() → [{ name, description, schema, capability, scopes, deny, group }]
   │    call(name, args) → 结果（文本 / 图片，走插件结果规范化）
   │    状态事件 → 分组可用性（如 Shizuku 未运行、权限被收回）
Node 层：Android Controller —— 普通 YayaPlugin
   start() 调 describe()，把清单映射成 PluginTool：子分组、审批默认值、执行前 guard(scopes)，deny 的函数不提供
   └─ 子分组：自身权限 / Shizuku / Termux:API（各自状态、开关、配置）
```
- **为什么不用 MCP**：MCP 也能走进程内通道，但它的工具定义表达不了能力等级（`exec` / `control`）、隐私 scope、`agent: 'deny'`、子分组这些一等元数据，只能塞自定义注解；直接做插件更轻（不需要 MCP SDK / 握手 / 会话），状态事件也能直接映射到子分组。这些能力只给 YAYA 用且必须受隐私 SDK 约束，MCP 的「通用客户端可用」用不上。
- **两种运行形态**：自有 App（nodejs-mobile，Java 桥）；纯 Termux（调不到 Java，后端换成 `termux-*` 命令 + `rish`，插件接口不变）。按 `process.platform === 'android'` 与探测结果选用。
- **安全**：Shizuku 等于 adb 权限，比桌面 Shell 更危险。每个 Java 函数必须声明能力与 scope，Node 侧照常 guard + 审批；授予权限、改系统设置这类标 `deny`（不提供给 AI，只能用户在界面上做）。Java 侧只接受来自内嵌 Node 的通道消息。
- 依赖 6.4 的子分组与配置界面；先在 Termux 后端验证，再做自有 App。

### 6.3 其它候选
- 第一个能力悬浮窗（如 AIDJ 迷你播放器），验证 Outsider SDK 的能力注入与设置页权限。
- 显示类插件做完后，再看工具结果视图（toolViews）：如 Cockpit 截图对比、快照差异高亮。
