# Autostart

> Last updated: 2026-10-01

Autostart manages the entries in `~/.config/autostart` — the KDE / XDG standard directory where
programs drop their `.desktop` files to run at login. The page lists them all and gives each one a
single switch: disabling does not delete anything, it just writes `Hidden=true` into the file, so you
can turn the entry back on at any time.

> Quick start: find the card, flip the switch on its right to **Disabled** / **Enabled**.

## What it does

- List every `.desktop` entry under `~/.config/autostart` (name, exec command, file name).
- One switch per card; every flip is written to disk immediately.
- Disabled entries are dimmed with a grey chip, so you can tell at a glance what's off.
- Entries are sorted by name and exportable as Markdown (sidebar bottom → "Copy current view as
  Markdown").

## UI at a glance

| Area        | Where           | Description                                                              |
| ----------- | --------------- | ------------------------------------------------------------------------ |
| Title row   | Top of the page | "Autostart" heading + subtitle "Manage ~/.config/autostart entries"      |
| Loading bar | Below the title | Progress while reading; shows errors                                     |
| Entry cards | Main body       | Grid of cards: icon, name + status chip, exec command, file name, switch |

Each card, left to right: a status icon (green rocket when enabled, grey moon when disabled), the
**name** in bold with a status chip (green **Enabled** / grey **Disabled**), two caption lines with
the **Exec** command and the **.desktop** file name, and the switch at the far right. The switch spins
while the write is in flight.

## Common tasks

### Enable / disable an entry

Just click the switch on the card:

- Flip to "Enabled": the entry runs again at next login.
- Flip to "Disabled": writes `Hidden=true`, so your desktop skips it at login; the file stays put and
  can be re-enabled at any time.

Changes are written back to the `.desktop` file immediately — there is no save button.

### Add a new entry

The page only toggles; it cannot create entries. To add one, drop a `.desktop` file into
`~/.config/autostart/`:

- Many apps ship a "start at login" option that places the file there for you.
- Or copy the matching `.desktop` from `/usr/share/applications/`.

A minimal autostart entry looks like this:

```ini
[Desktop Entry]
Name=My script
Exec=/home/you/scripts/hello.sh
Type=Application
```

Once the file is there, refresh the page (switch to another ability and back) and the new entry shows
up.

### Delete or modify an entry

Both are file operations:

- **Delete**: move or remove the corresponding `.desktop` in `~/.config/autostart/`.
- **Change the command**: edit its `Exec=` line; edit `Name=` to rename it.
- If you'd rather not touch files, just disable the entry with the switch — same effect, and you keep
  the option to restore it.

## Command line

```bash
autostart.list                                        # list autostart entries
autostart.toggle --file "Clash Verge.desktop" --hidden true   # disable an entry
autostart.toggle --file "Clash Verge.desktop" --hidden false  # re-enable it
```

`--file` takes the file name shown on the card (ending in `.desktop`).

## FAQ

**The page is empty.** `~/.config/autostart` contains no `.desktop` files, so you see "No autostart
entries" (with the note that none were found). Install an app with a start-at-login option, or add a
file yourself.

**Why fewer entries than software installed?** Only the **user-level** directory
`~/.config/autostart` is listed; the system-wide `/etc/xdg/autostart` is out of scope.

**Disabled vs deleted?** Disabling writes `Hidden=true` into the file — the file and the switch stay,
and one click restores it. Deleting removes the file, and restoring it means putting it back.

**The switch didn't stick.** A failed write leaves the list unchanged and logs the error. Usual causes
are the file being locked or a permissions problem — you can also edit the `Hidden=` line by hand and
refresh the page.

**What happens when I navigate away and back?** The page isn't cached; every visit re-reads the
directory, which is handy for picking up files you just added elsewhere.
