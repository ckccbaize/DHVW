#!/bin/sh
# 交叉编译设备端离线壳。产出 dist/dhvw-shell-linux-arm64 与 -armv7。
set -eu
cd "$(dirname "$0")"
OUT=../dist
mkdir -p "$OUT"

build() {
  arch="$1"; goarch="$2"; goarm="$3"
  echo "→ linux/$arch"
  if [ -n "$goarm" ]; then
    GOOS=linux GOARCH="$goarch" GOARM="$goarm" CGO_ENABLED=0 \
      go build -trimpath -ldflags="-s -w" -o "$OUT/dhvw-shell-linux-$arch" .
  else
    GOOS=linux GOARCH="$goarch" CGO_ENABLED=0 \
      go build -trimpath -ldflags="-s -w" -o "$OUT/dhvw-shell-linux-$arch" .
  fi
}

build arm64 arm64 ""
build armv7 arm 7

ls -l "$OUT"
