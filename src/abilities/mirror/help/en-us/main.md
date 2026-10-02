# Mirrors

> Last updated: 2026-10-01

Mirrors manages Arch Linux's pacman mirror file `/etc/pacman.d/mirrorlist`. It uses a custom
`[MIRROR]` comment format to name each source, shows one card with one switch per source, and can
speed-test them. Editing this file needs root, so every write goes through system authorization
(pkexec) — that is what makes this page different from the others.

> Quick start: click **Test** in the top-right to see which source is fast → flip the switch on the
> card you want to **Enabled**.

## What it does

- List every mirror in mirrorlist with its enabled state; cards sort enabled-first, then by latency.
- One switch per source to enable / disable it. pacman supports multiple active mirrors natively —
  enable as many as you like.
- **Test**: downloads a small file from each source and reports latency (ms) and speed (MB/s).
- Legacy files (bare `Server =` lines) are readable as-is — no manual conversion needed.
- A failed authorization or write never damages the original file; the error shows at the top of the
  page.

## UI at a glance

| Area         | Where           | Description                                                                                 |
| ------------ | --------------- | ------------------------------------------------------------------------------------------- |
| Title row    | Top of the page | "Mirrors" heading + subtitle "Arch Linux mirrors · N enabled"; **Test** button on the right |
| Error alert  | Below the title | Red alert for the last failed operation (cancelled authorization, write failure)            |
| Mirror cards | Main body       | Grid of cards: name, URL, test results; the enable switch at the bottom                     |

Each card: a status icon on the left (green check when enabled, grey globe when disabled), the
**source name**, and after a test run a latency chip next to it (green <300ms, orange <800ms, red
beyond that; failures show a red **Timeout** chip). Below is the URL as a caption; successful tests
add one more line with a download icon and the speed. Enabled cards carry a faint green outline. The
switch at the bottom of each card shows the current state (**Enabled** / **Disabled**) and spins while
the operation runs.

## Common tasks

### Enable / disable a mirror

Click the switch at the bottom of a card. Behind the scenes:

1. Only the target source's `Server` line is touched (add `# ` to disable, remove it to enable) —
   **every other line in the file is preserved verbatim**.
2. The new content is written to a temp file, then swapped in atomically via pkexec and a helper
   script using `mv`.
3. All reads and toggles are serialized, so rapid clicks can't corrupt the file.

When the authorization prompt appears, enter your password. **Cancel or mistype** and the write is
abandoned — the original file stays as it was and the page shows `pkexec failed: ...`. With the
project's polkit rule installed, one approval covers further operations for about five minutes.

### Test speed

Click **Test** in the top-right; the button shows a spinner, then each card displays latency and
speed and re-sorts (fastest first). Testing just downloads each source's `core` repository index —
at most 512KB with a 10-second timeout. **It installs and changes nothing.**

### Switching to a different set of sources

The page can only toggle sources already present. To add new ones:

- Pre-list them in `~/.config/LinuxCockpit/mirror/config.json` (see
  [Mirrorlist format](Mirror/MirrorlistFormat.md)); they appear as **Disabled** and one flip writes
  them into mirrorlist.
- Or hand-edit `/etc/pacman.d/mirrorlist` in the `[MIRROR]` format and refresh the page.

## Read more

- [Mirror/mirrorlist format](Mirror/MirrorlistFormat.md): what the `[MIRROR]` format looks like,
  legacy migration, and the safety guarantees around writes.

## Command line

```bash
mirror.get                                  # current mirror list and status
mirror.toggle --name USTC --enable true     # enable a mirror (--enable false disables; needs pkexec)
mirror.test                                 # test all mirrors for connectivity and speed
```

## FAQ

**Why does it ask for a password?** Writing `/etc/pacman.d/mirrorlist` requires root — that's
expected. Cancelling changes nothing. To avoid repeated prompts, install the project's polkit rule
(`scripts/49-cockpit-pkexec.rules` → `/usr/share/polkit-1/rules.d/`).

**It says `pkexec failed` — now what?** A wrong password, a denied authorization or an unrunnable
helper script all produce this. The original file was never touched: just flip the switch again. The
red banner at the top of the page contains the specific reason.

**Can I undo a bad write?** Before every successful write, the helper backs the file up to
`/etc/pacman.d/mirrorlist.cockpit.bak`; copy it back if you need to.

**Why did the file gain a new block after I toggled?** For a legacy file (bare `Server =` lines), the
first toggle appends a `# [MIRROR] <name>` + `Server = <url>` block at the end and leaves the old bare
line untouched — so the same URL can appear twice and pacman would hit it twice. Clean up the old
line after the first toggle. Details in [Mirrorlist format](Mirror/MirrorlistFormat.md).

**Can several sources be enabled at once?** Yes — pacman supports multiple sources natively and
doesn't require an order; the card order is display-only.

**All tests time out?** Check your network / proxy, or the sources themselves. Failed sources get a
red **Timeout** chip but their switches still work.
