# Theme and Motion

> Last updated: 2026-10-01

This page covers the four cards under **Settings → Appearance**: **Theme**, **Zoom**,
**Font** and **Animation**. Unless noted otherwise everything applies instantly — no
restart needed.

## Theme

**Theme** is the first card under Appearance: a grid of cards, one per color scheme, with
a swatch preview on top (background color plus dots for the primary and three accent
colors) and the theme name below. The current theme has a primary-colored border and a
check badge in its top-right corner. **One click switches** and the new id is written to
`theme` in `config.json`.

| Name in the UI     | Config value | Style                                           |
| ------------------ | ------------ | ----------------------------------------------- |
| Dark (Material 3)  | `dark`       | The default scheme                              |
| Light (Material 3) | `light`      | Light background, for daytime                   |
| Pure Black         | `pureblack`  | True black — saves power on OLED, high contrast |
| Moonlight (Indigo) | `moonlight`  | Cool indigo, easy on the eyes                   |
| Forest (Emerald)   | `forest`     | Deep emerald tones                              |
| Aurora (Violet)    | `aurora`     | Violet palette                                  |
| Rosy (Warm Pink)   | `rosy`       | Warm pink tones                                 |
| Sepia (Warm)       | `sepia`      | Warm paper feel, comfortable for long reading   |
| Slate (Cool Gray)  | `slate`      | Neutral cool gray                               |
| Follow system      | `system`     | Follows the OS light / dark preference          |

- **Follow system** is always the last card, drawn with a dashed border and a wand icon;
  the UI follows the OS in real time when it flips between light and dark.
- An unknown theme id in config.json falls back to `dark` — it can never break the UI.

### The switch animation (ripple reveal)

Whether switching themes animates is decided by the **Modern Motion** master switch in
the **Animation** card:

- **On**: the new theme expands from an origin as an accelerating ripple until it covers
  the screen; the origin is set by **Theme transition** (**From top-left corner** /
  **From mouse position** — the closer to the origin, the earlier it changes).
- **Off**: the theme swaps instantly with no animation (even hover lifts and other
  micro-motions stop).

## Zoom

**Zoom** is the second card: a **Scale** slider from 0.8 to 1.8 in steps of 0.05, with the
percentage shown on the right and **Small / Default / Large** labels at the ends.

- The scale is applied and written to config only when you **let go**; nothing changes
  while you drag, so you can pick a value with confidence.
- This is a true uniform scale (icons, spacing and text all scale) — not just font size.
- The default is 1.1 (110%).

## Font

**Font** is the third card with three options:

| Option                 | Behavior                                            |
| ---------------------- | --------------------------------------------------- |
| Default (Noto Sans SC) | Uses the bundled Noto Sans CJK stack                |
| Follow system          | Uses the platform UI font (`system-ui` and friends) |
| Custom font            | Takes a font family name installed on your system   |

- Picking **Custom font** reveals a **Font family** field (placeholder example
  `Noto Serif CJK SC / LXGW WenKai`); it saves on **blur or Enter**.
- An empty custom family falls back to the default stack, so the UI never degrades to a
  browser default.
- Changes apply instantly across the interface (the monospace stack is untouched).

## Animation

**Animation** is the fourth card (titled "Page Transition" inside), with four control
groups from top to bottom:

1. **Modern Motion** — the master switch.
   - On: theme changes ripple out from a configurable origin, and page transitions are
     enabled.
   - Off: all motion is disabled (the UI gets a `motion-off` class), themes swap
     instantly — hovers, drawers and Vuetify's internal transitions all stop.
2. **Enable transitions** — the master switch for transitions when switching ability
   pages; unadjustable while **Modern Motion** is off.
3. **Transition style** — five options (also locked when either switch above is off):

   | Option   | Effect                      |
   | -------- | --------------------------- |
   | Fade     | Opacity crossfade (default) |
   | Slide    | Horizontal push             |
   | Slide Up | Enters from below           |
   | Zoom     | Scale + fade                |
   | Flip     | 3D flip                     |

4. **Theme transition** — where the new theme expands from: **From top-left corner** or
   **From mouse position** (the pointer position at the moment you switch).
   Unadjustable while **Modern Motion** is off.

Every switch and option here saves and applies the moment you click it.

## Related commands

```bash
config.get                                  # current theme / uiScale / font / animations
config.set --patch '{"theme":"forest"}'     # switch theme directly
config.set --patch '{"uiScale":1.4}'        # set the scale
config.set --patch '{"font":{"mode":"system","family":""}}'
config.set --patch '{"animations":{"modernMotion":false,"enabled":false,"pageTransition":"slide","themeTransition":"cursor"}}'
```

Back to [Settings](../main.md).
