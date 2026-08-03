#!/usr/bin/env bash
# 切换 Arch Linux 软件源 (由 pkexec 以 root 调用)
# 用法: switch-mirror.sh '<server-line>'
#   例: switch-mirror.sh 'Server = https://mirrors.ustc.edu.cn/archlinux/$repo/os/$arch'
set -euo pipefail

MIRRORLIST="/etc/pacman.d/mirrorlist"
BACKUP="/etc/pacman.d/mirrorlist.cockpit.bak"
NEW_SERVER="${1:-}"

if [ -z "$NEW_SERVER" ]; then
  echo "用法: switch-mirror.sh '<server-line>'" >&2
  exit 1
fi

# 先备份 (保留上次备份)
cp -a "$MIRRORLIST" "$BACKUP"
printf '# LinuxCockpit 生成的镜像源配置\nServer = %s\n' "$NEW_SERVER" > "$MIRRORLIST"

echo "OK 已切换到: $NEW_SERVER"
