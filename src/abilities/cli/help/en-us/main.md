# CLI

> Last updated: 2026-10-01

The CLI page is an embedded REPL. Every button in the sidebar abilities is backed by a registered
command, and here you can type those command names directly — including operations no button
exposes, which makes it the fastest way to verify "why didn't the button do anything".
Open and use; no login required.

> Quick start: type `help` and press Enter to see all commands; type `<ability>.<command>`
> to run one; **Tab** completes, **↑ / ↓** walk the history.

## What it does

- Run any registered ability command: `<ability>.<command> --flag value`.
- Type `help` for a grouped list of every command — a living command dictionary.
- App shortcuts: `list` / `ls`, `info <alias>`, `launch <alias> [action]`.
- Launch apps by bare alias (e.g. `steam`); add one word for one of its actions.
- **Tab** completion (built-ins + every app alias / id) and **↑ / ↓** history.
- Errors print in red and never end the session — just type the next command.

## UI at a glance

| Area             | Where                | Description                                                                         |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------- |
| Page title       | Top                  | "CLI" + subtitle "Alias launch · tag completion · info `<alias>`"                   |
| Output card      | Below the title      | Your input (❯ prefix, primary color) mixed with output / errors; auto-scrolls       |
| Input line       | Bottom of the card   | ❯ prompt + input box; placeholder "Type a command, Tab to complete, ↑↓ for history" |
| Suggestion chips | Above the input line | Appear when several candidates match; click one to fill it in                       |
| Running hint     | End of the output    | "Running…" while a command is in flight                                             |

The output card is session-style: each command is echoed as typed (❯ prefix) followed by its
output; errors are red. The input box always has focus, so just type and press Enter.

## Common tasks

### Run a command

1. Click the input box (it's already focused when the page opens).
2. Type a command name, e.g. `system.stats`, and press Enter.
3. Output is appended above: objects as indented JSON, arrays one per line, empty results as
   `(无结果)` or `(空)` (these two literals don't change with the UI language).

Parameters: `--flag value`, for example:

```text
docker.action --name my-container --action restart
logs.query --level warn --limit 50
ft.load --name heart
```

- A `--flag` with no value is boolean `true` (e.g. `--exclude-self`).
- Most commands read `--` flags; bare positional words are passed through and used by few
  commands.
- While a command runs the hint "Running…" shows; focus returns to the input on completion.

### List all commands

Type `help` and press Enter. The output has two parts: app-command quick reference at the top
(from the apps ability), then every command grouped by ability with usage and description, e.g.
`[dashboard]`, `[logs]`, `[ft]`. Unsure what an ability offers? Start with `help`.

### Completion and history

- **Tab**: completes against built-ins plus every app alias / id. A single match completes
  immediately; multiple matches first extend to the longest common prefix, then pressing Tab
  again lists candidate chips you can click to fill.
- **↑**: older history entries; **↓**: newer ones; reaching the newest clears the input.
- History lives in this session's memory only and is cleared on restart.

### Launch apps

- `list` or `ls`: list all apps (alias + name); `(empty — no apps found)` when there are none.
- `info <alias>`: show app details — name, alias, path, type and command, risk level, tags,
  action list. The alias can be an app's alias, id or tag.
- `launch <alias> [action]` or `run <alias> [action]`: start an app / run one of its actions.
- A bare `<alias>` equals `launch <alias>`; `<alias> <action>` runs an action.
- Success prints "Started <name> (pid N)"; failure prints the concrete reason.

### When you mistype

- Unknown command name: prints `Unknown command: xxx (type help for all commands)` in red and
  the session continues.
- A command that throws: prints `Error: <reason>` — e.g. docker.action without `--name`
  answers `--name required`.
- A command filtered out by platform / mode is treated as unknown too.
- Just fix and press Enter again; nothing is written and no state is corrupted.

## Read more

- CLI-first is the core design: UI buttons and these commands share one registry, so anything a
  button does can be replayed verbatim here — handy for scripts and issue reproduction.
- Privileged commands (e.g. `hardware.pm-toggle`, mirror toggles) pop the system polkit password
  prompt; with the polkit rules installed, wheel-group users skip it for 5 minutes
  (AGENTS.md §3.1).
- Privacy: calls from this CLI run as usual; only AI / remote-origin calls are intercepted by the
  privacy SDK.

## Command line

This page _is_ the command line; the most useful entries:

```bash
help                                        # list all commands, grouped by ability
list                                        # list all apps (ls is equivalent)
info steam                                  # show app details
launch steam                                # start an app (run / bare alias are equivalent)
system.stats                                # the Overview page's collection command
logs.query --level error --limit 20         # the 20 most recent error log lines
mirror.toggle --name USTC --enable true     # enable a mirror
```

## FAQ

**Tab does nothing?** Completion only fires when something (a built-in or an app alias) starts
with what you've typed; type a few letters first.

**How do I clear the output?** There are no built-in `clear` / `quit` commands right now; output
accumulates until you restart the app (transcripts are never written to disk).

**Do aliases and ids both work?** Yes. Alias resolution matches an app's alias, id and tags,
case-insensitively; `launch` takes a single word, so use the alias for names with spaces.

**A command dumped a wall of JSON?** Objects print as indented JSON and arrays one per line; for
a structured view go back to that ability's page (same command underneath).

**Is history saved?** No — history is memory-only for the current session and is lost on
restart.
