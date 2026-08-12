# 显示（display）

纯后端能力：提供屏幕显示相关的操作命令——**壁纸管理与显示输出查询**。它没有 UI 页面、不进侧栏，通过注册命令（CLI / 其它能力 / 脚本）使用。

## 能力定位

- `display` 是**纯后端能力**（`index.ts` 无 `component`），不会出现在侧栏。
- 它通过主进程加载器注册 `display.*` 命令，供 CLI REPL、其它能力或脚本调用；渲染端也有对应的 preload 包装（`window.cockpit.wallpapers` / `applyWallpaper` / `outputs`）。
- 当前实现面向 **KDE Plasma**；换到其它桌面环境/系统时，只需改写本能力的 `service.ts`，命令接口不变（见仓库 README「平台适配」）。

## 前置依赖（系统工具）

| 工具 | 用途 | 缺失时行为 |
| --- | --- | --- |
| `plasma-apply-wallpaperimage` | 应用壁纸 | `display.apply` 返回 `{ ok: false }` |
| `kscreen-doctor` | 查询显示输出 | `display.outputs` 返回空列表 |

均为 KDE Plasma 自带工具；缺失不影响其它能力。

## 提供的能力 / 命令参考

### 列出壁纸 —— `display.wallpapers`

列出指定目录下的图片文件（仅扩展名匹配：`.png` / `.jpg` / `.jpeg` / `.webp` / `.bmp` / `.gif`），按名称排序。

```bash
display.wallpapers --dir ~/Pictures/Wallpapers
```

返回 `WallpaperFile[]`：

```jsonc
[{ "name": "mountains.jpg", "path": "/home/you/Pictures/Wallpapers/mountains.jpg" }]
```

目录不存在或不可读时返回空数组。

### 应用壁纸 —— `display.apply`

把一张图片设为桌面壁纸（调用 `plasma-apply-wallpaperimage <path>`）。需要 `--path`，必须为绝对路径。

```bash
display.apply --path /abs/to/wallpaper.jpg
```

返回 `{ ok: boolean }`。缺失 `--path` 时返回错误「需要 --path」。

### 列出显示输出 —— `display.outputs`

查询当前显示器连接与启用状态（解析 `kscreen-doctor -o` 的输出中 `Output: <n> <name> (enabled|disabled)` 行）。

```bash
display.outputs
```

返回 `DisplayOutput[]`：

```jsonc
[{ "name": "eDP-1", "description": "eDP-1", "connected": true, "enabled": true }]
```

解析不到的行会被跳过；工具缺失时返回空数组。

### 渲染端 preload 包装

```ts
await window.cockpit.wallpapers('/abs/dir')          // 同 display.wallpapers
await window.cockpit.applyWallpaper('/abs/file.jpg') // 同 display.apply，返回 boolean
await window.cockpit.outputs()                       // 同 display.outputs
```

## 如何被其它能力使用

作为后端基础设施，`display.*` 命令可被任意场景复用，常见用法：

- **壁纸轮换 / 随机壁纸**：用 `display.wallpapers --dir <目录>` 拿到候选列表，再 `display.apply --path <选中项>` 切壁纸。
- **壁纸背景**：应用外壳的 `window.background = "wallpaper"` 背景类型读取 KDE 壁纸配置展示（由独立的 `background/wallpaper` 能力负责读取）。
- **多屏信息**：`display.outputs` 返回各输出口的启用状态，可用于设置页/诊断脚本判断当前显示拓扑。

## 安全说明

`display` 的当前命令**不需要提权**（壁纸与输出查询都以当前用户权限执行）。这与 `mirror` 等需要 `pkexec` 的能力不同。

## 常见问题 / 已知局限

- **强绑定 KDE Plasma**：壁纸工具与输出解析都依赖 KDE；在其它桌面（GNOME / sway 等）命令会失败或返回空。适配其它平台需要改写 `service.ts`。
- **壁纸应用无回显**：`applyWallpaper` 只按子进程输出中是否含 `error` 判断成败，无法给出更细的错误原因。
- **输出解析宽松**：`display.outputs` 只识别 `Output: N <name> (enabled|disabled)` 模式，`kscreen-doctor` 的详细几何/分辨率信息不解析。
- **无 UI 页面**：所有操作需通过 CLI 或编程方式调用，侧栏不会出现「显示」条目。
