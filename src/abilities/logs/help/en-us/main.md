# Logs

> Last updated: 2026-10-01

The Logs page is the app's black box: warnings and errors from every main-process module, plus
forwarded renderer messages, flow into one pipeline — color-coded by level, live-tailing, and
pageable within the current session, with one-click export. Logs also land on disk at
`~/.config/LinuxCockpit/logs/cockpit-YYYY-MM-DD.log`; this page shows the **current run
(current session)** by default.

> Quick start: open the Logs page and it lands on the newest entry and starts tailing live;
> pick **ERROR** in the **Level** dropdown to see errors only, click **Export** to save the
> session.

## What it does

- Live view of main-process and renderer logs: time, level, source (scope), message.
- Filter by level: All / DEBUG / INFO / WARN / ERROR; the list reloads from the newest page.
- Page back through history: virtual scrolling, 300 entries per page, auto-loads earlier pages
  as you scroll up.
- Live tail: new entries auto-follow while you're at the bottom and stop moving the view once
  you scroll up.
- Repeated same-kind entries within 5 seconds merge into one line with a `*N` count (poll
  noise); the on-disk file keeps every raw line.
- Export the current session to a `.log` file for issues or archiving.
- The app bar's "copy page as Markdown" action copies the visible entries as text.

## Where the logs come from

- **Main process**: modules write through the framework logger (scopes like `mirror`,
  `dashboard`, `apps-cli`); each entry goes to three places — the console, the daily-rotating
  file, and an in-memory ring buffer (20000 entries).
- **Renderer**: the UI's `console.warn` / `console.error` and uncaught exceptions are forwarded
  as logs with scope `renderer` (`logs.post`).
- **Live push**: new entries are broadcast to every window; the Logs page appends them after
  its level filter.

## UI at a glance

| Area                  | Where                        | Description                                                                    |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Page title            | Top left                     | "Logs" + subtitle "Current session logs · filter by level · live tail"         |
| Line count            | Right of the title           | "{n} lines" = total matching entries in this session under the current filter  |
| Hide logs-self switch | Right of the count           | Hides the Logs ability's own entries (on by default; the choice is remembered) |
| Level                 | Dropdown right of the switch | All / DEBUG / INFO / WARN / ERROR                                              |
| Export                | Far right button             | Export the current session to a file                                           |
| Load older            | Centered above the list      | Appears only when earlier entries exist; loads another page on click           |
| Log list              | Main body                    | Virtual scroll, fixed 28px row height                                          |

Each row has four columns: **time** (h:m:s.ms), **level**, **scope** (module), **message**;
hover a row to see the full message (long text is ellipsized in the row). WARN rows have a
light orange background and ERROR rows a light red one; level text is colored by level;
merged rows show a `*N` count at the end.

## Common tasks

### See errors only

Open the **Level** dropdown at the top and pick **ERROR**; the list reloads immediately under
that level (still from the newest page). Pick **All** to restore. Switching level keeps the
"Hide logs-self" switch as-is.

### Load earlier entries

- The **Load older** button appears above the list while earlier entries remain; the bottom of
  the list always shows the newest page.
- Two ways to page back: click **Load older**, or scroll the list all the way to the top
  (auto-triggers the previous page).
- 300 entries per page; once you reach the end the button disappears and the line count is the
  session total.

### How live tail behaves

- On open the view sits at the bottom and follows new entries automatically.
- Scroll up (more than ~24px from the bottom) and auto-follow pauses; new entries still append
  but don't yank the view.
- Scroll back to the bottom to resume following.

### Hide the Logs ability's own noise

The "Hide logs-self" switch is on by default: it hides scope `logs` entries and ipc lines
starting with `logs.` — i.e. the act of querying logs logging itself. The file on disk always
keeps them. The switch state is stored in localStorage (key `cockpit-logs-ignore-self`), so
you can turn it off when debugging the Logs page itself.

### Export the current session

1. Click **Export** at the top.
2. Choose a location in the save dialog (default name like
   `cockpit-session-2026-10-01-12-30-00.log`).
3. A green snackbar confirms "Exported {n} log lines".

The export covers the **session's in-memory buffer** (all levels by default, up to 20000
entries) regardless of the on-screen filter — the command form can restrict it with `--level`.
For monthly or cross-session history, copy the files from
`~/.config/LinuxCockpit/logs/` directly.

## Read more

- File rotation: `cockpit-YYYY-MM-DD.log` per day, 10MB per file, 14 days retained, older
  files archived as `.gz`. Files in that folder open in any text editor.
- Relation to background tasks: task output shows in the Background Tasks panel and doesn't
  necessarily land here; this page is about framework-level logs.

## Command line

Querying and exporting logs are commands too:

```bash
logs.query --level warn --limit 200 --exclude-self   # query session logs (plus --scope / --exclude-scopes / --before)
logs.export --path /abs/session.log --level info     # export the current session, optionally by level
logs.post --level error --scope renderer --message "boom"   # submit one log line manually
```

## FAQ

**Entries are gone after switching abilities and back?** The Logs page doesn't cache its state
(keepAlive off), so each visit reloads from the newest page; earlier entries are still there —
scroll up.

**There's no search box — how do I find a keyword?** The UI only filters by level and pages;
there is no keyword search. Use `logs.query --scope <module>` on the command line, or export
and search the file in an editor.

**The line count doesn't match what I see?** The count is the session total under the current
level / hide-self filter; the page loads only the newest 300 entries up front, and earlier ones
arrive page by page as you scroll up.

**Everything is empty after a restart?** The page shows this run's in-memory buffer, which
starts empty on each launch; for history check `~/.config/LinuxCockpit/logs/` by date.

**The same message keeps repeating?** Repeats within 5 seconds merge into one line with a
`*N` count — noise reduction by design; the on-disk file keeps every line separately.
