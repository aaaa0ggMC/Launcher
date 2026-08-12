# 服务（systemd）

管理你的 systemd **用户服务**（`systemctl --user`）：查看状态、启动、停止、重启。

## 前置依赖

- **systemd**（命令 `systemctl`）
- **systemd 用户实例**可用（多数桌面发行版默认启用 `user@.service`，登录后自动运行）

> 本能力面向**用户服务**，不管理系统级（`systemctl`）服务——除非 Cockpit 本身以 root 运行，此时才会退回到系统级服务列表。

## 使用教程（UI）

侧栏 →「系统」→「服务」。页面展示用户服务的列表：

- **状态图标与颜色**：每行左侧图标 —— 绿色播放键（`active`）、红色警告键（`failed`）、灰色停止键（未激活）。
- **状态徽标**：每行标题右侧的徽标显示 `active / sub`（如 `active / running`）。
- **操作按钮**（每行右侧）：
  - **重启**：仅对运行中的服务可用。
  - **停止**：仅对运行中的服务可用（红色）。
  - **启动**：仅对未运行的服务可用（绿色）。
- **搜索过滤**：顶部搜索框按名称/描述做加权匹配（名称权重更高），输入即过滤。
- **显示全部**：默认只显示运行中的服务；勾选「显示全部（含未激活）」可查看所有服务（含 inactive / failed）。
- **刷新**：右上角「刷新」按钮重新拉取列表。每次操作后列表也会自动刷新。

页面副标题为「用户服务 (systemctl --user)」。

## CLI 命令参考

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `systemd.list` | 列出用户 systemd 服务 | `systemd.list` |
| `systemd.action` | 启动/停止/重启服务（需要 `--name` 和 `--action`） | `systemd.action --name myservice --action restart` |

`--action` 取值为 `start` / `stop` / `restart`。返回 `SystemdUnit[]`：

```jsonc
{ "name": "myservice.service", "loaded": true, "active": "active", "sub": "running", "description": "My service" }
```

## 常见问题 / 已知局限

- **操作失败**：`systemctl` 执行失败时错误会直接抛出（如服务不存在、依赖问题），页面显示错误提示。
- **只显示 service 类型**：列表只过滤 `--type=service`，timer / socket / target 等单元不在其中。
- **权限**：用户服务无需提权；但仅能操作当前用户的单元，无法启停系统级服务或其它用户的服务。
- **能力依赖**：`platforms: ['linux']`，仅 Linux 侧栏显示。
