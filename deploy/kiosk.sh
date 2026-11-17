#!/bin/sh
# Chromium kiosk：只打开本地壳，不请求主机。
# 总观态不建 WebGL，因此不强制 GPU 后端；保留 --disable-gpu-compositing 兜底由实测决定。
set -eu

URL="http://127.0.0.1:8080/"

# 设备屏幕倒装：X 输出旋转 180°（触控坐标由 X 一并旋转）
# 开机时 kiosk 可能早于 CRTC 就绪，等 connected 输出出现后再转
if command -v xrandr >/dev/null 2>&1; then
  n=0
  outs=""
  while [ "$n" -lt 50 ]; do
    outs=$(xrandr --query 2>/dev/null | awk '/ connected/{print $1}')
    [ -n "$outs" ] && break
    n=$((n + 1))
    sleep 0.2
  done
  for out in $outs; do
    xrandr --output "$out" --rotate inverted 2>/dev/null || true
  done
fi

# 显示层不熄屏交给应用（息屏由页面 #dim 控制）；必须在 X 就绪后关闭屏保/DPMS
xset s off 2>/dev/null || true
xset s noblank 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset dpms 0 0 0 2>/dev/null || true

# 兜底：Chromium/X 组合可能在启动后重新打开 DPMS；低频 watchdog 保持关闭
( while :; do xset -dpms 2>/dev/null || true; xset dpms 0 0 0 2>/dev/null || true; sleep 5; done ) &

exec chromium \
  --kiosk \
  --start-fullscreen \
  --window-size=1920,1080 \
  --app="$URL" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --lang=zh-CN \
  --accept-lang=zh-CN \
  --no-first-run \
  --disable-translate \
  --disable-features=Translate,TranslateUI,MediaRouter \
  --check-for-update-interval=31536000 \
  --user-data-dir=/home/dhvw/.config/dhvw-kiosk \
  --window-position=0,0
