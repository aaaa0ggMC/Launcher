# Fourier Transform

> Last updated: 2026-10-01

The Fourier Transform page is a teaching visualization: a chain of rotating vectors (epicycles)
whose tip traces out a figure — exactly the figure a discrete Fourier transform (DFT) reconstructs
from an outline. Switch between 2D and 3D views, tweak every parameter, load a preset or build
your own vector set, and watch the time-domain figure ↔ frequency-domain harmonics correspondence
directly.

> Quick start: the page opens on the "Circle" preset and plays automatically; click **Heart** or
> **Square** in the **Samples** panel to see a chain of vectors tracing a complex shape.

## What it does

- The classic epicycle demo: each vector spins at its own period and the chain's tip draws the
  track (default preset "Circle", playing on open).
- 2D / 3D views: in 3D vectors can rotate in any direction on the sphere and sweep genuine
  solids.
- Nine built-in presets: Circle, 3D Circle, Torus, Limacon, Cardioid, Square, Star, Heart,
  Random.
- Edit vectors by hand: length, both rotation periods (T_θ / T_φ) and the initial angles
  (θ₀ / φ₀), applied instantly.
- Display toggles: axes, vectors, track, final vector, swept cover, neon trail, follow tip.
- Load / export vector JSON files to share or reproduce a figure.
- Canvas colors follow the active theme — switching themes doesn't require a reload.

## UI at a glance

| Area             | Where                              | Description                                                       |
| ---------------- | ---------------------------------- | ----------------------------------------------------------------- |
| Canvas           | Left side (about 2/3 of the width) | Main view, origin centered; the chain and track render here       |
| Floating toolbar | Top-left of the canvas             | 5 icon buttons (below); hover shows each name                     |
| Right panel      | Right side, ~312px wide            | Title "Fourier Transform" + collapse button + 4 sections          |
| Collapse button  | Far right of the panel title row   | Chevron icon; collapses to a single chevron and the canvas widens |

The floating toolbar at the top-left of the canvas, left to right:

| Button (hover name) | Action                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| **Pause / Play**    | Pause or resume the simulation (shows the pause icon, green, while running) |
| **Repaint**         | Reset time to zero, clear the track and redraw from the current vectors     |
| **Reset view**      | Restore the default framing and zoom (pan / orbit reset too)                |
| **Follow tip**      | Lock the camera onto the chain's tip (primary color when on)                |
| **3D view**         | Toggle 2D / 3D (cube icon, primary color, in 3D)                            |

The right panel holds four sections: **Info**, **Controls**, **Vectors**, **Samples**; Info and
Controls are expanded by default, and clicking a title bar expands / collapses any section.
Every control is explained in [Panels explained](Panels/PanelsExplained.md).

## Common tasks

### Basic flow: turn one knob, watch the wave change

1. Click a preset in the **Samples** panel (e.g. Square) — the figure redraws and plays from zero.
2. Drag **Speed** in the **Controls** panel down (0.05–4) to watch the harmonics in detail;
   up to watch a whole period in seconds.
3. Uncheck **Track** to see only the vectors, or check **Cover** to see the region each vector
   sweeps.
4. Click **Repaint** to start over, or **Pause** to freeze a moment and inspect the angles.
5. Lost in the view? Click **Reset view** in the floating toolbar.

### 2D / 3D and camera control

- **3D view**: switches to a perspective camera (initial azimuth 45°, elevation ~31°); vectors
  with a polar period twist the chain into solids (try the Torus preset).
- **Mouse wheel**: zoom in / out (2D dolly, 3D orbit radius; the range is clamped).
- **Left-drag**: pan the view (2D and 3D; disabled while Follow tip is on).
- **Right-drag**: orbit the view (3D only; the canvas context menu is suppressed).
- **Reset view**: back to the default framing; with Follow tip on, the camera tracks the tip.

### Use presets

The **Samples** panel is a two-column grid of buttons — click to load; the active preset is
highlighted (primary color); each button's tooltip shows its description:

| Preset    | Tooltip                               | What to look for                                           |
| --------- | ------------------------------------- | ---------------------------------------------------------- |
| Circle    | Single vector · classic circle        | One vector draws a circle — the simplest default           |
| 3D Circle | Vertical circle · polar rotation only | A circle in the YZ plane, polar rotation only              |
| Torus     | Two periods · 3D swept region         | Two periods sweep a torus (turn on Cover + 3D)             |
| Limacon   | Two vectors · limacon                 | Two circles of different periods added                     |
| Cardioid  | Cardioid · DFT                        | A cardioid from a few harmonics                            |
| Square    | Square · Gibbs ringing at corners     | Gibbs ringing at the corners — why so many terms           |
| Star      | Five-pointed star · DFT               | A polyline figure, also DFT-reconstructed                  |
| Heart     | Heart · surprisingly few vectors      | A smooth curve — only a handful of vectors needed          |
| Random    | Random vectors · doodle               | Different every load; in 3D mode generates true 3D vectors |

The page opens on Circle by default.

### Edit vectors yourself

The **Vectors** panel is an editable table, one row per vector, columns:

| Column | Meaning                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------- |
| \|v\|  | Vector length (arm radius)                                                                          |
| T_θ    | Rotation period about X (seconds per round, polar); 0 = no rotation, lifts the circle off the plane |
| T_φ    | Rotation period about Z (seconds per round, the classic epicycle); 0 = static offset                |
| θ₀     | Initial polar angle (degrees; 90 = XY plane)                                                        |
| φ₀     | Initial azimuth (degrees)                                                                           |

Flow: edit the numbers → click **Update** (time resets, track clears, redraw).
**Add vector** appends a row (defaults: length 50, θ₀ 90, φ₀ 0, T_θ 0, T_φ 1);
the × icon at the end of a row removes it. Errors (e.g. non-numeric input) appear in red above
the table; an empty table shows "No vectors — add one or load a file".

### Load and export JSON

- **Load file**: a system file picker (JSON only) → applied immediately on read.
  Eight example files ship with the ability (in the source tree at
  `src/abilities/ft/examples/`: circle, line, limacon, cardioid, triangle, square, star, heart);
  the UI doesn't list them for you — find them in the picker.
- **Export vectors**: a save dialog (default `vectors.json`) writes the current table's vectors,
  speed and track limit.
- File format: `{"vectors": [{"x":0,"y":120,"secperRound":1}, ...], "runSpeed":1, "verticesLimit":4096}`;
  a bare array is accepted too. Legacy `orot` / `orotX` phase fields still load (folded into the
  initial direction).

## Read more

- [Panels explained](Panels/PanelsExplained.md): the Info / Controls / Vectors / Samples sections
  item by item, plus what each slider, switch and column actually changes.
- The mental model on that page: vectors chain tail-to-tip, the last one's tip is the "pen",
  the pen's path is the track, and each preset's vectors are what a DFT of that outline produces.

## Command line

Presets and file I/O are commands; the UI is just a wrapper:

```bash
ft.presets                                       # list all presets and their descriptions
ft.load --name heart                             # load a preset (--mode 3d generates 3D random vectors)
ft.load-file --path /abs/vectors.json            # load vectors from a JSON file
ft.export --path /abs/vectors.json --data '{"vectors":[]}'   # export vectors to JSON
```

## FAQ

**Canvas is blank / frozen?** Switching to another ability page pauses the animation (sim time
doesn't advance); it resumes when you come back. If it stays stuck, click **Play** or
**Repaint**.

**The track suddenly got shorter?** The track has a point cap (default 4096, adjustable to
200–8000 under Controls → Track limit); older points are dropped to save memory.

**Right-drag does nothing in 3D?** Orbit only works with **3D view** on — enable it first.

**Follow tip is on but panning stopped working?** Follow tip locks the camera to the tip and
disables panning; turn it off or click **Reset view**.

**Can I add my own preset buttons?** The presets come from the `ft.presets` command; adding one
is a code change in presets.ts, not a UI feature.
