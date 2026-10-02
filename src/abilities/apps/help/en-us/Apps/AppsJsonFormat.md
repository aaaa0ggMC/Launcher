# apps.json format

> Last updated: 2026-10-01

Each search root holds one `apps.json` — the app registry for that directory. Maintaining it by hand
is a first-class workflow: the scanner (`apps.rescan`) only fills gaps and **never overwrites** what
you wrote. Save the file and it takes effect immediately (roots are watched, so the page refreshes
live).

## What the file looks like

```jsonc
{
  "version": 1,
  "apps": {
    "bili-viewer": {
      // name / description / alias may be a string or { "zh": ..., "en_US": ... }
      "name": { "zh": "哔哩观看器", "en_US": "Bili Viewer" },
      "alias": "bili",
      "description": "Local bilibili cache player",
      "path": "bili-viewer", // directory/script relative to the root, or an absolute path
      "icon": "default/television", // default/<name>[/padding] · emoji/😎 · file//path
      "exec": {
        "type": "uv",
        "command": ["bili-viewer"], // entry point, e.g. ["app.js"] / ["bili-viewer"]
        "cwd": "{self}", // {self} = the entry's own dir; blank defaults to the same
        "terminal": true // run in a terminal
      },
      "actions": {
        // additional actions: the buttons next to "Launch" on the card
        "stop": {
          "name": "Stop",
          "icon": "default/pause",
          "exec": { "type": "systemd", "command": ["stop", "bili.service"] },
          "risk": "low"
        }
      },
      "tags": ["python", "download"], // manual tags
      "security": {
        "risk": "medium", // low / medium / high — button color & confirmation
        "auto_note": "Script contains sudo escalation", // scanner-generated, don't hand-edit
        "note": "Needs read/write access to ~/Downloads", // your note; shown in the dialog
        "acknowledged": true // already confirmed — never ask again
      },
      "managed": false // false = hand-maintained; rescans never touch it
    }
  }
}
```

## Field reference

| Field                | Type / values                                        | Description                                                                |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `name`               | string or `{zh, en_US}` object                       | Card title; highest search weight                                          |
| `description`        | string or object                                     | Card description; falls back to `path`                                     |
| `alias`              | string or object                                     | Alias: CLI shortcut and sidebar search keyword                             |
| `path`               | relative or absolute path                            | Project dir / script; determines the default cwd                           |
| `icon`               | `default/name[/padding]` · `emoji/😎` · `file//path` | Blank or `auto` = default icon                                             |
| `exec`               | object                                               | Primary launch = the card's **Launch** button                              |
| `actions`            | `{ actionId: { name, exec, ... } }`                  | Additional actions = the other card buttons                                |
| `tags` / `tags_auto` | string array                                         | Manual tags / scanner tags (python, node, script…), merged for display     |
| `security`           | `{ risk, auto_note?, note?, acknowledged? }`         | Risk level and notes                                                       |
| `managed`            | `false` or absent                                    | `false` = hand-maintained; rescans skip it entirely                        |
| `transformer`        | JS source string                                     | Live-output parser; only pops a window with `transformer_display`          |
| `missing`            | `true`                                               | Runtime field: source file not found; hidden unless "Show missing entries" |
| `root`               | string                                               | Runtime field: the search root this entry lives in                         |

## Multi-language values

`name` / `description` / `alias` accept object form, resolved against the current language:

```jsonc
"name": { "zh": "哔哩观看器", "en_US": "Bili Viewer" },
"description": { "zh": "B 站缓存播放器", "en_US": "Local bilibili cache player" }
```

Fallback chain: **current language → `en_US` → first available value → raw value**, so a single
language never breaks the UI. In the interface these fields live in the expandable
"Multi-language" area at the bottom of the **Add app** / **Edit** dialog, one name and description per
language. Action `name` / `description` support the object form too.

## Exec types

The eight types in the dropdown expand to the real commands:

| type      | Actually runs                                                           |
| --------- | ----------------------------------------------------------------------- |
| `uv`      | `uv run --directory <cwd> <command>`                                    |
| `python`  | `<cwd>/.venv/bin/python <command>` (or `python3` when there is no venv) |
| `node`    | `node <command>`                                                        |
| `docker`  | `docker <command>`                                                      |
| `systemd` | `systemctl [--user] <command>` (`--user` dropped when root is checked)  |
| `script`  | `bash <script path>` (works even without +x)                            |
| `desktop` | `gio launch <desktop file>`                                             |
| `custom`  | runs `<command>` directly                                               |

Other `exec` fields: `cwd` (`{self}` / `~`-prefixed / absolute / relative to the entry dir; blank =
entry dir), `terminal`, `background` (wins over terminal), `root` (pkexec), `env`, `args`.

## Rules of hand maintenance

- **Hand edits win**: fields already present in `apps.json` are never touched; the scanner only adds
  new entries, fills missing fields, and refreshes `tags_auto` and `security.auto_note`.
- **`managed: false`**: the entry is entirely yours — rescans skip it completely (not even the
  missing flag).
- **Undetectable entries**: registry entries whose file is gone get `missing` (hidden by default,
  card dimmed). Put the file back or fix `path` to restore them.
- **`security.auto_note` is scanner output** and gets refreshed on the next rescan; write your own
  text in `note` instead.
- **Deletion is permanent**: removing an id from the file deletes the app; there is no recycle bin.

## Auto-scanning and risk assessment

`apps.rescan --root <dir>` scans one level deep and drafts entries as follows:

| Directory contents   | Draft                                                          |
| -------------------- | -------------------------------------------------------------- |
| `pyproject.toml`     | uv tool (first `[project.scripts]` command, run in a terminal) |
| `package.json`       | node app (`main` or `app.js`)                                  |
| `.venv/`             | `python main.py`                                               |
| `Dockerfile`         | `docker compose up -d`                                         |
| anything else        | `xdg-open .` (medium risk)                                     |
| script / binary file | run with `bash` (marked `managed: false` when not executable)  |

The scanner also reads `.sh/.py/.js` text files for **risk assessment**: `curl | sh` / `wget | sh`
downloads, `sudo` / `pkexec` escalation, `chmod`/`chown` permission changes, `/etc/` and `rm -rf`
system edits, network activity (curl/wget/nc/ssh), and suspected credentials (.env / api_key /
token / secret) — combined into `low` / `medium` / `high` plus `auto_note`. Risk only affects button
color and whether a confirmation pops; it never blocks a launch.

## Next steps

- Back to [Apps](../main.md).
- Background tasks, root escalation and the live output window:
  [Background tasks & live output](../Advanced/BackgroundTasksAndLiveOutput.md).
