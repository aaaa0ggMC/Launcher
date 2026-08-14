# TESTING — 近期改动回归清单

> 用于回归近期对 AIDJ / 后台任务 / 日志视图的改动。逐项测试，勾选确认。
> 提交前建议把本文件列出的「关键」项跑一遍。

## 0. 测试环境

- 开发模式 `pnpm dev`
- 后台任务面板（侧栏徽标 / `background.list`）打开方式：运行中的任务 → 全局面板
- AIDJ 持久会话：`aidj.start-persistent --prompt <text>` 或界面「持续模式」

---

## 1. aidj.chat 不再忽略用户（关键，待测）

> 曾修：PHASE 自主指令会压过用户消息；末尾 `/discard_follows` 不被识别。

### 1.1 末尾命令被识别

**步骤**：在持续会话发：
```
从C418的the weirdest xxx 开始，语种多样化好吧 /discard_follows
```
**预期**：
- `/discard_follows` 生效（待播队列被丢弃）
- 剩余文本「从C418的…语种多样化」作为新指令注入，**不是**原样塞给 AI
- AI 立即开始重新生成（无需等队列降到 8 首以下）

### 1.2 用户消息是最高优先级

**步骤**：等 AI 自主播放几轮（fetchCount ≥ 2）后，发一条明确方向的消息（可带 `/discard_follows`）：
```
接下来多放点安静的中文民谣 /discard_follows
```
**预期**：下一批歌单明显贴合新方向，**不再**被「AUTONOMOUS RADIO FLOW · ignore the positive part of the initial prompt」压过（日志应出现 `### USER DIRECTED REQUEST`）。

### 1.3 不提前清空播放列表

**步骤**：队列排满时发 `xxx /discard_follows`，观察 AI 生成期间（可能 30~100s）：
**预期**：当前曲**继续播放**、后续旧队列**不消失**；直到新歌单生成后才整体替换（保留当前播放的那首）。
**反例**：AI 还在思考时列表就被清空 → 失败。

### 1.4 单独命令

**步骤**：发 `/discard_follows`（无正文）
**预期**：只丢弃、不注入消息；日志 `effect: "discard_follows"`。

### 1.5 普通消息（无命令）

**步骤**：发 `来点爵士`（不带命令）
**预期**：作为普通消息注入（`effect: "injected"`），**不**强制立即重取；队列仍满时等自然耗尽。

---

## 2. Intro 语言跟随用户（关键）

**步骤**：中文初始提示启动持久会话，连续播放 10+ 轮后观察 intro。
**预期**：intro 全程中文/用户所用语言，**后期不再漂移成英文**。
**检查**：日志中 `Language: Write the Intro in the language of the user's original request` 的行存在。

---

## 3. 配置保存不再 ENOENT

**步骤**：设置页（AIDJ）快速连续改动多个字段（如 status_bar、extra_rules、音量曲线），再刷新页面确认值生效。
**预期**：日志无 `saveAidjConfig failed ENOENT`；`~/.config/LinuxCockpit/aidj/config.json` 内容为最后一次保存的值（不丢）。

---

## 4. 封面请求去重

**步骤**：打开持续会话/连续播放视图，停留几分钟观察日志。
**预期**：同一 mp3 的 `aidj.get-cover` 每会话只请求一次（模块级缓存），不再每秒刷屏 `*35~*56`。

---

## 5. 主题切换无弃用警告

**步骤**：设置 → 外观切换主题（dark/light/pureblack…）。
**预期**：渲染端日志无 `[Vuetify UPGRADE] 'theme.global.name.value = ...' is deprecated`。

---

## 6. 滚动与进度条

### 6.1 日志视图（logview）

- 打开任务控制台 → **自动滚到底**（之前停在顶部）
- 滚到顶触发「显示更多消息」后再回到底部正常
- 新日志：在底部时自动跟随；往上滚后停止跟随

### 6.2 aidj.chat / 主界面 AIDJ

- 打开即显示最新消息（滚到底）
- 长历史打开不再等平滑滚动动画（`scroll-behavior` 已改 `auto`）

### 6.3 进度条

- job 任务进度条在**控制台底部**（而非头部）
- 新行到达、在底部时进度条保持可见；上滚后不强制跟随

---

## 7. ANSI 着色

**步骤**：运行输出带 ANSI 颜色的任务（如 aidj 日志 `[1;34mINF:[0m`），查看 logview 与 Transformer 原始输出。
**预期**：颜色正常渲染、控制码不显示为乱码文本。

---

## 8. volbal（可选，验证与 Python 一致）

**步骤**：同曲库选曲，对比 Node 与 `~/Projs/AIDJ` 的 LUFS 识别。
**预期**：LUFS 一致（偏差 < 0.1dB，此前 20 首实测最大 0.08）。当前 `lufs` 模式下音量补偿应与 Python 逐首相同；`linear`（RMS 回退）模式才有已知的 ffmpeg mean_volume 偏差（个别文件 ~0.9dB）。

---

## 快速回归命令

```bash
pnpm typecheck && pnpm lint   # 0 errors
```

---

## 9. 内置播放器（web 模式）

> 前置：设置里把播放后端切到「内置播放器」（`aidj.player-mode --set web`），侧栏应出现「播放器」页。

### 9.1 基础播放与声音（关键）

- 播放一首歌：**有声音**（曾因 `cockpit-audio://` 无 CORS 头 / 元素缺 `crossOrigin` 而静音，已修：协议带 `Access-Control-Allow-Origin: *` + scheme `corsEnabled` + 元素 `crossOrigin='anonymous'`）
- 长时间暂停后点播放 → 立即出声（AudioContext 挂起时自动 `resume()`）
- 切歌（手动 next / 自动 ended）进度正常、无卡顿

### 9.2 倍速

- 预设按钮 + 自定义输入框均生效
- **≤16x**：出声变速；**>16x（如 100）**：静音快进，到末尾自动切下一首继续快进
- 倍速值持久化（重启保留）

### 9.3 EQ 曲线库（eq.jsonl）

- 播放器页 EQ 子菜单：列表显示各曲线小图 + 名字；点行应用生效
- ✎ 打开编辑器：**能正确加载对应曲线**（曾因弹窗复用组件不重置而加载失败，已修）；拖动控制点实时出声预览；整体偏移 slider 直接平移所有频段
- 取消 → 恢复编辑前曲线；保存 → 落盘 `eq.jsonl` 并应用
- 内置预设可编辑不可删；🗑 只对用户自定义显示
- 设置页「EQ 最大范围」改动后编辑器 Y 轴 / 滑块 / 保存 clamp 跟随

### 9.4 淡入淡出 / AB 循环 / 睡眠定时

- 开淡入淡出后自动切歌有淡出/淡入；手动切歌即时（不等待淡入淡出）
- AB 循环：A/B 打点后区间循环，再次点击清除
- 睡眠定时到点自动暂停

### 9.5 局域网遥控

- 播放器页菜单 → 局域网遥控启动 → 显示 `http://<IP>:<端口>`
- 同局域网手机浏览器打开：能看到当前歌 / 封面 / 进度，能控制播放
- 端口可在设置改；后台面板能停止该任务

### 9.6 状态栏 / 其他

- web 模式下主界面状态栏**不再显示 Volbal**（内置播放器自己管理，避免假开关）
- 侧栏「播放器」页只在 web 模式显示；切回 dbus 模式自动隐藏

## 未决 / 后续

- [ ] 1.1–1.3（aidj.chat 用户指令）——用户尚未实测
- [ ] 8（volbal 与 Python 一致性）——已静态验证，实播可再确认
- [ ] 9.5（局域网遥控手机实测）——局域网真实设备尚未验证
