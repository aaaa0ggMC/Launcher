# Android 客户端 v0.9：反向代理认证与会话过期重认证

版本号 `0.9.0`，versionCode 为 `11`（上一版 0.8.2 / 10）。网页界面来自宿主，界面更新需要同时更新宿主；APK 更新提供原生侧体验改进。

## 场景

无头宿主挂在反向代理（Caddy 之类）后面，两种认证形态都要在 App 内闭环：

- **A · 首次连接**：代理层的 401（`basic_auth`）与跳转登录（`forward_auth`）。
- **B · 会话中途过期**：用户实测 Caddy 会话约半天到一天过期。过期后页面里的 `/api` 调用拿 401、SSE 也被挡在门外，必须触发一次「跳转认证」重新登录，而不是界面坏掉或永远重连失败。

## 原生侧（android/）

- **代理凭据存储**（`ProxyCreds.java`）：SharedPreferences 里一个 JSON blob（key `proxy_creds`），按 `host:port` 存代理用户名 / 密码。与 token 一样是**应用私有明文存储**（没有 EncryptedSharedPreferences，因为那要 AndroidX / Play 服务，本项目保持零依赖）——能读到这个文件的人本来也能读到 token。可覆盖（同一 host 再存一次）、可清除（用户名空即删）。密码不进任何日志。
- **`Client.onReceivedHttpAuthRequest`**：该 host 有凭据 → 直接 `handler.proceed(u, p)`（`autoAuthTries` 上限 2 次：被拒就改弹窗问用户，否则一条错误凭据会让 WebView 无限重试）；没有 → 原生对话框（用户名 / 密码 / 取消，标题带 host 与 realm）→ proceed + 存盘；取消 → `handler.cancel()` + `showConnect(err_proxy_cancelled)`。`authShowing` 防重入（同一挑战可能来多次，不叠对话框）；回连接页 / 重新认证时会撤掉开着的对话框，不让它留在新页面上面。
- **`probe()` 改造**：`setInstanceFollowRedirects(false)`，3xx 自己判断——同 host 手动跟随（≤5 跳防环），跳到别的 host → 新错误 `err_proxy_login`「代理要求先登录（跳转到 <host>）」，**绝不误报成功**（旧实现会被 302 跟到登录门户拿到 200）。401 带 `www-authenticate` → `err_proxy_auth`（提示检查代理用户名/密码，不是 cockpit token）；401 不带 → 保持原 `err_token` 语义。该 host 存过凭据时带 preemptive Basic；此时 Basic 占掉 `Authorization` 头，token 改走 `?token=` query（宿主两种都认，见 `server.ts` 的 `authorized`）。
- **`shouldOverrideUrlLoading` + 「代理流程中」**：服务器重定向（`req.isRedirect()`，API 24+，minSdk 26 可用）即使目标非宿主 origin 也留在 WebView；再加 `proxyFlow` 状态位（重定向离开宿主 origin 时置位、`onPageFinished` 回到宿主 origin 时清除），流程中页面脚本发起的导航也留在 App 内（覆盖 forward_auth 门户 `location.replace` 回跳）。用户点击（非重定向、非流程中）的站外链接仍 `openExternal`。取舍写在代码注释里：宿主是用户自己的服务器，信任其重定向。
- **`reauth()`（本次重点）**：网页侧发现 401 / 被踢到登录门户时经原生桥调 `reauth`（无参）。**不重新走 probe**——过期会话下 probe 只会 401，那样会错误地回到连接页。直接 `web.loadUrl(hostPageUrl())`，并 `probeSeq++` 作废在途探测、`pageReady=false`、`showLoading(true)`。之后由代理层重新挑战：basic_auth → `onReceivedHttpAuthRequest` 自动带存储凭据；forward_auth → 302 去门户，靠上面的 redirect 规则留在 WebView 内，用户登录后回跳重新加载页面，shim 全新初始化。
  - 节流与防循环：30s 内不重复；连续 3 次没治好 → `showConnect(err_proxy_retry)` 让用户手动处理。**观察期**（20s）内没再触发才把计数归零——否则一个用很久的会话会隔三差五过期、计数只增不减，迟早误触降级。
  - 门户停留超时（2 分钟没回到宿主 origin）也降级到连接页。
- **`Uploader`**：`uploadAll/uploadOne` 带上该 host 的代理 Basic 头（签名加 `proxyAuth` 参数，调用点两处：`deliverShare`、`onPicked`）。同样地 Basic 占头时 token 走 query。401 且带 `www-authenticate` → 报错区分「代理层认证失败」。
- **连接页（`connect.html`）**：新增可选的「代理认证」折叠区（用户名 / 密码 / 已保存提示 / 清除）。沿用现有卡片样式与中英文案；`state()` 多回一个 `proxyUser`（密码不回页面），`Bridge.connect` 多收两个参数（用户名非空 = 存 / 覆盖，都空 = 沿用）。
- 新字符串中英各一份（`res/values/strings.xml` + `res/values-zh/strings.xml`）。

## 网页侧（src/headless/web-shim.ts）

- `api()`：401 时读 `www-authenticate`，有 → 抛「代理层认证未通过」（没有 → 保持原来的「缺少或错误的 token」）；凡 401 一律触发重认证。
- **SSE 空闲探测**：连续 2 次重连失败后，用 fetch 探一次 `/api/info`（8s 超时）；401 或被重定向到非宿主 origin（`res.redirected` / `res.url` 判断）→ 同样触发重认证。**后台挂半天、没有任何命令调用时，这是唯一能发现会话过期的机会。**
- 重认证流程：本地事件 `cockpit:host-unauthorized`（外壳可弹一次性提示）→ 原生桥 `reauth`（无参）→ promise 单例限流 + 30s 时间节流（原生侧同样节流，双保险）。
- 首屏 `/api/info` 的 401 顺带就走上了面这条路（它只影响 `platform` 兜底，不再被完全吞掉）。

## 已知取舍

- **整页重载会丢当前 ability / 表单状态**（现有 `onRenderProcessGone` 也是整页重建，先例如此）。第 9 条「重载前 sessionStorage 记 ability id」**没有单独实现**：`App.vue` 早就把 `currentId` 写进 localStorage（`cockpit-ui-state`），且 `restoreUiState()` 在 `onMounted` 里覆盖 `sidebar.default`——重载后本来就回到原来的 ability。ability 内部状态（表单、进行中的会话）仍然会丢，那需要各能力自己持久化。
- **第 8 条（外壳提示）没有做**：App 里原生已经弹 Toast「代理会话已过期，正在重新认证…」；纯浏览器里 `reauth` 没有原生桥、只是个本地事件，弹「正在重新认证」反而误导。
- **401 一律触发重认证的代价**：token 不对（而非代理过期）时也会重载，最坏情况是 3 次重载后落到连接页。降级文案因此同时提到代理凭据和 token。正常路径下 probe 已经先把 token 不对拦在连接页，走不到这里。
- 代理与宿主不同端口时，`onReceivedHttpAuthRequest` 给的 host 可能不带端口，按当前宿主地址的端口补；真挂在别的端口上时用户在连接页手填一次即可（存的 key 与查询用的 key 一致）。

## 验证

- Gradle `assembleDebug` **未跑**：本机没有 `/opt/android-sdk`（也没有 `android.jar` / build-tools / JDK 17 的 javac；`./gradlew` 连 distribution 都下不下来），按约定不自行安装系统组件。
- 替代办法（**符号级编译，不是真机构建**）：手写一套 Android API stub（`/tmp/andstub`，只覆盖本项目用到的成员，`org.json` 用可用的最小实现），`R.java` 由 strings.xml 生成，然后
  `javac -sourcepath /tmp/andstub:<android 源码树> $(find /tmp/andstub -name '*.java') <8 个源文件>`
  对 `android/app/src/main/java` 全部 8 个源文件编译，**0 error**（只有既有的 `new URL(String)` deprecation 警告）。`@Override` 签名错、方法名拼错都会在这里现形。
- 另外用一个假 `SharedPreferences` 对 `ProxyCreds` 跑了 27 条断言（keyOf 各种形态 / 存 / 覆盖 / 多 host 互不干扰 / 清单条 / 空用户名即清除 / 坏 JSON 不炸且仍可写入 / 空 key 安全），全过。测试代码在 `/tmp`，没有进仓库（项目没有 Java 测试设施，加 JUnit 依赖超出本次范围）。
- `pnpm install` + `pnpm typecheck:web`（vue-tsc）通过，0 error。
- **未经真机 / 模拟器验证**：stub 不能替代 aapt / dex / 真机行为，对话框与 WebView 重定向的实际表现必须真机看。
- 手测矩阵：
  | # | 场景 | 预期 |
  |---|---|---|
  | a | Caddy `basic_auth` 首次连接 | 原生 probe 带 preemptive Basic 直接过；没存凭据时页面加载弹一次代理对话框，登录后进宿主页面并存盘，下次不再问 |
  | b | Caddy `forward_auth` 首次连接 | probe 报「代理要求先登录（跳转到 \<host\>）」而**不是**误报成功；在浏览器里登一次门户后重试即可进 |
  | c | 会话过期（Caddy 会话 TTL 调 1 分钟） | 使用中：下一次命令 401 → Toast「正在重新认证」→ 整页重载 → basic_auth 自动带凭据 / forward_auth 留在 App 内登门户后回跳，恢复后回到原来的 ability；空闲：SSE 连错两次 → 探 `/api/info` → 同样重认证 |
  | d | 取消认证对话框 / 门户登录失败 | 取消 → 回连接页并说明「已取消代理登录」；门户 2 分钟没回跳 → 降级到连接页；重认证连续 3 次没治好 → 停止自动重试，回连接页让用户手动处理 |
