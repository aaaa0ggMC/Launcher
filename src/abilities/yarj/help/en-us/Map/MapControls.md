# Map Controls & Sources

> Last updated: 2026-10-01

This page covers the map itself: panning and zooming, the three layers, projection switching,
base-map switching and place search, plus MBTiles offline maps and the tile cache.

## Basic controls

| Action                 | Effect                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Left-drag              | Pan the map (works in every mode; dragging during camera-follow playback switches to manual view) |
| Scroll wheel           | Zoom toward the pointer; a 0.5x–2.0x sensitivity option lives in Settings                         |
| Double-click           | Smooth zoom in centered on the click (can be set to "None" in Settings)                           |
| Click a cluster bubble | Expands that group's photos (up to 100 at a time) into the right drawer and zooms in one level    |
| Click a single dot     | Opens the drawer with every photo at that coordinate (including overlaps)                         |
| Hover a dot / bubble   | Cursor turns into a pointer; turns into a pin cursor while picking coordinates                    |

The vertical control array at the bottom-right of the map (hover for names), top to bottom:

| Button         | What it does                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Compass        | Enter / exit "My Exploration" roaming (disabled during route playback)                                                         |
| **+** Zoom in  | Zoom in one level; adjusts playback camera zoom during camera-follow playback                                                  |
| **−** Zoom out | Zoom out one level                                                                                                             |
| Globe / map    | Switch between the 3D globe and the 2D flat map                                                                                |
| Crosshair      | Reset view: with a local MBTiles source, fits that map's coverage; otherwise fits all photos, or returns to the default center |

The initial projection and double-click behavior are in
**Settings → Travel Log → Preferences** (see [Settings explained](../Settings/Options.md)).

## The three layers

Top menu → **Layers** (or **Exploration & Granularity**):

| Layer          | Contents                                                                |
| -------------- | ----------------------------------------------------------------------- |
| Photo markers  | Clustered dots for GPS-tagged photos, colored with the theme accent     |
| Explored areas | Translucent glowing polygons + outline built from buffered photo points |
| Sports routes  | GPX / KML track lines, glow and track points                            |

While roaming, the "explored areas" and "photo markers" layers are temporarily hidden so only
the current stage and legs show; they come back when you exit.

## Explored areas & granularity

Top menu → **Exploration & Granularity**: the switch at the top toggles the explored-area
layer; below are five granularity presets, with a check mark on the active one. Each shows
"Time gap ≤ Xh · Dist ≤ Ykm"; larger granularity merges a whole trip into one coherent blob:

| Granularity        | Time window | Link distance | Good for                            |
| ------------------ | ----------- | ------------- | ----------------------------------- |
| Fine Walk          | ≤ 2 h       | ≤ 400 m       | City walks                          |
| Standard Day Trip  | ≤ 8 h       | ≤ 1.2 km      | A day out                           |
| Full Day Excursion | ≤ 24 h      | ≤ 4 km        | Road trips, full-day hikes          |
| Multi-Day Area     | ≤ 72 h      | ≤ 15 km       | Multi-day journeys                  |
| Massive Region     | ≤ 168 h     | ≤ 40 km       | Long-distance / cross-country trips |

The default granularity, footprint radius and polygon opacity live in
**Settings → Travel Log → Preferences → Fog-of-War & Footprint**.

## Switching base maps

Top menu → **Map Sources** lists every available base map with the active one highlighted.
Chip meanings:

- `GOOGLE` / `AMAP` / `TENCENT` / `CARTO` / `ARCGIS` / `OSM` / `TIANDITU` — the provider family;
- `TILES API` — Google official Map Tiles API (pay-as-you-go, needs a key);
- `GCJ-02` — this source uses China's encrypted datum with a few hundred meters of offset;
- local MBTiles sources appear as their own entries (`MBTILES` chip).

Built-in sources include Google hybrid / satellite / streets / terrain, Amap streets and
satellite, Tencent streets, CartoDB dark and voyager, ArcGIS World Imagery, OpenStreetMap,
OpenTopo, Tianditu satellite and vector, plus a custom XYZ source. Tianditu and the Google
official sources need an API Key, entered under
**Settings → Travel Log → Map Sources & Config → API Keys & Online Templates**.

> GCJ-02 note: coordinates picked or adjusted under such a source carry the datum offset so they
> align with domestic road networks; switch to a WGS-84 source (ArcGIS, OSM) and you'll see
> roughly a few hundred meters of difference. That's the datum, not a bug.

## Place search & jump

Top menu → **Search Place**: type a city, landmark or place (e.g. "Tokyo Tower"), press Enter or
click the magnifier. Results show the formatted address, coordinates and a provider chip;
click one to fly there smoothly.

## Statistics & tile cache

Top menu → **Statistics**: four cards show total photos, with GPS, without GPS and folder
count; below is the recent scan history (one row per run: status chip, folder name, total /
with GPS); at the bottom, the on-disk tile cache usage bar (used / quota, turns yellow past
90%).

Browsed online tiles are cached on disk so you can revisit them offline; the quota and clear
buttons are in **Settings → Travel Log → Map Sources & Config → Local Disk Tile Cache**.

## MBTiles offline maps

An MBTiles file is a single-file tile database; add it and you have a fully offline base map:

1. **Settings → Travel Log → Map Sources & Config → Offline MBTiles Maps** → **Add MBTiles File**, then pick a `.mbtiles` file.
2. Each row shows the zoom range, file path and default zoom; adjust the default with **− / +**
   within the file's own range, or remove it with the trash icon.
3. Select it under **Map Sources** in the top menu — entries are named "Local · <file>" and
   carry an `MBTILES` chip.

For local vector MBTiles, administrative-boundary LOD and city→province hierarchy data are
generated in the background the first time you open the map (progress in the background tasks
panel); they drive the province/city boundary lines and region-name labels at low zoom.

## Related commands

```bash
yarj.providers                            # list all providers and the active one
yarj.set-active-provider --id arcgis-sat  # switch the base map
yarj.maps                                 # list MBTiles files and metadata
yarj.add-map --path ~/maps/Global.mbtiles # add an offline map
yarj.cache-stats                          # tile cache usage
yarj.clear-cache --id google-hybrid       # clear one provider's tile cache
```

Back to [Travel Log](../main.md) · Next [Photos, footprints & filters](../Photos/FootprintsAndFilters.md)
