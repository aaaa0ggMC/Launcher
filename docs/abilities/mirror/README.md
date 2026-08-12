# 软件源（mirror）

管理 Arch Linux 的 pacman 镜像源：查看当前启用的源、逐个启用/禁用、一键测速。

## 前置依赖

- **Arch Linux**（能力按 `platforms: ['linux']` 声明，仅 Linux 侧栏显示）
- **pacman**（镜像源对应 `/etc/pacman.d/mirrorlist`）
- **pkexec**（polkit）—— 切换镜像源需要 root 权限，缺失时启用/禁用功能不可用

## 使用教程（UI）

侧栏 →「系统」→「软件源」。页面以卡片形式展示每个镜像源：

- **启用状态**：卡片左侧图标区分 —— `✓`（已启用，绿色）或地球划叉（已禁用）。已启用的卡片带绿色描边。
- **URL**：镜像源地址（截断显示，悬停可看完整）。
- **开关**：卡片底部的开关即启用/禁用该镜像源。点击后会弹出 pkexec 认证框（见「安全说明」），完成后列表自动刷新。
- **测速**：页面右上角「测速」按钮。对所有镜像源并发测试，每张卡片显示延迟（ms）与下载速度（MB/s / KB/s / B/s）：
  - 延迟 < 300ms → 绿色；300–800ms → 橙色；> 800ms → 红色；失败显示「超时」或错误信息。
- **排序**：启用中的镜像源排前面；测速完成后，启用的源按延迟从低到高排序。

页面顶部副标题显示「Arch Linux 镜像源 · 已启用 N 个」。

## 镜像源列表的数据来源

列表 = `/etc/pacman.d/mirrorlist` 中的条目 **+ 配置文件中的补充条目**（来自 `~/.config/LinuxCockpit/mirror/config.json`，结构为 `{ "mirrors": [{ "name": ..., "url": ... }] }`）。配置文件中尚未写入 mirrorlist 的镜像会以**禁用**状态补充进列表——这样可以先测速、后启用，而不必手工编辑配置文件。

### `[MIRROR]` 格式

Cockpit 在 mirrorlist 中使用自定义的 `[MIRROR]` 标记管理每个镜像源：

```
# [MIRROR] USTC
Server = https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch

# [MIRROR] TUNA
# Server = https://mirrors.tuna.tsinghua.edu.cn/archlinux/$repo/os/$arch
```

- `Server =` 开头 = 启用
- `# Server =` 开头 = 禁用
- pacman 天然支持多源同时启用

### 旧格式自动迁移

如果你的 mirrorlist 还是旧的裸 `Server =` 行格式（没有 `[MIRROR]` 标记），第一次读取时会自动迁移解析：按 URL 的域名推断镜像名（首字母大写，如 `mirrors.ustc.edu.cn` → `USTC`）。**迁移只影响读取展示，不主动改写文件**——toggle 时才真正写入新格式。

## 安全说明

### 提权如何工作

切换镜像源必须写 `/etc/pacman.d/mirrorlist`（root 所有），流程为：

1. 主进程把新内容写到系统临时目录的临时文件（`cockpit-mirror-*`）。
2. 用 `pkexec` 调用 helper 脚本 `scripts/write-mirrorlist.sh <临时文件>`，以 root 执行。
3. 脚本先备份原文件到 `/etc/pacman.d/mirrorlist.cockpit.bak`，然后用 `mv` 原子替换（`mv` 在同文件系统上是原子操作：要么整体替换成功，要么原文件完全不受影响）。

### 免重复输密码（polkit 规则）

默认情况下每次 toggle 都要输一次密码。安装 polkit 规则可让 `wheel` 组用户在 5 分钟内免重复认证（对 Cockpit 的 helper 脚本生效）：

```bash
sudo cp scripts/49-cockpit-pkexec.rules /usr/share/polkit-1/rules.d/
sudo chmod 644 /usr/share/polkit-1/rules.d/49-cockpit-pkexec.rules
```

该规则只对 `write-mirrorlist` / `nvidia-pm-toggle` / `run-as-root` 这三个脚本匹配，不影响其它提权操作。不安装也完全可用，只是每次弹密码。

### toggle 的原子性保证

- toggle **只翻转目标 Server 行的 `# ` 注释前缀**，其余行原样保留。
- 文件**绝不原地修改**：先写临时文件，再由脚本 `mv` 原子换入。
- 解析失败 / 找不到目标镜像 / pkexec 被拒绝 / 任何错误 → 原文件保持原样，不受影响。
- 所有读写操作通过 Promise 链串行化，快速连点不会产生 IO 竞态，读取也永远不会看到写了一半的文件。

## CLI 命令参考

所有操作都是注册命令，可在内置 CLI REPL（`cli` 能力）中使用：

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `mirror.get` | 当前镜像源列表与状态 | `mirror.get` |
| `mirror.toggle` | 启用/禁用镜像源（需要 `--name` 和 `--enable`） | `mirror.toggle --name USTC --enable true` |
| `mirror.test` | 测试所有镜像源连通性与速度 | `mirror.test` |

返回值说明：

- `mirror.get` / `mirror.toggle` → `{ mirrors: [{ name, url, enabled }], lastError? }`，`lastError` 存在时表示最近一次操作失败。
- `mirror.test` → `[{ name, url, ok, latency?, speed?, error? }]` 数组。

## 常见问题 / 已知局限

- **测速会下载数据**：测速会真实下载每个镜像上约 512KB 的文件（`$repo` 替换为 `core`，`$arch` 按当前架构替换为 `x86_64` / `aarch64`），10 秒超时。镜像多时耗时会较长。
- **找不到镜像**：toggle 一个既不在 mirrorlist、也不在配置文件的名称时，返回错误「未找到镜像源」。
- **`[MIRROR]` 标记缺失的 Server 行**：toggle 一个标记后没有 Server 行的镜像时返回错误「镜像源 X 的 Server 行缺失」。
- **pkexec 失败**：认证被取消/拒绝时，开关不生效，页面顶部显示错误 `pkexec 失败: ...`。
- **无法添加/删除镜像**：本能力只管理启用/禁用；新增镜像源请手工编辑 `/etc/pacman.d/mirrorlist`，或写入 `~/.config/LinuxCockpit/mirror/config.json`（会自动以禁用状态出现在列表）。
- 能力只在 Linux 平台显示；其它平台侧栏自动过滤。
