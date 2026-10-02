# Built-in templates and script API

> Last updated: 2026-10-01

This page walks through the five presets in the **Templates** menu and the `cockpit.*` API available
to scripts. Each preset doubles as a worked example of the pattern "declare params → call commands →
report progress → return a result".

## Built-in templates

### Cockpit IPC Quick Start

Shows how to declare parameters, call Cockpit commands, run shell commands and report progress.
Parameters are `greeting` (string), `showStats` (boolean) and `concurrency` (slider). The script
first calls `cockpit.listCommands()` to print how many commands are registered, then
`dashboard.stats` for system status, then runs `uname -a`, and finally returns an object with the
command count, the greeting and the execution time. **Start here on your first run.**

### System Health Report

A combined check of system stats, GPU load, Docker containers and systemd services. Three booleans
enable or disable each section. Every step is wrapped in try/catch, so a missing ability or service
only logs a warning and the run continues; the summary is returned as the result. Failed systemd
units are listed in red via `cockpit.error`.

### Arch Mirror Benchmark

Uses `mirror.get` and `mirror.test` to benchmark and rank mirror sources. The `topCount` parameter
controls how many of the best mirrors to list; results are sorted by latency ascending, timeouts
show "connection timed out", and each entry notes whether it is currently enabled. Failures throw,
and the console shows the reason.

### Wallpaper Rotator

Scans a directory for wallpapers and applies a random one. Parameters are `wallpaperDir` (path,
defaulting to `$HOME/Pictures`) and `autoNotify` (whether to notify after switching). It lists
candidates with `display.wallpapers`, picks one at random and applies it with `display.wallpaper`;
an empty directory returns `{ status: 'no_wallpapers_found' }`.

### Data Pipeline & Archive

Fetches logs from an external API or the system, cleans and converts them, and saves them to local
storage. Parameters are `logLimit` (how many log lines to pull) and `archiveName` (archive filename
prefix). The script reads `logs.query`, counts the info/warn/error distribution, writes
`~/.config/LinuxCockpit/<prefix>-<timestamp>.json` and posts a system notification.

## The cockpit API

The global object available to scripts is `cockpit`:

| API                                                                          | Purpose                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `cockpit.command(name, args?)`                                               | call any registered Cockpit command and return its result   |
| `cockpit.listCommands()`                                                     | list every command's name / description / usage             |
| `cockpit.exec(cmd, args?, opts?)`                                            | spawn a program, returning `{ stdout, stderr, code }`       |
| `cockpit.sh(script, opts?)`                                                  | run a bash snippet, returning stdout; non-zero exit throws  |
| `cockpit.job(name, args?)`                                                   | start a registered background job, returning task info      |
| `cockpit.log / info / warn / error(…)`                                       | print log lines at different levels                         |
| `cockpit.progress(pct, message?)`                                            | update the progress bar and caption                         |
| `cockpit.sleep(ms)`                                                          | cancellable delay                                           |
| `cockpit.fetch(url, opts?)`                                                  | network request wired to the cancellation signal            |
| `cockpit.notify(title, body?)`                                               | post a system notification                                  |
| `cockpit.fs.readFile / writeFile / readdir / exists / mkdir / stat / unlink` | local file operations                                       |
| `cockpit.storage.get / set / delete / all`                                   | KV store in `~/.config/LinuxCockpit/scripting/storage.json` |
| `cockpit.env`                                                                | main-process environment variables                          |
| `cockpit.signal`                                                             | the cancellation signal (fires on stop)                     |
| `cockpit.config`                                                             | the values currently filled in the parameters panel         |

Additional notes:

- Both TypeScript and JavaScript run: TS is transpiled by esbuild, and `async/await`, top-level
  `return` and module-style `export const …` all work.
- The `export` keywords are stripped before the body is wrapped in an async function, so ESM-style
  code never errors.
- Stopping fires `cockpit.signal`; in-flight `command` / `sh` / `sleep` / `fetch` calls throw.
- Output is batched: high-frequency `cockpit.log` calls are merged before reaching the UI, so they
  cannot freeze the page.

## Parameter schema in full

```ts
export const config = {
  key: {
    type: 'string' | 'number' | 'boolean' | 'select' | 'slider' | 'secret' | 'path',
    label: 'Label shown in the panel',
    description: 'Helper text under the label (optional)',
    default: 'Default value',
    options: [{ label: 'Display', value: 'Actual' }], // select only
    min: 1, // number / slider
    max: 10,
    step: 1, // number / slider
    placeholder: 'Input placeholder (optional)'
  }
}
```

- The panel pre-fills the form from `default`, and the script reads whatever the panel holds.
- `secret` renders a password field; `path` adds a picker button; `slider` uses min/max/step.
- The panel re-parses about 0.25 s after each code change, so renaming or removing a field is
  reflected immediately.

## Next

- [Back to Workflow Scripting](../main.md)
- [Running, debugging and background jobs](RunningAndDebugging.md): output types, common errors and
  how to hand work to the background.
