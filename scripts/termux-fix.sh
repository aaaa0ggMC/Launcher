#!/data/data/com.termux/files/usr/bin/bash
# Termux 保活一键修复：厂商 ROM 会冻结后台的 Termux（宿主停住，App 连不上，直到切回 Termux）。
#
#   bash scripts/termux-fix.sh
#
# 做的事：
#   1. 安装 play-audio —— 宿主启动时用它循环播放静音（正在出声的进程不会被冻结；
#      不抢音频焦点，不影响其他 App 放歌）。宿主加 --no-keep-audio 可关闭
#   2. 申请 termux-wake-lock（防 CPU 深度休眠；宿主启动时也会自动申请）
#   3. 列出还需要在系统设置里手动确认的项
set -e

if [ -z "$TERMUX_VERSION" ] && [[ "$PREFIX" != *com.termux* ]]; then
  echo "这个脚本只在 Termux 里运行。" >&2
  exit 1
fi

echo "==> 安装 play-audio"
if command -v play-audio >/dev/null 2>&1; then
  echo "    已安装"
else
  pkg install -y play-audio
fi

echo "==> 申请 wake lock"
termux-wake-lock || echo "    termux-wake-lock 失败（不影响静音保活）"

echo "==> 试播 1 秒静音（检查音频输出可用）"
tmp="$(mktemp --suffix=.wav)"
node -e "const n=8000,b=Buffer.alloc(44+n*2);b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);require('fs').writeFileSync(process.argv[1],b)" "$tmp"
if play-audio "$tmp"; then echo "    正常"; else echo "    play-audio 播放失败：静音保活不可用" >&2; fi
rm -f "$tmp"

cat <<'TIP'

完成。重启宿主后日志里应出现：
  [termux] keep-alive silent audio started

如果之前手动开过 `while true; do play-audio ~/silence.wav; done`，现在可以关掉了（宿主自己会放）。

还建议在系统设置里确认：
  - Termux 的电池策略设为「无限制」，并在最近任务里锁定 Termux
  - Termux 的常驻通知里显示 wake lock held
之后若日志仍出现 "host process was paused by the system"，把那段日志发回来。
TIP
