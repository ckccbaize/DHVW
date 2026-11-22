#!/bin/sh
# Chromium kiosk：只打开本地壳，不请求主机。
# 总观态不建 WebGL，因此不强制 GPU 后端；保留 --disable-gpu-compositing 兜底由实测决定。
set -eu

URL="http://127.0.0.1:8080/"

# 设备屏幕倒装：X 输出旋转 180°（触控坐标由 X 一并旋转）
# setup_display 会被重复调用：X 的 logind 会话若未拿到 DRM master，
# xrandr 会静默失败并停在 320x200（X 最小编译尺寸）。这里以「实际 current 是否
# 达到目标宽」为唯一判据，未达标就继续重试，而不是发一次命令就当成功。
setup_display() {
  for out in $(xrandr --query 2>/dev/null | awk '/ connected/{print $1}'); do
    xrandr --output "$out" --off 2>/dev/null || true
    sleep 1
    xrandr --output "$out" --auto 2>/dev/null || true
    xrandr --output "$out" --rotate inverted 2>/dev/null || true
  done
}

# 当前是否已经拿到目标宽度（默认 1920；面板没亮时会是 320）
display_ok() {
  cur=$(xrandr --query 2>/dev/null | sed -n 's/.*current \([0-9]\+\) x \([0-9]\+\).*/\1/p' | head -1)
  if [ -n "$cur" ] && [ "$cur" -ge 1280 ]; then
    return 0
  fi
  return 1
}

if command -v xrandr >/dev/null 2>&1; then
  # 等 connected 输出出现（kiosk 可能早于 CRTC 就绪）
  n=0
  while [ "$n" -lt 50 ]; do
    [ -n "$(xrandr --query 2>/dev/null | awk '/ connected/{print $1; exit}')" ] && break
    n=$((n + 1))
    sleep 0.2
  done
  setup_display
  # 面板/DRM 可能晚就绪，或 X 会话短暂失去 master；最多再试 12 次（约 36s）
  (
    n=0
    while [ "$n" -lt 12 ]; do
      if display_ok; then
        exit 0
      fi
      sleep 3
      setup_display
      n=$((n + 1))
    done
    echo "[kiosk] 警告: 显示未能达到目标分辨率，当前: $(xrandr --query 2>/dev/null | head -1)" >&2
  ) &
fi

# 显示层不熄屏交给应用（息屏由页面 #dim 控制）；必须在 X 就绪后关闭屏保/DPMS
xset s off 2>/dev/null || true
xset s noblank 2>/dev/null || true
xset s 0 0 2>/dev/null || true
xset dpms force on 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset dpms 0 0 0 2>/dev/null || true

# 这台 HDMI 面板需要一次输入事件才真正点亮；模拟鼠标移动，避免开机黑屏
if command -v xdotool >/dev/null 2>&1; then
  (
    sleep 10
    xdotool mousemove 1 1 2>/dev/null || true
    sleep 1
    xdotool mousemove 2 2 2>/dev/null || true
    sleep 20
    xdotool mousemove 3 3 2>/dev/null || true
  ) &
fi

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
