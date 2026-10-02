# Sports Routes

> Last updated: 2026-10-01

Bring in GPX, KML tracks (or indoor workout JSON) exported from your watch or fitness app to
draw them as glowing route lines, open a full workout detail board, replay the trip along the
track, and even back out where each photo was taken from the track itself.

## Importing tracks

**Settings → Travel Log → Route Folders**:

- **Route folders**: add folders holding GPX / KML files (multiple supported; reorder, remove).
  During scanning, a same-named `.json` is parsed as companion metadata (heart-rate zones,
  etc.), and standalone workout JSON without a matching GPX is imported as an indoor workout.
- **Scan all folders**: background scan of every route folder; new files are imported and
  records for files deleted from disk are pruned automatically.
- **Import single GPX file**: pick one `.gpx` / `.kml` file and import it immediately.
- The title chip shows "N tracks imported".

Imported routes show on the map once the routes layer is on.

## Sports routes drawer

Top menu → **Sports Routes** opens the drawer on the right (420px wide):

- **Search box**: searches route name / description / activity type / date, and also supports
  `:gps(lon, lat, km)` spatial filtering — e.g. `:gps(114.4, 30.5, 5km)` finds tracks crossing
  that area.
- **Type chips**: All / Cycling / Running / Walking / Hiking.
- While a route is focused, **Show all routes** appears on the right to clear the focus.
- Each route card: icon and name, distance / avg speed / duration / date, plus a badge row with
  average heart rate, calories, steps and device type (watch / phone / indoor). Three icons at
  the card's bottom-right (hover for names):

| Icon  | What it does                                                   |
| ----- | -------------------------------------------------------------- |
| Bulb  | Highlight this route and dim the others (click again to clear) |
| Chart | Open the full workout detail board                             |
| Trash | Remove this route record from the database                     |

Clicking the card itself flies the map to the route's extent.

## Route detail board

Click the chart icon to open the workout detail dialog: activity and device chips in the title
(outdoor cycling / running / walking / hiking / indoor), plus **Play Trip**, **Map Focus** and
**Route Geotag** buttons. Three tabs below:

- **Overview metrics**: big total-distance number, estimated calories; a grid of total time /
  moving time / average speed / max speed / average HR / elevation gain; then, only when data
  exists, "Dynamics" (average and best pace, total steps, average and max cadence, stride),
  "Heart Rate Zones" (five-segment stacked bar — warm up / fat burn / aerobic / anaerobic /
  extreme, each with duration and share), "Training Status" (TE, suggested recovery, load,
  VO2max), check-in location / HR sensor / elevation profile cards, and a strip of photos taken
  along the way.
- **Splits (N)**: one row per kilometer, the bar width proportional to that km's average speed,
  with speed and duration.
- **Route photos (N)**: a photo grid; a check mark means the photo carries track coordinates;
  click a photo to view it fullscreen.

## Playing a trip

Click **Play Trip** in the detail board (exit "My Exploration" first if it's running); the
playback bar slides up at the bottom:

- Top row: route name, live speed / elevation / HR chips; on the right **Surrounding Photos**
  (with a count badge), the camera-follow toggle (hover: "auto-follow ↔ manual free view"), the
  full-route visibility toggle, the other-routes toggle (cycles fully hidden → dimmed → normal),
  and exit playback.
- Middle row: the timeline progress bar with current time and elapsed on the left, current /
  total distance and total duration on the right; drag to scrub.
- Bottom row: play / pause, **−5m / −1m / +1m / +5m** fine jumps, the **Splits** drop-down
  (jump straight to a kilometer), and **Playback speed** 1x / 5x / 15x / 30x / 60x on the right.
- **Space** also toggles play / pause; dragging the map during playback switches to manual
  free view.

The **Surrounding Photos** drawer lists photos taken near the current moment; the time window
can be ±1 min / ±3 min / ±5 min / all photos on the route. Each photo shows its capture time,
its offset from the current moment ("now", "+N s") and its distance to the track head; click a
photo to view it fullscreen.

## Route geotagging

Align photo capture times to a GPX track, interpolate real positions from track points, and give
photos without GPS a coordinate. Entry points: **Footprint Building → Geotag Photos from
Routes**, or **Route Geotag** in the detail board.

1. **Select target track**: the drop-down lists each route's distance and date.
2. **Camera clock fine-tuning**: camera clocks often drift seconds to minutes against satellite
   time. The system auto-detects the workout's timezone offset (chip: "detected timezone offset:
   ±N hours"), then the slider fine-tunes within ±120 seconds; click "Reset (0s)" to zero it.
   If the camera runs slow, drag right.
3. **Live preview**: shows the matched and unmatched counts and up to five preview rows
   (thumbnail, capture time, interpolated coordinates, deviation from the original position in
   meters, or "newly geotagged").
4. When it looks right, click **Start background geotagging** at the bottom right — the job runs
   in the background with progress in the background tasks panel. To start over, click
   **Reset geotagged records (N)** at the bottom left to wipe the track coordinates
   (photos fall back to the next priority).

Geotag results take top priority (see the GPS priority list in
[Settings explained](../Settings/Options.md)); geotagged photos carry a check mark, and the `:gps(...)`
search syntax covers them too.

## GPS drift correction

With photos sorted by time, the displacement between neighbors divided by elapsed time is the
speed. Some photos' GPS jumps to another country or city (signal loss), and speed plausibility
catches them: the outlier is interpolated from the surrounding anchors into a separate field,
never overwriting the original record. Entry point: **Footprint Building → GPS Spatio-temporal
Correction**.

- The **Analysis & correction mechanism** card shows how many photos have been corrected and the
  priority note (corrected_gps > guess_gps > gps_in_db > exif).
- **Target gallery root**: with several gallery folders you can correct just one.
- **Maximum plausible speed**: presets Land 120 / High-speed rail 350 / Civil aviation 800 /
  Supersonic 1200 km/h, or custom between 60 and 1500; anything above is treated as an outlier.
- **Minimum drift distance** (20–500 km): only jumps larger than this are corrected, so normal
  movement inside a city is left alone.
- **Drift reference time window** (2–72 hours): the maximum span allowed between anchor and drift
  point.
- **Start background correction job** runs the analysis; **Cancel & reset all corrections**
  restores the original coordinates in one click.

Corrected photos show a "GPS Corrected" box (drift distance, speed, reason) on their cards and
in the info panel; `:corrected_gps` lets you filter for exactly those photos.

## Related commands

```bash
yarj.add-route-root --path ~/Tracks   # add a route folder
yarj.import-route-file --path ~/ride.gpx  # import a single GPX
yarj.scan-routes                      # background scan of route folders
yarj.routes --activity cycling        # query routes (by type / keyword)
yarj.route --id <routeId>             # single route detail
yarj.get-route-photos --routeId <id>  # photos matched to a route's time span
yarj.preview-geotag --routeId <id> --offset 0  # preview geotag matching
yarj.geotag-routes --routeId <id> --offset 0    # start background geotagging
yarj.clear-route-geotag               # clear track coordinates
```

Back to [Travel Log](../main.md) · Previous
[Photos, footprints & filters](../Photos/FootprintsAndFilters.md) · Next
[Settings explained](../Settings/Options.md)
