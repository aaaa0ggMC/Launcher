# AI Loop: Models & Usage

> Last updated: 2026-10-03

This page covers the money-and-quota side of the AI loop: which model each agent uses, how the
**Tokens** chip counts and what its hover breakdown means, how to read cache hit rates, the optional
web search, and how API keys are stored. The workflow itself is described in
[AI Loop: How It Works](HowItWorks.md).

## Models per agent

Open page menu → **Models** (the same panel as **Settings → AI DJ → AI Models**). Every row is one
model slot:

| Row            | Used for                                                                    |
| -------------- | --------------------------------------------------------------------------- |
| Default model  | Text mode, title generation, and every agent that doesn't pin its own model |
| LoopAgent      | The agent that drives the batch                                             |
| LibAgent       | The library sub-agent (`ask_library_agent`)                                 |
| DreamAgent     | The seed-dreaming sub-agent (`dream_from_seeds`)                            |
| RankAgent      | The final ordering / DJ-intro agent                                         |
| VocabAgent     | Tag cleanup: proposes the canonical vocabulary                              |
| SanitizeAgent  | Tag cleanup: re-tags songs that don't map directly                          |
| Metadata model | Extracting language / emotion / genre / loudness / review for new songs     |

Each agent dropdown's first entry is **Follow default (model)** — picking it (or clearing the row)
makes that agent use the default model. Model names not in the endpoint's list can be typed by hand.
Changes save immediately and take effect from the next batch; nothing needs a restart.

The main chat page and the persistent-mode panel no longer have model dropdowns of their own — all
model choices live in this one panel.

## Tokens and caching

The **Tokens** chip in the status bar accumulates in real time: every LLM call adds to it as soon as
it returns, sub-agent calls included. **Context** / **Completion** beside it report the input /
output of the most recent LoopAgent call.

Hover the **Tokens** chip for the breakdown:

- **Input**, **Cached** (cache hits, with the hit rate) and **Output**, plus the **Total**.
- The same input / cached / output split **per agent** (LoopAgent, LibAgent, DreamAgent,
  RankAgent, …).

Cached tokens are read from the endpoint's own accounting: DeepSeek's `prompt_cache_hit_tokens` or
OpenAI's `prompt_tokens_details.cached_tokens`; when the endpoint doesn't report cache usage, the
breakdown says so instead of guessing.

Session records store the tokens of every round (including the per-agent split) together with
Context, so opening a session, reverting to a message, forking from one, or starting `/persist` all
restore the counters. Sessions created by older versions have no such data and show 0.

### Reading the cache hit rate

The overall hit rate is usually much lower than LoopAgent's own, and it **can be as low as 20–30 %
without anything being wrong**. Why:

- **LoopAgent hits often.** Every round re-sends the conversation so far, so the prefix is identical
  and mostly served from cache — around 80 % in practice.
- **Sub-agents (LibAgent / DreamAgent) send library fragments.** Within one pool, and across calls
  in the same batch, those fragments are identical and do hit cache. But each newly filtered
  candidate pool is read for the **first** time at least once, and a first read never hits — those
  misses carry a lot of tokens, which pulls the overall rate down.
- **RankAgent's input is the batch's own candidate list**, unique per batch, so its hit rate is low
  by nature — its token volume is small, so it matters little.

So: judge LoopAgent's rate on its own, expect first reads of new pools to miss, and don't chase the
average. (Earlier versions re-serialized sub-agent fragments as songs were added, which dropped
cache hits to almost zero; that is fixed — the exclusion list now sits at the end of the prompt.)

DeepSeek's cache is prefix-matched and best-effort: a request needs a moment to be cached after it
is issued, and requests sent in parallel can't use each other's cache.

## Web search (Tavily)

**Settings → AI DJ → Web search (Tavily)**:

| Setting              | Default | What it does                                                            |
| -------------------- | ------- | ----------------------------------------------------------------------- |
| **Allow web search** | Off     | Master switch; the tool only appears for the AI when on                 |
| **Tavily API Key**   | —       | Your key; without it the tool stays unavailable and settings remind you |
| **Results**          | 5       | Results per search (up to 10)                                           |
| **Depth**            | Basic   | Basic or Deep                                                           |

The AI uses it to look up facts about artists, songs, releases and news so it can understand a
request — **songs are still picked only from your library**. Page content is treated as untrusted
material and the AI won't follow instructions found in it. Requests go through the system proxy.

Queries are sent to Tavily, which means anything you type in a request may leave your machine as a
search query. Turn the switch off if that bothers you.

## API keys

The **API key** (OpenAI-compatible endpoint) and the **Tavily API key** are credentials:

- Stored **encrypted** in `aidj/config.json` (`enc:v2:` prefix, using Cockpit's crypto module) and
  decrypted only in memory. A plain key left by an older version is migrated to ciphertext the first
  time it is read.
- **Write-only** in settings: once set, the panel reports that a key exists (stored encrypted, never
  shown again) and that typing a new value replaces it; a button clears the saved key. The AI can't
  read them and can't change them through commands.
- After a key has been migrated to ciphertext, don't downgrade to an older version of AI DJ — it
  would treat the ciphertext as the key itself.

## Advanced / CLI

```bash
aidj.loop-preview --task <persistent task id>   # show the model each agent will actually use,
                                                # next to the batch's prompt, tools and playbooks
aidj.update-config                              # read / write aidj/config.json (loop_* keys)
```

## Read more

- Back to [AI DJ](../main.md).
- [AI Loop: How It Works](HowItWorks.md): the agents, tools, playbooks and workflow card.
- [Tag cleanup](../Library/TagCleanup.md): what the VocabAgent and SanitizeAgent slots are for.
- [Library & Metadata](../Library/MetadataAndStats.md): where metadata comes from.
