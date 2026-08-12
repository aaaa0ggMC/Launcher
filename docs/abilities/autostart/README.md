# 启动项（autostart）

管理 `~/.config/autostart` 目录中的开机自启动项：查看、启用、禁用。

## 前置依赖

- XDG 自启动规范支持的桌面环境（KDE Plasma / GNOME 等），目录 `~/.config/autostart`
- 需要至少有一个 `.desktop` 文件（可由应用安装、或桌面环境「系统设置 → 开机和关机 → 自启动」添加）

## 使用教程（UI）

侧栏 →「系统」→「启动项」。页面以卡片形式展示每个自启动项：

- **图标与状态**：启用项为火箭图标（`mdi-rocket-launch`，绿色）；禁用项为夜晚图标（`mdi-weather-night`，卡片半透明）。
- **名称**：来自 `.desktop` 文件的 `Name` 字段；缺省时用文件名（去 `.desktop` 后缀）。
- **执行命令**：`Exec` 字段，截断显示。
- **文件名**：对应的 `.desktop` 文件名。
- **开关**：卡片右侧开关切换启用/禁用。

列表按名称（中文排序规则）排列。没有自启动项时显示空状态提示：「`~/.config/autostart` 中没有 `.desktop` 文件。」

### 添加 / 删除

本能力**不提供添加与删除**——只管理已有条目的启用状态：

- **添加**：把某个应用的 `.desktop` 文件放到 `~/.config/autostart/` 即可（KDE 系统设置的「自启动」面板本质也是往这个目录写文件）。
- **删除**：直接删除对应的 `.desktop` 文件。

## CLI 命令参考

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `autostart.list` | 列出开机自启动项 | `autostart.list` |
| `autostart.toggle` | 启用/禁用启动项（需要 `--file` 和 `--hidden`） | `autostart.toggle --file "Clash Verge.desktop" --hidden true` |

返回 `AutostartEntry[]`：

```jsonc
{ "file": "Clash Verge.desktop", "name": "Clash Verge", "exec": "...", "comment": "...", "hidden": false }
```

## 启用/禁用原理

启用/禁用通过翻转 `.desktop` 文件 `[Desktop Entry]` 组里的 `Hidden` 字段实现（不真正删除文件）：

- 禁用 → 写入 `Hidden=true`
- 启用 → 删除 `Hidden` 字段

写入是原样序列化到原文件的（覆盖写）。

## 常见问题 / 已知局限

- **文件被重写**：toggle 时会按解析后的键值对重新序列化整个 `.desktop` 文件——注释行和空行会被丢弃，键的顺序会被重排。如果你手工编辑过该文件且依赖其中的注释，请注意这一点。
- **只识别 `.desktop` 文件**：目录中的其它文件会被忽略（仅列表计数）。
- **无添加/删除**：如上述，请用 KDE 系统设置或手工操作文件。
- **能力依赖**：`platforms: ['linux']`，仅 Linux 侧栏显示。
