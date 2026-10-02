# Services

> Last updated: 2026-10-01

Services lists your user-level systemd services (`systemctl --user`), one per row: name, state and
description, with **Start / Stop / Restart** right there on the row. Handy for the programs that run
as user services — sync clients, dev servers, your own units — without opening a terminal and typing
systemctl.

> Quick start: type the service name into the search box → click the red **Stop** or green **Start**
> icon button on that row.

## What it does

- List all user services (including inactive ones; active ones are shown by default).
- Search by name / description, refresh in one click.
- **Restart**, **Start** and **Stop** directly on each row; the list refreshes after every action.
- Color-coded states: running, failed and stopped are distinguishable at a glance.

## UI at a glance

| Area         | Where                   | Description                                                                                               |
| ------------ | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Title row    | Top of the page         | "Systemd Services" heading + subtitle "User services (systemctl --user)"; **Refresh** button on the right |
| Search box   | Below the title, left   | Searches service name / description (case-insensitive; multiple keywords are AND-ed)                      |
| Show all     | Right of the search box | Checkbox "Show all (including inactive)"; by default only active services are listed                      |
| Service list | Main body               | Rows inside one card: status icon + name on the left, action buttons on the right                         |

Each row, left to right: a status icon, the **service name** (`xxx.service`) in monospace, a status
chip showing `active / sub`, and the **description** as a caption; at the far right sit the icon
buttons (hover to see their names):

- **Restart** (circular arrow): only clickable while the service is running.
- **Start** or **Stop**, whichever applies: active services show a red **Stop** (stop icon), others a
  green **Start** (play icon).

The icon buttons carry no text — hover for a tooltip with the name; the button spins while the action
runs.

## Reading the state

The chip shows two values separated by `/`: the `active` state and the `sub` state, with matching
color and icon:

| active state                    | Icon and color   | Meaning                                  |
| ------------------------------- | ---------------- | ---------------------------------------- |
| `active`                        | green play icon  | Running (usually with sub `running`)     |
| `failed`                        | red warning icon | Failed to start or errored while running |
| anything else (e.g. `inactive`) | grey stop icon   | Not running (usually `dead` / `exited`)  |

Common sub states: `running` (the process is alive), `exited` (finished cleanly — many one-shot
services rest here), `dead` (stopped), `failed`. States are shown exactly as systemctl reports them.

## Common tasks

### Start / stop / restart a service

1. Find the target row (the search box filters fastest).
2. Click the matching icon button on the right: red **Stop** while running, green **Start** while
   stopped, and **Restart** on any active service.
3. The button spins for a moment, then the list refreshes and the chip shows the new state.

If the action fails (unit missing, blocked by system policy…), the list stays as it was and the error
lands in the log — open the Logs ability and search `systemd` for the exact reason.

### Only see what's running

That's the default. To see everything (including inactive / failed), tick **Show all (including
inactive)** next to the search box; untick to go back to the compact view. Search and this checkbox
stack.

### A service is missing?

This page lists **user** services (`systemctl --user`). System services (`systemctl` without
`--user`) are not shown — unless Cockpit itself runs as root, in which case system services are
listed instead. To check which kind a unit is, compare with
`systemctl --user list-units --type=service --all` in a terminal.

## Command line

```bash
systemd.list                                        # list user systemd services
systemd.action --name myservice --action restart    # start/stop/restart (action = start | stop | restart)
```

## FAQ

**The list is empty?** No service matches the current filter: by default only active services show,
and a freshly booted machine may genuinely have none — tick **Show all (including inactive)**. The
search text also filters; clear the box and look again.

**Nothing happened after clicking?** A failed systemctl call leaves the list unchanged and logs the
error (search `systemd` in the Logs ability). User services normally need no password; if the unit
itself needs extra privileges (e.g. touching system resources), the log states why.

**Is the data live?** It's read once on entry and refreshed after each action — no polling. For the
latest state click **Refresh** in the top-right.

**What happens when I navigate away and back?** The page isn't cached; every visit re-reads the
service list.
