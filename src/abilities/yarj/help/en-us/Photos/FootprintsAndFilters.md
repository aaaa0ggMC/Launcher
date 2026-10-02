# Photos, Footprints & Filters

> Last updated: 2026-10-01

Everything about the photo side: the location photos drawer, the fullscreen viewer, editing and
adding coordinates, "My Exploration" roaming, search syntax and filter rules.

## Location photos drawer

Click a cluster bubble or a single dot on the map to slide out the "Location Photos" drawer
(420px wide):

- **Header**: shows "Location Photos (N)" and the coordinates; when the in-drawer filter is
  active it shows "filtered / total".
- **Relocate icon** (hover: "Relocate this photo group together"): moves the whole group to a
  new center while preserving relative spacing; in multi-select mode with boxes ticked, only the
  selected photos move (the icon carries a count badge).
- **My Exploration** button: starts journey roaming from this group of photos.
- **Filter box**: filters only the current list (filename, tags, notes…); the "?" button next to
  it opens the advanced syntax guide.
- **Load more photos (current/total)**: the list keeps paging as you scroll, or click the
  button; the batch size is configured in Settings.
- **Multi-select** switch at the bottom: turn it on to tick cards, which reveals **Select All**,
  **Deselect All** and **Relocate Selected**.

## Photo cards

One card per photo, top to bottom:

- Thumbnail: click for fullscreen; in multi-select mode, click to tick. A checkbox sits at the
  top-left and is always visible in multi-select. Videos get a camera badge.
- Filename and capture time; the address box (reverse-geocoded), the **GPS Corrected** box (with
  drift distance and reason), the **Estimated GPS Guess** box (see below); notes and tag chips
  (or an "Add Tag / Note" chip when empty).
- Bottom icon row, left to right (hover for names):

| Icon              | What it does                                             |
| ----------------- | -------------------------------------------------------- |
| Pencil            | Edit GPS, tags & note                                    |
| Braces            | Expand / collapse the full database metadata (JSON tree) |
| Map marker radius | Lookup address (reverse geocoding; needs GPS)            |
| Marker plus       | Pick / change coordinates on the map                     |
| Crosshair         | Center on map                                            |
| Copy              | Copy file path                                           |

The bottom-right corner holds **Show in Folder**.

## Fullscreen viewer & shortcuts

Click a thumbnail to open the fullscreen viewer: photo or video in the middle, details panel on
the right (open by default), and previous / counter / next at the bottom.

| Key                  | Action                            |
| -------------------- | --------------------------------- |
| Esc                  | Back to map                       |
| ← / →                | Previous / next                   |
| + / =                | Zoom in                           |
| - / _                | Zoom out                          |
| 0                    | Reset zoom and rotation           |
| R                    | Rotate clockwise 90°              |
| Shift+R or L         | Rotate counter-clockwise 90°      |
| I                    | Show / hide the details panel     |
| Wheel / double-click | Zoom / toggle between 2.5x and 1x |
| Left-drag            | Pan while zoomed in               |

Top toolbar, left to right: back to map, index, zoom in, zoom out, reset, rotate left, rotate
right, details, show in folder, close. Clicking the dark backdrop also exits.

Videos play in the embedded player; for codecs it can't decode (HEVC / H.265 10-bit and similar)
you get an **Open in System Player** fallback card.

The right panel shows: media type and resolution, camera and lens, exposure settings
(time / shutter / aperture / ISO / focal length), GPS location (coordinates, altitude,
correction and guess results), **Lookup Address**, **Add as Tag**, tags & notes editing, the
full JSON metadata, plus system-player and folder actions.

## Adding coordinates: pick, guess, solidify

- **Pick on the map**: click the marker-plus icon on a card or in the panel → a banner appears
  at the top ("Picking location: Click on the map…") with a floating preview of the photo at the
  right (hover to enlarge) → click the map to choose a point → a dialog shows the new and old
  coordinates, can optionally **Resolve Address (Optional)**, and **Confirm & Update** saves.
  Use **Cancel** on the banner or Esc to abort.
- **Estimated GPS Guess**: photos with no EXIF GPS whose capture time falls between two
  geotagged photos get an estimated midpoint, shown in a yellow "Estimated GPS Guess" box (with
  estimated distance and time delta). Click **Solidify Location** to write it in as a real
  coordinate, or **Pick Correct Location** to choose your own. Top menu →
  **Footprint Building → Recompute Guessed GPS** recomputes everything.
- **Group relocate**: the relocate icon in the drawer header moves the whole group (or the
  ticked selection) to a new center preserving relative spacing; the dialog shows the old center,
  new center and translation distance — **Confirm Relocation** applies it.

## My Exploration (journey roaming)

Enter via the compass icon at the bottom-right, **My Exploration** in the top menu, or the
**My Exploration** button in the photo drawer. The control panel slides up at the bottom and the
HUD capsule at the top shows the current stage date and time.

The panel has two rows:

- First row: the **Stage X / Y** chip (click it to type a stage number and jump, with shortcuts
  for first / 25% / 50% / 75% / last), the stage title and time range, the transport-mode chip
  (Flight / High-Speed Train / Driving / Walking-Cycling / Ferry / Local Sightseeing, with
  distance and estimated speed), and **Exit Exploration** at the right.
- Second row: the **Granularity** stepper (five presets; the drop-down offers **Custom Count**
  to cluster a huge library into a set number of stages, and **Reset to Preset**),
  **Jump to Stage**, the focus-scope icon (±3 / ±5 / ±8 stages or show all, fading distant
  stages and legs), **Stage Photos (N)**, previous / next stage, and **Auto Cruise / Pause**.

- **Space** also toggles play / pause.
- Cruise pacing (stage stay duration, camera flight pacing), auto-play on entry and
  auto-opening the photo drawer are all in
  **Settings → Travel Log → Preferences → Journey Shuttle & Cruise**.
- While roaming, the photo and explored-area layers are hidden to keep the stages and legs
  readable; they return when you exit.

## Photo search syntax

Top menu → **Photo Search**: typing searches filenames, tags, places, camera and notes; press
Enter and click **Show All Matches in Right Drawer** to browse in the drawer. The "?" button in
the input opens the full guide:

| Syntax                                         | Description                                      |
| ---------------------------------------------- | ------------------------------------------------ |
| `:has_gps` / `:no_gps`                         | Only photos with real GPS / without GPS or guess |
| `:guess_gps`                                   | Photos with an estimated midpoint                |
| `:corrected_gps`                               | Photos whose drift was corrected                 |
| `:gps(lon, lat, km)`                           | Photos within a radius of the given coordinates  |
| `:city("Beijing" or "Shanghai")`               | Capture city, boolean expressions allowed        |
| `:country("Japan")`                            | Capture country / region                         |
| `:tags("landscape" and "night")`               | Tag filter with and / or / not                   |
| `:comment("summer" and not "homework")`        | Note search                                      |
| `:appendix(key, value)`                        | Exact match on custom appendix metadata          |
| `:camera("Sony" and "A7M4")`                   | Camera make and model                            |
| `:lens("24-70" or "50mm")`                     | Lens model                                       |
| `:iso(> 800)` / `:f(<= 2.8)` / `:focal(>= 50)` | Numeric comparisons                              |
| `:year(2024 or 2025)`                          | Capture year                                     |
| `:date(2024-06-01..2024-08-31)`                | Capture date range                               |
| `"text and love"`                              | Quoted phrase, boolean expressions allowed       |
| `:has_gps and not :video`                      | Exclude videos, keep photos                      |

## Photo filter rules (Filter)

**Settings → Travel Log → Preferences → Photo display filter rules (Photo Filters)**.
Rules apply to both the map and photo lists — handy for hiding documents, screenshots and
other noise:

1. Click **Add filter condition**; it starts with a "AI type not in `["Document","Blackboard"]`"
   rule.
2. Each rule = field + operator + value. Pick the field from the drop-down (AI type / brief /
   OCR text, camera make / model, taken_at, tags, comment, path, file size, GPS lat/lon) or type
   any metadata key.
3. Operators: in / not in / contains / not contains / equals / not equals / is not empty /
   is empty / gt / lt. The value box is disabled for "is empty / is not empty".
4. Enter a JSON list (e.g. `["Document", "Blackboard"]`) or comma-separated text.
5. When the field is the AI type and the operator is in / not in, a row of category chips appears
   (Document, Blackboard, Screenshot, Portrait, Scenery, Food, …) — click to add or remove.
6. Each rule has an on/off switch and a trash icon; with no rules the map shows every geotagged
   photo.

## Related commands

```bash
yarj.photos --has-gps true            # query photos with GPS
yarj.photos --q "Tokyo"               # keyword query
yarj.update-photo --path /a.jpg --patch '{"tags":["night"]}'  # edit tags
yarj.reverse-geocode --lat 35.68 --lon 139.76 --lang en        # reverse geocoding
yarj.recompute-guesses                # recompute midpoint guesses
yarj.batch-update-gps --updates '[{"path":"/a.jpg","lat":35.1,"lon":139.2}]'
```

Back to [Travel Log](../main.md) · Previous
[Map controls & sources](../Map/MapControls.md) · Next [Sports Routes](../Routes/Tracks.md)
