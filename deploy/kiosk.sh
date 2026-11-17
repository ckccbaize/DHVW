#!/bin/sh
# Chromium kiosk：只打开本地壳，不请求主机。
# 总观态不建 WebGL；显现页的 Live2D 在 RK3566/panfrost 上会 GL_OUT_OF_MEMORY，
# 因此 ARM 统一走 SwiftShader 软件 WebGL，并用 --disable-gpu-compositing 降低共享内存。
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
    # 开机后 HDMI 已 active 但面板可能仍黑；一次 off/auto 强制 mode set 唤醒
    xrandr --output "$out" --off 2>/dev/null || true
    sleep 1
    xrandr --output "$out" --auto 2>/dev/null || true
    xrandr --output "$out" --rotate inverted 2>/dev/null || true
  done
  # 面板/显示器可能比 X 晚就绪；延迟再强制一次 mode set
  (
    sleep 15
    for out in $outs; do
      xrandr --output "$out" --off 2>/dev/null || true
      sleep 1
      xrandr --output "$out" --auto 2>/dev/null || true
      xrandr --output "$out" --rotate inverted 2>/dev/null || true
    done
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

# Debian 的 chromium 包装脚本在 /dev/shm 小于 3.8G 时强制 --disable-dev-shm-usage，
# 默认会落到 /tmp（本机也是 tmpfs）。把 TMPDIR 指到根分区，避免共享内存吃光 RAM。
mkdir -p /var/tmp/dhvw-chromium
export TMPDIR=/var/tmp/dhvw-chromium

exec chromium \
  --kiosk \
  --start-fullscreen \
  --window-size=1920,1080 \
  --app="$URL" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-pinch \
  --disable-gpu-compositing \
  --use-gl=angle \
  --use-angle=swiftshader \
  --enable-unsafe-swiftshader \
  --js-flags=--max-old-space-size=256 \
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
