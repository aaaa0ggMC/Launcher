# Workflow Scripting

> Last updated: 2026-10-01

Workflow Scripting is a built-in TypeScript / JavaScript runtime: write a script in the page, call
any Cockpit command with `cockpit.command`, run shell commands, read and write files, post
notifications, and watch the run unfold in the console below. Scripts are stored in
`~/.config/LinuxCockpit/scripts/` and can be reopened any time.

> Quick start: pick a preset from the **Templates** menu (e.g. "System Health Report") → fill the
> fields in the **Parameters** panel on the right → click **Run** at the top right (or press
> Ctrl+Enter) → read the output in the console below.

## What it does

- Automate with TypeScript / JavaScript and `await` any Cockpit command (dashboard, mirrors,
  containers, systemd, logs…).
- Declare `export const config = { … }` and the parameter panel generates the form for you.
- Run shell commands (`cockpit.sh` / `cockpit.exec`), touch the local filesystem (`cockpit.fs`),
  make network requests (`cockpit.fetch`).
- Post system notifications (`cockpit.notify`) and keep state between runs with a KV store
  (`cockpit.storage`).
- The console shows logs, stdout/stderr, progress, duration and the value your script `return`s.
- Hand long work to a background job from inside the script (`cockpit.job('script-run', …)`) so it
  survives page switches.

## UI at a glance

| Area             | Where                      | Description                                                                    |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------ |
| Top toolbar      | Topmost row                | File and editing actions, run / stop                                           |
| Editor           | Left of the toolbar area   | Line-number gutter plus the code area; a strip above shows path and line count |
| Splitter         | Between editor and console | Drag up/down to resize the console                                             |
| Console          | Lower half of the page     | Status, duration, line count, output stream, return value                      |
| Parameters panel | Right side (collapsible)   | Form generated from the script's `config`                                      |

**Top toolbar, left to right**:

- Filename pill: `name.language`, followed by a `•` when there are unsaved changes.
- **TS / JS** toggle (sets the save extension and the compiler loader).
- Icon buttons (hover for their names): **New**, **Open**, **Reload from disk** (only when the
  script has a path), **Save**, **Find**.
- Text buttons: **Templates** (built-in presets), **Saved (n)** (only once you have saved scripts),
  **Snippets** (insert common code), **Parameters** (toggles the right panel; the badge shows the
  field count).
- Far right: **Run** (labelled `Ctrl+↵`), which becomes **Stop** while running.

## Common tasks

### Start from a built-in template

Click **Templates**; the menu lists every preset with a one-line description:

| Template                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| Cockpit IPC Quick Start | Minimal sample: declare params, call a command, run shell, report progress   |
| System Health Report    | Rolls up system stats, GPU load, Docker containers and systemd units         |
| Arch Mirror Benchmark   | Runs `mirror.get` / `mirror.test` and ranks the best mirrors                 |
| Wallpaper Rotator       | Scans a wallpaper directory and applies a random one, optionally notifying   |
| Data Pipeline & Archive | Pulls logs, counts levels, writes a local JSON archive, posts a notification |

Clicking one loads the whole script into the editor and generates its parameter form.

### Create, save and open

- **New**: gives you an `untitled.ts` with a stub.
- **Save** (or Ctrl+S): writes straight to disk when a path exists; otherwise opens a Save-as dialog.
- **Open**: a file picker for `*.ts` / `*.js` / `*.mjs` / `*.cjs`.
- **Reload from disk**: discards editor changes and re-reads the file from disk.
- **Saved (n)**: lists scripts under `~/.config/LinuxCockpit/scripts/` (newest first). Click a title
  to load it; the trash icon at the end of a row deletes it (deleting the one being edited leaves
  you with a fresh empty script).

The last opened file is restored automatically the next time you enter the page.

### Fill parameters

Write this in your code:

```ts
export const config = {
  wallpaperDir: { type: 'path', label: 'Wallpaper dir', default: '~/Pictures' },
  checkGpu: { type: 'boolean', label: 'Check GPU', default: true },
  concurrency: { type: 'slider', label: 'Concurrency', min: 1, max: 10, default: 3 }
}
```

The **Parameters** panel generates controls about a quarter second after you stop typing:
string → text field, boolean → switch, select → dropdown (label/value from `options`),
slider → slider, `secret` → password field (eye icon toggles visibility), `path` → text field with
a folder button, number → number field. The **Reset** icon at the top of the panel restores every
`default`; an empty panel offers **Insert Config Schema**. The script reads values through
`cockpit.config.<key>`.

### Run and stop

1. Click **Run** at the top right, or press Ctrl+Enter in the editor.
2. The console status becomes "Running" and a progress bar appears;
   `cockpit.progress(40, 'text')` updates both the bar and the caption.
3. Click **Stop** mid-run: the main process aborts the script, child processes are killed and the
   status becomes "Cancelled".
4. A clean end reads "Success", a thrown error reads "Error"; duration and line count show in the
   toolbar.
5. A top-level `return` value is displayed in the "Return value:" box at the bottom of the console.

Note: when the script has a file on disk and the editor has no unsaved changes, the on-disk version
is loaded before running.

### Read the output

- Every line carries a timestamp and a type tag `[log]` / `[info]` / `[warn]` / `[error]` /
  `[stdout]` / `[stderr]` / `[result]` / `[system]`, colour-coded by type.
- The three icons at the top right of the console (hover for names): **Auto-scroll** (toggle; when
  on it stays pinned to the newest line), **Copy** (copies all output), **Clear**.
- Objects returned by `cockpit.command(...)` can be printed with `cockpit.log(obj)` and are
  formatted as indented JSON.

### Find and replace

Ctrl+F (or the magnifier in the toolbar / above the editor) opens the floating search box at the
top right: typing shows a match count, Enter jumps to the next match, Shift+Enter to the previous,
the `Aa` icon toggles case sensitivity, Esc closes. The downward arrow to the left of the search box
reveals the replace row: **Replace** replaces the current match, **Replace All** replaces all of
them at once.

### Snippets

The **Snippets** menu inserts, at the cursor: a config schema, a Cockpit command call, a shell
command, a file read, a file write, a network request, a sleep, a system notification, and a KV
storage call.

## Read more

- [Built-in templates and script API](Usage/TemplatesAndScripts.md): what each of the five presets
  does, plus the `cockpit.*` API reference.
- [Running, debugging and background jobs](Usage/RunningAndDebugging.md): what each output type
  means, how to triage failures, and how to move work to the background.

## Privacy and security

- `scripting.run` and `scripting.eval` are "arbitrary code execution" commands, so AI / remote
  callers need the system.exec clearance; your own use from the UI is unaffected.
- `secret` parameters render as password fields that the agent cannot read — but treat them as
  front-end input, since what the script does with them is up to you.
- A script is effectively a local admin account: it can run any command and write any path. Only
  run scripts you can read and understand.

## Command line

The UI is a wrapper around these commands:

```bash
scripting.run --code "cockpit.log(1+1)" --lang js          # run a snippet of JS/TS
scripting.eval --expr "cockpit.listCommands()"             # evaluate an expression
scripting.stop                                             # stop the running script
scripting.parseConfig --code "export const config = { … }" # parse the parameter schema
scripting.list                                             # list saved scripts
scripting.load --path ~/.config/LinuxCockpit/scripts/demo.ts
scripting.save --name demo --code "…" --lang ts --path /abs/demo.ts
scripting.delete --path demo.ts                            # delete (path or filename)
scripting.templates                                        # list built-in templates
```

## FAQ

**No output at all?** The script may have finished without logging anything: add
`cockpit.log('start')` to confirm it ran. If the console says "No output yet", nothing has run.

**It says "Error" but I can't see why?** The reason is printed as an `[error]` line — usually a
TypeScript problem, a wrong command name, or a command whose ability isn't loaded (check with
`cockpit.listCommands()`).

**The parameters panel is empty?** There is no `export const config = { … }` in the code, or it is
incomplete. Use **Insert Config Schema** in the empty panel to start from a working example.

**My long task stops when I switch pages?** In-page runs are foreground. Hand the work over with
`await cockpit.job('script-run', { code, language })` and it keeps running in the sidebar's
Background Tasks panel.
