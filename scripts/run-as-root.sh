#!/usr/bin/env bash
# 以 root 在指定目录运行命令 (由 pkexec 调用)
# 用法: run-as-root.sh <cwd> <argv...>
set -euo pipefail

CWD="${1:-}"
shift

if [ -z "$CWD" ]; then
  echo "用法: run-as-root.sh <cwd> <argv...>" >&2
  exit 1
fi

cd "$CWD" || exit 1
exec "$@"
