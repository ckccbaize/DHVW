#!/bin/sh
# Chromium kiosk：只打开本地壳，不请求主机。
# 总观态不建 WebGL，因此不强制 GPU 后端；保留 --disable-gpu-compositing 兜底由实测决定。
set -eu

URL="http://127.0.0.1:8080/"

# 设备屏幕倒装：X 输出旋转 180°（触控坐标由 X 一并旋转）。
#
# 关键：不要无条件 `--off` 再 `--auto`。每一次 --off 都会让 VOP 把输出降回
# 320x200 再重建，对显示器就是一次真实的信号断/接；有的显示器重新同步失败
# 就停在「有背光、无图像」。只有当前状态确实不对时才去改。
#
# 也别信 xrandr 的返回码：X 失去 DRM master 时 mode set 会被内核拒绝
# （Configure crtc failed），命令看起来执行了但宽度不变。所以判据只有一个：
# 实际 current 宽度。
TARGET_W=1920

current_w() {
  xrandr --query 2>/dev/null |
    awk '/current/ { for (i = 1; i <= NF; i++) if ($i == "current") { print $(i + 1); exit } }'
}

display_ok() {
  w=$(current_w)
  [ -n "$w" ] && [ "$w" -ge 1280 ]
}

# 只在确实不正确时才动输出：先试温和的按模式设置（不切断信号），
# 仍是小尺寸才退回 off/auto 强制重建一次。
apply_display() {
  for out in $(xrandr --query 2>/dev/null | awk '/ connected/{print $1}'); do
    if ! display_ok; then
      xrandr --output "$out" --mode "${TARGET_MODE:-1920x1080}" 2>/dev/null || true
    fi
    xrandr --output "$out" --rotate inverted 2>/dev/null || true
    if ! display_ok; then
      xrandr --output "$out" --auto 2>/dev/null || true
      xrandr --output "$out" --rotate inverted 2>/dev/null || true
    fi
  done
}

if command -v xrandr >/dev/null 2>&1; then
  # 等 connected 输出出现（kiosk 可能早于 CRTC 就绪）
  n=0
  while [ "$n" -lt 50 ]; do
    [ -n "$(xrandr --query 2>/dev/null | awk '/ connected/{print $1; exit}')" ] && break
    n=$((n + 1))
    sleep 0.2
  done
  apply_display
  if ! display_ok; then
    # 少见的启动竞态：再做几次温和重试，绝不反复切断信号
    (
      n=0
      while [ "$n" -lt 6 ]; do
        display_ok && exit 0
        sleep 3
        apply_display
        n=$((n + 1))
      done
      echo "[kiosk] 警告: 显示未达 ${TARGET_W}px，当前: $(xrandr --query 2>/dev/null | head -1)" >&2
    ) &
  fi
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
