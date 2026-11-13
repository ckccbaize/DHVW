"""持久化：事件日志（life.db）、记忆库（memory.db）、摘要 JSON。

写盘纪律（PC/docs/PLAN.md §6）：产物走临时文件 + 原子改名；数据库只开 WAL。
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from . import data_dir


def _bigrams(text: str) -> list[str]:
    """中文没有空格：用二元组当索引词，2 个汉字也能命中。"""
    s = "".join(ch for ch in text if not ch.isspace())
    if len(s) <= 1:
        return [s] if s else []
    return [s[i : i + 2] for i in range(len(s) - 1)]


def _index_text(text: str) -> str:
    return " ".join(dict.fromkeys(_bigrams(text)))


def _normalize(text: str) -> str:
    return " ".join(text.split())


class Store:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or data_dir()
        self.root.mkdir(parents=True, exist_ok=True)
        self.digest_file = self.root / "digest.json"
        self._lock = threading.Lock()
        self._life = sqlite3.connect(self.root / "life.db", check_same_thread=False)
        self._life.row_factory = sqlite3.Row
        self._life.execute("pragma journal_mode=wal")
        self._life.executescript(
            """
            create table if not exists events (
              uuid text primary key,
              seq integer,
              t_local integer,
              t_corrected integer,
              kind text,
              payload text,
              src text,
              received_at integer
            );
            create index if not exists events_seq on events(seq);
            create table if not exists sessions (
              id text primary key,
              begun_at integer,
              ended_at integer
            );
            create table if not exists actions (
              id text primary key,
              action text not null,
              args text,
              ok integer,
              result text,
              at integer
            );
            create table if not exists kv (
              key text primary key,
              value text not null
            );
            """
        )
        self._memory = sqlite3.connect(self.root / "memory.db", check_same_thread=False)
        self._memory.row_factory = sqlite3.Row
        self._memory.execute("pragma journal_mode=wal")
        self._memory.executescript(
            """
            create table if not exists mem_meta (
              id text primary key,
              text text not null,
              norm text not null,
              tier text,
              conf real,
              t integer,
              updated_at integer,
              src text
            );
            create unique index if not exists mem_norm on mem_meta(norm);
            create virtual table if not exists mem_fts using fts5(idx);
            """
        )
        self._rebuild_fts_if_needed()

    # ---------------- events ----------------
    def add_events(self, events: list[dict]) -> dict:
        """按 uuid 幂等入库，返回本批最大 seq 与去重计数。"""
        inserted = 0
        duplicated = 0
        max_seq = 0
        now = int(time.time() * 1000)
        with self._lock, self._life:
            for ev in events:
                if not isinstance(ev, dict):
                    continue
                uuid = str(ev.get("uuid") or "").strip()
                if not uuid:
                    continue
                seq = int(ev.get("seq") or 0)
                max_seq = max(max_seq, seq)
                cur = self._life.execute(
                    "insert or ignore into events(uuid, seq, t_local, t_corrected, kind, payload, src, received_at)"
                    " values(?,?,?,?,?,?,?,?)",
                    (
                        uuid,
                        seq,
                        int(ev.get("t_local") or 0),
                        int(ev.get("t_corrected") or 0),
                        str(ev.get("kind") or ""),
                        json.dumps(ev.get("payload") or {}, ensure_ascii=False),
                        str(ev.get("src") or "device"),
                        now,
                    ),
                )
                if cur.rowcount:
                    inserted += 1
                else:
                    duplicated += 1
        return {"seq": max_seq, "inserted": inserted, "duplicated": duplicated}

    def recent_events(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._life.execute(
                "select uuid, seq, t_local, kind, payload from events order by received_at desc limit ?", (limit,)
            ).fetchall()
        return [
            {"uuid": r["uuid"], "seq": r["seq"], "t_local": r["t_local"], "kind": r["kind"], "payload": json.loads(r["payload"] or "{}")}
            for r in rows
        ]

    # ---------------- sessions ----------------
    def begin_session(self, session_id: str) -> None:
        with self._lock, self._life:
            self._life.execute(
                "insert or replace into sessions(id, begun_at, ended_at) values(?,?,null)", (session_id, int(time.time() * 1000))
            )

    def end_session(self, session_id: str) -> None:
        with self._lock, self._life:
            self._life.execute("update sessions set ended_at=? where id=?", (int(time.time() * 1000), session_id))

    # ---------------- kv ----------------
    def put_kv(self, key: str, value: object) -> None:
        with self._lock, self._life:
            self._life.execute(
                "insert into kv(key, value) values(?,?) on conflict(key) do update set value=excluded.value",
                (key, json.dumps(value, ensure_ascii=False)),
            )

    def get_kv(self, key: str, default: object = None) -> object:
        with self._lock:
            row = self._life.execute("select value from kv where key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    # ---------------- actions ----------------
    def record_action(self, action_id: str, action: str, args: dict, ok: bool, result: dict) -> None:
        with self._lock, self._life:
            self._life.execute(
                "insert or replace into actions(id, action, args, ok, result, at) values(?,?,?,?,?,?)",
                (action_id, action, json.dumps(args, ensure_ascii=False), 1 if ok else 0, json.dumps(result, ensure_ascii=False), int(time.time() * 1000)),
            )

    # ---------------- digest ----------------
    def write_digest(self, digest: dict) -> None:
        """原子写 data/digest.json（GET /__digest 等价物）。"""
        self.put_kv("digest", digest)
        tmp = self.digest_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(digest, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.digest_file)

    def read_digest(self) -> dict:
        return self.get_kv("digest", {}) or {}

    # ---------------- memory ----------------
    def _rebuild_fts_if_needed(self) -> None:
        with self._lock, self._memory:
            fts = self._memory.execute("select count(*) c from mem_fts").fetchone()["c"]
            meta = self._memory.execute("select count(*) c from mem_meta").fetchone()["c"]
            if fts == meta:
                return
            # 索引可删可重建（验收项）：正文在 mem_meta，FTS 只是派生物
            self._memory.execute("delete from mem_fts")
            for row in self._memory.execute("select rowid, norm from mem_meta"):
                self._memory.execute("insert into mem_fts(rowid, idx) values(?,?)", (row["rowid"], _index_text(row["norm"])))

    def upsert_facts(self, facts: list[dict], src: str = "device") -> dict:
        accepted: list[str] = []
        merged: list[str] = []
        rejected: list[dict] = []
        now = int(time.time() * 1000)
        with self._lock, self._memory:
            for fact in facts:
                if not isinstance(fact, dict):
                    rejected.append({"id": "", "reason": "not_object"})
                    continue
                text = _normalize(str(fact.get("text") or ""))
                fact_id = str(fact.get("id") or "").strip()
                if not text:
                    rejected.append({"id": fact_id, "reason": "empty_text"})
                    continue
                if not fact_id:
                    fact_id = "pc-" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
                updated = int(fact.get("t") or now)
                existing = self._memory.execute("select id, conf, updated_at from mem_meta where norm=?", (text,)).fetchone()
                if existing:
                    # LWW：同文本取 conf 高者，时间戳相同时 pc 覆盖 device
                    keep_new = existing["updated_at"] <= updated or src == "pc"
                    if keep_new:
                        self._memory.execute(
                            "update mem_meta set conf=max(coalesce(conf,0),?), updated_at=?, tier=coalesce(?, tier) where id=?",
                            (float(fact.get("conf") or 0.6), updated, fact.get("tier"), existing["id"]),
                        )
                    merged.append(existing["id"])
                    continue
                cur = self._memory.execute(
                    "insert into mem_meta(id, text, norm, tier, conf, t, updated_at, src) values(?,?,?,?,?,?,?,?)",
                    (fact_id, text, text, str(fact.get("tier") or "L2"), float(fact.get("conf") or 0.6), int(fact.get("t") or 0), updated, src),
                )
                self._memory.execute("insert into mem_fts(rowid, idx) values(?,?)", (cur.lastrowid, _index_text(text)))
                accepted.append(fact_id)
        return {"accepted": accepted, "merged": merged, "rejected": rejected}

    def search(self, text: str, k: int = 8) -> list[dict]:
        query = _normalize(text)
        if not query:
            return []
        tokens = _bigrams(query)
        # 二元组之间用 AND 收敛；命中不了再退到 OR，避免长句全空
        for joiner in (" AND ", " OR "):
            expr = joiner.join(f'"{t}"' for t in tokens)
            try:
                with self._lock:
                    rows = self._memory.execute(
                        "select m.id, m.text, m.tier, m.t, bm25(mem_fts) as rank from mem_fts"
                        " join mem_meta m on m.rowid = mem_fts.rowid where mem_fts match ? order by rank limit ?",
                        (expr, k),
                    ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            if rows:
                return [
                    {
                        "id": r["id"],
                        "text": r["text"],
                        "tier": r["tier"],
                        "ts": r["t"],
                        "score": round(1.0 / (1.0 + abs(float(r["rank"]))), 4),
                    }
                    for r in rows
                ]
        return []

    def memory_count(self) -> int:
        with self._lock:
            return int(self._memory.execute("select count(*) c from mem_meta").fetchone()["c"])

    def close(self) -> None:
        self._life.close()
        self._memory.close()
