#!/bin/sh
# Chromium kiosk：只打开本地壳，不请求主机。
# 总观态不建 WebGL，因此不强制 GPU 后端；保留 --disable-gpu-compositing 兜底由实测决定。
set -eu

URL="http://127.0.0.1:8080/"

# 显示层不熄屏交给应用（息屏由页面 #dim + DPMS 控制）；先关掉 X 的屏保与 DPMS
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true

exec chromium \
  --kiosk \
  --app="$URL" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=Translate,MediaRouter \
  --check-for-update-interval=31536000 \
  --user-data-dir=/home/dhvw/.config/dhvw-kiosk \
  --window-position=0,0
