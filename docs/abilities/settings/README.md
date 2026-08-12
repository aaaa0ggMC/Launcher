# 设置 (settings)

Linux System Cockpit 的设置中心：集中管理主题/配色、界面缩放、窗口外观、动画、语言、侧边栏排序、启动确认等全局选项，并承载各能力自己注入的设置项。

## 使用教程

### 打开设置页

- 侧边栏「系统」分组点击 **设置**，或
- 点击顶栏右侧的**齿轮图标**直达

### 页面结构

设置页分两级：

- **顶层**：顶部搜索框 + 一行可横向滚动的分类标签（chips）
- **二级**：当前分类下的所有设置项**内联展开**在一个网格中，无需再点击进入子页面

### 搜索设置

顶部搜索框支持**全文匹配**：可搜索分类名、设置项名称、描述与关键词，匹配到的设置项会按所属分类分组内联展示（顶部显示「N 项设置」）。找不到时提示更换关键词。

### 「外观」分类（设置能力自带）

「外观」分类位于第一个，包含以下设置项：

| 设置项 | 作用 |
| --- | --- |
| **主题** | 多套配色方案 / 跟随系统。点击色块即切换（见下「主题 / 配色」） |
| **界面缩放** | 整体 UI 等比例缩放（0.8–1.8，拖动滑块，松手应用并保存） |
| **窗口** | 无边框、圆角、背景与 Fuse 蒙层等窗口外观 |
| **界面动画** | 现代动效总开关、能力页面切换过渡、主题切换动画 |
| **语言** | 界面语言（中文 / English） |
| **侧边栏** | 侧栏排序规则：字母序 / 使用频次 / 最近使用；清空使用记录 |
| **启动** | 所有应用启动前是否弹确认 |
| **关于** | 版本与技术栈信息 |

#### 主题 / 配色

内置 10 套配色：`dark`（深色，默认）、`pureblack`（纯黑）、`light`（亮色）、`moonlight`（月光，靛蓝）、`forest`（森林，墨绿）、`aurora`（极光，紫罗兰）、`rosy`（玫瑰，暖粉）、`sepia`（羊皮纸，暖色）、`slate`（石板，冷灰）与 `system`（跟随系统亮暗）。点击色块即时切换；配置了未知 id 会自动回落 `dark`，不会弄坏界面。

#### 窗口

- **无边框窗口** / **圆角窗口**：两者均**下次启动生效**
- **圆角半径**：0–40 px（圆角开启时显示）
- **背景**：`透明` / `图片` / `壁纸`；选「图片」时可手填路径或用文件夹按钮选择图片文件（png/jpg/jpeg/webp/bmp/svg/gif/avif）
- **Fuse 蒙层不透明度**（0–1）与 **背景图片不透明度**（0–1）、**背景模糊**（0–60 px）：**即时生效**
- 图层关系：`Background(底) → Fuse(中) → Data(顶)`。Fuse 蒙层 100% 时完全盖住背景；调低 Fuse 可透出背景，图片可见度 = 背景图片不透明度 × (1 − Fuse 蒙层不透明度)

#### 界面动画

- **现代动效**（总开关）：开启后主题切换以波纹效果扩散到全屏、启用页面切换动画；关闭后所有动效关闭、主题即时切换
- **启用切换动画** + **切换样式**：侧栏能力页面之间的过渡效果——`淡入淡出` / `左右滑动` / `上滑` / `缩放` / `翻转`
- **主题切换动画**：新主题的扩散起点——`左上角扩散`（默认）或 `鼠标处扩散`（从当前鼠标位置开始扩散）

#### 语言

中文 / English 单选；切换后需**重载页面**才能生效。

#### 侧边栏排序

- `字母序`（默认）：按分类、名称排序
- `使用频次`：按统计的使用次数降序
- `最近使用`：按最近使用时间降序
- 统计数据存于 `~/.config/LinuxCockpit/apps.csv`（每打开一次侧栏条目或启动一次应用即累加）；点击「清空使用记录」可一键归零，清空后立即生效

#### 启动

「所有启动前都需确认」开关：开启后从应用注册表启动任何条目前都会先弹确认。

### 各能力注入的设置

设置页的每个分类都是各能力通过 `index.ts` 的 `settings` 数组注入的（设置页本身只提供「外观」分类）。目前有：

- **应用**（apps）— **搜索目录**：添加/移除应用注册表的扫描根目录
- **总览**（dashboard）— **总览排版**：重置总览页卡片排版
- **AI DJ**（aidj）— **AI DJ 配置**：API 密钥、模型选择、播放偏好等（存 `~/.config/LinuxCockpit/aidj/config.json`）
- **AIDJ Lyrics**（aidj-lyrics）— **歌词页配置**：卡拉OK 逐字高亮、歌词滚动跟随、字号/行高/字重/位置偏移（存 `~/.config/LinuxCockpit/aidj-lyrics/config.json`）

以上分类的标签按当前界面语言显示，搜索也能命中它们的内容。

## CLI 命令参考

设置能力注册了 5 个命令：

### `config.get`
读取全局配置。

```
config.get
```

返回 `~/.config/LinuxCockpit/config.json` 的完整内容。

### `config.set`
更新全局配置并广播给所有窗口（主题、缩放等即时生效）。

```
config.set --patch {"theme":"pureblack"}
```

`--patch` 为 JSON 对象（整体覆盖顶层字段，请传完整子对象）。写入失败或 patch 不是合法 JSON 时返回错误。

### `stats.record`
记录一次使用（供侧边栏「使用频次 / 最近使用」排序）。

```
stats.record --id apps
```

### `stats.list`
读取使用频次统计（`~/.config/LinuxCockpit/apps.csv`）。

```
stats.list
```

返回 `{ ok, stats }`。

### `stats.clear`
清空全部使用记录（`apps.csv` 归零并广播刷新）。

```
stats.clear
```

## 配置项（config.json）

所有全局配置保存在 **`~/.config/LinuxCockpit/config.json`**（JSON 格式，手改需重启或调 `config.set` 生效）。

```jsonc
{
  "theme": "dark",            // 配色方案 id，见上「主题 / 配色」
  "language": "zh",           // 界面语言: zh | en
  "uiScale": 1.1,             // 界面缩放 (0.8–1.8, 经 webFrame.setZoomFactor 等比缩放)
  "animations": {
    "modernMotion": true,     // 现代动效总开关
    "enabled": true,          // 页面切换动画开关
    "pageTransition": "fade", // fade | slide | slide-up | zoom | flip
    "themeTransition": "corner" // 主题切换扩散起点: corner | cursor
  },
  "window": {
    "width": 1280,            // 初始窗口宽（下次启动生效）
    "height": 800,            // 初始窗口高（下次启动生效）
    "frameless": true,        // 无边框（下次启动生效）
    "rounded": true,          // 圆角（frameless 时生效，下次启动生效）
    "radius": 12,             // 圆角半径 px (0–40)
    "background": "transparent", // transparent | image | wallpaper
    "backgroundImage": "",    // background=image 时的图片路径
    "backgroundOpacity": 1,   // 背景图片不透明度 (0–1)
    "fuseAlpha": 0.85,        // Fuse 蒙层不透明度 (0–1)
    "fuseBlur": 28            // 背景模糊 (px)
  },
  "runtime": {
    "terminal": ["konsole", "--hold", "-e"], // 终端类应用启动命令
    "confirmBeforeLaunch": true              // 启动前确认
  },
  "sidebar": {
    "default": "cli",          // 初始页面（缺失/无效时回落第一个能力）
    "sort": "alpha"            // alpha | frequency | recent
  }
}
```

## 常见问题

**改了某些设置为什么没生效？**

无边框/圆角/窗口尺寸是**下次启动**才生效的窗口属性；背景、Fuse、主题、缩放、动画等**即时生效**。切换语言后需重载页面。

**把 `theme` 写坏了会不会弄坏界面？**

不会。未知/无效的 theme id 一律自动回落 `dark`。

**清空使用记录会删除我的应用吗？**

不会。`apps.csv` 只是「侧栏条目打开次数 + 应用启动次数」的统计，清空只影响「使用频次 / 最近使用」排序。
