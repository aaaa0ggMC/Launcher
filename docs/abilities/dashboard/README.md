# 总览（dashboard）

自定义系统总览页：用 gridstack 网格自由排布主机、处理器、内存、GPU、NVIDIA 电源管理、磁盘与 Docker 容器卡片，实时轮询刷新。布局可持久化、可锁定（以便选中复制文字）。

> **平台**：能力按 `platforms: ['linux']` 声明，仅在 Linux 平台侧栏显示。

## 前置依赖 / 系统工具

| 能力块 | 依赖工具 | 缺失时表现 |
| --- | --- | --- |
| 处理器 / 内存 / 交换 / 磁盘 | 无（`os` / `/proc/meminfo` / `/sys/class/thermal` / `df`） | — |
| GPU 卡片 | `nvidia-smi` | 显示「未检测到 GPU (nvidia-smi 不可用)」 |
| Docker 卡片 | `docker`（守护进程运行中） | 显示「Docker 未运行或无容器」 |
| 包计数（主机卡片） | `pacman` / `flatpak` | 对应计数显示 `—` |
| NVIDIA 电源管理切换 | `pkexec`（polkit） | 切换失败，报错 |

`system.stats` 采集会并发执行 GPU 查询与容器列表；任一项失败只是该卡片为空，不影响整页。

## 使用教程（UI）

侧栏 →「总览」。页面顶部显示主机名、系统与已运行时长，右侧有**锁定**与**刷新**按钮；下方是 12 列网格卡片。

### 卡片布局（gridstack）

默认 7 张卡片，每张默认宽度 6（占半行）：

| 卡片 ID | 标题 | 内容 |
| --- | --- | --- |
| `host` | 主机 | 主机名、系统、架构、用户、桌面环境、Shell、运行时长、pacman/flatpak 包数 |
| `cpu` | 处理器 | 型号、核数、使用率环形图、温度（>60°C 橙 / >80°C 红）、负载（1/5/15m）、频率 |
| `mem` | 内存 | 内存使用率进度条（>70% 橙 / >85% 红）、已用/共、交换分区（无则显示「未启用交换分区」） |
| `gpu` | GPU | 每张显卡：型号、驱动、显存用量与占比、利用率、温度、风扇、功耗/功耗上限 |
| `pm` | NVIDIA 电源管理 | `NVreg_PreserveVideoMemoryAllocations` 当前值与切换按钮 |
| `disk` | 磁盘 | 每个 `/dev/` 分区：挂载点、使用率进度条（>70% 橙 / >85% 红）、已用/共/可用 |
| `docker` | 容器 | 运行/停止/总数统计 + 每个容器的名称与状态 |

- **拖动 / 缩放**：默认解锁状态，可拖动卡片、从边角调整大小。网格 `cellHeight: 48px`（细粒度垂直步进，卡高度可精细调节），水平按 12 列吸附；`float: true`，卡片停在放下位置，容器高度随最低卡片自适应。
- **自动保存**：每次拖动/缩放结束，布局自动经 `dashboard.set-layout` 持久化（见「布局持久化」）。无需手动保存。
- **自动刷新**：页面每 4 秒后台轮询一次（无加载条闪烁）；手动点「刷新」立即重新采集。
- **Markdown 导出**：总览页支持把当前快照导出为 Markdown（主机/CPU/内存/GPU/磁盘/容器），由框架的页面导出入口调用。

### 锁定布局（选中复制）

点锁形按钮锁定布局：`grid.disable()` 关闭拖动与缩放，**这样卡片里的文字可以正常选中并复制**（CSS 选择/复制与拖拽互斥）。锁定状态写入 `~/.config/LinuxCockpit/config.json` 的 `dashboard.locked`，下次进入保持。再点一次解锁恢复拖动。

### 重置排版

在**设置 → 总览 → 总览排版**里点「重置排版」：一键恢复默认卡片位置（`dashboard.reset-layout` 命令），并广播 `cockpit:dashboard-reset`，总览页在活动状态下即时套用默认布局。

### NVIDIA 电源管理切换

pm 卡片显示 `NVreg_PreserveVideoMemoryAllocations` 当前值（`0`/`1`/`—`），按钮显示「已启用/已禁用」。点击弹确认框（会修改 `/etc/modprobe.d/nvidia-pm-override.conf`、自动备份，需要管理员密码，**重启后才生效**），确认后经 `pkexec` 调 `scripts/nvidia-pm-toggle.sh` 翻转 `0↔1`。

## 布局持久化

布局保存在 `~/.config/LinuxCockpit/ui-state.json`：

```jsonc
{
  "dashboardLayout": [
    { "x": 0, "y": 0, "w": 6, "h": 8, "id": "host" }
  ],
  "dashboardLayoutVersion": 2
}
```

- `dashboardLayout`：gridstack 节点数组（`x/y/w/h/id`）。
- `dashboardLayoutVersion`：网格几何版本（当前为 `2`，见 `DASHBOARD_LAYOUT_VERSION`）。**网格尺寸升级时旧布局会作废**，自动回退到默认排版，避免按旧尺度错位渲染。

加载校验（任一不满足即丢弃、回退默认并下次改动时重存）：

1. 版本号必须等于当前 `DASHBOARD_LAYOUT_VERSION`。
2. 每个节点都有合法数字 `x`/`w` 且落在 12 列内（`0 ≤ x && x + w ≤ 12`）。
3. 卡片集合必须恰好是 `{host, cpu, mem, gpu, pm, disk, docker}` —— 卡片增删后旧布局不再适用，会被丢弃重建。

## CLI 命令参考

所有操作都是注册命令，可在内置 CLI REPL（`cli` 能力）中使用：

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `system.stats` | 系统实时状态（host/GPU/docker/RAM/disk） | `system.stats` |
| `hardware.gpu` | GPU 信息（nvidia-smi） | `hardware.gpu` |
| `hardware.pm` | 读取 `NVreg_PreserveVideoMemoryAllocations` 当前值 | `hardware.pm` |
| `hardware.pm-toggle` | 切换 `0↔1`（pkexec，重启生效） | `hardware.pm-toggle` |
| `docker.list` | 列出 Docker 容器（含停止的） | `docker.list` |
| `docker.action` | 启动/停止/重启容器 | `docker.action --name new-api --action start` |
| `dashboard.get-layout` | 读取总览排版 | `dashboard.get-layout` |
| `dashboard.set-layout` | 保存总览排版（`--layout` 必须是数组） | `dashboard.set-layout --layout []` |
| `dashboard.reset-layout` | 重置总览排版为默认（并广播刷新所有窗口） | `dashboard.reset-layout` |

返回值要点：

- `system.stats` → `SystemStats`：`hostname / platform / arch / release / uptime / username / shell / de / packages / loadAvg / cpu{model,cores,usage,temp,freq} / mem{total,used,free,percent} / swap? / disk[] / gpu[] / docker[]`。
- `hardware.gpu` → `GpuInfo[]`（`name / driver / vram / vramUsed / vramPercent / usage / temp / fanSpeed? / power? / powerLimit?`）。`nvidia-smi` 返回 `[N/A]` 的字段（无风扇/无功耗监控的卡）会被规范化成空，UI 直接省略。
- `hardware.pm` → `0 | 1 | null`；`hardware.pm-toggle` 返回切换后的值。
- `docker.list` / `docker.action` → `DockerContainer[]`（`id / name / image / status / state / ports`），`docker.action` 执行后返回最新的容器列表。
- `dashboard.get-layout` → `{ layout, version }`。

## 常见问题 / 已知局限

- **GPU 卡片空**：无 NVIDIA 卡或 `nvidia-smi` 不在 PATH 时，GPU 卡片显示「未检测到 GPU」。仅 NVIDIA 被支持。
- **Docker 卡片空**：`docker` 未安装或守护进程未运行 → 「Docker 未运行或无容器」。
- **切换电源管理需重启**：`NVreg_PreserveVideoMemoryAllocations` 是 modprobe 参数，重启后才生效；切换通过 `pkexec` 弹密码（可安装 `scripts/49-cockpit-pkexec.rules` 免 5 分钟重复认证）。
- **重排后布局失效**：任何会改变网格几何（`cellHeight`）的升级，或卡片集合变化，都会让已存布局被判定失效而重置——这是有意为之，避免错位渲染。
- **CPU 温度**：从 `/sys/class/thermal/thermal_zone*` 读（前 4 个 zone），无需 lm_sensors；读不到时温度显示 `—`。
- **平台限制**：仅 Linux。统计采集（`/proc/meminfo`、`df`、`nvidia-smi`）与 GPU/容器逻辑都假定 Linux；其它平台侧栏自动过滤。
- **poll 静默失败**：4 秒后台轮询失败时保留上一次快照，不弹错；只有手动「刷新」失败才在页面顶部显示错误。
