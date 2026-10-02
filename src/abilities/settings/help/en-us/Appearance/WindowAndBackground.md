# Window and Background

> Last updated: 2026-10-01

This page covers **Settings → Appearance → Window** (the full-width card). That card
manages three things: the window chrome and corners, the background source, and the Fuse
overlay that sits on top of the background.

> Remember the timing: **frameless / rounded take effect on next launch; background and
> Fuse apply instantly.** (The small note at the bottom of the card says the same.)

## Frameless and rounded

Two switches at the top of the card:

- **Frameless window**: drops the system title bar in favor of the in-app top bar.
  **Takes effect on next launch.**
- **Rounded window**: window corner rounding while frameless. **Takes effect on next
  launch.** Turning it on reveals the **Corner radius** slider (0–40px, step 1, default
  12); releasing applies it immediately — you can watch the corners change, and dialog
  scrims follow the same radius.

## Background

The **Background** dropdown has three options, with the selected item's description shown
in the small text underneath:

| Option            | Behavior                                                                 | Timing    |
| ----------------- | ------------------------------------------------------------------------ | --------- |
| Transparent       | No background drawn; the Fuse translucent overlay provides the base tint | Instantly |
| Image             | Uses a local image path you provide, supports Gaussian blur              | Instantly |
| Desktop Wallpaper | Reads the KDE desktop wallpaper automatically, supports Gaussian blur    | Instantly |

Picking **Image** adds an **Image path** row:

- Type the path directly (e.g. `/home/user/Pictures/wall.jpg`); it saves on blur;
- or click the folder icon inside the field (hover: "Select background image") and choose
  a file, supporting png / jpg / jpeg / webp / bmp / svg / gif / avif.

## The Fuse overlay

Fuse is a translucent overlay between the background and the content; it decides how much
background shows through:

- **Fuse overlay opacity** (0–100%): overlay strength, applies while dragging. At 100%
  the background is fully hidden; lower it to reveal the background.
- **Background image opacity** (0–100%): appears only when Background is **Image** or
  **Desktop Wallpaper**; controls how strong the picture is.
- **Background blur** (0–60px): Gaussian blur on the background, applies on release.

Layer order (verbatim from the note): `Background (bottom) → Fuse (middle) → Data (top)`.
Image visibility = **background image opacity × (1 − fuse overlay opacity)** — don't
max out both, or they cancel each other.

### Two common recipes

- **Clean solid look**: Background = Transparent, Fuse overlay opacity high (80%+).
- **Wallpaper peeking through**: Background = Desktop Wallpaper, Fuse overlay opacity
  around 30–60%, Background blur to taste (10–30px is pleasant), and lower the
  background image opacity if it's still too loud.

## Related commands

```bash
config.get     # current window config (frameless / rounded / background / fuse*)
config.set --patch '{"window":{"background":"wallpaper","fuseAlpha":0.45,"fuseBlur":20}}'
config.set --patch '{"window":{"frameless":false}}'    # back to system borders (next launch)
config.set --patch '{"window":{"rounded":true,"radius":16}}'
```

Back to [Settings](../main.md).
