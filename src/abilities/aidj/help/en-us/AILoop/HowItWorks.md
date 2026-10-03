# AI Loop: How It Works

> Last updated: 2026-10-03

AI DJ's picking loop no longer dumps your whole library into one prompt (though it still can). In the
default **Agent** mode an agent works in rounds: it reads your request, calls a toolbox over the
library — title and lyric search, tag clouds and filters, random picks, sub-agents that curate or
dream — and a final ranking agent orders the batch and writes the DJ intro. Everything the agents do
for one batch is shown as a **workflow card** in the chat. Settings live under
**Settings → AI DJ → AI loop**; this page explains what they change.

> Quick start: just chat. "something chill in Chinese", "start from 辽阔的森林", "some Jay Chou" or
> "no music, let's talk" all work — the loop picks its own playbook and tools. Open the workflow card
> above the reply to see what it did.

## Two loop modes

**Loop mode** (**Settings → AI DJ → AI loop**) picks how a batch is produced:

| Loop mode                            | What it does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| **Agent (tools search the library)** | Default. An agent searches and filters the library tool by tool (this page).     |
| **Text (whole library in prompt)**   | The older way: the whole library is injected into the prompt and the AI answers. |

Changing **Loop mode** takes effect for **newly opened** sessions; every other AI loop setting
applies from the **next batch**, so a running persistent session picks them up without a restart.
Instant chat (the main page's input box) and persistent sessions (`/persist`, the background panel)
run the **same workflow** in agent mode.

## Inside one batch

A batch is one workflow run: **LoopAgent** → (sub-agents) → **RankAgent**.

- **LoopAgent** is the driver: it understands the request, calls the tools and organizes the
  workflow. It doesn't read songs one by one — it judges at the **tag layer** (reads the tag cloud,
  keeps or drops whole tag groups) and leaves picking individual songs to the sub-agents and search
  tools.
- **LibAgent** (tool `ask_library_agent`) reads a slice of the library (tags + reviews) and picks
  songs matching a description. LoopAgent decides the slice: the current candidate pool (default),
  the whole library, an explicit list of song ids, or a filter.
- **DreamAgent** (tool `dream_from_seeds`) is given seed songs (with tags, reviews and lyric
  snippets), imagines the "scene" they open up and expands outward within the chosen scope.
- **RankAgent** always runs after LoopAgent finishes (you can switch it off in settings): it sees
  the full information of all candidates, orders them, drops the unsuitable ones and writes the DJ
  intro. LoopAgent's last reply is only a hand-over note for RankAgent.

The division of labour: judgement belongs to the LLM, legality is guaranteed by code. Song ids must
exist; already-played songs can't be queued again (a pinned start is the exception); on
auto-refill each batch has a per-artist cap; sub-agents can only return songs inside their scope;
RankAgent can't add new songs; and a pinned start is always first. If RankAgent's output can't be
parsed, the pinned start plus the first N candidates are kept (N = tracks per batch) and the card
says so; in the normal case at most 1.5× the tracks per batch are kept. Candidates run
**tracks per batch × candidate factor** — by default 8 × 2 = 16 candidates, about 8 of which make
the final batch.

### Tools

LoopAgent can call these tools (each song carries a short id like `#k3f9`, stable for your library,
so the AI refers to songs by id instead of copying titles):

| Tool                                     | What it does                                                                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use_playbook`                           | Load the full steps of one playbook                                                                                                                                                                                  |
| `search_titles`                          | Search all songs by title / artist (simplified-traditional tolerant; already-played songs are flagged)                                                                                                               |
| `search_lyrics`                          | Full-text lyric search (spacing and punctuation don't matter; returns the matching line). Sub-agents can't see lyrics, so quoting or describing a lyric goes through this                                            |
| `get_songs`                              | Full song information, with lyric snippets when asked                                                                                                                                                                |
| `tag_cloud`                              | Tag cloud of the current candidate pool (emotion / genre / language / loudness with counts)                                                                                                                          |
| `filter_library`                         | Keep or drop songs by tag (or lyric) in bulk to shrink the pool; a filter that empties the pool is rejected, `reset` starts over                                                                                     |
| `search_library`                         | Search inside the current pool                                                                                                                                                                                       |
| `similar_to`                             | Find resonant songs by tag similarity (other artists by default)                                                                                                                                                     |
| `recent_history`                         | Recently played songs                                                                                                                                                                                                |
| `random_pick`                            | Pick random songs from the **current pool** (excluding played and already-queued), with optional filters, same-artist limits and avoiding recently played artists; `queue=true` adds them straight to the candidates |
| `ask_library_agent` / `dream_from_seeds` | Call the LibAgent / DreamAgent                                                                                                                                                                                       |
| `queue_tracks` / `unqueue_tracks`        | Add / remove songs by id; `pin_first` pins a start at the top of the batch                                                                                                                                           |
| `no_music`                               | The user doesn't want music this round (just chat, a question, "stop"): no songs, no RankAgent, LoopAgent's reply is the answer, and auto-refill pauses in persistent mode                                           |
| `web_search`                             | Search the web (Tavily); only offered when web search is enabled with a key in settings                                                                                                                              |

### Playbooks

Four playbooks ship built in. LoopAgent only sees a catalogue (id + when to use) in its system
prompt and fetches the steps with `use_playbook` when it wants them. Playbooks are guidance, not a
rigid script.

| Playbook      | When                                          | What it does                                                                                                                                                                          |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed_start`  | Start from one song / one lyric line / phrase | Title search → lyric search if no hit → read full info incl. lyrics → pick a start (just one if the mood clashes) → pin first → drop mismatched tags → DreamAgent expands → hand over |
| `artist_pick` | "some <artist>"                               | Title search for that artist's songs → if many, let LibAgent pick by current mood → queue (a user-named artist ignores the per-artist cap)                                            |
| `radio_flow`  | Auto-refill with no new request               | Read the recent sequence → drop tags that would break the flow → use a recent song as an anchor and let DreamAgent continue; `random_pick` one or two for surprise                    |
| `chat`        | Chat only, no music                           | `no_music` first, `web_search` for facts if needed, answer in the listener's language and maybe offer songs afterwards                                                                |

You can add playbooks without touching code: drop a `.md` in `src/abilities/aidj/loop/playbooks/`
(a `---` block with `id` / `title` / `when` at the top, steps in the body), or list them in
`preferences.loop_playbooks` in `aidj/config.json` (each entry `{id, title, when, steps}`). The same
id overrides a built-in; `preferences.loop.disabled_playbooks` disables them.

## The workflow card

Each batch gets one card, above the AI reply in the main chat and in the persistent panel in the
background tasks. Its title bar shows the playbook used, the status (running · round n of m /
RankAgent ordering / result), the batch's tokens and the elapsed time; when the batch ends it
collapses to a single summary line (e.g. rounds, tool calls, and how many candidates were kept or
dropped — chat-only rounds collapse to "chat only"). The timeline below lists every agent step
colour-coded by agent (LoopAgent / LibAgent / DreamAgent / RankAgent) with the tool name, a one-line
summary ("tag filter 3223 → 2636 tracks", "lyric search → 2 hits", "pinned as start +1", "16 → 8,
8 dropped") and its duration; expanding a row shows the raw arguments and results.

While a batch runs, the "Thinking…" bubble in agent mode shows the **current stage** — which agent
is working and roughly what it is doing (plus the round number) — instead of a character count. In
text mode it still shows a character count.

The workflow is saved with the session as its own record type: reopening a session brings the cards
back. These records are a log for you — they **never enter the AI's memory**. Each raw tool result
is stored truncated to at most 1500 characters.

## Chat-only rounds

Say "no music, let's talk" (or ask something unrelated to picking): LoopAgent calls `no_music`, no
playlist is produced and its reply is the answer — it can search the web for facts and tells
confirmed information apart from hearsay. In persistent mode the round after a chat-only turn
**pauses auto-refill**; the chat says auto-refill is paused and that sending another message
continues. The next message that asks for songs again resumes auto-refill, and the chat confirms it.

## AI loop settings

All under **Settings → AI DJ → AI loop**:

| Setting                                                      | Default    | What it does                                                                                                                                                                               |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Loop mode**                                                | Agent      | Agent (tools search the library) or Text (whole library in prompt)                                                                                                                         |
| **Library order**                                            | By emotion | How the library is arranged in text-mode prompts and sub-agent slices: by emotion (same-mood songs grouped, same-artist neighbours shuffled apart), by genre, or alphabetical (old)        |
| **Max tracks per artist per batch (0 = no limit)**           | 2          | Caps one artist per batch on auto-refill only; a user-named artist is not capped                                                                                                           |
| **Tracks per batch**                                         | 8          | Songs per batch                                                                                                                                                                            |
| **Refill when queue below**                                  | 8          | Queue depth that triggers a new batch                                                                                                                                                      |
| **Recent tracks as context**                                 | 15         | How many recent songs the loop sees as context                                                                                                                                             |
| **Max agent tool rounds per batch**                          | 14         | A "round" is one LLM round-trip (several tools may be called in one round); the UI cap shows this + 1 forced wrap-up round. When to stop is the model's decision — the cap is not a target |
| **Allow library sub-agent (kernel picks its library scope)** | On         | Lets LoopAgent delegate picking to LibAgent with a scope of its choosing                                                                                                                   |
| **Tag filter strength**                                      | Medium     | How aggressively tag filtering narrows the pool (light / medium / strong)                                                                                                                  |
| **Candidate factor**                                         | 2          | Candidates = tracks per batch × factor                                                                                                                                                     |
| **RankAgent orders and writes the DJ intro**                 | On         | Run RankAgent after LoopAgent; off keeps LoopAgent's own order and LoopAgent writes the intro itself                                                                                       |

"By emotion" grouping matters mostly for text mode and sub-agent slices: same-mood songs sit
together and same-artist neighbours are shuffled apart, and artist parsing understands reversed
"title - artist" naming (e.g. `七里香 - 周杰伦`).

## Advanced / CLI

Prompt templates live one file per template in `src/abilities/aidj/loop/prompts/*.md` (not in code);
override one with `preferences.loop_prompts.<name>` in `aidj/config.json`.

```bash
aidj.loop-preview --task <persistent task id>                 # preview the next batch without calling the AI:
                                                              # loop mode, phase, batch prompt, tools,
                                                              # playbooks and the model each agent will use
aidj.loop-preview --task <persistent task id> --system true   # also include the system prompt
```

## Read more

- Back to [AI DJ](../main.md).
- [AI Loop: Models & Usage](ModelsAndUsage.md): per-agent models, tokens and cache hit rates, web
  search, API keys.
- [Library & Metadata](../Library/MetadataAndStats.md): library, metadata and the tag vocabulary.
- [Tag cleanup](../Library/TagCleanup.md): merging redundant tags into a clean vocabulary.
- [Built-in Player](../Player/BuiltInPlayer.md) and
  [Lyrics Page](../Lyrics/LyricsPage.md): the playback side.
