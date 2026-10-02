# Settings Explained

> Last updated: 2026-10-01

Travel Log adds four sections to the Settings page: **Gallery Folders**, **Route Folders**,
**Map Sources & Config** and **Preferences**. Nearly every change saves immediately (a
"Preferences updated and saved" toast pops up).

## Gallery folders

The data source for photo metadata. The scanner collects photos from these folders and parses
EXIF (including GPS).

- **Folder {n}**: read-only path; reorder with **Move up / Move down** (higher wins), remove with
  the trash icon (**Remove folder**).
- Bottom input: paste a path or pick one with the folder icon, then **Add**.
- Shows "Not configured" when empty. After adding folders, remember to click **Scan** in the
  page's top menu — until then nothing is plotted.

## Route folders

Where GPX / KML tracks come from; the UI mirrors Gallery Folders (add / move up / move down /
remove) with two extra actions:

- **Scan all folders**: background scan; same-named `.json` files are parsed as companion
  metadata (heart-rate zones, etc.), standalone workout JSON without a matching GPX is imported
  as an indoor workout, and records for deleted files are pruned after the scan.
- **Import single GPX file**: manually pick one `.gpx` / `.kml` to import.
- The title chip shows "N tracks imported"; the refresh icon re-reads the list.

## Map Sources & Config

Four cards.

### Active map source

- **Active map source** (drop-down): chooses the base map for the main view. Chips mark the
  family (GOOGLE / AMAP / TENCENT / CARTO / ARCGIS / OSM / TIANDITU / TILES API / MBTILES) and
  GCJ-02 sources get an extra yellow badge; selecting a GCJ-02 source shows a warning about the
  datum offset.
- **Map label language**: follow the Cockpit app language (auto) / Simplified Chinese /
  Traditional Chinese / English / Japanese / Korean / native local language. Each language has
  its own cache partition, so switching doesn't re-download tiles.

### API keys & online templates

- **Google Maps API Key**: for Google satellite, hybrid, streets and terrain maps
  (100,000 free tile requests per month). Click the eye icon to show/hide; saving happens on
  blur.
- **Tianditu API Key (Token)**: required for Tianditu satellite and vector maps.
- **Custom XYZ tile URL template**: for self-hosted tile servers; supports the placeholders
  `{z}` `{x}` `{y}` `{-y}` `{s}` `{r}` `{apiKey}`.
- **Save Settings** saves all keys and templates manually.

### Local disk tile cache

- **Enable disk cache** (switch): browsed online tiles are cached to disk for offline use and to
  avoid re-spending API quota.
- The chip next to it shows total cache size and tile count; **Clear All Cache** wipes it.
- **Cache limit quota**: 500 MB / 1 GB (default) / 2 GB / 5 GB / 10 GB / unlimited; over the
  limit old tiles are evicted LRU-style, and the usage bar turns yellow past 90%.
- **Provider cache partitions**: per-provider usage with a trash icon per row to clear just that
  provider.

### Offline MBTiles maps

- **Add MBTiles File**: pick a `.mbtiles` file; invalid or duplicate files are rejected with a
  message.
- Each row: zoom range (z0–z18, a red "Read failed" chip on error), file path, **default zoom**
  (− / + within the file's own range), and a trash icon to remove.
- After adding, select it under **Map Sources** in the top menu.

## Preferences

Seven groups; every change applies and saves immediately.

### 1. Map & view preferences

| Option                  | Values                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| Default projection      | Remember last view state (recommended) / 3D globe / 2D flat map (Mercator) |
| Startup view rule       | Auto-fit all photos (default) / restore last position & zoom               |
| Annotation language     | Follow system (default) / zh-CN / zh-TW / English / local native           |
| Double-click action     | Smooth zoom in (default) / none (prevent accidental clicks)                |
| Scroll zoom sensitivity | 0.5x–2.0x slider                                                           |

### 2. Journey shuttle & cruise

| Option                                     | Description                                                          |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Camera flight pacing                       | Smooth 1.5s (recommended) / cinematic 2.5s / brisk 0.8s / instant 0s |
| Default cruise focus scope                 | ±3 / ±5 (recommended) / ±8 stages / show all                         |
| Cruise stage stay duration                 | 1.0–6.0 s slider                                                     |
| Auto-play cruise when entering exploration | Switch                                                               |
| Auto-open stage photos drawer on cruise    | Switch                                                               |

### 3. Fog-of-War & footprint

Controls the look of the "explored areas" (roads traveled) polygon layer — a larger radius makes
the footprint cover more ground.

| Option                                | Range / values                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Default spatiotemporal granularity    | Fine walk / standard day trip / full day excursion / multi-day area / massive region |
| Default footprint radius              | 30–300 m slider                                                                      |
| Footprint fill opacity                | 20%–90% slider                                                                       |
| Photo markers layer shown by default  | Switch                                                                               |
| Explored areas layer shown by default | Switch                                                                               |

### 4. UI & performance

| Option                                    | Values                                                     |
| ----------------------------------------- | ---------------------------------------------------------- |
| Side drawer sliding batch size            | 20 / 30 (recommended) / 50 / 100 photos                    |
| Time-shuttle HUD style                    | Prominent neon HUD (recommended) / minimal translucent     |
| Photo cluster density                     | Tight (35px) / standard (50px, recommended) / loose (70px) |
| Auto incremental scan silently on startup | Switch                                                     |

### 5. Route playback & track smoothing

| Option                                           | Description                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| Enable route track smoothing (reduce GPS jitter) | Filters micro-jitter from the track                              |
| Enable camera follow damping (gimbal stabilizer) | Steadier camera during playback                                  |
| Smoothing window strength                        | 3–15 points (Gaussian kernel); only visible when smoothing is on |

### 6. Photo display filter rules (Photo Filters)

Field + operator + value filtering that applies to the map and photo lists; see
[Photos, footprints & filters](../Photos/FootprintsAndFilters.md).

### 7. GPS coordinate priority

A photo can carry several sources of coordinates; the first available one in this order wins:

| Priority | Source                  | Produced by                                               |
| -------- | ----------------------- | --------------------------------------------------------- |
| 1        | GPX track interpolation | Route geotagging — snaps precisely onto the ride/run path |
| 2        | Drift corrected         | Result of GPS drift correction                            |
| 3        | Smart guess             | Midpoint estimate between neighboring photos              |
| 4        | Database                | Coordinates you picked, saved or solidified by hand       |
| 5        | EXIF GPS                | Original coordinates written by the camera / phone        |

Use **Move up / Move down** on each row to reorder (saves immediately), or
**Restore Default Priority** in the section header.

At the bottom of the section there's also **Reset all preferences to defaults** (red), which
resets every preference above.

## Related commands

```bash
yarj.config                                  # read the current config
yarj.save-config --patch '{"exploredRadiusM":120}'  # change one preference
yarj.add-root --path ~/Pictures              # add a gallery folder
yarj.move-root --path ~/Pictures --dir 1     # reorder gallery folders
yarj.set-map-zoom --id <mapId> --zoom 4      # set an MBTiles default zoom
yarj.set-gps-priority --priority '["track","corrected","guess","db","exif"]'
```

Back to [Travel Log](../main.md) · Previous [Sports Routes](../Routes/Tracks.md)
