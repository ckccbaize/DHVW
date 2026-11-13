"""pc:action 白名单执行（CONTRACTS.md §3.4）。

只做 Python 进程能真做到的事；需要外壳/场景管线的动作显式失败，不假装成功。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

APPS = {
    "browser": None,  # 交给系统默认浏览器
    "explorer": "explorer.exe",
    "notepad": "notepad.exe",
}

UNSUPPORTED = {
    "notify": "系统通知需要外壳窗口，暂未接线",
    "map.generate": "场景像素生成管线未接（PC 侧待做，见 docs/ARM-CORE-INTEGRATION.md §3.3）",
}


def _http_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return value


def _local_file(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if not path.is_absolute():
        return None
    return str(path) if path.exists() else None


def run(action: str, args: dict) -> tuple[bool, dict]:
    if action in UNSUPPORTED:
        return False, {"reason": UNSUPPORTED[action]}

    if action == "web.open":
        url = _http_url(args.get("url"))
        if not url:
            return False, {"reason": "url 必须是 http(s)"}
        os.startfile(url)  # noqa: S606 - 已校验协议
        return True, {"opened": url}

    if action == "media.play":
        target = _http_url(args.get("url")) or _local_file(args.get("url"))
        if not target:
            return False, {"reason": "url 必须是 http(s) 或本机存在的绝对路径"}
        os.startfile(target)  # noqa: S606
        return True, {"playing": target}

    if action == "app.open":
        name = str(args.get("app") or "")
        if name not in APPS:
            return False, {"reason": f"未知应用：{name}", "allowed": sorted(APPS)}
        exe = APPS[name]
        if exe is None:
            os.startfile("https://www.bing.com")  # noqa: S606 - 打开默认浏览器
        else:
            subprocess.Popen([exe], close_fds=True)  # noqa: S603
        return True, {"app": name}

    return False, {"reason": f"动作不在白名单：{action}"}


def describe() -> dict:
    return {"supported": ["web.open", "media.play", "app.open"], "unsupported": UNSUPPORTED, "env": sys.platform}
