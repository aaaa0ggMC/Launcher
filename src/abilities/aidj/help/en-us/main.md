# AI DJ

> Last updated: 2026-10-03

AI DJ hands your local music library to an AI that behaves like a radio host: you ask in plain
language, it picks and orders songs from **your** library, writes the intro, and pushes the playlist
to a player. Picking runs as an **agent loop**: the AI works in rounds with a toolbox over your
library (title and lyric search, tag clouds and filters, sub-agents that curate or dream up
continuations), and each batch shows up as a **workflow card** in the chat — the details are in
[AI Loop: How It Works](AILoop/HowItWorks.md). One folder registers three sidebar pages that share
this help:

- **AI DJ** (this page): chat to pick songs + background auto-rotation.
- **Lyrics**: a full-page lyrics view with karaoke word fill and scroll-follow.
- **Player**: the built-in player page (crossfade / EQ / speed / spectrum / LAN remote).

Metadata, sessions, play frequency and listening stats all live on this machine under
`~/.config/LinuxCockpit/aidj/`; the main config file is `~/.config/LinuxCockpit/aidj/config.json`.

> Quick start: open the **AI DJ** page → click the handle at the top center to open the page menu →
> fill in **Settings → AI DJ** (API URL / API key / music folders) → type "some chill Chinese songs"
> in the input box → **Send**. The AI replies with an intro plus a playlist card; click **Play all**
> to start playing.

## What it does

- Ask in natural language: mood, scene, language, a lyric line, "some Jay Chou" — the AI picks from
  **your library** and never hallucinates songs that don't exist.
- Agent picking with playbooks: the loop follows playbooks like "seed start" (begin from one song /
  lyric line) or "artist pick" (a named artist), narrows the pool by tags, can hand picking to
  library and dream sub-agents, and a ranking agent orders the batch and writes the DJ intro — see
  [AI Loop: How It Works](AILoop/HowItWorks.md).
- Chat-only turns: say you don't feel like music and the AI just answers; in persistent mode
  auto-refill pauses until you ask for songs again.
- Web search (optional, Tavily): the AI can look up artists, songs, releases and news to understand
  a request — songs still come only from your library.
- Tag cleanup: a guided pass that merges redundant mood / genre / language / loudness tags into one
  clean vocabulary and rewrites song metadata into a new slot — see
  [Tag cleanup](Library/TagCleanup.md).
- Token breakdown: hover the **Tokens** chip for input / cached / output totals, the cache hit rate,
  and the same split per agent — see
  [AI Loop: Models & Usage](AILoop/ModelsAndUsage.md).
- Slash commands that hit the library directly: `/random`, `/pr`, `/explore`, `/ftop`, `/analyse`,
  `/filter`, `/persist` — no AI round-trip needed.
- Persistent mode: fork the current conversation into a background task that keeps generating and
  pushing songs after you close the page; you can keep chatting from the background panel.
- Metadata sync: fills in language / mood / genre / loudness / review per song so the AI can pick
  smarter.
- Playback control: next / previous / play-pause / stop / volume, either through an external MPRIS
  player (vlc, mpv, …) or the built-in player.
- Listening stats: play frequency and day / month / year heatmaps, one click to replay.

## UI at a glance

| Area          | Where                | Description                                                                                                                                                                  |
| ------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top bar       | Very top of the page | Current track (truncated), playback status chip, AI API status chip, player dropdown                                                                                         |
| Conversation  | Middle               | Message stream (You / AI DJ / System); AI replies render as Markdown, with a workflow card above each batch; scroll up to load older messages                                |
| Playlist card | Under an AI reply    | **Play all**, **Push to background**, plus a song grid with covers and drag-to-reorder                                                                                       |
| Input area    | Bottom               | Status chips, multi-line input, **Send** / **Stop**, **Expand** / **Collapse**                                                                                               |
| Page menu     | Handle at top center | New Chat, Start from Now, Chat Sessions, Models, Song Frequency, Metadata Slots, Bilibili Video Download, Listening Time Stats, Tag cleanup, Update MetaData, Desktop Lyrics |

The player dropdown on the right of the top bar only appears in **external player (MPRIS / DBus)**
mode. Its default entry is **Current Active** (follow whichever player is active); you can also pin a
specific player. It disappears when you switch to the built-in player backend.

The row of small chips above the input box is live status: **Tokens** (cumulative, counting every LLM
call including sub-agents — hover it for a breakdown of input, cached with hit rate, output and
total, plus the same split per agent), **Context** / **Completion** (the latest LoopAgent call's
input / output), **Tracks** (library size, `…` while loading),
**Memory** (played memory — click to clear), **Volbal** (loudness balance — click to cycle
off → lufs → linear), **RecordFreq** (frequency recording toggle), **Listen** (listening stats
toggle) and **Backgrounds** (running background tasks). Which chips show, and in what order, is
configured in **Settings → AI DJ → AI DJ Settings → Status bar indicators** (value = display order,
0 = hidden).

## Common tasks

### First run: fill in the config

1. Open the **Settings** page in the sidebar, category **AI DJ** → item **AI DJ Settings**.
2. **API Configuration**: **API URL** (an OpenAI-compatible endpoint, e.g.
   `http://localhost:1145/v1`) and **API Key**. The key is write-only and stored encrypted — settings
   never show it again; type a new value to replace it, or use the button beside it to clear the
   saved key.
3. **AI Models** (the same panel as page menu → **Models**): the **Default model** covers text mode,
   title generation and every agent without its own setting; LoopAgent, LibAgent, DreamAgent,
   RankAgent, VocabAgent, SanitizeAgent and the metadata model can each follow the default or pin
   their own model, and names not in the list can be typed by hand. Changes save as you make them
   and apply from the next batch; the chat page and the persistent panel no longer have model
   dropdowns of their own.
4. **Music Library & Player**: add music folders under **Search folders** (scanned recursively) with
   **Add**; add **Lyrics search folders** (`.lrc`) if you want the desktop lyrics window.
5. Lyrics come from Netease: by default an external service (**NCM API URL**, default
   `http://localhost:3000`, i.e. [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)).
   For the in-process direct connection, click **Sign Disclaimer & Enable** under
   **NCM Built-in Direct Connection Auth** first.
6. Optional — **Web search (Tavily)**: turn on **Allow web search** and paste a Tavily API key if the
   AI may look facts up online (see
   [AI Loop: Models & Usage](AILoop/ModelsAndUsage.md)).

Changes apply immediately and are written to `~/.config/LinuxCockpit/aidj/config.json`.

### Chat with the AI DJ

Type a request in the bottom input box and click **Send** (or press **Shift+Enter**). The reply
starts as a "Thinking…" bubble, which in agent mode shows the current stage of the workflow — which
agent is working and roughly what it is doing — instead of a character counter (text mode still
counts characters). Above the finished reply sits a **workflow card**: one per batch, listing the
playbook used, the status, token usage and elapsed time, and — expanded — every agent step and tool
call with a one-line summary. Then comes the intro plus the playlist card. If only an intro comes
back, a system line "AI found no songs to match your request" appears underneath — usually the
library has nothing that matches.

Requests can be anything: a mood ("something chill in Chinese", "instrumentals for coding"), a
starting point (a song or a lyric line, "start from 辽阔的森林"), an artist ("some Jay Chou"), or no
music at all ("no music, let's talk") — then the AI answers directly without a playlist. The full
workflow is described in [AI Loop: How It Works](AILoop/HowItWorks.md).

To interrupt a generation, click the red **Stop**; your text is restored into the input box.

How much a copy / Markdown export contains is set in **Settings → AI DJ → Detail of copy / export as
Markdown**: **Basic** (default — conversation and playlists only), **Detailed** (each reply is preceded
by its batch's workflow summary and one line per step) or **Advanced** (plus every step's arguments /
result JSON and per-agent tokens, including RankAgent's drop reasons).

### Slash commands

Typing `/` in the input box opens a command hint popup: **↑ / ↓** to select, **Tab** to complete,
**Esc** to dismiss. Available commands:

| Command                                         | What it does                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/random <number>`                              | Pick N random songs (unheard first) and push them as an AI message                                     |
| `/pr <number>`                                  | Let the AI curate a coherent playlist from random candidates                                           |
| `/explore <number>`                             | Find unheard / least-played songs                                                                      |
| `/ftop <N>` / `/ftop -<N>` / `/ftop <A> <B>`    | Most / least played songs, or a rank range                                                             |
| `/analyse <language\|emotion\|genre\|loudness>` | Metadata distribution as a system message                                                              |
| `/filter <expression>`                          | Filter the library with a boolean expression (title / lyrics / all + `[field:value]` metadata filters) |
| `/persist <message>`                            | Fork the current conversation into a persistent background session                                     |
| `/persist-stop`                                 | Stop the running persistent session                                                                    |

`/filter` example: `/filter [language:粤语] and ("Jay Chou") or [emotion:孤独]`. It searches titles by
default; add `--compare=lyrics|all` to search lyrics. Chinese simplified/traditional fuzzy matching and
English case-insensitivity are on by default.

### Play and push playlists

- **Play all** (top-left of a playlist card): sends the whole list to the current player.
- Click a song's **cover** in the grid: plays just that song.
- **Push to background** (external-player mode only): starts a continuous-playback background task on
  the current player — see [Library & Metadata](Library/MetadataAndStats.md) and
  [Built-in Player](Player/BuiltInPlayer.md).
- In built-in player mode there is no "Push to background"; **Play all** appends the list to the
  built-in player's queue and the current track keeps playing.

When a continuous-play task already owns that player, **Play all** first opens an "Overwrite the
playlist?" confirmation — two sources racing to switch tracks is messy, so it is usually better to
cancel.

### Sessions: search, pin, rename, delete

Page menu → **Chat Sessions**:

- Top row: back arrow, refresh icon button, the **Search sessions…** field (filters by title /
  first prompt / latest message) and a session-count chip.
- The list groups by Today / Yesterday / date, pinned sessions first; each entry shows its message
  count.
- **Right-click** a session for: **Pin / Unpin**, **Auto-generate title** (runs a background job that
  asks the AI for a name), **Set title** (rename in a dialog) and **Delete** (red, irreversible).

Clicking a session loads it; long histories show a parse progress bar first.
In a conversation, right-click any message for **Copy**, **CopyRaw** (the AI message's raw text),
**Revert to here** or **Fork from here** (copies the conversation up to that message into a new
session and switches to it).

### Persistent mode: background auto-rotation

1. Chat for a while, or use **Start from Now** (below).
2. Type `/persist keep it upbeat` and press Enter — or click **Start from Now** in the page menu
   (external-player mode).
3. The current conversation is forked into a `(Copy)` session and a background task keeps generating
   playlists and pushing them to the player; the **AI DJ page's chat stays untouched**.
4. Open the **Background tasks** panel from the sidebar bottom. The task has two custom views:
   `chat` lets you keep sending messages, switch the send-target player, and right-click to revert or
   copy — each batch shows its workflow card and the token counters update live; `continuous` shows
   now playing / next / the pending queue, and supports drag-to-reorder, player switching, volume
   and resetting played memory.
5. Type `/persist-stop` or stop the task in the panel to finish.

A chat-only turn in a persistent session (the AI answered without picking songs, e.g. after "no
music, let's talk") **pauses auto-refill**: the chat notes that this round was chat-only and that
sending another message continues. The next message that asks for songs resumes auto-refill, and the
chat says so.

Persistent sessions also work in built-in-player mode (pushing into the built-in player's queue), but
**continuous-playback tasks** (the **Push to background** button on a playlist card) are only offered
in external-player mode — the button doesn't show otherwise.

### Models and tag cleanup

- Page menu → **Models** (same content as **Settings → AI DJ → AI Models**): pin a model per agent
  or leave them on **Follow default**; details in
  [AI Loop: Models & Usage](AILoop/ModelsAndUsage.md).
- Page menu → **Tag cleanup**: merge redundant mood / genre / language / loudness tags into one
  clean vocabulary and rewrite metadata into a new slot; details in
  [Tag cleanup](Library/TagCleanup.md).

### Update MetaData and library housekeeping

- Page menu → **Update MetaData**: starts the "AIDJ Metadata Sync" background task, scanning for new
  songs without metadata and filling them in. If it is already running, the background panel opens
  instead. When it finishes you get "Metadata sync finished: N" or "No new metadata written".
- Page menu → **Metadata Slots**: split metadata into collections (`AnimeOST`, `JPop-2024`…) and
  tick which ones are active, per whole slot or per song; the header chip "Active: N songs"
  recalculates live. **Set write** picks where future syncs write, **Set as Bilibili default** picks
  where Bilibili downloads write.
- Page menu → **Song Frequency**: the library ranked by play count — click a cover to send it to the
  player; the top icon toggles ascending / descending.
- Page menu → **Listening Time Stats**: heatmaps of minutes per hour / day / month with
  **Day (24h per day)**, **Month (days)** and **Year (months)** granularity, a `YYYY-MM` **Jump**
  field and **Back to now**; hover a cell for duration and coverage.

### Bilibili video download

Page menu → **Bilibili Video Download**: paste BV / AV IDs or video links (separated by spaces,
commas or newlines) and click **Resolve video** (or **Ctrl+Enter**); multi-part videos split into
rows. Tick **Skip existing**, choose **Audio only (m4a)** or **Video stream (mp4)** and a
**metadata write slot**, then click **Confirm download (N items)** to start a background task.
Using it requires signing the disclaimer and logging in under
**Settings → AI DJ → Bilibili Video Import & Extension** (QR login / importing a Cookie both work).

### Desktop lyrics window

Page menu → **Desktop Lyrics** (shown as **Close Desktop Lyrics** with a check mark while open):
opens a frameless, transparent, always-on-top desktop lyrics window bound to the current player —
one independent window per player. The window can be dragged around by default; **right-click → Lock**
makes it mouse-passthrough (unclickable), and **Lock on open** in
**Settings → AI DJ → Desktop lyrics display** locks it from the start.
Font, size, colors and window position live in
**Settings → AI DJ → Desktop lyrics display**.

## Read more

- [Built-in Player](Player/BuiltInPlayer.md): the player page and playback backend, crossfade, EQ,
  speed, AB loop, sleep timer, LAN remote.
- [Lyrics Page](Lyrics/LyricsPage.md): karaoke word fill, scroll-follow, immersive mode and typography.
- [Library & Metadata](Library/MetadataAndStats.md): scanning, metadata sync and slots, tag cleanup,
  frequency and listening stats, Bilibili import.
- [AI Loop: How It Works](AILoop/HowItWorks.md): the agent workflow — agents, tools, playbooks,
  loop settings and the workflow card.
- [AI Loop: Models & Usage](AILoop/ModelsAndUsage.md): per-agent models, token counting and cache hit
  rates, web search, key storage.
- [Tag cleanup](Library/TagCleanup.md): merge redundant tags into a clean vocabulary and rewrite
  metadata into a new slot.

## Platforms and dependencies

The core of AI DJ (chat, library, metadata, stats) is cross-platform; playback depends on the backend:

- **External player (MPRIS / DBus)**: Linux only. Needs a session DBus and an MPRIS-capable player
  (vlc, mpv, …). Non-Linux platforms are forced onto the built-in player. When the player drops off,
  the task retries or ends according to
  **Settings → AI DJ → Continuous playback → Reconnect window (minutes)**.
- **Built-in player**: works on every platform with no external programs, but continuous-playback
  tasks and several EQ / volume commands only register in that mode.
- **ffmpeg / ffprobe**: used to measure LUFS / RMS for dynamic volume balance. If missing, nothing
  errors — volume balancing just doesn't happen.
- **OpenAI-compatible endpoint**: without one no playlist can be generated; the top-bar API chip
  shows **Offline**.
- **NeteaseCloudMusicApi**: the default lyric source for metadata sync; if it isn't running, switch to
  the built-in direct connection (requires signing the disclaimer).
- Persistent rotation / chat / metadata sync all run on background tasks, so AI DJ depends on the
  "background tasks" capability; remove it and AI DJ doesn't load at all.

## Privacy and security

- The **API key** and the Tavily key are credentials stored **encrypted** in `config.json` (decrypted
  only in memory; plain keys left by older versions are migrated to ciphertext on first read). They
  are write-only in settings, unreadable by the AI, and agents cannot rewrite `secrets.*` through
  commands.
- With web search enabled, the AI's search queries are sent to **Tavily**. Songs are still picked
  only from your local library, and web page content is treated as untrusted material the AI won't
  follow instructions from.
- Workflow records (agent steps, tool calls and their results) are saved with the session as their
  own record type, but they **never enter the AI's memory** — they are a log for you, not context for
  the next turn.
- **Bilibili account profile** (uid / nickname / avatar) and **listening stats** are personal privacy
  scopes — AI snapshots and screenshots redact them.
- QR login, importing credentials and signing / revoking disclaimers can only be done by you in the
  UI; the agent cannot invoke them.
- The built-in player's **LAN remote** opens a port to the network, so the agent needs separate
  authorization to start it.

## Command line

Every UI action has a command; the same work is scriptable:

```bash
aidj.generate --prompt "some chill Chinese songs"   # AI generates a playlist
aidj.random --count 10                              # 10 random songs, counted into context
aidj.curate --count 10                              # AI curates from random candidates
aidj.filter --query '[emotion:孤独] and ("Jay Chou")'   # boolean library filter
aidj.analyse --field language                       # metadata distribution
aidj.search --q Jay Chou                            # library search (similarity >= 80)
aidj.status                                         # playback + library / memory / volbal
aidj.next | aidj.prev | aidj.toggle | aidj.stop     # playback control
aidj.volume --set 0.6                               # set volume (0-1)
aidj.start-persistent --prompt "start from now"     # start persistent mode (external player only)
aidj.chat --task <id> --text "more rock"            # message a running persistent session
aidj.loop-preview --task <id>                       # preview the next batch's prompt / tools / models (no AI call)
aidj.vocab-draft | aidj.sanitize-estimate           # tag cleanup: read the vocabulary draft / estimate a run
aidj.metadata-sync                                  # background task: sync missing metadata
aidj.sessions.list                                  # list sessions
aidj.freq                                           # play frequency list
aidj.player-mode --set web                          # switch playback backend (dbus|web)
aidj.lyrics-page-save --config '{"scroll_follow":false}'   # save the lyrics page config
```

## FAQ

**The API chip says "Offline"?** The AI endpoint is unreachable: check
**Settings → AI DJ → API URL / API Key** and whether the endpoint actually serves `/models` (some
don't, which doesn't stop chat). The chip turns green again within 15 seconds once fixed.

**Nothing plays and I get "DBus not connected"?** External-player mode needs an MPRIS player running
on the session bus (vlc, mpv, …). Check the player dropdown, or switch the backend to the built-in
player in **Settings → AI DJ → Playback backend**.

**Where did the "Player" page go?** It only exists while the playback backend is the built-in player;
Linux defaults to external-player mode, so it's hidden.

**Where is the model dropdown that used to sit in the input bar?** It's gone — models are set per
agent now: open page menu → **Models** (or **Settings → AI DJ → AI Models**), pick a model on any
agent or leave it on **Follow default**, and the change applies from the next batch.

**Loudness balance is on but volume never changes?** It needs `ffprobe` (ffmpeg) to measure loudness,
and the anchor is calibrated the moment you release a volume drag — everything else is balanced
around that level.
