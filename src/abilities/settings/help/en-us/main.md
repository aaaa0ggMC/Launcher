# Settings

> Last updated: 2026-10-01

Settings is the single configuration entry point for Linux System Cockpit: the shell's
own appearance, window, animation, language and sidebar options, plus the settings every
ability injects for itself — all on one page. Most changes apply **instantly**; a few
(frameless window, rounded corners) take effect the next time you launch. Everything is
written to `~/.config/LinuxCockpit/config.json`, and a copy of the previous version is
kept as `config.json.bak` before every write.

> Quick start: click **Settings** in the sidebar (System group) → pick **Appearance** in
> the left nav → click a **Theme** card to switch color schemes instantly; drag the
> **Zoom** slider and let go to apply the scale.

## What it does

- Color schemes: 10 themes (including follow-system light / dark); theme switching can
  animate as a ripple reveal.
- Zoom and font: scale and retype the whole interface, great for HiDPI screens.
- Window shape: frameless window, rounded corners with radius, background (transparent /
  image / desktop wallpaper) and the Fuse overlay.
- Motion: modern-motion master switch, page-transition style, and where the theme
  reveal starts.
- Language: switch between 中文 and English.
- Sidebar: alphabetical / usage-frequency / recently-used / custom drag ordering, plus a
  one-click usage-record reset.
- Ability toggle: enable / disable an ability at runtime (temporary, not persisted).
- Collects every ability's injected settings (Balance, AI DJ, Lyrics, Player, Journey
  Records, Apps, Dashboard, AI & Remote …) so you don't have to hunt for them.

## UI at a glance

Master–detail layout: category nav on the left, the active category's cards on the right.

| Area              | Where                                           | Description                                                                                                                  |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Page header       | Top of the content (hidden when narrow)         | The "Settings" title and the caption "Settings injected by each ability · search matches categories and individual settings" |
| Search box        | Top of the left nav; in the top bar when narrow | Placeholder "Search settings…", with a × to clear                                                                            |
| Category nav      | Left rail (~200px, scrolls on its own)          | "General" group on top (the shell's own settings), then one group per ability category                                       |
| Setting cards     | Right content (scrolls on its own)              | One card per setting, two columns by default; Window / Sidebar / Ability toggle span the full width                          |
| Category dropdown | Top bar when narrow                             | "Settings category" picker, grouped with subheaders                                                                          |

Behaviors worth knowing:

- **Narrow mode**: below 620px of container width the left nav collapses into a search
  box plus a category dropdown at the top — no horizontal scrolling.
- **Search**: typing filters live. The nav keeps only matching categories and the
  content lists every matching setting with a "{n} settings" count on top. Search covers
  category names, ability names, descriptions and keywords; no matches show an empty
  state ("No matching settings / Try different keywords — search matches category names
  and setting content").
- **Position memory**: the page is not kept alive (it rebuilds after you leave), but it
  remembers your last category and scroll position for the current run; a restart goes
  back to the default category.
- **Jumping in from another ability**: a "go to settings" entry on another ability's page
  opens this page on that category — and on the exact setting when one is targeted
  (scrolls into view and highlights it for about 1.6s).
- **Copy page**: the document icon at the bottom of the sidebar (hover: "Copy current
  view as Markdown") exports every settings category together with the **current values**
  as Markdown — handy for pasting to an AI or keeping a record.
- The "?" button at the bottom of the sidebar (hover: "Help for the current ability")
  opens this help dialog.

### The shell's own two categories

| Category   | Settings                                                               |
| ---------- | ---------------------------------------------------------------------- |
| Appearance | Theme, Zoom, Font, Window, Animation, Language, Sidebar, Launch, About |
| Abilities  | Ability toggle (runtime on/off)                                        |

Details for each setting:

| Setting   | What it does                                          | When it applies                                 |
| --------- | ----------------------------------------------------- | ----------------------------------------------- |
| Theme     | 10 color schemes + follow system                      | Instantly                                       |
| Zoom      | 0.8–1.8 uniform UI scaling                            | On release (persisted)                          |
| Font      | Default Noto / follow system / custom family          | Instantly                                       |
| Window    | Frameless, rounded, background & Fuse overlay         | Frameless / rounded next launch; rest instantly |
| Animation | Modern motion master, transition style, reveal origin | Instantly                                       |
| Language  | 中文 / English                                        | Saved instantly (see the caption)               |
| Sidebar   | Sort rules, custom order, clear usage records         | Instantly                                       |
| Launch    | Confirm before launch                                 | Persisted instantly                             |
| About     | Version and tech stack                                | —                                               |

### Settings injected by abilities

This page only holds **the shell's own settings plus the items each ability injects**.
Injected categories show up in the left nav under the ability's own sidebar category
(backend-only abilities appear too, e.g. AI & Remote). Common ones:

| Ability         | Settings category | Typical content                                           |
| --------------- | ----------------- | --------------------------------------------------------- |
| Balance         | Balance settings  | Platform credentials, auto polling                        |
| AI DJ           | AI DJ settings    | API key, model, playback preferences                      |
| Lyrics          | AIDJ Lyrics       | Karaoke / scrolling, typography                           |
| Player          | Player            | Crossfade, EQ, playback speed, LAN remote                 |
| Journey Records | Journey Records   | Gallery folders, route folders, map sources & preferences |
| Apps            | Apps              | App scan roots                                            |
| Dashboard       | Dashboard         | Reset the dashboard card layout                           |
| AI & Remote     | AI & Remote       | MCP / Remote toggles, access token, privacy policy        |

## Common tasks

### Switch the color scheme

1. Pick **Appearance** in the left nav, then click any card in the **Theme** grid.
2. The current theme has a primary-colored border and a check badge; a second click on
   another card switches right away — no restart needed.

See [Appearance → Theme and Motion](Appearance/ThemeAndMotion.md).

### The UI is too big or too small

1. Pick **Appearance** and find the **Zoom** card.
2. Drag the **Scale** slider (0.8–1.8); the percentage shows on the right.
3. The scale is applied and persisted only when you **let go** — the UI does not change
   while you drag.

### Square corners / I want my wallpaper back

1. Pick **Appearance** and find the **Window** card.
2. Turn on **Rounded window** to reveal the **Corner radius** slider (0–40px).
3. Set Background to **Desktop Wallpaper** or **Image**, then lower **Fuse overlay
   opacity** to let the background through.

See [Appearance → Window and Background](Appearance/WindowAndBackground.md).

### Page-switch animation is too busy

1. Pick **Appearance** and find the **Animation** card.
2. Turn off **Modern Motion** (master switch): all motion stops instantly and themes
   swap instantly.
3. Or keep modern motion and just pick a different **Transition style** (Fade / Slide /
   Slide Up / Zoom / Flip).

### Switch to English

1. Pick **Appearance**, find the **Language** card, click **English (US)**.
2. The setting saves immediately. The card's caption says "Switch language — reloads the
   page to apply": most text switches live; if a label looks stale, restart to
   normalize everything.

### The sidebar order doesn't suit me

1. Pick **Appearance** and find the **Sidebar** card.
2. Pick **Custom**, then drag the ability cards (drag handle on the right of each card,
   or use the ↑ ↓ buttons), or click **Reset to Alphabetical**.
3. The sidebar re-sorts instantly.

### I don't need an ability right now

1. Pick **Abilities**, find the ability in the **Ability toggle** card.
2. Turn its switch off: the sidebar entry and commands are **hidden immediately** and a
   message pops up at the top.
3. Turn it back on to restore; a restart also restores everything.

See [Abilities → Ability toggle](Abilities/AbilityToggles.md).

### Stop the launch confirmation

1. Pick **Appearance**, find the **Launch** card.
2. Turn off **Require confirmation before every launch** (on by default). The setting is
   persisted instantly.

### Version and tech stack

Pick **Appearance** → **About**: "Linux System Cockpit · Electron + Vue 3 + Vuetify 3
(Material 3)" plus a note about the config directory.

## Where settings are stored

| File                                              | Contents                                           |
| ------------------------------------------------- | -------------------------------------------------- |
| `~/.config/LinuxCockpit/config.json`              | Global shell config (most switches on this page)   |
| `~/.config/LinuxCockpit/config.json.bak`          | The previous version, kept before every write      |
| `~/.config/LinuxCockpit/sidebar-order.json`       | Custom sidebar order                               |
| `~/.config/LinuxCockpit/apps.csv`                 | Usage frequency / recent stats                     |
| `~/.config/LinuxCockpit/<ability-id>/config.json` | Each ability's own config (aidj, balance, yarj, …) |

Notes:

- Writes are read → merge → atomic temp-file replace; **if the existing config can't be
  read, saving is aborted instead of overwriting your config with an empty one**.
- On first run a default config is materialized (theme dark, language zh, scale 1.1,
  all motion on, sidebar default page cli, alphabetical order).
- **The initial page** (which ability opens at startup — `sidebar.default`, default
  `cli`) has no UI switch; change it from the CLI:
  `config.set --patch '{"sidebar":{"default":"apps"}}'`.
- **AI & Remote** settings can only be changed by you: an agent cannot modify `agent.*`
  through commands, so it can't grant itself access.

## Read more

- [Appearance → Theme and Motion](Appearance/ThemeAndMotion.md): theme, zoom, font,
  animations.
- [Appearance → Window and Background](Appearance/WindowAndBackground.md): frameless,
  rounded, background and the Fuse overlay.
- [Appearance → Language, Sidebar and Launch](Appearance/LanguageSidebarAndLaunch.md):
  language switching, sidebar ordering, launch confirmation.
- [Abilities → Ability toggle](Abilities/AbilityToggles.md): runtime on/off and the
  protected abilities.

## Command line

Every switch on this page has a command behind it:

```bash
config.get                                    # read the global config (raw config.json)
config.set --patch '{"theme":"pureblack"}'    # update any key, broadcast immediately
sidebar.order.get                             # read the custom sidebar order
sidebar.order.set --order '["apps","aidj"]'   # overwrite the custom sidebar order
stats.record --id apps                        # record one usage event
stats.list                                    # read usage stats
stats.clear                                   # clear usage records (counters reset)
ability.set-enabled --id display --enabled false  # disable an ability at runtime
ability.list                                  # list abilities and their enabled state
ability.describe --id settings                # command/job/help manifest for an ability
ability.describe --id settings --format md    # same, as Markdown
```

## FAQ

**Changed a setting but nothing happened?** Theme, background, zoom, motion and language
apply instantly; **frameless and rounded take effect next launch** (the Window card's
note says the same).

**Max zoom is still too small?** 0.8–1.8 is the supported range; for larger scales,
raise the system DPI / display scaling.

**Sidebar "usage frequency" doesn't change?** Only opening a sidebar entry or launching
an app from the Apps page increments the counters; click **Clear usage records** to
start over.

**An ability I disabled is missing?** Open **Abilities → Ability toggle** and turn it
back on, or restart the app (disabled state isn't persisted).

**Can't find a setting in search?** Search covers category names, ability names,
descriptions and keywords; try a shorter keyword ("wallpaper", "zoom", "sort").
