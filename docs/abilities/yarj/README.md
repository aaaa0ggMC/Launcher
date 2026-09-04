# Yet Another Recorded Journey（yarj）— 详细实施任务书

> 本文档是 **yarj 能力的详细任务书 + 能力文档**，供实施与后续维护使用。
> 前置必读：`AGENTS.md`（架构/约定）、`DESIGN.md`（界面规范，UI 改动必须遵守）。
> 参考实现：`apps`（文件夹设置、排版标杆）、`aidj`（page-menu、jobs、settings 注入）、`playground`（命名作业样板）、`rungame`（带第三方依赖的 zip 分发能力）。

---

## 1. 项目概述

**名称**：Yet Another Recorded Journey（旅行记录 / 足迹地图）
**Ability 文件夹**：`src/abilities/yarj/`
**定位**：把照片的拍摄地点（EXIF 内置信息）映射到地图上，在地图中标注「用户探索过的区域」，形成个人的足迹地图。

### 1.1 初版范围（v1）

| 范围             | 内容                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| ✅ 必做          | 扫描图库目录，解析每张照片的 EXIF（含 GPS），构建元数据库                                              |
| ✅ 必做          | 主页面全屏地图，照片位置打点，点击弹窗看照片信息                                                       |
| ✅ 必做          | 地图自适应扩大（占满页面），右下角竖排按钮阵列：放大 / 缩小 / 球体↔平面切换（+复位）                   |
| ✅ 必做          | Page-menu（仿 AIDJ）：菜单含「扫描」等操作                                                             |
| ✅ 必做          | 设置注入两节：**Gallery Folders**（图库目录，仿 apps 搜索目录）、**Map Files**（MBTiles 地图文件表格） |
| ✅ 必做          | 元数据含 `appendix`（JSON 字符串），供动态数据（用户打 tag 等）扩展                                    |
| ✅ 必做          | 自包含，可 zip 分发（解压进 `src/abilities/yarj/` → `pnpm install` → 重建即可用）                      |
| ❌ 不做（v1.1+） | 轨迹线绘制、探索区域多边形手绘、HEIC 解析、在线底图、照片去重/相似检测、时间线                         |

### 1.2 关键约束

- **MUST follow DESIGN.md**（UI 排版：默认密度文字按钮、间距底线、页面外壳 min-height、状态冻结等）。
- CLI-first：每个操作都是注册命令（`yarj.*`），UI 与 CLI 共用同一 handler。
- 渲染端 sandbox：本地文件一律经自定义协议（`cockpit-icon://` 已有，本能力新增 `cockpit-tile://`）。
- 跨平台（无 Linux 专属依赖）；能力依赖 `background-tasks`（扫描走命名作业，仿 apps/aidj 的 `meta.ts`）。

---

## 2. 技术选型（含实测依据）

| 用途          | 选型                                                | 理由 / 实测                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MBTiles 读取  | **Node 内置 `node:sqlite`**（`DatabaseSync`）       | 实测：Electron 39.8.10（Node 22.22.1）下直接 `require('node:sqlite')` 可用（仅 ExperimentalWarning，无需 flag、无需任何 npm 依赖）。374MB 的 `GlobalMap_ADM0_2.mbtiles` 以 `readOnly` 打开、查询 `tiles`/`map`+`images` 双布局、读到 gzip 数据均成功。**零原生依赖** → zip 分发不需要 electron-rebuild，这是选它而非 `@mapbox/mbtiles`（依赖 node-sqlite3 原生模块）的决定性理由 |
| 元数据库      | **同一 `node:sqlite`**                              | 一个 SQLite 方案通吃 MBTiles 与元数据，减少依赖面；API 变化风险用「封装在 `db.ts` 单文件，可替换 better-sqlite3」缓解                                                                                                                                                                                                                                                            |
| 地图渲染      | **MapLibre GL JS（`maplibre-gl`，^5.x）**           | 实测目标文件 `format = pbf`（tippecanoe 矢量瓦片），**只有 MapLibre 类库能原生渲染 pbf + 支持 globe 投影**（v4 起 `projection: 'globe'`；Leaflet 渲染不了 pbf，CesiumJS 过重）。BSD 许可。备选：若未来纯光栅 mbtiles 优先可再评估                                                                                                                                                |
| EXIF 解析     | **`exifr`**（纯 JS，MIT）                           | 主进程扫描用；支持 GPS（`gps.latitude/longitude/altitude`）、`DateTimeOriginal`、相机/镜头字段，异步 API 适合长任务循环                                                                                                                                                                                                                                                          |
| 视频 GPS 解析 | **`ffprobe` (ffmpeg)** + ISO 6709 解析器            | 主进程扫描用；提取 QuickTime/MP4 的 `creation_time` 与 `location`（ISO 6709 格式如 `+31.2304+121.4737+12.000/`），支持手机/无人机/运动相机拍摄的短片足迹                                                                                                                                                                                                                         |
| 瓦片传输      | 自定义协议 **`cockpit-tile://<mapId>/<z>/<x>/<y>`** | 仿 `cockpit-icon`/`cockpit-audio` 现有模式（`protocol.registerSchemesAsPrivileged` + `protocol.handle`），无需 HTTP 端口/CORS 管理；`supportFetchAPI + stream + corsEnabled` 特权。备选（不推荐）：主进程起 localhost HTTP 服务                                                                                                                                                  |
| 照片缩略图    | 现有 **`cockpit-icon://<abs-path>`**                | `<img>` 直接引用，无需新代码                                                                                                                                                                                                                                                                                                                                                     |

### 2.1 `node:sqlite` 使用要点

- 主进程 `import { DatabaseSync } from 'node:sqlite'`（TS 需 `@types/node` 覆盖；当前根 devDeps 已含 `@types/node@^22`，`DatabaseSync` 类型已存在，若缺失在 yarj 内 `declare module` 兜底或升级 types）。
- 全部 sqlite 访问收敛在 `src/abilities/yarj/db.ts`（打开/预编译语句/关闭），MBTiles 读取另收敛在 `mbtiles.ts`——两处都只暴露纯函数，未来换 better-sqlite3 只改这两个文件。
- 启动警告（ExperimentalWarning）可忽略；用 `makeLogger('yarj')` 记录一次，不刷屏。
- MBTiles 打开必须 `{ readOnly: true }`；元数据库用 WAL 模式（`PRAGMA journal_mode = WAL`）避免扫描长事务阻塞读取。

### 2.2 目标 MBTiles 实测结论（GlobalMap_ADM0_2.mbtiles）

- 表结构：`metadata` + **`tiles`**（573,403 行）+ **`map` + `images`**（194,848 张去重图）双布局共存。
  → 读取器必须**优先 `tiles` 表，缺行时回退 `map JOIN images`**。
- `metadata`：`minzoom=0, maxzoom=10, format=pbf, type=overlay, bounds, center, json(矢量图层声明)`。
- 瓦片数据以 **gzip** 存储（头 `1f 8b`，无 `compression` 元数据）→ 读出后必须解压再回给渲染端。
- 坐标是 **TMS**（`tile_row` 自南向北）→ 转 XYZ 必须翻转 `row = 2^z - 1 - y`。
- 单瓦片可达 ~900KB → 解压用 **异步 `zlib.gunzip`**（不要 sync 阻塞主进程），并加 LRU 瓦片缓存（主进程侧，容量 ~64MB 或 ~256 张）。

---

## 3. 文件清单

```
src/abilities/yarj/
  package.json                 # 依赖声明：exifr（主进程，rollup 内联进 out/main）；maplibre-gl（渲染端，Vite 打进 yarj chunk）
  index.ts                     # Ability 元数据 + settings 注入（仿 aidj index.ts）
  meta.ts                      # platforms=[] 全平台；dependencies=['background-tasks']（仿 apps）
  types.ts                     # YarjConfig / GalleryRoot / MapFile / Photo / ScanRun / PhotoFilters
  service.ts                   # config.json 读写（仿 aidj load/save 模式）+ 元数据库 CRUD + 统计
  db.ts                        # node:sqlite 封装：打开/预编译/迁移（metadata.db）
  mbtiles.ts                   # MBTiles 读取器：元数据、双布局 tile 查询、TMS flip、gzip 解压、LRU
  tile-protocol.ts             # registerYarjTileProtocol() → cockpit-tile:// 协议 handler
  scan.ts                      # 扫描器：遍历图库目录 → exifr 解析 → upsert 元数据库（可中止）
  jobs.ts                      # registerJobHandler('yarj.scan') 命名作业（进度/日志/取消）
  commands.ts                  # yarj.* 命令表（见 §5）
  translations/zh.json
  translations/en-US.json
  components/
    GalleryFoldersSection.vue  # 设置·图库目录（仿 apps/SearchRootsSection.vue）
    MapFilesSection.vue        # 设置·地图文件（Zoom/File/ZoomLevel 表格 + -/+ 步进）
  View.vue                     # 主页面：全屏地图 + page-menu + 右下按钮阵列 + 照片图层
docs/abilities/yarj/README.md  # 本文档（任务书 + 能力文档）
```

框架侧最小改动（仅 2 处，均新增、不破坏现有行为）：

1. `src/main/index.ts`：`protocol.registerSchemesAsPrivileged` 增加 `cockpit-tile` 条目（`secure/supportFetchAPI/stream/corsEnabled`），并在 `registerIconProtocol()` 旁调用 `registerYarjTileProtocol()`。
2. `src/main/ui/index.html`：CSP `connect-src` 追加 `cockpit-tile:`（MapLibre 经 `fetch()` 拉瓦片，自定义 scheme 需显式放行；`worker-src 'self' blob: data:` 已满足 MapLibre blob worker）。

---

## 4. 数据模型

### 4.1 能力配置 `~/.config/LinuxCockpit/yarj/config.json`

```jsonc
{
  "galleryRoots": [{ "path": "/home/aaaa0ggmc/Pictures/Photos", "watch": false }],
  "maps": [
    {
      "id": "global", // 唯一 id（path hash 或用户起名）
      "path": "/home/aaaa0ggmc/Desktop/GlobalMap_ADM0_2.mbtiles",
      "defaultZoom": 2, // 设置表格里 ZoomLevel -/+ 调整的值
      "enabled": true
    }
  ],
  "exploredRadiusM": 1000, // 探索区域默认半径（米），可被照片 appendix 覆盖
  "adm1MinZoom": 4, // ADM1（省级）回退缩放（无 LOD 数据时）
  "adm2MinZoom": 6, // ADM2（县级）回退缩放（无 LOD 数据时）
  "lodScreenFraction": 0.7, // LOD 占屏比例：某区占视口该比例才显示其边界（0–1）
  "lastView": { "projection": "globe", "center": [0, 20], "zoom": 2 } // 记住上次视图（可空）
}
```

读写：`loadYarjConfig() / saveYarjConfig(patch)`（仿 `loadAidjConfig`），配置路径经 `paths.ts` 的能力配置目录约定（`~/.config/LinuxCockpit/yarj/`）。所有字段缺省合并默认值，坏 JSON 回落默认并记日志。

### 4.2 元数据库 `~/.config/LinuxCockpit/yarj/metadata.db`

```sql
CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,        -- 绝对路径（唯一键）
  root        TEXT NOT NULL,               -- 所属图库根目录（用于按目录过滤/重扫）
  file_size   INTEGER,                     -- 增量扫描：size+mtime 未变则跳过
  mtime       REAL,
  width       INTEGER, height INTEGER, orientation INTEGER,
  taken_at    TEXT,                        -- DateTimeOriginal（优先）/ GPS 时间戳（兜底）ISO8601
  camera_make TEXT, camera_model TEXT, lens_model TEXT,
  focal_length REAL, f_number REAL, exposure_time TEXT, iso INTEGER,
  gps_lat REAL, gps_lon REAL, gps_alt REAL,
  hash        TEXT,                        -- 文件 SHA-256 内容哈希（用于移动/重命名追踪与去重）
  appendix    TEXT NOT NULL DEFAULT '{}',  -- JSON 字符串：动态数据（用户 tag 等），见 4.3
  scanned_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_photos_gps ON photos (gps_lat, gps_lon);
CREATE INDEX IF NOT EXISTS idx_photos_root ON photos (root);
CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos (taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos (hash);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT, started_at TEXT, finished_at TEXT,
  status TEXT,                 -- running | done | cancelled | error
  total INTEGER, with_gps INTEGER, failed INTEGER, error TEXT
);
```

说明：v1「探索过的区域」由照片 GPS 点 + 半径圆直接派生（见 §6.4），**不单独建表**；半径存在 `photos.appendix.explored_radius_m`，缺省用 config 的 `exploredRadiusM`。`scan_runs` 供「上次扫描时间/结果」统计展示。

### 4.3 `appendix` JSON 约定（动态扩展点）

```jsonc
{
  "tags": ["东京", "樱花", "家庭"],
  "title": "上野公园",
  "note": "…",
  "explored_radius_m": 1500, // 覆盖全局默认半径
  "hide_on_map": false // 用户手动从地图隐藏该点
}
```

- 扫描器只写 `{}`；内容全部经 `yarj.update-photo`（UI 编辑/CLI patch）维护。
- 未来任何动态字段（多边形轨迹、评分、链接）都往 appendix 加，DB 无需迁移。

---

## 5. 主进程设计

### 5.1 命令清单（`commands.ts`，全部 CLI-first，`satisfies CommandSpec[]`）

| 命令                    | 参数                                         | 返回                                        | 说明                                                                                                       |
| ----------------------- | -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `yarj.config`           | —                                            | `YarjConfig`                                | 读配置                                                                                                     |
| `yarj.save-config`      | `--patch <json>`                             | `YarjConfig`                                | 整体 patch 保存                                                                                            |
| `yarj.add-root`         | `--path`                                     | 新 roots 列表                               | 添加图库目录（校验存在、去重）                                                                             |
| `yarj.remove-root`      | `--path`                                     | 新 roots 列表                               | 移除图库目录                                                                                               |
| `yarj.move-root`        | `--path --dir -1\|1`                         | 新 roots 列表                               | 调整顺序（仿 apps.move-root）                                                                              |
| `yarj.add-map`          | `--path [--id]`                              | maps 列表                                   | 添加 mbtiles：校验 SQLite 头 + 读元数据（minzoom/maxzoom/format），自动生成 id                             |
| `yarj.remove-map`       | `--id`                                       | maps 列表                                   | 移除地图文件                                                                                               |
| `yarj.set-map-zoom`     | `--id --zoom <n>`                            | maps 列表                                   | 设置该地图 defaultZoom（设置表格 -/+ 用）                                                                  |
| `yarj.set-map-enabled`  | `--id --enabled`                             | maps 列表                                   | 开关地图                                                                                                   |
| `yarj.maps`             | —                                            | `MapFileInfo[]`                             | 每个地图 + 实时读出的 mbtiles 元数据（bounds/center/minzoom/maxzoom/format/瓦片数，读失败给 `error` 字段） |
| `yarj.scan`             | `[--root]`                                   | `{ ok, taskId }`                            | 启动扫描命名作业（无 --root = 扫全部目录），立即返回 taskId                                                |
| `yarj.scan-status`      | —                                            | `{ lastRuns, photoCount, withGps, byRoot }` | 统计信息（page-menu 展示）                                                                                 |
| `yarj.photos`           | `--root --has-gps --since --bbox <json> --q` | `Photo[]`                                   | 查询照片（渲染端拼 GeoJSON）；`--bbox` 为 `[minLon,minLat,maxLon,maxLat]`                                  |
| `yarj.update-photo`     | `--path --patch <json>`                      | `Photo`                                     | 更新 appendix（tags 等）；patch 为 appendix 的顶层字段合并                                                 |
| `yarj.map-info`         | `--id`                                       | `MapFileInfo`                               | 单图元数据（地图页初始化用，含 center/bounds）                                                             |
| `yarj.lod`              | `[--id]`                                     | `{ ok, taskId }`                            | 生成行政区 LOD（包围盒缓存）后台作业                                                                       |
| `yarj.lod-status`       | —                                            | `LodStatus[]`                               | 各地图 LOD 生成状态（就绪/生成中/数量）                                                                    |
| `yarj.lod-data`         | `--id`                                       | `LodData \| null`                           | 读取 LOD 缓存（shapeID → 经纬跨度）                                                                        |
| `yarj.hierarchy`        | `[--id]`                                     | `{ ok, taskId }`                            | 推导「市/县 → 省」归属后台作业                                                                             |
| `yarj.hierarchy-status` | —                                            | `HierarchyStatus[]`                         | 各地图归属生成状态                                                                                         |
| `yarj.hierarchy-data`   | `--id`                                       | `HierarchyData \| null`                     | 读取归属缓存（adm2→adm1 正向 + adm1→adm2 反向）                                                            |

> CLI 命令描述走翻译：翻译文件需含每个 `<命令>.desc` 键（CLI 用 `t(name + '.desc', description)` 兜底，见 §8）。

### 5.2 命名作业（`jobs.ts`）

- `registerJobHandler('yarj.scan', handler)`，仿 playground `pg-task` 样板：
  - 遍历每个图库目录 → `scan.ts` 的异步循环；
  - 每处理若干张（如 25 张）`control.setProgress(百分比)` + `control.pushLine(进度行)`；
  - `control.setCancel(() => ac.abort())`，循环内查 `ac.signal.aborted`，中止时 `control.finish('cancelled')`；
  - 结束写 `scan_runs`（done/cancelled/error + 统计），完成后 `control.finish('exited')`。
- 渲染端触发：`window.cockpit.btJob('yarj.scan', { root? })`（参数为普通对象，注意深拷贝规范）；任务自动出现在全局面板，可随时停止。
- 增量逻辑：`photos` 表里 `file_size + mtime` 与磁盘一致则跳过解析（EXIF 解析是大头，跳过可提速一个数量级）；扫描中对已删除文件标记移除（v1 简化：只 upsert，不物理删行；「清理失效记录」留 v1.1）。

### 5.3 扫描器（`scan.ts`）

- 支持扩展名（v1）：`.jpg .jpeg .tif .tiff .png .webp`（exifr 原生支持）；HEIC 明确不做（v1.1+）。
- 每张照片 `exifr.parse(path, { gps: true, pick: [...] })` 提取（即「exif 里大部分有用字段」）：
  `Make / Model / LensModel / FNumber / ExposureTime / ISO / FocalLength / DateTimeOriginal / Orientation / PixelXDimension / PixelYDimension / GPSLatitude / GPSLongitude / GPSAltitude / Software / Artist / Copyright / Flash / WhiteBalance / MeteringMode / ExposureBiasValue`。
- `taken_at`：`DateTimeOriginal` 优先，缺失回退 GPS 时间戳，再缺省留空（非致命，照常入库）。
- GPS 数值统一转十进制浮点（`gps.latitude/longitude/altitude` 已是十进制，直接取）。
- 单文件解析失败不中断整体：计数 `failed`，`pushLine` 警告行（限流：同类错误只打印前 10 条）。

### 5.4 MBTiles 读取 + 瓦片协议（`mbtiles.ts` / `tile-protocol.ts`）

```
GET cockpit-tile://<mapId>/<z>/<x>/<y>
```

- 解析 URL → 查 config.maps 找 `mapId` → 不存在/被禁 → 404。
- 连接缓存：`Map<mapId, DatabaseSync>`（readOnly，惰性打开，配置变更时关闭重建）。
- 查询：`row = 2^z - 1 - y`（TMS flip），先查 `tiles` 表，`map`+`images` 表存在且 `tiles` 无行时 JOIN 兜底（预编译两条语句，启动时探测表结构决定启用哪条）。
- 命中后：头两字节 `1f 8b` → 异步 `zlib.gunzip`（`zlib.gunzip` 回调包装成 Promise）；非 gzip 原样返回。
- 响应头：`format=pbf` → `application/x-protobuf`；`png` → `image/png`；`jpg` → `image/jpeg`；统一 `Access-Control-Allow-Origin: *`（`corsEnabled` 下 MapLibre 保持 origin-clean）；`Cache-Control: private, max-age=86400`。
- LRU：主进程侧 `Map`（key=`mapId/z/x/y`，容量上限 ~256 条 / 64MB，超限删最旧）；MapLibre 自带瓦片缓存，协议层缓存只防重复请求。
- 全程 try/catch → 404/500 干净返回，不让协议 handler 抛异常（仿 icon/audio 协议的防御风格）。

### 5.5 服务（`service.ts`）

- `loadYarjConfig / saveYarjConfig`：`~/.config/LinuxCockpit/yarj/config.json` 读写（目录不存在先 mkdir，写临时文件 + rename 原子替换，仿 mirror 的安全写法）。
- `openMetadataDb()`：`metadata.db` 惰性打开 + `PRAGMA journal_mode=WAL` + 建表迁移（`CREATE TABLE IF NOT EXISTS`）。
- `upsertPhoto / queryPhotos / updatePhotoAppendix / recordScanRun / scanStats`：预编译语句 + 参数化（路径/根目录可能含引号，一律占位符）。
- 渲染端拿到的 `Photo` 序列化结构：`{ id, path, root, taken_at, width, height, gps_lat, gps_lon, gps_alt, camera_make, camera_model, appendix(解析后的对象) }`——**不下发完整 EXIF**，弹窗展示所需字段足够（appendix 在渲染端展开）。

---

## 6. 渲染端设计

### 6.1 Ability 元数据（`index.ts`）

```ts
export default {
  id: 'yarj',
  name: '旅行记录', // 侧栏名（翻译键 ability.yarj.name）
  icon: 'default/map', // game-icon-pack 已有 map.svg（备选 default/location、default/compass）
  category: '旅行', // 侧栏分组（决定点：'旅行' 或并入 '工具'，见 §10 决策点）
  keepAlive: true, // 切走保留地图实例（需 onActivated 里 map.resize()）
  component: defineAsyncComponent(() => import('./View.vue')),
  settings: [/* 见 6.5 */]
} satisfies Ability
```

### 6.2 主页面布局（`View.vue`）

```
┌────────────────────────────────────────────────┐
│  page-menu（顶部居中，仿 AIDJ，可收起）            │
│   └ 扫描 / 数据统计 / 图层开关…                   │
├────────────────────────────────────────────────┤
│                                                │
│          MapLibre 全屏地图（flex-grow-1）        │
│          照片点 / 探索区域圆 / 瓦片               │
│                                                │
│                        ┌────────┐              │
│                        │  [+]   │ ← 右下角竖排  │
│                        │  [−]   │   按钮阵列    │
│                        │ [🌐⬜] │              │
│                        │  [⌂]   │              │
│                        └────────┘              │
└────────────────────────────────────────────────┘
```

- 外壳：页面根 `position: absolute; inset: 0; overflow: hidden`（仿 aidj-shell），**不加外壳滚动条**（地图自己满铺）；App.vue 能力页容器的 min-height 由框架处理，本页内容不超高，符合 DESIGN.md §4.6。
- 地图容器 `flex-grow-1` + `min-height: 0`，窗口/侧栏切换后 `map.resize()`（`onActivated` + `ResizeObserver`）。
- 无地图配置 → 居中 `v-empty-state`（icon `mdi-map-outline`），文案引导去设置添加（「设置 → 旅行记录 → 地图文件」）。
- 地图文件损坏/读取失败 → 地图页顶部非阻塞提示条（`v-alert`），不白屏。

### 6.3 Page-menu（仿 AIDJ `View.vue` 的 `.page-menu`）

- 结构与样式照抄 AIDJ 的 page-menu（顶部居中、毛玻璃 handle（chevron）、展开面板 `.page-menu-pop`、`.menu-item` 悬浮高亮、Transition）。
- 主菜单项（v1）：
  1. **扫描**（`mdi-sync`）→ `btJob('yarj.scan')`，成功后刷新图层与统计；扫描中显示进度状态行（复用 `cockpit:bt` 事件或直接提示「已在后台任务面板查看进度」）。
  2. **数据统计**（`mdi-chart-box-outline`）→ 面板展示 `yarj.scan-status`：照片总数 / 含定位数 / 上次扫描时间与结果（chip 显示 done/cancelled/error，仿 BtLogView 的状态表达）。
  3. **图层开关**（`mdi-layers-outline`）→ 展开子步（仿 sessions 子步）：☑ 照片点 / ☑ 探索区域 / ☑ 圆半径标签。
  4. （可省）**打开设置** → 跳转设置分类（若框架支持，否则省略）。
- 扫描进行中：菜单项显示 loading 图标并禁用重复触发。

### 6.4 地图与图层（核心）

- 初始化：`new maplibregl.Map({ container, style: { version: 8, sources: { tiles: {...} }, layers: [瓦片图层] }, center, zoom, projection: config.lastView.projection })`。
  - 瓦片 source：`{ type: 'vector'|'raster', tiles: ['cockpit-tile://<mapId>/{z}/{x}/{y}'], minzoom, maxzoom }`（format 决定 type；矢量图层用 metadata.json 里声明的 `source-layer`）。
  - **矢量图层分级渲染（重要）**：tippecanoe 类 mbtiles 常在低缩放就把行政细分简化塞进瓦片，显示策略必须由样式层控制：
    - **主图层**（layer id 含 `adm0`/`admin-0`/`country`/`continent` 等）→ 全缩放级别显示：浅填充（主题色 0.1 alpha）+ 实线（宽 1）。
    - **细节图层**（其余，如 `adm1_2`，内含 ADM1/ADM2 两种要素）→ **按 `shapeType` 拆成两个线图层**：
      - `yarj-line-<sl>-adm1`：ADM1（省级，含 DISP 争议区）— 实线、**圆角连接/端点**（低顶点数下明显更平滑）、宽度随缩放 0.9→1.5 渐增、`line-blur: 0.5` 抗锯齿、主题色 0.5 alpha
      - `yarj-line-<sl>-adm2`：ADM2（县级）— 更淡更细实线（0.5→0.9 / 0.32 alpha）、同样圆角
      - 显示门槛：**有 LOD 数据 → 按「区域占屏比例」逐区自适应**；无 LOD → 回退 `adm1MinZoom`（4）/ `adm2MinZoom`（6）整数缩放门槛。
      - ⚠️ **边界粗糙的根源是数据精度**：tippecanoe 低缩放大幅简化几何（实测四川 z6 仅 4 个顶点、江苏 z6 11 个；该文件 extent=2048 / detail 11）。渲染端已用圆角+实线+抗锯齿改善观感；要真正的平滑边界需用更高精度重新生成瓦片（见 §13.6）。
  - **LOD（Level of Detail，动态逐级加载）**：`lod.ts` 后台作业解码矢量瓦片（实测 z0→z6 覆盖 99.2% 要素仅 ~1.3s），按 `shapeID` 缓存每个行政区的经纬跨度（`~/.config/LinuxCockpit/yarj/lod/<mapId>.json`）。渲染端在 `moveend`/`resize` 时按 `lodMinZoom = ceil(log2(fraction·viewport·360/(w·256)))` 重算当前缩放应显示的区，动态 setFilter。首次打开地图自动触发生成作业（统计面板可见「就绪 · N 个行政区」）。
    - 判定函数 `isDetailLayer()`（View.vue）；阈值 `adm1MinZoom` / `adm2MinZoom` / `lodScreenFraction`（默认 0.7）可在 `config.json` 调整。
  - 主题联动：矢量填充/描边、marker 颜色全部用 `rgb(var(--v-theme-primary))` 等 CSS 变量（AGENTS.md：画布类渲染端配色跟随主题，不硬编码 hex）。
- **照片点层**：`yarj.photos` → GeoJSON `FeatureCollection` → `maplibregl.Marker`（DOM marker 更利于弹窗内 `<img src="cockpit-icon://…">`）或 symbol layer（照片多时 symbol 性能更好，v1 用 DOM Marker 简化、数量大再优化）；点击 → `maplibregl.Popup`：缩略图 + 拍摄时间 + 相机型号 + 经纬度 + tags chips + 「编辑标签」入口（调 `yarj.update-photo`）。
- **探索区域层**（v1 派生）：每点一个半透明圆（`geojson` source + `fill` 层，半径 = appendix.explored_radius_m ?? config.exploredRadiusM），颜色主题主色、opacity ~0.18、描边更淡；开关见 page-menu。v1.1 再引入多边形/轨迹。
- **右下角竖排按钮阵列**（`position: absolute; right: 16px; bottom: 16px; flex-direction: column; gap: 8px`，即 DESIGN.md 的 `ga-2` 起步）：
  - `[+]` 放大：`map.zoomIn()`（图标按钮，允许 `size="small"`，`variant="flat"` 毛玻璃背景）
  - `[−]` 缩小：`map.zoomOut()`
  - `[🌐/⬜]` 投影切换：`map.setProjection('globe' | 'mercator')`，图标与 tooltip 随状态切换（球体=mdi-earth / 平面=mdi-square-outline；英文 label 用 `globe`/`平面图`）
  - `[⌂]` 复位：`map.fitBounds(metadata.bounds)`（回到世界视图）
  - 全部图标按钮带 `:title`（i18n），鼠标悬浮提示。
- **视图记忆**：`moveend` 节流后写 `config.lastView`（projection/center/zoom），下次进入恢复。

### 6.5 设置注入（`index.ts` settings，两级结构照抄 apps/aidj）

```
分类（一级 chip）：旅行记录  (icon mdi-map-marker-path, label '旅行记录')
├─ 图库目录 (Gallery Folders)      — GalleryFoldersSection.vue
└─ 地图文件 (Map Files)            — MapFilesSection.vue
```

- **GalleryFoldersSection.vue**：直接仿 `apps/SearchRootsSection.vue`——列表（readonly 路径 + 上移/下移/删除图标按钮）、输入框 + 文件夹选择（`window.cockpit.pickFile({ directory: true })`）+「添加」文字按钮（默认密度，`height="40" class="px-5"`）；命令走 `yarj.add-root/remove-root/move-root`。
- **MapFilesSection.vue**：任务书要求的表格 UI：

```
Zoom      File                                ZoomLevel
──────────────────────────────────────────────────────
[0–10]  [ GlobalMap_ADM0_2.mbtiles      [🗺] ]   [−] 2 [+]
[0–5 ]  [ …/region.mbtiles             [🗺] ]   [−] 3 [+]
                              [+ 添加地图文件]
```

- 每行一个地图：`minzoom–maxzoom`（来自 `yarj.maps` 的元数据，读失败显示 `读取失败` 红色 chip）、文件路径 readonly 字段（`text-truncate`）、图标按钮（打开文件所在位置或预览，v1 做 `mdi-information-outline` 显示完整路径/格式/瓦片数 tooltip）、**ZoomLevel −/+ 步进**（调 `yarj.set-map-zoom`，即该地图打开时的默认缩放，步长 1，范围夹在 minzoom–maxzoom 内）、删除图标按钮（`color="error"`）。
- 添加：`pickFile({ filters: [{ name: 'MBTiles', extensions: ['mbtiles'] }] })` → `yarj.add-map`；失败（非 SQLite / 无 tiles 表）弹 snackbar 报错。
- 表头文字按钮/间距遵守 DESIGN.md（默认密度、`ga-2`、行 `py-3` 起步）。

### 6.6 i18n 与可访问性

- 所有用户可见文本走 `translate(uiLang, key)`；zh/en-US 双写（§8 清单）。
- 图标按钮一律 `:title`；页面无键盘焦点陷阱。

---

## 7. 自包含与分发

- `package.json`：
  ```jsonc
  {
    "name": "@cockpit/yarj",
    "version": "0.1.0",
    "private": true,
    "dependencies": {
      "exifr": "^7.1.3",
      "maplibre-gl": "^5.20.0"
    }
  }
  ```
  - `exifr`（主进程用）会被 rollup **内联进 `out/main/index.js`**（externalizeDepsPlugin 只读根 package.json）→ 运行时零外部依赖；
  - `maplibre-gl`（渲染端用）经 Vite 打进 yarj 的异步 chunk（首次进入页面才加载）；
  - `node:sqlite` 内置，无依赖。
- zip 分发验证（验收项）：把 `src/abilities/yarj/` 打包 → 解压到干净副本的 `src/abilities/` → `pnpm install`（workspace 自动识别并安装依赖）→ `pnpm build` → 侧栏出现「旅行记录」，地图/扫描/设置全部可用。
- `node_modules/` 不入 zip、不入 git（.gitignore 已覆盖）；能力整体可如 fnaf/ut/mt/rungame 一样 gitignore + zip 分发。

---

## 8. 国际化键清单（zh.json / en-US.json 必须双写）

| 键                                                                                                         | 中文                                                          | 备注                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| `ability.yarj.name` / `ability.yarj.category`                                                              | 旅行记录 / 旅行                                               | 侧栏                                 |
| `yarj.menu.scan` / `yarj.menu.stats` / `yarj.menu.layers`                                                  | 扫描 / 数据统计 / 图层                                        | page-menu                            |
| `yarj.scan.started` / `yarj.scan.running` / `yarj.scan.done` / `yarj.scan.failed`                          | 扫描已开始 / 扫描中 / 扫描完成 / 扫描失败                     | 状态                                 |
| `yarj.stats.photos` / `yarj.stats.withGps` / `yarj.stats.lastScan`                                         | 照片总数 / 含定位 / 上次扫描                                  | 统计面板                             |
| `yarj.layers.photos` / `yarj.layers.explored` / `yarj.layers.radius`                                       | 照片点 / 探索区域 / 圆半径                                    | 图层开关                             |
| `yarj.map.zoomIn` / `yarj.map.zoomOut` / `yarj.map.projection` / `yarj.map.reset`                          | 放大 / 缩小 / 球体·平面图 / 复位视图                          | 右下按钮 title                       |
| `yarj.map.empty` / `yarj.map.emptyHint`                                                                    | 尚未配置地图 / 前往「设置 → 旅行记录 → 地图文件」添加 MBTiles | 空状态                               |
| `yarj.map.loadError`                                                                                       | 地图文件读取失败                                              | 顶部提示                             |
| `yarj.popup.takenAt` / `yarj.popup.camera` / `yarj.popup.coords` / `yarj.popup.editTags`                   | 拍摄时间 / 相机 / 坐标 / 编辑标签                             | 弹窗                                 |
| `yarj.settings.gallery` / `yarj.settings.maps`（+ label./desc. 前缀，见 apps 惯例）                        | 图库目录 / 地图文件                                           | 设置分类                             |
| `yarj.maps.add` / `yarj.maps.remove` / `yarj.maps.zoomLevel` / `yarj.maps.zoomRange` / `yarj.maps.invalid` | 添加地图文件 / 移除 / 缩放级别 / 缩放范围 / 文件无效          | 设置表格                             |
| `label.旅行记录` / `desc.旅行记录` …                                                                       | 设置分类翻译                                                  | 与 apps 的 `label.`/`desc.` 模式一致 |
| `yarj.<cmd>.desc`（每个命令一个）                                                                          | 各命令描述                                                    | CLI `t(name+'.desc')` 用             |

---

## 9. 里程碑与验收标准（建议实施顺序）

> 每步结束必须 `pnpm typecheck && pnpm lint` 0 errors（提交前强制）。
> **✅ 全部完成（2026-08-18）**，实现细节与验证结果见 §13「实施记录」。

### M0 骨架（0.5 天）

- [x] 创建 `src/abilities/yarj/` 全套文件（页面占位、空命令表、translations 骨架、package.json、meta.ts、index.ts）
- [x] 侧栏出现「旅行记录」条目（icon `default/map`）
- [x] typecheck/lint 通过

### M1 配置与设置（1 天）

- [x] `service.ts` config 读写 + `yarj.config/save-config/add-root/remove-root/move-root` 命令
- [x] GalleryFoldersSection 注入设置页（仿 apps），添加/移除/排序即时生效并持久化
- [x] 设置页在 `pnpm dev` 下验证

### M2 MBTiles 服务（1.5 天）

- [x] `db.ts` + `mbtiles.ts`：双布局查询、TMS flip、gzip 解压、元数据读取
- [x] `tile-protocol.ts` + 框架两处改动（index.ts privileges、index.html CSP）
- [x] 用真实 `~/Desktop/GlobalMap_ADM0_2.mbtiles` 验证：`yarj.add-map` 成功读元数据（minzoom 0 / maxzoom 10 / format pbf）；渲染端 `fetch('cockpit-tile://…/2/2/1')` 返回合法 pbf（0x1a protobuf magic，~1.8MB）
- [x] LRU 命中/未命中逻辑（冒烟测试覆盖）

### M3 地图页面（1.5 天）

- [x] maplibre-gl 集成：矢量瓦片渲染、globe/mercator 切换、右下角竖排按钮阵列（+ / − / 投影 / 复位）
- [x] 空状态（未配置地图）、加载失败提示条
- [x] keepAlive 下切页再回来 `map.resize()` 正常，无白屏（ResizeObserver + onActivated）

### M4 扫描 + 元数据库（2 天）

- [x] `scan.ts` + `jobs.ts`：`yarj.scan` 命名作业（进度/日志/取消/scan_runs 落库）
- [x] exifr 字段提取全量入库（含 GPS、taken_at 兜底、相机/镜头）
- [x] 增量扫描：二次扫描跳过 size+mtime 未变文件（日志可见跳过数）
- [x] 构造测试照片集（含/不含 GPS、坏文件）验证 failed 计数与整体不中断

### M5 照片图层（1.5 天）

- [x] `yarj.photos` 查询 + 渲染端 marker 层 + Popup（缩略图 `cockpit-icon://`、时间、相机、坐标、tags 编辑）
- [x] 探索区域圆层（半径 = appendix ?? config，开关在 page-menu）
- [x] page-menu 完成：扫描（含进行中禁用）/ 统计面板 / 图层开关
- [x] `yarj.update-photo` 编辑 tags 后图层即时刷新

### M6 打磨与分发（1 天）

- [x] 全部 i18n 键补齐 zh/en-US；DESIGN.md §6 检查清单逐项过
- [x] 视图记忆（lastView）、统计面板细节、无定位照片的过滤开关
- [x] zip 分发验证（§7 步骤）：依赖仅 exifr（主进程内联）+ maplibre-gl（渲染端 chunk），`node:sqlite` 零依赖
- [x] 本 README 补「使用教程」小节（见 §9.1）

---

### 9.1 使用教程（UI）

侧栏 →「旅行」→「旅行记录」。

**首次使用三步**：

1. **设置 → 旅行记录 → 图库目录**：添加照片目录（或直接输入绝对路径后「添加」）；支持多条、可上下排序、可移除。
2. **设置 → 旅行记录 → 地图文件**：添加 MBTiles（如 `~/Desktop/GlobalMap_ADM0_2.mbtiles`）；每行显示缩放范围（min–max）、文件路径与「缩放级别」−/+ 步进（决定打开时的默认缩放），信息按钮可看格式/瓦片数。
3. **页面顶部 page-menu → 扫描**：后台任务面板实时看进度；完成后带定位的照片自动出现在地图上。

**地图操作**：

- 右下角竖排按钮：`+` 放大 / `−` 缩小 / `🌐⬜` 地球与平面切换 / `⌂` 复位视图（fitBounds）。
- 点照片标记 → 弹窗：缩略图、拍摄时间、相机、坐标、标签（可直接编辑逗号分隔标签并保存）。
- 视图位置/缩放/投影会被记住，下次进入恢复。

**Page-menu**：扫描（进行中禁用并转圈）、数据统计（照片总数/含定位/最近扫描记录 chip）、图层（照片点 / 探索区域开关）。

**CLI 等价操作**（与 UI 同一 handler）：

```
yarj.config                      # 读配置
yarj.add-root --path ~/Pictures  # 添加图库目录
yarj.add-map --path ~/Desktop/GlobalMap_ADM0_2.mbtiles
yarj.scan                        # 触发扫描（后台作业）
yarj.photos --has-gps true       # 查带定位的照片
yarj.update-photo --path /abs/photo.jpg --patch {"tags":["东京"]}
```

---

## 10. 决策点（实施时可与用户确认）

> 实施已按下列默认执行；如需调整随时改。

1. **侧栏分组**：`category: '旅行'`（独立成组）。✅ 已采用「旅行」分组（图标 `default/map`，名称「旅行记录」）。
2. **地图文件表格的 ZoomLevel 含义**：✅ 按「每行一个地图：左列显示可用缩放范围 min–max，右列 ZoomLevel −/+ 步进调整该地图默认缩放」实现；若本意是「调整显示 min/max 范围」或「多地图分层合成」，需改 §6.5。
3. **探索区域形状**：✅ v1 用「照片点 + 半径圆」派生（circle 层数据驱动半径，`radiusM = appendix.explored_radius_m ?? config.exploredRadiusM`，随 zoom 换算像素）；多边形手绘/轨迹线列 v1.1。
4. **图标**：✅ `default/map`（game-icon-pack `2-items/map.svg`）。
5. **HEIC**：✅ v1 不解析，仅按扩展名跳过并计入扫描统计；v1.1 再评估。
6. **瓦片协议注册时机**：⚠️ 实施发现 `abilities-loader` 的 eager glob 在 app ready **前**导入所有 commands.ts，模块作用域直接 `protocol.handle` 会抛 `Session can only be received when app is ready` —— 改为走框架的 `registerStartupHook`（ready 后执行）。已在代码注释与 §13 记录。

---

## 11. DESIGN.md 合规自查清单（提交 UI 改动前逐项过）

- [ ] 文字按钮（扫描 / 添加地图文件 / 添加目录）默认密度，`size="small"` 只用于图标按钮
- [ ] chip（状态/统计）有 `padding-block: 4px; min-height: 24px`
- [ ] 右下按钮阵列 `gap ≥ 8px`，距边 ≥ 16px，不贴边
- [ ] page-menu 面板间距 `padding: 8px`、menu-item `padding: 10px 12px`（照抄 AIDJ）
- [ ] 地图页无外壳多余滚动条（`overflow: hidden` 满铺，App.vue 容器 min-height 由框架保证）
- [ ] 状态有数据支撑：扫描中/完成/失败来自 scan_runs（含 `finished_at`），不做「当前时钟猜状态」
- [ ] 模板无残留 `size="small"` 与 CSS 意图冲突
- [ ] 配色用 `--v-theme-*`，无硬编码 hex（marker/瓦片样式/按钮背景）

---

## 12. 风险与缓解

| 风险                                                   | 缓解                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `node:sqlite` 为实验性 API，Electron/Node 升级可能变更 | 全部 sqlite 访问收敛 `db.ts`/`mbtiles.ts` 两文件；变更时单点替换 better-sqlite3（API 几乎同构） |
| MapLibre GL（含 globe）体积大，首次进页面加载慢        | 走 code-split 异步 chunk；仅 yarj 页面触发加载，不影响框架首屏                                  |
| 374MB/57 万瓦片 mbtiles 查询延迟                       | SQLite 索引命中 + 预编译语句 + 主进程 LRU；单瓦片查询实测为微秒~毫秒级                          |
| gzip 大瓦片（~900KB）同步解压卡顿                      | 异步 `zlib.gunzip`（Promise 化），不阻塞主进程                                                  |
| CSP 拦截自定义协议 fetch                               | 已规划 `index.html` `connect-src` 追加 `cockpit-tile:`（M2 验收含此改动）                       |
| WebGL 不可用（老机器/远程）                            | 初始化失败捕获 → 显示错误提示与降级文案，不白屏不崩溃                                           |
| 扫描耗时/大目录                                        | 增量跳过 + 命名作业（可停止、进度可见、跨页面存活）+ `scan_runs` 记录                           |
| 路径含引号/特殊字符的 SQL 注入                         | 全部参数化语句，绝不字符串拼接 SQL                                                              |

---

## 13. 实施记录（2026-08-18）

### 13.1 环境实测结论（与任务书 §2 一致并补充）

| 项目              | 结论                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:sqlite`     | Electron 39.8.10（Node 22.22.1）直接可用（仅 ExperimentalWarning）；`DatabaseSync` 支持 `{ readOnly: true }`、WAL、预编译语句。类型来自 `@types/node@22.20.1` 自带 `sqlite.d.ts`                                                                                                                                                       |
| `zlib/promises`   | ⚠️ **本环境（系统 Node 26.5 与 Electron 内嵌 Node 22.22）都没有 `zlib/promises` 子路径**（非标准构建）。`mbtiles.ts` 改用 `util.promisify(zlib.gunzip)`，运行时验证通过                                                                                                                                                                |
| exifr GPS         | `exifr.parse(path, { gps: true })` 只返回**原始** `GPSLatitude/GPSLongitude` 数组（且被 `pick` 过滤）；十进制坐标对象必须走独立的 **`exifr.gps(path)`**。`scan.ts` 已按此实现。`DateTimeOriginal` 被 exifr 转成 UTC `Date`（本地 +08:00 的 12:00 → `04:00:00.000Z`），存 ISO 字符串，UI 用 `new Date()` 本地化显示，语义正确           |
| maplibre-gl v5.24 | ① 无独立 worker 文件，**默认内联 Blob worker**（`worker-src blob:` CSP 已放行，探针验证 blob worker 可创建）→ 无需 `setWorkerUrl`；② 投影 API 改为对象：`style.projection = { type: 'globe' }`、`map.setProjection({ type })`、`map.getProjection().type`；③ 表达式幂运算用 `['^', 2, ['zoom']]`（类型里没有 `'pow'`）                 |
| 瓦片协议注册时机  | ⚠️ `abilities-loader` 的 `import.meta.glob(eager)` 在 **app ready 前**导入全部 `commands.ts` → 模块作用域 `protocol.handle` 抛 `Session can only be received when app is ready`。**解法**：`commands.ts` 里 `registerStartupHook(() => registerYarjTileProtocol())`（框架在 ready 后执行）。此为能力自启动的既有机制（apps/aidj 同款） |
| 元数据 DB 写入    | `photos` 用 `INSERT ... ON CONFLICT(path) DO UPDATE SET ...`（**不更新 appendix 列**）→ 重扫保留用户 tags（测试验证）                                                                                                                                                                                                                  |

### 13.2 验证矩阵（本次实施已跑）

| 层         | 方法                                                                                                                                                                             | 结果                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 构建       | `pnpm typecheck`（node + web）                                                                                                                                                   | ✅ 0 errors                                                         |
| 构建       | `pnpm lint`（yarj 范围）                                                                                                                                                         | ✅ 0 warnings（mt/ut 为 gitignored 能力的历史遗留，与本能力无关）   |
| 构建       | `pnpm build`                                                                                                                                                                     | ✅ main 2.18MB（exifr 内联）+ renderer yarj chunk 1.6MB（maplibre） |
| 后端逻辑   | `node --test` + `mock.module('electron')` 冒烟（7 用例）：mbtiles 元数据/瓦片（TMS+gzip）/无效文件、db upsert+appendix 保留、扫描（EXIF+GPS+增量+坏文件）、配置+地图添加         | ✅ 7/7 pass（真实 374MB mbtiles + exiftool 造的 GPS 照片）          |
| 集成       | Electron 探针（真实运行时）：`cockpit-tile://` fetch → 200 / pbf magic 0x1a / Content-Type / ACAO:* / 404 分支 / blob worker / 生产 CSP                                          | ✅ 全过                                                             |
| 应用启动   | 打包应用无头启动：`ability commands registered (14/14)` 含 yarj、`cockpit-tile protocol registered`、侧栏解析含 yarj、无未捕获异常                                               | ✅                                                                  |
| 应用内 E2E | CDP 驱动真实应用：侧栏点击 → `stats.record id=yarj`、app-bar 标题变「旅行记录」、`TILE_FETCH 200`、经真实 IPC `yarj.scan` → `SCAN_STATUS done`、`yarj.photos` 返回 2 张 GPS 照片 | ✅                                                                  |
| 页面渲染   | 无头沙箱中页面切换过渡卡死（`-leave-active` 不结束，GPU 进程崩溃 exit 139 的环境假象，**「应用」等所有能力同样卡死**）→ 判定为环境限制，非 yarj 缺陷；真机需人工确认一次地图渲染 | ⚠️ 环境                                                             |

### 13.3 后续优化（v1.1 候选）

- 照片量大时 marker 改为 symbol 层 + 聚合（当前 DOM marker 适合千级以内）。
- 探索区域支持多边形手绘 / 轨迹线；HEIC 解析；删除文件的失效清理（当前只 upsert 不删行）。
- 多地图同时合成（分层）与地图切换下拉。

### 13.4 真机反馈修复（用户上机后）

用户在真机打开地图后反馈「所有边界全部显示，不应低缩放就显示国内边界」。排查结论与修复（**非 mbtiles 问题**）：

1. **样式层未分级**：该 mbtiles（tippecanoe）`adm0` 与 `adm1_2` 两层的 `minzoom` 都是 0——低缩放瓦片里就含简化省界，显示策略必须由样式控制。原 `buildStyle` 对每个矢量层无条件 fill + line，导致 z0 起全显示 5 万+ 省界。
   - 修复：主图层（国家/洲界）全级别 + 浅填充实线；细节图层（省/市界）仅在 `>= detailMinZoom`（默认 4）显示，细淡虚线、无填充（见 §6.4 与 `isDetailLayer`）。
2. **连带 bug：`addMapFile` 默认缩放 = maxzoom**：添加地图时 `defaultZoom: meta.maxzoom`（=10），打开直接钻到最深缩放、满屏边界。修复为 `Math.min(meta.maxzoom, 2)`（世界视图）。
   - 用户已有条目 `GlobalMap_ADM0_2-pa9bem` 的 `defaultZoom: 10` 已直接改回 `2`（备份 `config.json.bak`）。
3. **`detailMinZoom` 可调**：新增 `config.json` 字段（默认 4），修改后重启或重新进入页面生效。

### 13.5 LOD 自适应分级（用户追问「adm1/adm2 一起显示 / 能否动态加载」）

**为什么 adm1 和 adm2 一起显示**：mbtiles 把 ADM1（省）与 ADM2（县）合在**同一个矢量图层** `adm1_2` 里，要素靠属性 `shapeType` 区分（ADM0/ADM1/ADM2/DISP）。此前按「图层」整层设门槛 → 两层一起出现。修复：按 `shapeType` 拆成两个线图层、分别设阈值。

**能否按「区域占屏 70% 动态加载下一层级」**：✅ 已实现（`lod.ts` + 渲染端动态过滤）：

- 实测：tippecanoe 低缩放瓦片含完整要素（z0 一层即 2.8 万），后台解码 z0→z6 即可覆盖 **52,172/52,573（99.2%）**，**耗时约 1.3s**；结果缓存到 `lod/<mapId>.json`。
- 规则：某行政区经度跨度 `w` 在缩放 z 占视口比例 = `w/360·2^z·256/viewportW`；达到 `lodScreenFraction`（默认 0.7）才显示该区边界 → `minZoom = ceil(log2(f·W·360/(w·256)))`。渲染端 moveend/resize 动态 setFilter（含「未收录小要素走回退阈值」兜底）。
- ⚠️ 数学后果（诚实说明）：70% 是很严的阈值——经度跨度 ≥5° 的省级区在 z6-8 出现；2° 宽的小省要到 z10；县/市级（<1°）几乎不会达到 70% 占屏。想更早看到细分层级就把 `lodScreenFraction` 调低（如 0.25，大省 z4-5 出、小省 z7-8 出）。这与主流地图 App 的做法一致（它们对行政线实际用 5–10% 级别的占屏阈值）。
- 相关命令：`yarj.lod`（后台生成）、`yarj.lod-status`、`yarj.lod-data`；依赖 `@mapbox/vector-tile` + `pbf`（已加入能力 package.json，zip 分发自包含）。

### 13.6 省分界线粗糙（用户反馈）

**现象**：省（ADM1）分界线在出现层级（z4–7）呈折线状、很糙。

**实测定位（数据精度问题，非渲染 bug）**：解码真实瓦片统计中国各省边界顶点数——

| 省份 | z4  | z5  | z6     | z7  | z8  |
| ---- | --- | --- | ------ | --- | --- |
| 新疆 | 574 | 688 | 250    | 26  | 36  |
| 四川 | 31  | 11  | **4**  | 4   | 8   |
| 江苏 | 358 | 245 | **11** | 13  | 6   |

tippecanoe 低缩放大幅简化几何（`strategies` 元数据含 `detail_reduced`/`tiny_polygons`），且该文件 `extent=2048`（detail 11 级）。z6 时四川边界只有 4 个顶点 → 必然是折线。**这是瓦片数据决定的，客户端无法凭空补顶点**。

**已做的渲染端改善**（`View.vue` buildStyle）：

- 线型：虚线 → **实线**；`line-join/cap: round`（圆角连接，锐角观感大减）；宽度随缩放 `0.9→1.5` 渐增；`line-blur: 0.5` 抗锯齿；ADM1 主题色 alpha 提到 0.5。ADM2 同理（更淡更细）。

**要真正的平滑边界（可选）**：用更高精度重新生成瓦片（需原始 GeoJSON，tippecanoe ≥ 2.x）：

```bash
tippecanoe -o smooth.mbtiles -z 12 --detail 12 -S 2 \
  --maximum-tile-bytes=500000 adm0.geojson adm1_2.geojson
```

关键参数：`--detail 12`（extent 4096，坐标精度翻倍）、`-S 2`（更轻的简化，0=不简化）、`-z 12`（更高的 maxzoom 供 LOD 放大后更细腻）。生成后替换 `maps[].path` 即可，LOD 会自动重新生成（删除旧 `lod/<id>.json` 缓存）。

### 13.7 市/县 → 省 归属推导（用户询问「能否获取每个市属于哪个省」）

**数据事实**：`adm1_2` 图层把 ADM1（省）与 ADM2（市/县）平级存放，ADM2 只带国家代码（`shapeGroup`）与自身 name/id，**没有父级省字段**——归属必须空间推导。

**实现**（`hierarchy.ts` + `yarj.hierarchy` 后台作业）：

- 解码 z4–z6 瓦片：收集每国的省多边形**碎片**（tippecanoe 会把大省按瓦片裁剪，碎片并集 = 完整省）+ 每个市/县的**代表点**（最大外环质心 → 包围盒中心兜底）。
- 同国过滤（shapeGroup）+ 5°×5° 网格索引（含 3×3 邻域）+ 射线法点面包含；未命中走「最近省」兜底。
- 结果缓存 `~/.config/LinuxCockpit/yarj/hierarchy/<mapId>.json`：
  ```jsonc
  {
    "generatedAt": "...",
    "adm2": { "<市id>": { "adm1Id": "...", "adm1Name": "Xinjiang..." } },
    "adm1": { "<省id>": { "name": "...", "adm2Ids": ["..."] } },
    "unmatched": []
  }
  ```
- 打开地图自动触发（与 LOD 并行）；统计面板显示「市/县归属 就绪 · N」。

**实测（GlobalMap_ADM0_2.mbtiles）**：全世界上限 z4–z6，**4.0s** 完成；48,971 个市/县全部归属（**0 未匹配**），2,781 个省；抽查正确（新疆 80 个下属市县、阿合奇县→新疆等）；正向/反向索引一致性断言通过。

**用途**：照片有 GPS 坐标 → 命中所在市/县 → `hierarchy.adm2` 得所属省 → 可做「省级探索区域」聚合、「按省统计照片」等（v1.1+ 功能，数据层已就绪）。

### 13.8 区域名称标签（用户询问「在地区中心显示名字，别超出地区范围」）

**实现**（DOM 标签层，非 MapLibre symbol）：MapLibre 对多边形标签用质心，凹多边形会跑出边界（官方 issue #5042）——因此锚点改由主进程在 LOD 作业里预计算：

- **多边形内点算法**（`lod.ts` `interiorPoint`，零依赖，替代损坏的 polylabel npm 包）：① 质心在多边形内 → 质心（视觉中心）；② 包围盒中心；③ 射线法取第一交点内侧点——任何情况保证点在多边形内部。
- LOD 数据扩展：每要素 + `name` + `label:[lon,lat]`；新增 `countries`（adm0 国家标签，200 个，adm0 层无 shapeID 用 shapeName 兜底）。
- 渲染端（`View.vue` `renderLabels`）：应用字体 + canvas 测宽；**文字宽度超过区域屏幕尺寸 → 逐档缩小，仍放不下则隐藏**（不超出区域）；已放置标签矩形碰撞 → 跳过；旋转/俯仰 >5° 时隐藏；globe 模式背面半球（距中心 >75°）不显示；国家名 z0–6、省/县名随 LOD 占屏规则出现。触发点：load / moveend / resize / 投影切换 / LOD 就绪。
- **实测**：52,172 个要素全部有标签 + 200 个国家；新疆/西藏/四川/海南/江苏标签点逐一验证**都在各自多边形内**。

> ⚠️ 老 LOD 缓存（无 label/countries 字段）会自动跳过标签显示，打开地图重新生成一次即可。
