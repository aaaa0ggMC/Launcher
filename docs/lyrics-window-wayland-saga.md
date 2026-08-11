# 桌面歌词窗口在 Wayland 下的折腾记（踩坑实录）

> AIDJ 桌面歌词浮窗（透明 · 无边框 · 圆角 · 绑定 DBus 播放器）在 KDE Plasma 6 / Wayland 上从零到能用的全过程，以及一个个被 Electron + Wayland 狠狠教育过的坑。留档，避免重踩。

## 背景

Electron 应用的窗口能力在 Wayland 下被严重削弱，因为**合成器（KWin）拥有定位/置顶/输入路由**，客户端协议（xdg-shell）根本不提供这些。

| 能力                  | 原生 Wayland（KDE）                          | X11 / Windows / macOS          |
| --------------------- | -------------------------------------------- | ------------------------------ |
| 窗口定位 `setPosition` | 被合成器忽略 ❌                              | 生效 ✅                        |
| 置顶 `setAlwaysOnTop`  | 被忽略，需 KDE 手动置顶 ❌                   | 生效 ✅                        |
| 鼠标穿透 `setIgnoreMouseEvents` | **no-op**，Electron/Chromium 在 Wayland 未实现 ❌ | 生效 ✅（真 X11 会话） |
| 窗口类型（OSD）       | xdg-shell 无此概念，都是 Normal ❌           | `_NET_WM_WINDOW_TYPE_NOTIFICATION` ✅ |

## 踩坑记录（按时间顺序）

### 1. 定位只能靠 KWin D-Bus scripting

`win.setPosition(x, y)` 在 Wayland 下是摆设。唯一路径是调 KWin 的 scripting D-Bus API：

```
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript <文件路径>
qdbus6 org.kde.KWin /Scripting/Script<id> org.kde.kwin.Script.run
```

### 2. `loadScript` 吃的是「文件路径」，不是脚本内容

把脚本字符串直接传进去 → `Could not open <脚本>`。**先写临时文件，传路径**，跑完删。

### 3. KWin 6 脚本里没有 `Qt`、`move()` 也不是方法

- `w.move(x, y)` → `Property 'move' ... is not a function`（KWin 6 里 `move` 是布尔属性，表示"正在被拖动"）。
- `Qt.rect(...)` → `Qt is not defined`（只有 QML/declarative 脚本才有 `Qt` 全局，`loadScript` 的普通 JS 没有）。

### 4. ⭐ 核心坑：`w.frameGeometry.x = X` 是 NO-OP

QJSEngine 里 `w.frameGeometry` 读取返回的是一个 **JS 副本**，给 `.x` 赋值只改了副本，窗口纹丝不动。**通过探针在活窗口上实测确认**：

```
BEFORE -309.5,25 2112x140        ← 从未被移动过，越扩越偏
AFTER_OBJ 120,120                ← w.frameGeometry = {x,y,width,height}：✅ 绝对定位
AFTER_PROP 120,120               ← w.frameGeometry.x = 400：❌ no-op
AFTER_OBJ2 200,200               ← 整对象赋值：✅
```

**正确写法（唯一可靠）**：
```js
const g = w.frameGeometry;
w.frameGeometry = { x: X, y: Y, width: g.width, height: g.height };
```

此前所有"居中修复"都在空转——因为搬窗根本没生效。这解释了"越漂越右、永远不居中"。

### 5. `getBounds()` 在 Wayland 上滞后

KWin 脚本移动窗口后，Electron 的 `win.getBounds()` / `getPosition()` **不会同步**，仍是旧值。所以：
- 居中计算**绝不能依赖 `getBounds()` 的当前宽高**，要用**目标宽高**（`x = 工作区中心 − 目标宽/2`）。
- 防重守卫要跟**上次请求值**比较，不能跟 `getBounds()` 比。

### 6. KWin 脚本刷屏（113~406 次/时段）

`autoFitWidth` 每次轮询（600ms）都因 `window.innerWidth` 滞后而误判需要 resize → 反复重定位 → KWin 脚本爆炸。修法：`lastFitW` 记录上次目标宽，同一个目标不再重复执行；三处定位路径（center / auto-fit / lock 缩窗）全部加「没变化就跳过」守卫。

### 7. 鼠标穿透：真·无解

- `setIgnoreMouseEvents` 在 Wayland 是 no-op（Chromium 没实现 `wl_surface` 输入区域）。
- XWayland 上 X11 输入形状 → Wayland 输入区域的转换在 KWin 上也不生效。
- 唯一能穿透的 Wayland 方案是 **wlr-layer-shell**（wshowlyrics 用的），Chromium 没实现。
- 结论：锁定只能做到「窗口内部不响应 + 缩窗到贴合内容减少遮挡」，真穿透只在 X11/Windows/macOS。

### 8. `ELECTRON_OZONE_PLATFORM_HINT` 在 Electron 38 被移除

想用 `ELECTRON_OZONE_PLATFORM_HINT=x11` 强制 XWayland → **无效**（Electron 38 起移除），需 `--ozone-platform=x11` 命令行开关。但 XWayland 路线也不通：
- 硬件加速下 GPU 进程段错误（`exit_code=139`）。
- 禁用硬件加速后，透明窗口走 `x11_software_bitmap_presenter` 又无法呈现（`XGetWindowAttributes failed`）。
- **XWayland 彻底放弃**。

## 现状（可用的部分）

- **定位/居中**：主进程用目标宽高算绝对中心 → KWin 整对象赋值搬窗 → 可用。
- **锁定**：内部不响应 + 缩窗；穿透在 Wayland 不可用（README「已知局限」有表）。
- **置顶**：KDE 手动（应用无法强制）。
- X11 / Windows / macOS：全部能力正常（穿透/置顶/定位）。

## 给未来自己的提醒

1. 写 KWin 脚本先 `qdbus6 ... loadScript` 在活窗口上探针验证，别假设。
2. Wayland 下别信 `getBounds()` / `getPosition()` / `window.innerWidth` / `window.screen`——都可能是旧的。
3. 定位用「目标尺寸算绝对中心」，防重跟「上次请求」比。
4. 凡是 Electron + Wayland 的窗口能力问题，先查 Chromium 是否实现，再考虑绕法。
