# Ability toggle

> Last updated: 2026-10-01

Location: **Settings → Abilities → Ability toggle** (the full-width card). Here you can
temporarily enable / disable any ability at runtime — no file edits, no restart.

## What it looks like

The card lists every ability sorted by ability id. Each row, left to right: a puzzle
icon, the ability name, the gray ability id, and a switch. Disabled abilities fade out
(about 55% opacity).

## How the switch behaves

1. Flipping a switch pops a snackbar at the top of the page:
   - Off: "{name} disabled (sidebar entry and commands hidden immediately)"
   - On: "{name} enabled"
2. **Disabling is instant**: the ability's sidebar entry disappears right away, and its
   commands behave as if never registered — UI buttons, the CLI and AI calls all stop
   working.
3. **Not persisted**: this is runtime-only state; **a restart restores everything**.
4. If you're sitting on the page of an ability that just got disabled, the shell
   navigates back to the first ability in the sidebar.
5. Flipping it back on restores the sidebar entry and commands immediately.

## Protected abilities

Two abilities can't be disabled (the shell depends on them); trying shows an orange
snackbar "{name} cannot be disabled (protected)" and the switch stays on:

- **Settings** (this very page — disable it and you could never open it again)
- **Background tasks** (multiple abilities depend on the capability it provides)

## When it's handy

- An experimental ability is in the way but you don't want to uninstall or edit code.
- You want a clean interface for a screenshot or a demo, hiding internal abilities.
- Bisecting "which ability is causing this": disable it, and if the problem vanishes,
  you've found it.

## Related commands

```bash
ability.list                                        # list abilities and their enabled state
ability.set-enabled --id display --enabled false    # disable at runtime
ability.set-enabled --id display --enabled true     # enable again
ability.describe --id settings                      # command/job/help manifest for an ability
```

Back to [Settings](../main.md) · Related: [Appearance → Theme and Motion](../Appearance/ThemeAndMotion.md).
