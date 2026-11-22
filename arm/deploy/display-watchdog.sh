#!/bin/sh
# 设备常亮 + 分辨率看门狗。由 dhvw-display.service 以 root 运行（需要写
# /sys/class/graphics/fb0/blank 与 systemctl restart dhvw-x）。
set -u

TARGET_MIN=1280   # 低于此宽度视为未拿到目标模式（X 回落到 320x200）
CHECK_EVERY=10    # 秒
BAD_LIMIT=3       # 连续多少次异常后重启 X（约 30s）

export DISPLAY="${DISPLAY:-:0}"

current_width() {
  xrandr --query 2>/dev/null | awk '
    /current/ { for (i = 1; i <= NF; i++) if ($i == "current") { print $(i + 1); exit } }
  '
}

bad=0
while :; do
  xset s off 2>/dev/null || true
  xset s noblank 2>/dev/null || true
  xset s 0 0 2>/dev/null || true
  xset -dpms 2>/dev/null || true
  xset dpms 0 0 0 2>/dev/null || true
  echo 0 > /sys/class/graphics/fb0/blank 2>/dev/null || true

  cur=$(current_width)
  if [ -z "$cur" ] || [ "$cur" -lt "$TARGET_MIN" ]; then
    bad=$((bad + 1))
    if [ "$bad" -ge "$BAD_LIMIT" ]; then
      logger -t dhvw-display "display stuck at ${cur:-unknown}px, restarting dhvw-x"
      bad=0
      systemctl restart dhvw-x 2>/dev/null || true
      sleep 20
    fi
  else
    bad=0
  fi
  sleep "$CHECK_EVERY"
done
