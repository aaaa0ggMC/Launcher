# apps.json 格式

> 最后更新：2026-10-01

每个搜索根目录下放一份 `apps.json`，它就是该目录的应用注册表。你可以完全用手工编辑的方式维护它——
扫描器（`apps.rescan`）的策略是**只补充、不覆盖**：已有你写的内容绝不改动，只在字段空缺时补草稿。
手工改完保存即生效（目录被监视，页面会即时刷新）。

## 文件长什么样

```jsonc
{
  "version": 1,
  "apps": {
    "bili-viewer": {
      // 名称 / 描述 / 别名可以是字符串，也可以是 { "zh": ..., "en_US": ... } 对象
      "name": { "zh": "哔哩观看器", "en_US": "Bili Viewer" },
      "alias": "bili",
      "description": "B 站缓存视频播放器",
      "path": "bili-viewer", // 相对根目录的目录/脚本，或绝对路径
      "icon": "default/television", // default/<名字>[/padding] · emoji/😎 · file//绝对路径
      "exec": {
        "type": "uv",
        "command": ["bili-viewer"], // 入口，如 ["app.js"] / ["bili-viewer"]
        "cwd": "{self}", // {self}=条目自身目录；留空默认也是条目目录
        "terminal": true // 终端中运行
      },
      "actions": {
        // 附加操作：卡片上「启动」旁边的一个个按钮
        "stop": {
          "name": "停止",
          "icon": "default/pause",
          "exec": { "type": "systemd", "command": ["stop", "bili.service"] },
          "risk": "low"
        }
      },
      "tags": ["python", "下载"], // 手工标签
      "security": {
        "risk": "medium", // low / medium / high，决定按钮颜色与是否弹确认
        "auto_note": "脚本内包含 sudo 提权操作", // 扫描器自动生成，别手改
        "note": "需要读写 ~/Downloads", // 手工备注，确认框里显示
        "acknowledged": true // 已确认过，以后不再弹
      },
      "managed": false // false = 手工条目，重扫完全不动
    }
  }
}
```

## 字段速查

| 字段                 | 类型 / 取值                                          | 说明                                                       |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `name`               | 字符串 或 `{zh, en_US}` 对象                         | 卡片标题；搜索权重最高                                     |
| `description`        | 字符串 或 对象                                       | 卡片描述；没有时卡片显示 `path`                            |
| `alias`              | 字符串 或 对象                                       | 别名：CLI 快捷名与侧栏搜索关键词                           |
| `path`               | 相对路径 或 绝对路径                                 | 项目目录 / 脚本文件；决定默认工作目录                      |
| `icon`               | `default/名字[/padding]` · `emoji/😎` · `file//路径` | 留空或 `auto` = 默认图标                                   |
| `exec`               | 对象                                                 | 主启动操作 = 卡片上的 **启动** 按钮                        |
| `actions`            | `{ 操作ID: { name, exec, ... } }`                    | 附加操作 = 卡片上的其他按钮                                |
| `tags` / `tags_auto` | 字符串数组                                           | 手工标签 / 扫描自动标签（python、node、script…），合并展示 |
| `security`           | `{ risk, auto_note?, note?, acknowledged? }`         | 风险等级与备注                                             |
| `managed`            | `false` 或缺席                                       | `false` = 手工条目，重扫完全不碰                           |
| `transformer`        | JS 源码字符串                                        | 实时输出解析器，配 `transformer_display` 才弹窗            |
| `missing`            | `true`                                               | 运行时字段：扫描不到源文件；勾「显示缺失条目」才显示       |
| `root`               | 字符串                                               | 运行时字段：该条目所属搜索根目录                           |

## 多语言写法

`name` / `description` / `alias` 支持对象格式，界面按当前语言取文案：

```jsonc
"name": { "zh": "哔哩观看器", "en_US": "Bili Viewer" },
"description": { "zh": "B 站缓存播放器", "en_US": "Local bilibili cache player" }
```

回退链：**当前语言 → `en_US` → 第一个可用值 → 原始值**，所以只写一种语言也不会白屏。
界面上编辑这些字段的位置：**添加应用** / **编辑** 弹窗底部展开的「多语言 / Multi-language」区域，
按语言逐个填名称与描述。操作按钮（`actions`）的 `name` / `description` 同样支持对象格式。

## 执行类型（exec.type）

界面下拉框里的八种类型，各自展开成的真实命令：

| type      | 实际执行                                                           |
| --------- | ------------------------------------------------------------------ |
| `uv`      | `uv run --directory <工作目录> <command>`                          |
| `python`  | `<工作目录>/.venv/bin/python`（存在时，否则 `python3`）`<command>` |
| `node`    | `node <command>`                                                   |
| `docker`  | `docker <command>`                                                 |
| `systemd` | `systemctl [--user] <command>`（勾了 root 才去掉 `--user`）        |
| `script`  | `bash <脚本路径>`（没有 +x 权限也能跑）                            |
| `desktop` | `gio launch <desktop 文件>`                                        |
| `custom`  | 直接执行 `<command>`                                               |

`exec` 的其余字段：`cwd`（`{self}` / `~` 开头 / 绝对 / 相对条目目录，留空 = 条目目录）、
`terminal`（终端运行）、`background`（后台任务，优先级高于 terminal）、`root`（pkexec 提权）、
`env`（额外环境变量）、`args`（附加参数）。

## 手工维护原则

- **手工编辑优先**：`apps.json` 里已存在的字段，扫描一概不动；只在新条目、空缺字段、
  `tags_auto` 和 `security.auto_note` 上补内容。
- **`managed: false`**：整条交给你维护，重扫时**完全跳过**（连缺失标记都不加）。
- **检测不到的条目**：注册表里有、目录里没有的会被标上 `missing`（默认隐藏，卡片半透明），
  把文件放回去或改掉 `path` 即可恢复。
- **`security.auto_note` 是扫描器生成的**，手改会在下次重扫时被覆盖；要写说明请用 `note`。
- **删除即永久**：从文件里删掉整个 id 就等于删除应用，没有回收站。

## 自动扫描与风险评估

`apps.rescan --root <目录>` 只扫根目录下一层，按下面的规则猜草稿：

| 目录内容          | 草稿                                               |
| ----------------- | -------------------------------------------------- |
| `pyproject.toml`  | uv 工具（取 `[project.scripts]` 首个命令，开终端） |
| `package.json`    | node 应用（`main` 或 `app.js`）                    |
| `.venv/`          | `python main.py`                                   |
| `Dockerfile`      | `docker compose up -d`                             |
| 其它目录          | `xdg-open .`（中风险）                             |
| 脚本 / 可执行文件 | `bash` 运行（无执行权限时标 `managed: false`）     |

同时扫描器会读 `.sh/.py/.js` 等文本内容做**风险评估**：`curl | sh` / `wget | sh` 下载、`sudo` /
`pkexec` 提权、`chmod`/`chown` 权限变更、`/etc/` 与 `rm -rf` 系统级修改、网络连接（curl/wget/nc/ssh）、
疑似凭据（.env / api_key / token / secret）,综合出 `low` / `medium` / `high` 与 `auto_note`。
风险评估只影响**按钮颜色和是否弹确认**，不阻止你启动。

## 下一步

- 返回 [应用](../main.md)。
- 后台任务、root 提权、实时输出窗口见 [后台任务与实时输出](../高级/后台任务与实时输出.md)。
