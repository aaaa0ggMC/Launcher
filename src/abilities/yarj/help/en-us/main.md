# Travel Log

> Last updated: 2026-10-01

Travel Log turns your photo library into a map of where you've been: it scans gallery folders,
reads EXIF GPS coordinates, plots the photos, and connects them into the areas you explored.
It supports offline MBTiles maps plus online base maps (Google, CartoDB, ArcGIS, Tianditu),
and can turn exported GPX / KML tracks into "Sports Routes" you can replay end to end.

Photo metadata lives in `~/.config/LinuxCockpit/yarj/metadata.db`; preferences and folder
settings live in `~/.config/LinuxCockpit/yarj/config.json`. Your original images stay where
they are — they are never copied or modified.

> Quick start: **Settings → Travel Log → Gallery Folders**, add your photo folders, then come
> back here and click **Scan** in the top drop-down menu. Photos with GPS appear on the map.

## What it does

- Footprint map: EXIF GPS points, burst shots auto-clustered into bubbles that open the whole group.
- Explored areas: photo points buffered and merged into "roads you traveled", with five
  granularity presets from a city walk to multi-week trips.
- My Exploration (journey roaming): stages your photos by time, auto-flies through them with a
  time-shuttle HUD, and can auto-cruise.
- Sports Routes: GPX / KML track folders or single-file import, route layer, full workout detail
  board, per-km splits and trip playback.
- Advanced geotagging: route-based photo matching, GPS drift correction, midpoint guessing for
  photos without GPS, one-click solidify.
- Works offline: MBTiles local base maps plus an on-disk tile cache.

## UI at a glance

| Area                   | Where                                                        | Description                                                          |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Top drop-down menu     | Small chevron handle centered at the top of the page         | Entry point for almost every feature (see table below)               |
| Map                    | Main body                                                    | Base map + photo clusters + explored areas + sports routes layers    |
| Control array          | Bottom-right of the map, 5 vertical translucent icon buttons | My Exploration / Zoom in / Zoom out / Toggle globe·flat / Reset view |
| Location photos drawer | Right edge, 420px wide                                       | Opens when you click a photo point on the map                        |
| My Exploration panel   | Bottom center                                                | Appears during journey roaming                                       |
| Route playback bar     | Bottom center                                                | Appears while playing a sports route                                 |
| Pick / relocate banner | Top center                                                   | Appears while picking coordinates or relocating a group of photos    |
| Time-shuttle HUD       | Top center                                                   | Shows the current stage's date and time while roaming                |
| Map error              | Top of the map                                               | Shows the reason when the base map fails to load                     |

All icon buttons are text-free — **hover to see their names** (e.g. "Zoom in", "Reset view").

### What's in the top drop-down menu

Click the handle at the top to expand the main menu, 11 items in total:

| Item                          | What it does                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| **My Exploration**            | Enters journey roaming: stages all photos by time and flies through them                |
| **Photo Search**              | Search by filename / tag / place / camera / note; the "?" button opens the syntax guide |
| **Sports Routes**             | Opens the routes drawer on the right                                                    |
| **Search Place**              | Type a place name (e.g. "Tokyo Tower") and fly to it                                    |
| **Map Sources**               | Switches the base map; a chip shows the active source, GCJ-02 sources get a datum badge |
| **Scan**                      | Re-scans all gallery folders and rebuilds metadata; the icon spins while running        |
| **Statistics**                | Photo totals / with GPS / no GPS / folders, recent scan history, tile cache usage       |
| **Exploration & Granularity** | Explored-area layer toggle plus five granularity presets                                |
| **Layers**                    | Toggles for photo markers / explored areas / sports routes                              |
| **Footprint Building**        | The three advanced geotagging tools                                                     |
| **Prune Missing Records**     | Removes metadata for photos deleted from disk                                           |

## Common tasks

### First run: add gallery folders and scan

1. Click the gear icon at the right of the top app bar to open
   **Settings → Travel Log → Gallery Folders**.
2. Paste a photo folder path (e.g. `/home/user/Pictures`) or pick one with the folder icon in
   the input, then click **Add**. Add as many as you like; reorder with **Move up / Move down**,
   remove with the trash icon.
3. Back on the Travel Log page, click **Scan** in the top menu. Scanning runs as a background
   task — watch progress in the sidebar's background tasks panel.
4. When it finishes, GPS-tagged photos are plotted automatically; photos without GPS get a
   midpoint "guess" (see [Photos & Footprints](Photos/FootprintsAndFilters.md)).

> Adding a folder without scanning leaves the map empty.

### Look at photos from a place

1. **Drag** to pan, **scroll** to zoom.
2. Photo points cluster into bubbles with a count. **Click a bubble** to zoom in one level and
   expand that group's photos into the right drawer (up to 100 at a time).
3. Zoom in until single dots appear, then **click a dot** to open the "Location Photos" drawer
   with every photo at that coordinate (including exact overlaps).
4. Click a thumbnail in the drawer to open the fullscreen viewer; click the crosshair icon on a
   card ("Center on Map") to fly the map back to that photo.

### Fix coordinates, tags and notes

- Click the pencil icon on a card ("Edit GPS, Tags & Note") to change coordinates, tags and
  notes, or **pick coordinates on the map**.
- For photos that already have GPS, **Lookup Address** reverse-geocodes the coordinates, and
  **Add as Tag** stores the place name as a tag.
- Whole group shot at the wrong spot? The relocate icon in the drawer header (badge shows the
  selected count) moves the group while preserving relative spacing.

### Switch the base map

Top menu → **Map Sources** → pick a base map. Tianditu needs an API Key from Settings, and the
Google official Tiles API sources are pay-as-you-go. Domestic Chinese sources (Amap, Tencent,
Google China endpoints) use the GCJ-02 datum with a few hundred meters of offset — you'll see a
yellow badge when one is active.

### Toggle globe / flat

Use the globe/map icon in the bottom-right control array ("Toggle globe / flat") to switch
between the 3D globe and the 2D flat map. The crosshair icon ("Reset view") instantly fits all
your photos.

### Cruise through your journey

Click the compass icon in the bottom-right or **My Exploration** in the top menu to enter
journey roaming: a control panel slides up at the bottom and the HUD capsule shows the current
stage time. Press **Auto Cruise** to fly through stages automatically; Space works too.
Details in [Photos & Footprints](Photos/FootprintsAndFilters.md).

### Play a sports route

Top menu → **Sports Routes** → click the chart icon on a route card to open the detail board →
**Play Trip** to replay the route at 1x–60x speed. Details in [Sports Routes](Routes/Tracks.md).

## Read more

- [Map controls & sources](Map/MapControls.md): pan/zoom, layers, projection, base maps, MBTiles, place search.
- [Photos, footprints & filters](Photos/FootprintsAndFilters.md): photo drawer, fullscreen viewer, roaming, search syntax, filter rules.
- [Sports Routes](Routes/Tracks.md): GPX/KML import, detail board, trip playback, route geotagging.
- [Settings explained](Settings/Options.md): every option in the four settings sections.

## Privacy and security

- Photo GPS, activity routes, journey stops and addresses are a **sensitive** privacy scope:
  AI snapshots, screenshots and remote access are redacted for this range, and the map plus
  drawers are marked accordingly.
- You can request clearance for the agent to see this data in plain text — you approve it
  yourself in the consent window.
- Reverse geocoding and place search send the coordinates / query to a third-party geocoding
  service (Google when a key is set, otherwise OpenStreetMap Nominatim); purely local actions
  (MBTiles, database queries) make no network requests.

## Command line

Every step in the UI is also a CLI command:

```bash
yarj.scan                                  # scan gallery folders and build metadata
yarj.scan-status                           # photo totals / with GPS / recent scans
yarj.add-root --path /home/user/Pictures   # add a gallery folder
yarj.maps                                  # list MBTiles map files
yarj.set-active-provider --id google-hybrid # switch the base map
yarj.geocode --query "Tokyo Tower" --lang en  # place name -> coordinates
yarj.photos --has-gps true                 # query photos with GPS
yarj.update-photo --path /a.jpg --lat 35.68 --lon 139.76  # update a photo's coordinates
```

## FAQ

**The map only says "No photos yet"?** No gallery folder is configured or nothing has been
scanned. Add folders under **Settings → Travel Log → Gallery Folders**, then click **Scan** in
the top menu. If it says "Indexed N photos, but none contain GPS geotags", those photos have no
location data — use the **Footprint Building** tools to add coordinates.

**Base map fails to load / blank map?** An error appears at the top. For online sources check
your network and API keys (Google official and Tianditu require keys), switch to another
source, or add an MBTiles offline map.

**Photo positions are off by a few hundred meters?** You're on a GCJ-02 datum source (Amap,
Tencent, Google China endpoints). Coordinates picked or adjusted under such a source carry that
offset so they align with domestic road networks; viewed on a WGS-84 source (ArcGIS, OSM) the
difference shows up. That's the datum, not a bug.
