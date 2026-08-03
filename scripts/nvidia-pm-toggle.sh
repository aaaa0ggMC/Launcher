#!/usr/bin/env bash
# 切换 NVIDIA NVreg_PreserveVideoMemoryAllocations 0 <-> 1 (由 pkexec 以 root 调用)
set -euo pipefail

FILE="/etc/modprobe.d/nvidia-pm-override.conf"
BACKUP="/etc/modprobe.d/nvidia-pm-override.conf.cockpit.bak"

if [ ! -f "$FILE" ]; then
  echo "未找到 $FILE" >&2
  exit 1
fi

cp -a "$FILE" "$BACKUP"

if grep -q 'NVreg_PreserveVideoMemoryAllocations=1' "$FILE"; then
  sed -i 's/NVreg_PreserveVideoMemoryAllocations=1/NVreg_PreserveVideoMemoryAllocations=0/' "$FILE"
  echo "0"
else
  sed -i 's/NVreg_PreserveVideoMemoryAllocations=0/NVreg_PreserveVideoMemoryAllocations=1/' "$FILE"
  echo "1"
fi
