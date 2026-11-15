"""设备存档备份：原子写 JSON、索引落 kv、只保留最近 N 份。

设备通过 WS `state:save` 上报整份存档；PC 不解析业务字段，只做校验、
落盘和回放。恢复时把原样 JSON 通过 `state:restore` 发回设备。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path

from .store import Store

MAX_BYTES = 4 * 1024 * 1024
KEEP = 20
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class SaveStore:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.root = store.root / "saves"
        self.root.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[dict]:
        items = self.store.get_kv("state_saves", []) or []
        return [x for x in items if isinstance(x, dict) and SAFE_ID.match(str(x.get("id") or ""))]

    def _save_index(self, items: list[dict]) -> None:
        self.store.put_kv("state_saves", items[:KEEP])

    def put(self, save: object, reason: str = "auto") -> dict:
        if not isinstance(save, dict):
            raise ValueError("save 不是对象")
        life = save.get("life")
        agent = save.get("agent")
        if not isinstance(life, dict) or not isinstance(agent, dict):
            raise ValueError("save 缺少 life/agent")
        raw = json.dumps(save, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_BYTES:
            raise ValueError(f"存档超过 {MAX_BYTES} 字节")
        now = int(time.time() * 1000)
        sid = f"{now}-{uuid.uuid4().hex[:8]}"
        path = self.root / f"{sid}.json"
        tmp = path.with_suffix(".json.tmp")
        tmp.write_bytes(raw)
        os.replace(tmp, path)
        meta = {
            "id": sid,
            "receivedAt": now,
            "reason": str(reason or "auto")[:40],
            "savedAt": int(save.get("savedAt") or now),
            "day": life.get("day"),
            "minute": life.get("minute"),
            "scene": agent.get("scene"),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest()[:16],
        }
        items = [meta] + [x for x in self.list() if x.get("id") != sid]
        self._save_index(items)
        self._prune()
        return meta

    def read(self, sid: str) -> dict | None:
        if not SAFE_ID.match(str(sid or "")):
            return None
        path = self.root / f"{sid}.json"
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    def path(self, sid: str) -> Path | None:
        if not SAFE_ID.match(str(sid or "")):
            return None
        path = self.root / f"{sid}.json"
        return path if path.is_file() else None

    def delete(self, sid: str) -> bool:
        path = self.path(sid)
        if path is None:
            return False
        path.unlink(missing_ok=True)
        self._save_index([x for x in self.list() if x.get("id") != sid])
        return True

    def _prune(self) -> None:
        items = self.list()
        keep = {str(x.get("id")) for x in items[:KEEP]}
        for path in self.root.glob("*.json"):
            if path.stem not in keep:
                path.unlink(missing_ok=True)
