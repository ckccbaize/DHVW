#!/bin/sh
# 设备端安装：资源包 → /opt/dhvw/www，壳 → /usr/local/bin，单元 → systemd。
# 用法（在设备上）：sudo sh deploy/install.sh /path/to/dhvw-shell-linux-arm64
set -eu

BIN="${1:-}"
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "用法: sudo sh deploy/install.sh <dhvw-shell 二进制>" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root（systemd 单元与 /opt 写入）" >&2
  exit 1
fi

if ! id dhvw >/dev/null 2>&1; then
  useradd --system --home-dir /home/dhvw --create-home --shell /usr/sbin/nologin dhvw
fi
# Chromium 需要访问 /dev/dri/card* 与 renderD*（GPU 合成）
usermod -aG video,render dhvw 2>/dev/null || true

install -d /opt/dhvw
install -d -o dhvw -g dhvw -m 0755 /opt/dhvw/data

# 覆盖前留一份现场：kiosk.sh 与 systemd 单元不在 /opt/dhvw-backup-* 的手工备份里，
# 一旦新版本有问题无法回退。只保留最近 5 份。
BK="/var/backups/dhvw-config-$(date +%Y%m%d-%H%M%S)"
install -d "$BK/systemd"
for f in /opt/dhvw/kiosk.sh; do [ -f "$f" ] && cp -a "$f" "$BK/" || true; done
for f in /etc/systemd/system/dhvw-*.service; do [ -f "$f" ] && cp -a "$f" "$BK/systemd/" || true; done
for f in /etc/systemd/logind.conf.d/99-dhvw-nosleep.conf /etc/sysctl.d/99-dhvw.conf; do
  [ -f "$f" ] && { install -d "$BK/$(dirname "$f")"; cp -a "$f" "$BK/$f" || true; }
done
ls -1d /var/backups/dhvw-config-* 2>/dev/null | sort | head -n -5 | xargs -r rm -rf || true

rm -rf /opt/dhvw/www
cp -a "$ROOT/www" /opt/dhvw/www
chown -R root:root /opt/dhvw/www
chmod -R a+rX /opt/dhvw/www

install -m 0755 "$BIN" /usr/local/bin/dhvw-shell
install -m 0755 "$HERE/kiosk.sh" /opt/dhvw/kiosk.sh

install -m 0644 "$HERE/systemd/dhvw-shell.service" /etc/systemd/system/dhvw-shell.service
install -m 0644 "$HERE/systemd/dhvw-x.service" /etc/systemd/system/dhvw-x.service
install -m 0644 "$HERE/systemd/dhvw-display.service" /etc/systemd/system/dhvw-display.service
install -m 0644 "$HERE/systemd/dhvw-kiosk.service" /etc/systemd/system/dhvw-kiosk.service
install -m 0644 "$HERE/systemd/dhvw-qqbot.service" /etc/systemd/system/dhvw-qqbot.service

if [ -f "$ROOT/qq-openclaw/dist/dhvw-server.js" ] && [ ! -x /usr/local/bin/node ]; then
  echo "警告: QQ Bot 需要 Node 22.14+（/usr/local/bin/node），当前未安装" >&2
fi
if [ -f "$ROOT/qq-openclaw/dist/dhvw-server.js" ]; then
  rm -rf /opt/dhvw/qq-openclaw
  cp -a "$ROOT/qq-openclaw" /opt/dhvw/qq-openclaw
  chown -R root:root /opt/dhvw/qq-openclaw
  chmod -R a+rX /opt/dhvw/qq-openclaw
  install -d /etc/dhvw
  if [ ! -f /etc/dhvw/qqbot.json ]; then
    install -m 0640 -o root -g dhvw "$HERE/qqbot.example.json" /etc/dhvw/qqbot.json
  fi
fi

# Chromium 中文界面需要 zh_CN.UTF-8 locale（避免英文 UI 触发翻译气泡）
if command -v localedef >/dev/null 2>&1; then
  localedef -i zh_CN -f UTF-8 zh_CN.UTF-8 2>/dev/null || true
fi

# 关闭 Chromium 翻译气泡（kiosk 全屏不应出现浏览器 UI）
install -d /etc/chromium/policies/managed
install -m 0644 "$HERE/chromium/dhvw-policy.json" /etc/chromium/policies/managed/dhvw.json

install -d /etc/systemd/logind.conf.d
install -m 0644 "$HERE/logind/99-dhvw-nosleep.conf" /etc/systemd/logind.conf.d/99-dhvw-nosleep.conf

install -d /etc/sysctl.d
install -m 0644 "$HERE/sysctl/99-dhvw.conf" /etc/sysctl.d/99-dhvw.conf
sysctl -p /etc/sysctl.d/99-dhvw.conf >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable --now dhvw-shell.service
systemctl enable dhvw-x.service dhvw-display.service >/dev/null 2>&1 || true
if [ -f /etc/dhvw/qqbot.json ]; then
  systemctl enable --now dhvw-qqbot.service >/dev/null 2>&1 || true
fi

# 注意顺序：重启 logind 会让已运行的 X 失去会话控制权（DRM master），
# 之后 xrandr 报 "Configure crtc failed" 并停在 320x200，且不会自愈。
# 因此重启 logind 后必须重启 dhvw-x（display 看门狗也会兜底）。
systemctl restart systemd-logind >/dev/null 2>&1 || true
if systemctl is-active --quiet dhvw-x.service; then
  systemctl restart dhvw-x.service
fi

# enable --now 对已运行的服务不生效，必须显式重启，否则仍跑旧二进制/旧资源
systemctl restart dhvw-shell.service

echo "已安装。检查："
echo "  systemctl status dhvw-shell --no-pager"
echo "  curl -s http://127.0.0.1:8080/__health"
echo "kiosk 需先有 X（graphical.target）：systemctl enable --now dhvw-kiosk.service"
