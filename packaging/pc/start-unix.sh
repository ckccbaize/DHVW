#!/bin/sh
# DHVW ARM device page - PC test launcher (Linux / macOS, loopback only).
# 只用本机回环，不要求 Node / Go / Python。
# 用法：sh start-unix.sh [端口]      默认 18080
set -eu
cd "$(dirname "$0")"

PORT="${1:-18080}"
case "$(uname -s)" in
  Linux) BIN=./dhvw-shell-linux-amd64 ;;
  Darwin)
    case "$(uname -m)" in
      arm64) BIN=./dhvw-shell-darwin-arm64 ;;
      *) BIN=./dhvw-shell-darwin-amd64 ;;
    esac
    ;;
  *)
    echo "只支持 Linux / macOS；Windows 请双击 start-windows.bat" >&2
    exit 1
    ;;
esac

if [ ! -x "$BIN" ]; then
  echo "缺少可执行文件 $BIN" >&2
  exit 1
fi

"$BIN" -dev -addr "127.0.0.1:$PORT" -pair-addr "" -root www &
PID=$!
trap 'kill $PID 2>/dev/null || true' INT TERM EXIT

i=0
until curl -sf "http://127.0.0.1:$PORT/__health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 40 ]; then
    echo "服务未就绪：端口 $PORT 可能被占用。换端口：sh start-unix.sh 18081" >&2
    exit 1
  fi
  sleep 0.25
done

URL="http://127.0.0.1:$PORT/"
echo "已启动：$URL"
echo "巡演页：${URL}tour.html"
echo "地图预览：${URL}preview.html?scene=home"
echo "按 Ctrl-C 停止。"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
fi
wait "$PID"
