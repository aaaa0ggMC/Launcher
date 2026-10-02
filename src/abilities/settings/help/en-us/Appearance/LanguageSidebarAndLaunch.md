# Language, Sidebar and Launch

> Last updated: 2026-10-01

This page covers the **Language**, **Sidebar** and **Launch** cards under
**Settings → Appearance**.

## Language

The **Language** card (titled "Language") is a radio group:

- **中文**
- **English (US)**

Picking one writes the config immediately. The caption below reads "Switch language —
reloads the page to apply": most text switches live; if a label looks stale, restart to
normalize everything. The help dialog also reloads its tree in the new language.

## Sidebar

The **Sidebar** card (titled "Sidebar Sorting") controls how sidebar entries are ordered.
The caption explains: frequency and recent come from `apps.csv`, and **opening a sidebar
entry or launching an app increments the counters**.

### Sort rules (radio group)

| Option          | Behavior                                            |
| --------------- | --------------------------------------------------- |
| Alphabetical    | Grouped by sidebar category, then by name (default) |
| Usage frequency | By open counts in `apps.csv` — most-used first      |
| Recently used   | By last open time — just-used first                 |
| Custom          | Exactly the order you drag                          |

### Custom order

Picking **Custom** expands a card grid with one card per ability (icon, name, category,
index):

- **Drag to reorder**: grab a card by its drag handle on the right (or anywhere on the
  card) and move it up or down;
- **Buttons**: each card has ↑ ↓ buttons that move it one slot at a time;
- Newly added abilities are appended to the end;
- **Reset to Alphabetical** in the top-right restores the default order in one click.

The order lives in `~/.config/LinuxCockpit/sidebar-order.json`; changes are broadcast
immediately and the sidebar re-sorts on the spot.

### Clear usage records

The red text button **Clear usage records** at the bottom of the card resets every
counter in `apps.csv` and **takes effect immediately** (it spins briefly). Both the
"usage frequency" and "recently used" sorts then start accumulating from zero.

## Launch

The **Launch** card has a single switch: **Require confirmation before every launch**
(on by default). With it off, launching an entry from the Apps page no longer pops a
confirmation. The setting is persisted instantly and survives restarts.

> Note: medium / high-risk entries on the Apps page still get a security confirmation
> (with a "Got it — don't ask again" option). That's a separate per-entry risk
> mechanism, unaffected by this switch.

## The initial page isn't on this page

"Which ability opens at startup" (`sidebar.default` in config.json, default `cli`) has
**no UI switch** — change it from the CLI:

```bash
config.get                                          # view sidebar.default
config.set --patch '{"sidebar":{"default":"apps"}}'  # open Apps at startup
```

An id that doesn't exist falls back to the first ability in the active sort order.

## Related commands

```bash
config.get                                            # read language / sidebar / runtime
config.set --patch '{"language":"zh"}'                # switch language
config.set --patch '{"sidebar":{"sort":"frequency"}}' # sort by usage frequency
sidebar.order.get                                     # view the custom order
sidebar.order.set --order '["apps","aidj"]'           # overwrite the custom order
stats.list                                            # view usage stats
stats.clear                                           # clear usage records
```

Back to [Settings](../main.md).
