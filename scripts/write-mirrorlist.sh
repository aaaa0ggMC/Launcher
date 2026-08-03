#!/usr/bin/env bash
# 原子替换 mirrorlist (由 pkexec 以 root 调用)
# 用法: write-mirrorlist.sh <temp-file>
#   备份原文件到 mirrorlist.cockpit.bak，然后原子替换 (mv)。
#   mv 是同分区原子操作：要么成功替换，要么原文件完全不受影响。
set -euo pipefail

MIRRORLIST="/etc/pacman.d/mirrorlist"
BACKUP="/etc/pacman.d/mirrorlist.cockpit.bak"
SRC="${1:-}"

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "用法: write-mirrorlist.sh <temp-file>" >&2
  exit 1
fi

# Backup original (preserve last copy).
[ -f "$MIRRORLIST" ] && cp -a "$MIRRORLIST" "$BACKUP"

# Atomic replace: mv on same filesystem is atomic.
# chmod on the source first so the dest inherits correct permissions.
chmod 644 "$SRC"
mv -f "$SRC" "$MIRRORLIST"

echo "OK"
