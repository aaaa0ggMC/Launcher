# Lyrics Page

> Last updated: 2026-10-01

"Lyrics" is AI DJ's second sidebar page: a full-page view of the current song's lyrics with
**karaoke word-by-word fill** and **scroll-follow**. It follows AI DJ's playback backend, so it works
both in external-player (MPRIS) mode and built-in-player mode.

Colors always follow the app theme and are not configurable; what you _can_ configure is the
presentation and typography (**Settings → AIDJ Lyrics → Lyrics Page Config**).

> Quick start: start playback in AI DJ, then open the **Lyrics** page — the current line highlights
> and scrolls to the vertical center. For the sing-along effect, make sure
> **Settings → AIDJ Lyrics → Lyrics Page Config → Karaoke word highlight** is on.

## UI at a glance

| Area                 | Where                                       | Description                                                                                                                      |
| -------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Header               | Top of the page (can be hidden in settings) | Cover, track name, status chip, lyric-source chip, artist · album, player name, player dropdown, transport buttons, progress bar |
| Lyrics body          | Middle                                      | Scroll-follow mode shows all lyrics and centers the current line; fixed-window mode shows only a few lines around it             |
| MV view              | Full-page overlay                           | Playing an `.mp4` / `.mkv` / `.webm` with audio-only off covers the page with muted video and turns lyrics into bottom subtitles |
| Immersive background | Behind everything                           | With immersive mode on and a cover present, a blurred, dimmed cover becomes the background (also automatic while stopped)        |

The header's icon buttons, left to right: the **Player** dropdown (external-player mode only) →
previous → play / pause (primary button) → next → stop → **Desktop lyrics** (toggle, highlighted while
open). To the right of the progress bar you see `current time / total duration`.

The chip next to the track name reports the lyric type: **YRC** (Netease word-by-word lyrics, which
enable real word fill) or **LRC** (plain lyrics; the fill advances per line).

## Common tasks

### Switch player (external-player mode)

The header's **Player** dropdown defaults to **Current Active** (auto-follows the active player) but
can pin a specific MPRIS player. In built-in-player mode the dropdown is gone — lyrics simply follow
the built-in player.

### Open the desktop lyrics window

Click the **Desktop lyrics** icon button in the header (or AI DJ page menu → **Desktop Lyrics**): it
opens a frameless, transparent, always-on-top desktop lyrics window bound to the current player;
click again to close. The window can be dragged around, and **right-click → Lock** makes it
mouse-passthrough. Its font, size, colors and window position are configured under
**Settings → AI DJ → Desktop lyrics display** — it shares the lyric data with this page but has its
own settings.

### Fix lyric timing

When lyrics run early or late, change
**Settings → AIDJ Lyrics → Lyrics Page Config → Typography → Position offset (ms)**: positive shows
lyrics **earlier**, negative later (range −1000 to 1000). The backend position is polled every 600ms
and interpolated in the page, so the progress bar and highlight glide instead of jumping.

### Watch MV

When an mp4 / mkv / webm is playing and
**Settings → AI DJ → Playback preferences → Audio Only Mode** is off, the page switches to MV mode:
muted video stays in sync with the audio (sound still comes from the player) and lyrics become two
subtitle lines at the bottom (current + next). During playback, moving the mouse into the upper part
of the picture reveals the controls; after 3 seconds of no movement — or when the mouse leaves the
picture — they hide again. When stopped, the page returns to the normal lyrics view, and if the song
has no lyrics a cover preview card with a play button appears. To listen without video, turn on
**Audio Only Mode**.

## Settings

All under **Settings → AIDJ Lyrics → Lyrics Page Config** (saved automatically; **Reset to defaults**
in the top-right restores everything):

| Setting                                                                                                                                                                                                             | What it does                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scroll-follow lyrics**                                                                                                                                                                                            | On: show all lyrics and auto-center the current line; off: fixed window with just a few lines around it                                      |
| **Karaoke word highlight**                                                                                                                                                                                          | The current line fills word-by-word from inline LRC timestamps (real word fill with YRC lyrics, otherwise advancing to the next line's time) |
| **Dim non-current lines**                                                                                                                                                                                           | Dims the other lines                                                                                                                         |
| **Show header**                                                                                                                                                                                                     | Track info / playback controls / progress                                                                                                    |
| **Immersive mode**                                                                                                                                                                                                  | With a cover, overlay a blurred + dimmed cover as the background instead of the user-configured one                                          |
| **Lines above current / Lines below current**                                                                                                                                                                       | How many lines to show around the current one in fixed-window mode (0–8)                                                                     |
| Typography: font, current line size (18–46), candidate line size (13–28), current weight (500–900), candidate weight (400–700), line height (1.0–2.0), line gap (4–24), letter spacing (−2–8), position offset (ms) | Typography only — colors always follow the theme                                                                                             |

The lyrics page config is stored separately in `~/.config/LinuxCockpit/aidj-lyrics/config.json`, and
does not touch the AI DJ main config.

## No lyrics?

- "Nothing playing": AI DJ hasn't started a song yet — go play one from the AI DJ page.
- "No lyrics": the song has no lyric in the library. Run AI DJ page menu → **Update MetaData** to sync
  metadata (it fetches LRC / YRC lyrics), or add folders holding `.lrc` files under
  **Settings → AI DJ → Lyrics search folders**.

## Read more

- Back to [AI DJ](../main.md).
- [Built-in Player](../Player/BuiltInPlayer.md): playback backend, EQ, speed and the LAN remote.
- [Library & Metadata](../Library/MetadataAndStats.md): where lyrics and metadata come from.

## Privacy and security

The lyrics page and desktop lyrics window only show the current track, lyrics and cover — no
credentials. Commands like reading lyrics, switching tracks or toggling the desktop window aren't
declared agent-forbidden, so the agent may call them; it still can't see the API key, and personal data
like the Bilibili profile and listening stats is redacted. Logging in, importing credentials and
signing disclaimers stay yours to do in the settings.

## Command line

```bash
aidj.lyrics                        # current playback state + lyrics (incl. word-by-word lyrics)
aidj.lyrics-player                 # players bound to the lyrics page (empty list in web mode)
aidj.lyrics-select-player --name org.mpris.MediaPlayer2.vlc   # bind a player (__auto__ = auto-follow)
aidj.lyrics-state                  # is the current player's desktop lyrics window open?
aidj.lyrics-toggle                 # open / close the current player's desktop lyrics window
aidj.lyrics-page-config            # read the lyrics page display config
aidj.lyrics-page-save --config '{"karaoke":false,"scroll_follow":false}'   # save the lyrics page config
```

## FAQ

**The page resets when I come back?** The lyrics page isn't keep-alive'd — it is destroyed when you
leave and reloaded when you return (the AI DJ and Player pages keep their state).

**The highlight doesn't move / lines desync?** First fine-tune **Position offset (ms)**; if the source
chip says **LRC** instead of **YRC**, the song has no word-by-word lyrics and only line-level fill is
possible — running **Update MetaData** once may fetch them.

**MV view is black?** Make sure the file is a video format and **Audio Only Mode** is off; on a video
error the page reloads the source once, and if the codec isn't supported by the built-in decoder it
stays black — enable **Audio Only Mode** in **Settings → AI DJ → Playback preferences** to fall back
to the normal lyrics view.
