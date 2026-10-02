# Background tasks & live output

> Last updated: 2026-10-01

This page is about "what happens after you click": plain launch, terminal launch, background tasks,
root escalation, the live output window, and multi-step actions. All of these switches live in the
**Add app / Edit** dialog.

## Four ways to run

| Switch (edit dialog)     | Behaviour                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| none (default)           | Foreground detached launch; the card returns immediately                                                                          |
| **Run in terminal**      | Opens a system terminal (default `konsole --hold -e`, configurable globally)                                                      |
| **Background task**      | No window; the framework hosts the process and lists it in the Background Tasks panel (takes precedence over the terminal switch) |
| **Run as root (pkexec)** | Asks for authorization via polkit, then runs as root (escalation only ever goes through pkexec + a helper script)                 |

Switches can combine — e.g. terminal + root. But a **background task takes over the output pipe**,
in which case the terminal switch is ignored.

## Background tasks

For entries (or actions) with **Background task** checked:

- The process runs with piped stdio and **outlives the page**.
- Open the **Background Tasks** panel (tray icon at the bottom of the sidebar, badge while tasks run)
  to see it: a live scrolling console, CPU / memory / VRAM usage, an **stdin input box**, Ctrl+C,
  **Terminate** and **Force kill**.
- After you click such a button, the app page **opens the panel for you**.
- Tasks are attached to this program: they are cleaned up on exit and never orphaned; quitting while
  tasks run asks for confirmation first.

A good fit for servers, daemons and anything whose log you want to keep watching.

## Root escalation

With **Run as root (pkexec)** checked, launching pops the system authorization prompt:

- After one approval, further privileged launches skip the password for about five minutes
  (provided the project's polkit rule is installed).
- Cancelling (or failing) the authorization aborts that launch; nothing else is affected.
- Escalation always goes through pkexec invoking a fixed helper script — never an interactive root
  shell.

Don't check this for ordinary apps — only entries that genuinely need system-level resources.

## Live output window

The "Live Output Transformer" section of the edit dialog takes a JS constructor plus the
**Enable live popup** switch:

- Every successful, monitorable launch then opens a live output window (a modal ~80% wide).
- The title shows the app name, with a `pid` chip and a status chip (**Running** / **Exited (code)**,
  turning red on a non-zero exit code).
- The icon row top-right (hover for names): **Component view** / **Raw output**, **Auto-scroll**,
  **Clear**, **Close**.
- Without a transformer the window shows plain text lines; **Raw output** keeps ANSI colors and
  highlights stderr.
- Output produced between launch and the window opening is buffered — nothing is lost.

The advanced API (`onNewLine(e, ui)` and the component factories `NewText` / `NewTitle` / `NewAlign`
/ `NewBar` / `NewStatus` / `NewTable`) is described by the hint under that textarea.

## Multi-step actions

Each **additional action** row in the edit dialog ends with a **multi-step commands** textarea —
one command per line, executed in order:

- Intermediate steps run **headless and are awaited**; the first failure aborts the run with
  "step N failed".
- Only the **last step** is a launch: it honors its own terminal / background / root switches.
- Ideal for "pull → build → start the service" flows in one click.

## Next steps

- Back to [Apps](../main.md).
- Fields and hand maintenance of `apps.json`: [apps.json format](../Apps/AppsJsonFormat.md).
