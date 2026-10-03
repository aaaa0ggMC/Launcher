# Tag cleanup

> Last updated: 2026-10-03

Over time the `emotion`, `genre`, `language` and `loudness` tags of a library drift into synonyms and
near-duplicates, which makes tag-based picking noisy. **Tag cleanup** (AI DJ page menu → **Tag
cleanup**) merges them into one clean vocabulary and rewrites the songs that don't conform. It runs
in four steps and always writes its results into a **new metadata slot** — your original data is
never modified. Files live under `~/.config/LinuxCockpit/aidj/sanitize/`.

> Quick start: page menu → **Tag cleanup** → tick the fields to clean → **Generate vocabulary** →
> review the mapping → **Estimate** → **Start cleanup (background)** → **Use cleaned metadata**.

## 1. Requirements

- Tick the fields to clean (each shows how many distinct tags it currently has) and write any extra
  requirements. Requirements are English by default, e.g. "use Chinese; keep emotions under 30; keep
  city pop". Then click **Generate vocabulary**.
- A **VocabAgent** makes one call per field. Fields with more than 120 tags go in two steps: first
  the canonical tags, then the old tags are mapped in parallel groups of 120.
- This runs as a **background task**: you can leave the page and come back, each field shows its own
  progress (waiting for the model / thinking / generating · N characters / done), the task can be
  stopped, and the background panel keeps the log.
- **Earlier drafts**: every new proposal archives the previous draft (the last 10 are kept) and an
  archived draft can be restored; restoring archives the current draft first.

## 2. Review

One page per field:

- A summary line: how many tags collapse into how many canonical ones, how many old tags are
  deleted, and whether everything can be cleaned by direct mapping or some tags stay unmapped (those
  songs are handed to the SanitizeAgent).
- The **canonical tags**: delete the ones you don't want, add new ones.
- The **mapping list**: searchable, filterable to changed entries only, and editable row by row —
  point an old tag at a canonical one, or leave it empty to delete that old tag.
- **Feedback on this field** plus **Redo this field**, if the proposal misses the mark.

Edits save automatically. When the cleanup runs, **every** selected field of **every** song is
rewritten through the mapping; tags that are in neither the vocabulary nor the mapping are dropped.
Only songs carrying unmapped old tags are sent to the SanitizeAgent.

## 3. Run

- Options: **Try to fill unknown languages** (on by default — songs whose language can't be
  determined stay `unknown` rather than being guessed) and **Songs per SanitizeAgent call** (default
  1, up to 20).
- **Estimate** shows, per metadata source, how many songs map directly, how many need the
  SanitizeAgent, the main reasons, and how many cached results can be reused.
- **Start cleanup (background)** begins the run.

The **SanitizeAgent** sees the raw metadata plus a lyric snippet per song and may only output tags
from the vocabulary; code validates its output, retries once on violations, and drops tags that
still don't conform. Language stays `unknown` when the information isn't enough — no guessing.

Each song's result is cached per vocabulary version, so stopping mid-run and starting again with the
same vocabulary continues where it left off.

## 4. The results land in a new slot

- The main library's results are written to `Sanitized-<date>.metadata`, the Bilibili slot's to
  `Bilibili-Sanitized-<date>.metadata`.
- The new slot is registered as **disabled** first and only then filled; the source data is left
  untouched.
- A source that is completely unchanged by the cleanup gets **no** new slot — the run record notes
  that its songs were unchanged and the original slot is kept.

## 5. Cleanup runs

The **Cleanup runs** list holds every run:

- **Use cleaned metadata** enables the new slot, disables the source, points future syncs (regular
  and Bilibili imports) at the new slot and activates that vocabulary.
- **Switch back** restores the previous state; if this run cleaned up an earlier run's results, it
  switches back to that earlier run.
- While a cleaned vocabulary is in use, new songs synced later (Bilibili imports included) are
  normalized to the vocabulary on write, and the metadata extraction prompts carry the allowed tags.
  Tags that are in neither the vocabulary nor the mapping are dropped, and an undeterminable
  language becomes `unknown`.
- The source is always the current write target, so you can clean up on top of a previous cleanup.
- After switching back, songs that were synced into the cleaned slot have no record in the original
  slot, so the next sync treats them as new and re-extracts them.

## Unknown language

Filtering by language while the AI picks **never** removes songs with unknown language — a missing
tag is not a language mismatch — and the sub-agents and RankAgent are likewise told not to drop
`unknown` songs.

## Files and commands

`~/.config/LinuxCockpit/aidj/sanitize/` holds `draft.json` (current draft), `drafts/` (archived
drafts), `runs.json` (run records), `active.json` (the vocabulary in use) and `cache-*.jsonl`
(resume caches).

```bash
aidj.tags-cloud                                       # tag cloud of the current write slots (main library + Bilibili)
background.job --name aidj.vocab-propose              # job behind "Generate vocabulary"
background.job --name aidj.sanitize                   # job behind "Start cleanup (background)"
aidj.vocab-draft [--set '<json>']                     # read or replace the current vocabulary draft
aidj.vocab-drafts                                     # list archived drafts
aidj.vocab-draft-restore --version <n>                # restore an archived draft
aidj.sanitize-estimate                                # per-source estimate for a cleanup run
aidj.sanitize-runs                                    # list cleanup runs and their state
aidj.sanitize-switch --run <id> --use sanitized       # enable a run's cleaned metadata
aidj.sanitize-switch --run <id> --use original        # switch back to the original metadata
```

## Read more

- Back to [AI DJ](../main.md).
- [Library & Metadata](MetadataAndStats.md): metadata sync, slots and stats.
- [AI Loop: How It Works](../AILoop/HowItWorks.md): how the agents use these tags when picking.
- [AI Loop: Models & Usage](../AILoop/ModelsAndUsage.md): the VocabAgent / SanitizeAgent model slots.
