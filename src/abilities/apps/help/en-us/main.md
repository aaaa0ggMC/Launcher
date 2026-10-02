# Apps

> Last updated: 2026-10-01

Apps gathers the projects, scripts and little tools scattered across your directories into a single
**app registry**: scan one folder into a deck of cards, launch with one click, and attach extra
buttons such as stop / restart / rebuild to each app. The registry is simply the `apps.json` file in
each search root — **hand-editing is welcome**, since the scanner only fills gaps and never
overwrites what you wrote.

> Quick start: click **Add Directory** in the top-right → pick a folder that holds your projects →
> **Add App** with a name and command → click **Launch** on the card.

## What it does

- Turn every registered app under a search root into a card: search, filter by tag, launch in one
  click.
- Each app can carry several **additional actions** (start / stop / rebuild …) besides **Launch**;
  the darker the button, the more dangerous the action.
- Three ways to run: plain foreground, **Run in terminal**, or **Background task** (output lands in
  the global Background Tasks panel).
- Medium / high-risk apps ask for confirmation before launching; tick "Got it — don't ask again"
  to skip it forever.
- Launch apps straight from the sidebar search box; right-click for the action menu.
- Export the registry as Markdown any time (sidebar bottom → "Copy current view as Markdown").

## UI at a glance

| Area                 | Where                   | Description                                                                               |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| Title row            | Top of the page         | "App Registry" heading + subtitle; **Add Directory** and **Add App** buttons on the right |
| Search box           | Below the title, left   | Searches name / alias / description / ID (case-insensitive)                               |
| Tag chips            | Right of the search box | **All** plus one chip per tag; click to filter, click again to clear                      |
| Show missing entries | Below the tag chips     | Checkbox; also shows entries whose source file is gone                                    |
| Search-root chips    | Below the tag row       | The configured roots; click × to remove. If none, a hint chip is shown                    |
| App cards            | Main body               | One card per app in a grid; action buttons at the bottom                                  |

Each card top-to-bottom: the **icon** (40px rounded avatar), the **name** (a shield icon appears
next to high-risk entries — hover shows "High risk — requires confirmation before launch"), a
**Missing** chip when the source file is gone, the **description** (falls back to the path), and the
**tag** chips (manual and auto tags merged and deduplicated).

The button row at the bottom of each card: **Edit** (pencil icon, text button) on the left;
**Launch** (play icon) and the app's **additional action** buttons on the right, each with its own
icon and label. Button color encodes risk: green = low, orange = medium, solid red = high. While the
source file is missing the whole card is dimmed and all launch buttons are disabled.

## Common tasks

### Add a search root

1. Click **Add Directory** in the top-right of the page.
2. In the dialog type an **absolute path** (the placeholder shows `/home/you/Apps`), or click the
   folder icon inside the field to pick it with the system dialog.
3. Click **Add**.

The `apps.json` inside that directory is its registry. You can also manage roots centrally in
**Settings → Apps → Search Directories**: move up / down to change search order (order affects
search-result ranking), remove, and add more. Configured roots also appear as chips under the search
box; click × to drop one instantly.

### Add or edit an app

- **Add App**: fill in **Name**, **ID** (leave empty to derive it from the path / name),
  **Path** (relative to the store directory or absolute — the folder icon picks it), **Description**,
  **Icon**, **Exec type**, **Risk level**, **Command**, plus the **Run in terminal / Background task
  / Create directory** switches. Expand "Multi-language" to give each UI language its own name and
  description.
- **Edit**: click **Edit** at the bottom-left of a card. Besides the fields above you can change the
  **Alias** (CLI shortcut), **Tags**, working directory, **Risk note**, **Run as root (pkexec)**,
  add or remove **additional action** rows, and configure the **live output transformer**.
- The red **Delete** at the bottom-left of the edit dialog removes the entry from `apps.json`
  immediately — there is no recycle bin.

### Launch an app

Click **Launch** on a card, or any of its action buttons. The flow is always the same:

1. Medium / high risk pops the confirmation dialog first (see below).
2. On success the app starts and the card returns immediately — it never waits for exit.
3. Apps with a live-output transformer open the output window; background tasks open the global
   Background Tasks panel for you.

What happens after the click depends on the entry's switches: **Run in terminal** opens a system
terminal window; **Background task** keeps the process under the framework (see
[Advanced → Background tasks & live output](Advanced/BackgroundTasksAndLiveOutput.md));
**Run as root (pkexec)** asks for authorization first.

### Confirm before launch

Entries (or actions) with **medium / high** risk pop a confirmation dialog before launching:

- The title reads `Launch "‹name›"?`; the alert shows what the scanner **detected** plus any
  **note** you wrote in the editor.
- Below it, "About to launch ‹name›" with a risk chip.
- Tick **Got it — don't ask again** and click **Launch** to mark the entry acknowledged — later
  launches skip the dialog. Click **Cancel** to abort.

To get the confirmation back for one entry, set its `security.acknowledged` back to `false` in
`apps.json` (the edit dialog no longer shows that checkbox). There is also a global launch-confirmation
switch: **Settings → Appearance → Launch** ("Require confirmation before every launch").

### Quick launch from the sidebar

Type an app name / alias / tag into the search box at the top of the sidebar (placeholder: "Search
abilities / apps / tools"). Matching entries appear under the **Quick launch** group:

- **Left-click** a result: launch that app (same flow as the card's **Launch** button).
- **Right-click** a result: a context menu with the app's main launch first, then each of its
  additional actions (labelled exactly like the card buttons). Pick one to run it.

### What "background" means

With the **Background task** switch on, launching no longer opens a terminal — the process is handed
to the framework's background-task service: its stdio is piped into a ring buffer and it shows up in
the **Background Tasks** panel (tray icon at the bottom of the sidebar, with a badge while tasks run)
— live console, CPU / memory / VRAM usage, stdin input, Ctrl+C, terminate and force-kill. Tasks are
**attached to this app**: they are cleaned up on exit. Clicking such a button opens the panel for you.
See [Advanced → Background tasks & live output](Advanced/BackgroundTasksAndLiveOutput.md).

### Usage statistics

- Every **launch of an app** (card buttons, quick launch, CLI — all of them) adds a row
  `app:<root>:<path>` to `~/.config/LinuxCockpit/apps.csv`; every **sidebar entry click** adds a row
  keyed by the ability id.
- Sidebar sort rules live in **Settings → Appearance → Sidebar**: **Alphabetical / Usage frequency /
  Recently used / Custom** — frequency and recent read from that same file.
- **Clear usage records** in the same settings card zeroes every counter immediately.

## Read more

- [Apps/apps.json format](Apps/AppsJsonFormat.md): every registry field, the multi-language object
  form, and the rules for hand maintenance.
- [Advanced/Background tasks & live output](Advanced/BackgroundTasksAndLiveOutput.md): background
  tasks, terminal, root escalation, the live output window and multi-step actions.

## Privacy and security

- Launching apps and creating / editing / deleting registry entries from an AI or remote session
  requires the corresponding execute / control permission — you approve it yourself in the consent
  window.
- The risk-confirmation dialog can only be confirmed by you; the agent cannot click "Launch" for you.

## Command line

Every step of the Apps page is a registered command, usable from the built-in CLI REPL
(`--flag value` arguments):

```bash
apps.list                                              # list all apps across search directories
apps.get --root ~/Apps --id bili-viewer                # read a single entry
apps.config                                            # read the Apps ability config (roots etc.)
apps.update --root ~/Apps --id bili-viewer --patch '{"name":"x"}'   # update/create an entry
apps.delete --root ~/Apps --id start-rdp               # delete an entry
apps.add-root --path /home/you/Apps                    # add a search directory
apps.remove-root --path /home/you/Apps                 # remove a search directory
apps.move-root --path /home/you/Apps --dir 1           # reorder roots (-1 up / 1 down)
apps.create --root ~/Apps --id myapp --patch '{"name":"My App","exec":{"type":"custom","command":["run.sh"]}}' --mkdir true
apps.rescan --root /home/you/Apps                      # rescan a directory for drafts
launch.run --root ~/Apps --id bili-viewer              # launch an app
launch.action --root ~/Apps --id new-api --action stop # run an app action
```

The REPL also understands alias / tag shortcuts:

```bash
list / ls                  # list all apps (alias or ID + name)
info <alias>               # show details (name/alias/path/type/risk/tags/actions)
launch <alias> [action]    # launch an app or one of its actions
<alias>                    # bare alias launch (matches alias/ID/tag, case-insensitive)
<alias> <action>           # run an action directly, e.g. new-api stop
```

## FAQ

**I added a project folder but nothing shows up.** The directory watcher only refreshes the page when
files change — it never creates entries for new projects. Click **Add App**, or run
`apps.rescan --root <dir>` to draft them.

**Launch failed with "working directory does not exist"?** The entry's path points at a directory that
was moved or deleted. Tick **Show missing entries** to find the dimmed card, fix the path with
**Edit**, or delete it.

**Why doesn't the search box find tags?** It matches name / alias / description / ID only; use the
tag chips beside it for tags. Multiple keywords are space-separated and AND-ed.

**Why are the buttons greyed out?** While the source file is missing, all launch buttons are disabled
(the card is dimmed and carries a **Missing** chip). Restore the file or fix the path to re-enable them.

**My search text disappeared after switching pages.** This page isn't cached (keepAlive: false); it
always starts fresh.
