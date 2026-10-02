# Built-in Player

> Last updated: 2026-10-01

"Player" is AI DJ's third sidebar page. It only shows while the playback backend is the
**built-in player** — an HTML5 player that needs no vlc / mpv, works on every platform, and comes
with crossfade, a 10-band equalizer, speed, AB loop, sleep timer, spectrum and a LAN remote.

> Quick start: click the handle at the top center → **LAN remote** → **Start remote server**,
> then open the printed address in your phone's browser to control playback. Crossfade and EQ live in
> the same menu.

## When this page exists

The built-in player page is bound to the active playback backend:

- Linux defaults to **external player (MPRIS / DBus)**, so the "Player" page is **not in the
  sidebar**.
- Pick **Built-in player** in **Settings → AI DJ → Music Library & Player → Playback backend** (or run
  `aidj.player-mode --set web`) and the "Player" entry appears immediately; switching back to
  "External player" hides it again.
- Non-Linux platforms (Windows / macOS) have no session DBus and are **always** on the built-in
  player, so this page is visible by default.

Switching the backend stops running continuous / persistent sessions; data-class background tasks
(downloads, metadata sync) keep running. The settings page itself warns that the built-in player is
an experimental backend.

## UI at a glance

| Area           | Where                  | Description                                                                                            |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Page menu      | Handle at top center   | Play queue, Playback speed, Sleep timer, Equalizer, Spectrum, LAN remote, Playback backend (read-only) |
| Cover & title  | Upper middle           | Cover art (note placeholder when none), track title (truncated), playback status chip                  |
| Progress       | Middle                 | Elapsed time, draggable seek slider, total duration; the seek only commits on release                  |
| Transport      | Below the progress bar | Previous / play-pause (large button) / next / stop                                                     |
| Spectrum strip | Above the bottom bar   | 48 bars in theme colors when enabled                                                                   |
| Bottom toolbar | Very bottom            | Loudness-balance chip, crossfade chip, A / B loop buttons, volume button                               |

The **Playback backend** row in the page menu only reports the current mode (Built-in player /
External player (MPRIS)); you can't switch it from here.

## Common tasks

### Manage the play queue

Page menu → **Play queue**: lists the built-in player's queue with the current track highlighted and
the total count at the right; a red trash icon appears when the queue is non-empty — click it for
**Clear queue** (stops playback and removes everything). An empty queue shows "Queue is empty".

### Playback speed and silent fast-forward

Page menu → **Playback speed**: a row of 0.5x / 0.75x / 1.0x / 1.25x / 1.5x / 2.0x buttons (the
current value is highlighted), plus a **Custom speed** field — type any positive number and click
**Apply** (Enter works too). Anything above 16 fast-forwards silently, useful for scrubbing.
The default speed is set in **Settings → Player → Built-in Player Config → Audio processing → Default
playback rate**.

### Sleep timer

Page menu → **Sleep timer**: 15 / 30 / 45 / 60 / 90 / 120 minute buttons. While set, the menu row
shows "mm:ss left" and you can always click **Cancel timer**.

### Equalizer

Page menu → **Equalizer**:

- Each preset is a row: curve thumbnail on the left, name on the right (built-ins show their localized
  names where one exists, e.g. Flat / Pop / Rock / Classical / Vocal, otherwise the built-in name).
  Click a row to apply, the pencil button **Edit**s, and user presets also get a red trash **Delete**
  (built-ins can't be deleted).
- The **+** in the top-right (hover: **New EQ**) opens the editor.
- In the editor, **drag the control points** on the curve to change gains, use the **Overall offset**
  slider to shift every band at once, rename in the top-right field, then **Cancel** or **Save**.
  Dragging previews live (nothing is persisted); cancelling restores the curve that was active before
  the editor opened, while **Save** writes and applies it.
- The bands are a fixed 10-band set (31Hz–16kHz). The maximum gain range is configured in
  **Settings → Player → Built-in Player Config → Audio processing → EQ max range (±dB)** (12–60,
  default 20); **Reset presets** restores only the built-ins to factory defaults and keeps your
  custom ones.

### Spectrum

Page menu → **Spectrum**: a toggle. When on, a 48-bar spectrum strip appears at the bottom of the
page (it only has content in built-in-player mode while playing; the toggle is disabled otherwise).
Whether it shows by default is set in
**Settings → Player → Built-in Player Config → Display & remote → Spectrum strip shown by default**.

### Crossfade

The **Crossfade** chip, second from the left in the bottom toolbar, toggles the fade between tracks:
when on, switching songs fades out and back in. Duration is set in
**Settings → Player → Built-in Player Config → Track transitions → Crossfade duration (s)** (0.5–8s).
The chip is disabled outside built-in-player mode.

### Loudness balance (Volbal)

The leftmost chip in the bottom toolbar cycles **off → LUFS → RMS** and highlights while enabled.
It measures each song's loudness with ffprobe and nudges the player volume around one "anchor"
level; **releasing a volume drag recalibrates the anchor** to that level, so set a comfortable volume
first and then let go. Without ffmpeg (ffprobe) installed nothing errors — balancing just doesn't
happen.

### AB loop

The two round **A** and **B** buttons on the right of the bottom toolbar: click **A** at the loop
start and **B** at the loop end to repeat that span; click a lit button again to clear the loop.
Both are only available in built-in-player mode.

### Volume

The rightmost button in the bottom toolbar opens a slider: dragging adjusts volume live, and
**releasing re-calibrates the loudness anchor**. The icon switches to a muted style at zero.

### LAN remote (web remote)

Page menu → **LAN remote**:

1. Click **Start remote server** (it becomes **Stop remote server**); a chip with the port appears on
   the menu row.
2. The menu shows a `http://localhost:<port>` link, and the background task log also prints
   `http://<LAN IP>:<port>` addresses.
3. Open that address in a browser on your phone or any LAN device to see the current song / cover /
   progress and control playback (play-pause, previous / next, stop, seek, volume, speed).
4. The port is configured in
   **Settings → Player → Built-in Player Config → Display & remote → LAN remote port** (0 = disabled,
   default 17320); after changing it, restart the remote server for it to take effect.

The remote server is a background task and can also be stopped straight from the background panel.

## Read more

- Back to [AI DJ](../main.md).
- [Lyrics Page](../Lyrics/LyricsPage.md): lyrics for the same playback backend.
- [Library & Metadata](../Library/MetadataAndStats.md): library, metadata and listening stats.

## Privacy and security

- The LAN remote **opens a port to the network**, so the agent needs separate authorization to start
  it. The remote page can only see the song and control playback — it never touches your credentials.
- The remote page is unauthenticated and unencrypted; keep it to trusted networks and click
  **Stop remote server** when you don't need it.

## Command line

```bash
aidj.player-mode --set web                  # switch to the built-in player (page then appears)
aidj.player-state                           # unified state (queue / rate / AB points in web mode)
aidj.player-crossfade --enabled true --seconds 3   # query or set crossfade
aidj.player-rate --set 1.25                 # playback speed
aidj.player-abloop --a 30 --b 60            # AB loop (--off true clears)
aidj.player-sleep --minutes 30              # sleep timer
aidj.player-volbal --enabled true --method lufs    # loudness balance
aidj.player-rebase --base 0.6               # make the current volume the new loudness anchor
aidj.eq-list                                # list EQ presets and the active one
aidj.eq-active --id vocal                   # apply an EQ
aidj.eq-save --name "My Bass" --gains "[6,5,4,2,0,0,0,0,0,0]"   # create an EQ
aidj.web-remote-status                      # remote server status and port
aidj.web-remote-start                       # start the remote server
aidj.web-remote-stop                        # stop the remote server
```

## FAQ

**The "Player" page isn't in the sidebar?** You're in external-player (MPRIS) mode — switch to the
built-in player in **Settings → AI DJ → Playback backend**.

**The EQ / speed / AB loop buttons are greyed out?** Those are built-in-player-only features; they
disable when you switch back to an external player. The **Crossfade** chip disables too (the external
player decides its own transitions).

**My playback stopped when I switched backends?** Switching stops running continuous / persistent
sessions — expected behaviour. Downloads and metadata sync keep going.

**My phone can't open the remote address?** Make sure the phone is on the same LAN, use the LAN IP
printed in the background task log (not localhost), and that the port isn't blocked by a firewall.
