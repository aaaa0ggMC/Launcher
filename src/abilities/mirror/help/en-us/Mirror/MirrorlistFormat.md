# Mirrorlist format

> Last updated: 2026-10-01

Everything on the Mirrors page revolves around one file: `/etc/pacman.d/mirrorlist`. To pacman it is
an ordinary mirrorlist; to Cockpit it is understood through a `[MIRROR]` comment format that records
what each source is called and whether it's on.

## The [MIRROR] format

Each source is two lines: a `# [MIRROR] <name>` comment header followed by a `Server = ...` line.
**Disabling just comments out** the `Server` line (`# Server = ...`); enabling removes the comment:

```
# [MIRROR] USTC
Server = https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch

# [MIRROR] TUNA
# Server = https://mirrors.tuna.tsinghua.edu.cn/archlinux/$repo/os/$arch
```

In the example above USTC is enabled and TUNA disabled. The rules:

- `Server = ` at line start = **enabled**; `# Server = ` at line start = **disabled**.
- The name lives only in the comment header — pick anything; the page displays and toggles by name.
- `$repo` / `$arch` are pacman placeholders: keep them verbatim, don't expand them.
- A blank line may separate the header and the `Server` line; every other comment, blank line and note
  in the file is preserved as-is.

## Legacy format and migration

The traditional mirrorlist is bare `Server = ...` / `# Server = ...` lines with no names. Those files
are read directly: names are guessed from the URL (e.g. `mirrors.ustc.edu.cn` → `USTC`) and the
entries are listed and toggle-able right away.

From the first toggle onward, however, Cockpit always writes in the `[MIRROR]` format — concretely, it
**appends** a `# [MIRROR] <name>` + `Server = <url>` block at the end of the file and leaves every
other line untouched. So after the first operation on a legacy file you can end up with both the old
bare line and the new block (the same URL twice, so pacman hits it twice). It's worth deleting the old
bare line after the first toggle and keeping only `[MIRROR]` blocks.

## Write safety guarantees

Every toggle is a full read → modify → atomic-replace cycle:

1. **Read**: the file is re-read right before the operation (disk is the source of truth), and all
   operations are serialized so rapid clicks can't overwrite each other.
2. **One line changed**: apart from adding / removing the `# ` prefix on the target `Server` line,
   every other line is preserved.
3. **Temp file + mv**: the new content goes to a temp file under `/tmp`, then a helper script
   (`scripts/write-mirrorlist.sh`), called through pkexec, first backs the original up to
   `/etc/pacman.d/mirrorlist.cockpit.bak` and then `mv -f`s the temp file into place. On the same
   filesystem `mv` is atomic: it either succeeds or the original file is completely unaffected.
4. **Failure aborts early**: a cancelled / wrong password or a failing script returns an error before
   any replacement; the file is untouched and the page shows `pkexec failed: ...`.
5. **Missing targets are not written**: if the source exists neither in the file nor in the preset
   config, you get `mirror not found: <name>` and no write happens.

## Presetting a batch of sources (optional)

`~/.config/LinuxCockpit/mirror/config.json` can pre-list sources:

```jsonc
{
  "mirrors": [
    { "name": "USTC", "url": "https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch" },
    { "name": "TUNA", "url": "https://mirrors.tuna.tsinghua.edu.cn/archlinux/$repo/os/$arch" }
  ]
}
```

They are merged with the mirrorlist contents for display: URLs already present aren't duplicated,
new ones are appended as **Disabled**, and flipping their switch writes them into mirrorlist via the
flow above (a `[MIRROR]` block is created automatically when the file has none for them).

## Next steps

- Back to [Mirrors](../main.md).
