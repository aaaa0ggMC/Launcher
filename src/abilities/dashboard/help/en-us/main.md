# Overview

> Last updated: 2026-10-01

The Overview page gathers the key state of this machine onto one screen: host info, CPU, memory,
GPU, disk and Docker containers as seven cards. Stats refresh silently every 4 seconds, and the
card layout can be dragged freely and is remembered automatically. All data comes from local
commands (`os`, `df`, `nvidia-smi`, `docker ps`, `pacman` / `flatpak`) — nothing leaves the machine.

> Quick start: open the Overview page and it loads immediately; click **Refresh** at the top
> right for a manual update; drag a card by its title bar to move it — the new layout saves itself.

## What it does

- See everything at a glance: Host / CPU / Memory / GPU / NVIDIA Power Mgmt / Disk / Containers,
  seven cards in total.
- A silent background poll every 4 seconds; a failed poll keeps the previous snapshot.
- Drag and resize cards freely; the layout is saved automatically and survives restarts;
  one click restores the default layout.
- Watch CPU temperature and frequency, memory / swap, per-mount disk usage, GPU utilization
  and VRAM.
- Inspect Docker container states; read or toggle the NVIDIA power-management parameter
  (admin password required, takes effect after reboot).
- The app bar's "copy page as Markdown" action copies the current snapshot as text for sharing.

## UI at a glance

| Area          | Where                    | Description                                             |
| ------------- | ------------------------ | ------------------------------------------------------- |
| Page title    | Top left                 | "System Overview" + hostname · system · uptime          |
| Lock / unlock | Top right, first button  | Padlock icon button; hover shows Lock / Unlock layout   |
| Refresh       | Top right, second button | Re-collect everything now (first load shows a skeleton) |
| Card grid     | Main body                | 7 cards on a 12-column grid; drag, resize, auto-save    |

The seven cards, in default order:

| Card              | What it shows                                                                           |
| ----------------- | --------------------------------------------------------------------------------------- |
| Host              | Hostname, system, architecture, user, desktop, shell, uptime, pacman / flatpak counts   |
| CPU               | Model, usage ring, cores, frequency, temperature (color-coded), load (1/5/15m)          |
| Memory            | RAM bar with used / total; swap section ("Swap not enabled" when absent)                |
| GPU               | Per GPU: temperature, driver, VRAM, fan, power, GPU utilization, VRAM usage (see below) |
| NVIDIA Power Mgmt | Current `NVreg_PreserveVideoMemoryAllocations` value and toggle button                  |
| Disk              | Usage bar per `/dev/` mount, used / total, available space                              |
| Containers        | Docker running / stopped / total counts plus a per-container status list                |

## Common tasks

### Drag, resize and reset the layout

1. Make sure the padlock icon at the top right is **unlocked** (hover: "Unlock layout (drag to
   rearrange)").
2. Drag a card by its title bar to the target slot — the grid is 12 columns with 48px rows, so
   it lands on the nearest grid point when you release.
3. Drag a card's edge or corner handle to resize it.
4. Every move or resize saves itself to `~/.config/LinuxCockpit/ui-state.json`; there is no
   Save button.

> The grid floats: a card stays exactly where you drop it and is not pushed back up into gaps.
> Adding or removing cards is not supported — the set of 7 cards is fixed.

### Lock / unlock the layout

The padlock icon at the top right toggles between two states:

- **Unlock layout**: cards can be dragged and resized (default).
- **Lock layout (enable text selection)**: dragging and resizing are disabled so you can
  select and copy text inside the cards.

The state is written to `dashboard.locked` in the global `config.json`, so the page reopens locked.

### Reset the layout

To restore the default arrangement after dragging cards around:

1. Open the **Settings** page from the sidebar (or the gear icon at the top right of the app bar).
2. Find "Overview → Dashboard Layout" in the category list or the search box.
3. Click the red **Reset Layout** button.

The page snaps back to the default layout and re-saves it. This is equivalent to the
`dashboard.reset-layout` command.

### Manual refresh and auto refresh

- **Refresh** re-collects everything immediately (CPU usage needs ~0.4s of sampling, so the
  button shows a loading state).
- Auto poll: while the page is open it refreshes silently every 4 seconds without a loading
  bar; on failure the previous data stays.
- Package counts (pacman / flatpak) are cached for 60 seconds and not recounted every poll.

### Read the GPU card

The GPU card depends on `nvidia-smi`. For each GPU it shows the model, a temperature chip
(red above 80 °C), driver version, VRAM used / total (MB), fan speed and power draw (fields a
card doesn't expose are omitted), a GPU utilization bar and a VRAM usage percentage bar.

- With no NVIDIA GPU or no working `nvidia-smi`, the card shows "No GPU detected
  (nvidia-smi not available)".
- Hybrid graphics machines also follow `nvidia-smi` output.

### Read the containers card

Three chips at the top of the card show **Running N**, **Stopped N** and **Total N**; below, one
row per container with its name and state (green play icon = running, grey stop icon = not
running).

- This card is **read-only** — it has no start / stop buttons.
- To start / stop / restart a container, use the `docker.action` command from the CLI (see
  "Command line"). It changes system state, so only AI / remote-origin callers need a separate
  permission; local use is unaffected.
- If Docker isn't installed or isn't running, the card shows "Docker is not running or no
  containers".

### Toggle NVIDIA power management

The card shows the current value of `NVreg_PreserveVideoMemoryAllocations` (0 / 1 / `—`) and an
**Enabled** / **Disabled** button. Clicking it opens a confirmation dialog explaining that
`/etc/modprobe.d/nvidia-pm-override.conf` will be modified (backed up automatically), that an
admin password is required and that a reboot is needed. After **Confirm**, the polkit password
prompt appears. On failure the page shows "Failed to toggle power management".

## Read more

This ability is a single-page document — the UI is the whole story. Two things worth knowing:

- Where collection failures go: every failed collection (`nvidia-smi`, `docker`, `pacman` failing
  to run) is logged — open the Logs ability and filter WARN / ERROR to trace it.
- Graceful degradation: with `nvidia-smi`, `docker`, `pacman` or `flatpak` missing, the matching
  card shows a placeholder instead of failing the page.

## Command line

Every part of the Overview is a registered command; the UI is just a wrapper:

```bash
system.stats                                # collect one full system snapshot (= Refresh)
hardware.gpu                                # GPU info only (nvidia-smi)
hardware.pm                                 # read NVreg_PreserveVideoMemoryAllocations
hardware.pm-toggle                          # toggle 0↔1 (pkexec, reboot required)
docker.list                                 # list all Docker containers
docker.action --name <name> --action start  # start a container; action can be stop / restart
dashboard.get-layout                        # read the saved layout
dashboard.set-layout --layout '[...]'       # save the layout (JSON array)
dashboard.reset-layout                      # reset to the default layout (all windows, live)
```

## FAQ

**Dragging does nothing?** Check the padlock icon at the top right — if it is orange the layout
is locked; click it to unlock first.

**Reset Layout seems to do nothing?** It restores the defaults and re-saves them immediately in
every open Overview window (they share one layout file); if the page wasn't open, the next visit
shows the defaults.

**The GPU card only says "No GPU detected"?** `nvidia-smi` is missing from PATH or failed:
run `nvidia-smi` in a terminal, then click **Refresh** on the page.

**Containers look incomplete or stale?** The list comes from `docker ps -a`; when the current
user lacks permission (not in the docker group) the command fails and the card shows
"Docker is not running or no containers".

**Temperature / VRAM / fan fields are missing?** They depend on system sensors and GPU support;
when a value can't be read the field is simply omitted and the rest still updates.
