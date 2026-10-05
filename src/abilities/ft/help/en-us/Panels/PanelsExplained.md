# Panels explained

> Last updated: 2026-10-01

This page walks through the four sections of the Fourier Transform right panel — **Info**,
**Controls**, **Vectors**, **Samples** — plus the floating toolbar: where each control is, its
exact label, and what it actually changes. Read [Fourier Transform](../main.md) first for the
basic flow.

## Mental model: a relay of arms

- Each arrowed line in the scene is one **vector** (arm): the first starts at the origin, the
  second at the first one's tip, and so on; the last arm's tip is the **pen**.
- Every vector rotates at a constant rate; the pen's path is the **track** — the reconstructed
  figure.
- "A figure = a sum of rotating vectors" is exactly what a discrete Fourier transform (DFT)
  does: sample the outline, recover each harmonic's amplitude and frequency, and turn them
  into one vector's length and period each.

## Floating toolbar (top-left of the canvas)

| Button            | Hover label  | What it does                                                                                          |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| Play / Pause icon | Pause / Play | Toggle the simulation. Shows the pause icon (green) while running; time freezes when paused           |
| Eraser            | Repaint      | Reset sim time to zero, clear the track, redraw from the current vectors (parameters untouched)       |
| Crosshairs        | Reset view   | Default framing: target back to origin, zoom back to default, 3D azimuth back to 45° / elevation ~31° |
| Target            | Follow tip   | Lock the camera onto the pen; panning is disabled while on (button turns primary color)               |
| Square / cube     | 3D view      | Toggle 2D / 3D; in 3D you can right-drag to orbit                                                     |
| Rotate 3D         | Touch rotate | 3D only: single-finger drag rotates instead of panning — orbit without a right mouse button          |

## Info section

Read-only live status (refreshed every 250ms):

| Field    | Meaning                                           |
| -------- | ------------------------------------------------- |
| Status   | Running / Paused                                  |
| FPS      | Current frame rate / peak since the page opened   |
| Sim time | Seconds accumulated from 0, scaled by Speed       |
| Vectors  | Number of vectors in the chain                    |
| Points   | Track points drawn / track point limit            |
| Tip      | Pen coordinates; (x, y, z) in 3D, (x, y) in 2D    |
| View     | 2D or 3D                                          |
| Zoom     | Multiple of the default framing; ×1.00 is default |

## Controls section

### Playback row

Three buttons at the top: the full-width **Pause / Play**, then **Repaint** and **Reset view**
(same actions as the toolbar buttons).

### Three switches

| Switch     | What it does                                                           |
| ---------- | ---------------------------------------------------------------------- |
| Follow tip | Camera tracks the pen, handy when the pen runs off-screen              |
| Neon trail | Glow effect on the track (visual only, no data change)                 |
| 3D view    | Toggle 2D / 3D; orbit needs 3D, and the Cover region becomes a surface |

### Five display checkboxes

| Checkbox     | What appears on the canvas                                          |
| ------------ | ------------------------------------------------------------------- |
| Vectors      | The arms themselves (arrowed segments)                              |
| Cover        | The region each vector's tip sweeps (circles in 2D, surfaces in 3D) |
| Axes         | X / Y / Z axes                                                      |
| Track        | The pen's path — the figure itself                                  |
| Final vector | The straight line from the origin to the pen                        |

### Two sliders

| Slider      | Range / step     | What it changes                                                                                                |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Speed       | 0.05 – 4 (0.05)  | How fast sim time flows. 0.05 for slow-motion detail, 4 to skim; no effect while paused                        |
| Track limit | 200 – 8000 (200) | Maximum points kept in the track; oldest are dropped beyond it. Lower saves memory, longer keeps a longer tail |

## Vectors section

An editable table, one row per vector; the hint line above the table spells out the columns:

| Column | Meaning                                                                                     |
| ------ | ------------------------------------------------------------------------------------------- |
| \|v\|  | Arm length — this vector's share of the figure                                              |
| T_θ    | Period about X (seconds per round). 0 = this arm doesn't tilt, it only turns in-plane       |
| T_φ    | Period about Z (seconds per round) — the classic epicycle axis; 0 = static (a fixed offset) |
| θ₀     | Initial polar angle (degrees). 90 = starts in the XY plane; 0 / 180 = starts at +Z / −Z     |
| φ₀     | Initial azimuth (degrees) — which way it faces on frame one                                 |

Buttons and states:

- **Update**: apply the table as the new vector set — time resets, track clears, view reframes.
- **Load file**: pick a JSON file to read (format on the main page).
- Red text above the table: this operation's error (the specific load / export failure).
- **Add vector**: appends a row with defaults length 50, θ₀ 90, φ₀ 0, T_θ 0, T_φ 1.
- The × icon at the row's end (hover "Remove this vector") deletes that row.
- An empty table shows "No vectors — add one or load a file".
- **Export vectors**: writes the table's vectors plus the current speed and track limit to JSON.

> With T_θ = 0 you have the textbook 2D epicycle. Give one vector a non-zero T_θ and it also
> rotates about X, twisting the whole chain into a solid — that's how Torus and 3D Random work.

## Samples section

A two-column grid of preset buttons — click to load; the active preset is highlighted. The
vector composition of each preset:

| Preset    | Vector composition                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Circle    | One static zero vector + one vector, length 120, T_φ = 1 s/round                                                |
| 3D Circle | One static zero vector + one vector with T_θ = 1 s/round only; the circle turns in the YZ plane                 |
| Torus     | One vector length 100, T_φ = 1 s/round + one along Z with T_θ = 0.25 s/round (fast polar wobble)                |
| Limacon   | Two co-directional vectors, T_φ = 1 s/round and 2 s/round                                                       |
| Cardioid  | The cardioid's parametric equation sampled, then DFT'd with 24 harmonics                                        |
| Square    | A square's edges sampled, then DFT'd with 50 harmonics (corners need many terms, hence ringing)                 |
| Star      | A five-point star polyline sampled, then DFT'd with 45 harmonics                                                |
| Heart     | The heart's parametric equation sampled, then DFT'd with 30 harmonics (smooth curve, tiny coefficients dropped) |
| Random    | 10–15 randomly generated vectors per load; 3D mode spreads directions uniformly on the sphere                   |

## Back

- [Fourier Transform](../main.md)
