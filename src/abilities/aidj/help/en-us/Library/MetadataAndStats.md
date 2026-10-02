# Library & Metadata

> Last updated: 2026-10-01

This page covers AI DJ's back office: how the library is scanned, where the metadata (language / mood /
genre / loudness / review) comes from, where play frequency and listening time are stored, and how a
Bilibili video becomes a song in your library. Everything lives on this machine under
`~/.config/LinuxCockpit/aidj/`.

> Quick start: AI DJ page menu → **Update MetaData** — it scans the library for songs missing metadata
> and fills them in. To let only part of the metadata take effect, use **Metadata Slots**.

## Where the data lives

| Path (relative to `~/.config/LinuxCockpit/`) | Contents                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `aidj/config.json`                           | AI DJ main config (API, library folders, playback preferences, persona, …) |
| `aidj/music_metadata.jsonl`                  | Library metadata (the default write target)                                |
| `aidj/music_lyrics.jsonl`                    | Fetched LRC lyrics                                                         |
| `aidj/metadata/<name>.metadata`              | Metadata slot files (created when you add a slot)                          |
| `aidj/frequency.csv`                         | Play count per song                                                        |
| `aidj/time.csv`                              | Listening minutes per hour (listening stats)                               |
| `aidj/songs_timeline.csv`                    | One row per listening event                                                |
| `aidj/playlists/<name>.txt`                  | Saved playlists (`aidj.save`)                                              |
| `aidj/eq.jsonl`                              | EQ curves (built-ins can be edited; custom presets live only here)         |
| `aidj/sessions/main.json` + `sessions/`      | Session index and histories                                                |
| `aidj-lyrics/config.json`                    | Lyrics page display config (separate from the main config)                 |

Your audio files stay in the music folders you configured; AI DJ only reads the index and metadata and
never moves or renames them (Bilibili downloads land in `Bilibili/<BV id>/` under your music folder).

## Library scanning

**Settings → AI DJ → Music Library & Player → Search folders**:

- **Music folders**: recursively scans the folder for audio files. You can configure several and
  reorder them with **Move up** / **Move down**; the red **×** removes a folder. Type a path or use
  the folder icon (**Browse…**) in the input, then click **Add**.
- **Lyrics search folders**: recursively scans `.lrc` files for the desktop lyrics window (shared with
  the lyrics page).

The first conversation triggers a scan and metadata load; with a big library the **Tracks** chip shows
`…` first. If counts look stale after changing the library, run `aidj.reload` (or
`aidj.invalidate-library` in the CLI) to force a rescan.

## Metadata sync (Update MetaData)

AI DJ page menu → **Update MetaData** starts the "AIDJ Metadata Sync" background task:

1. It rescans the music folders and only processes **new** songs (already-synced songs are skipped).
2. For each new song it searches Netease for lyrics (LRC / word-by-word YRC) and hot comments.
3. The **Metadata extraction model** extracts five fields — `language`, `emotion`, `genre`,
   `loudness` and `review` — which are written to the current write slot.
4. When it finishes the page shows "Metadata sync finished: N" or "No new metadata written", and the
   background panel shows per-song progress.

Related settings, all under **Settings → AI DJ**:

- **NCM API URL** and **Lyric source**: an external service by default
  ([NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi), default
  `http://localhost:3000`); choosing **Built-in (in-process, direct to Netease)** requires signing the
  disclaimer with **Sign Disclaimer & Enable** first.
- **Sync concurrency** (1–16): how many songs at once — faster, but heavier on API limits.
- **Comment count** (0–50): hot comments fetched per song to ground the AI review; 0 = off.
- **Metadata field injection**: which of genre / mood / language / loudness / review are fed to the
  picking AI (all on by default).
- **Loudness adjustment → Adjustment method**: LUFS or RMS (Linear); together with **Volume curve**
  this decides how aggressive dynamic volume balance is.

When the lyric source is unreachable, or Netease has no match for a song, **nothing is written for that
song** and the next sync retries it; the background panel separates "no lyric found" / "network error" /
"extraction failed", and the N in "Metadata sync finished: N" is the number of successfully extracted
songs.

## Metadata slots

Metadata is written to `music_metadata.jsonl` by default. **Metadata Slots** let you split metadata
into collections and combine them as needed — e.g. "only let anime OST metadata drive picking", or
"keep Bilibili downloads in their own file".

AI DJ page menu → **Metadata Slots**:

- The header shows **Active: N songs** (recomputed live) and a **New collection** button.
- Each slot is a row: the tri-state checkbox on the left toggles the whole slot active / inactive;
  **Set write** chooses where future syncs write; **Set as Bilibili default** chooses where Bilibili
  downloads write; the arrow **View items** opens the detail view; non-default slots also have a red
  **Delete slot**. Deleting is safe — the local file is renamed to a `.deleted` backup, not erased.
- The detail view lets you **Search** by song name / genre / mood / review, **Select all** /
  **Deselect all**, and toggle individual songs.

Slot files live in `~/.config/LinuxCockpit/aidj/metadata/`; naming one is all the create dialog asks
(e.g. `AnimeOST`, `JPop-2024`).

## Play frequency and listening stats

- **Song Frequency** (AI DJ page menu): every library song ranked by play count — click a cover to
  send it to the player; the top icon toggles ascending / descending. The toggle is
  **Settings → AI DJ → Playback preferences → Record play frequency**, or the **RecordFreq** chip in
  the conversation status bar.
- **Listening Time Stats** (AIDJ page menu → Listening Time Stats): minutes recorded per hour and
  drawn as heatmaps — granularity **Day (24h per day)**, **Month (days)**, **Year (months)**, with a
  `YYYY-MM` **Jump** field and **Back to now**; hover a cell for its duration and coverage. Counting
  runs in the background: every 30 seconds a sample adds 0.5 minutes while a backend reports Playing,
  **even if the AI DJ page isn't open**. The toggle is
  **Settings → AI DJ → Playback preferences → Listening time stats** (or the **Listen** chip).
- **Record song timeline**: appends each listening event to `songs_timeline.csv`, on by default.

Stats are a **personal privacy scope** — AI snapshots and screenshots redact them.

## Bilibili video download

Pull Bilibili videos (audio) into the library with AI-generated metadata:

1. **Settings → AI DJ → Bilibili Video Import & Extension**: flip the **Enabled / Disabled** switch
   (the first time a disclaimer dialog opens — click **Agree & Enable**), then **Scan QR Login** or
   **Import Credential** (file path, Cookie string or JSON all work). As a guest you can only parse
   360P/480P basic streams.
2. AI DJ page menu → **Bilibili Video Download**: paste BV / AV IDs or links and click
   **Resolve video**.
3. Multi-part videos split into rows and already-downloaded ones are flagged; remove mistakes or
   **Clear all**.
4. Pick a **metadata write slot**, whether to **Skip existing**, **Audio only (m4a)** or
   **Video stream (mp4)**, then click **Confirm download (N items)** to start a background task whose
   progress shows in the background panel.

Files land in `Bilibili/<BV id>/` under your music folder, and metadata goes to the chosen slot
(default `Bilibili-Current.metadata`). Play the resulting mp4 and open the **Lyrics** page for MV, or
turn on **Audio Only Mode** in settings to just listen.

## Read more

- Back to [AI DJ](../main.md).
- [Built-in Player](../Player/BuiltInPlayer.md): playback backend, EQ, speed and the LAN remote.
- [Lyrics Page](../Lyrics/LyricsPage.md): lyrics and the MV view.

## Command line

```bash
aidj.freq                                   # play frequency list
aidj.time-stats                             # listening time (one row per hour)
aidj.time-range --start 1735689600000 --end 1738368000000   # range query (ms timestamps)
aidj.sync                                   # sync new-song metadata right away (foreground)
aidj.metadata-sync                          # same, but as a background task
aidj.analyse --field genre                  # distribution of one field
aidj.metadata-slots-list                    # list slots and their active state
aidj.metadata-slots-toggle --slot AnimeOST  # activate / deactivate a whole slot
aidj.metadata-slots-set-write --slot AnimeOST   # set the write target slot
aidj.bili-resolve --input "BV1xx411c7mD"    # resolve BV/AV IDs and expand multi-part videos
aidj.save --name MyList --songs "..."       # save a playlist
aidj.load --name MyList                     # read a playlist back
aidj.reload                                 # rescan the library and config
```

## FAQ

**New downloads don't show up in the library?** Check the music folders are configured and the files
really are audio; after the sync finishes run `aidj.reload`, or reopen **Song Frequency** to see the
count.

**Sync stalls or reports lots of "no lyric found"?** Check that the external NCM service is running
(`http://localhost:3000`) or switch to the built-in direct connection (needs the disclaimer signed);
lowering **Sync concurrency** is more stable.

**I changed metadata but picking didn't change?** Check the slot is active (the header's
"Active: N songs") and that the field is enabled under **Metadata field injection**.

**Stats don't match how long I listened?** Counting samples every 30 seconds and adds 0.5 minutes
while playing (rounded to whole minutes on flush); pausing stops it, and a force-killed process can
lose at most the part-hour not yet flushed.
