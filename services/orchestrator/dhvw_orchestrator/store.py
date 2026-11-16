"""持久化：事件日志（life.db）、记忆库（memory.db）、摘要 JSON。

写盘纪律（PC/docs/PLAN.md §6）：产物走临时文件 + 原子改名；数据库只开 WAL。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

from . import data_dir
from .embedder import DIM, MODEL_NAME, LocalEmbedder, runtime_versions


DAY_MS = 86_400_000

# ---- 遗忘曲线（Ebbinghaus 指数保持）----
# 保持率 R = exp(-Δ天 / S)；S 是稳定性（天），按层给初值，每次被成功召回就按间隔重复拉长。
STABILITY_DAYS = {"L0": 120.0, "L1": 14.0, "L2": 3.0}
DEFAULT_STABILITY = STABILITY_DAYS["L2"]
REINFORCE_FACTOR = 0.6  # 召回一次稳定性 ×1.6
MAX_STABILITY = 3650.0
RETENTION_FLOOR = 0.05  # 低于它算“遗忘”，退出检索
FORGOT_KEEP_DAYS = 30  # 遗忘行保留期（审计/可复活），之后物理删除
SUPERSEDED_KEEP_DAYS = 180  # 被取代行保留期


def stability_for(tier: str | None) -> float:
    return STABILITY_DAYS.get(str(tier or "L2"), DEFAULT_STABILITY)


def retention_of(stability: float | None, last_access_ms: int, now_ms: int) -> float:
    # 指数遗忘：稳定性 S 天、最后一次接触距今 Δ 天的保持率
    s = float(stability or 0.0)
    if s <= 0.0:
        return 0.0
    age_days = max(0.0, (now_ms - int(last_access_ms or 0)) / DAY_MS)
    return math.exp(-age_days / s)


def half_life_days(stability: float | None) -> float:
    return 0.6931471805599453 * float(stability or 0.0)


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


_UPDATE_CUES = re.compile(r"(改口|不再|换成|改为|其实更|现在更|讨厌了|不喜欢了)")
_WARM_CUES = re.compile(r"(喜欢|暖|灯|风衣|茶|咖啡|雨|陪|睡|休息|周记)")
_SOCIAL_CUES = re.compile(r"(约定|一起|下次|想去|聊|见面|出门|去玩)")


def _mood_boost(text: str, tier: str, mood: dict | None) -> float:
    if not isinstance(mood, dict) or not mood:
        return 0.0
    dims = mood.get("dims") if isinstance(mood.get("dims"), dict) else {}
    band = str(mood.get("band") or "").lower()
    valence = float(dims.get("valence", 0.5))
    energy = float(dims.get("energy", 0.5))
    social = float(dims.get("social", 0.4))
    boost = 0.0
    if band in ("low", "tired", "down") or valence < 0.3 or energy < 0.3:
        if tier == "L0" or _WARM_CUES.search(text):
            boost += 0.04
    if social > 0.55 or band in ("social", "lively"):
        if _SOCIAL_CUES.search(text):
            boost += 0.04
    return boost


class Store:
    def __init__(self, root: Path | None = None, embedder: LocalEmbedder | None = None) -> None:
        self.root = root or data_dir()
        self.root.mkdir(parents=True, exist_ok=True)
        self.digest_file = self.root / "digest.json"
        self._lock = threading.Lock()
        self.embedder = embedder or LocalEmbedder(data_root=self.root)
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
        self._vec_ready = self._load_sqlite_vec(self._memory)
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
              src text,
              superseded_by text
            );
            create unique index if not exists mem_norm on mem_meta(norm);
            create virtual table if not exists mem_fts using fts5(idx);
            """
        )
        cols = {r["name"] for r in self._memory.execute("pragma table_info(mem_meta)")}
        if "superseded_by" not in cols:
            self._memory.execute("alter table mem_meta add column superseded_by text")
        for col, ddl in (
            ("stability", "alter table mem_meta add column stability real"),
            ("recalls", "alter table mem_meta add column recalls integer default 0"),
            ("last_access", "alter table mem_meta add column last_access integer"),
            ("forgotten_at", "alter table mem_meta add column forgotten_at integer"),
        ):
            if col not in cols:
                self._memory.execute(ddl)
        # 老行按层补初值：稳定性取层初值，最后一次接触取写入时间
        self._memory.execute(
            "update mem_meta set stability = case coalesce(tier,'L2') when 'L0' then ? when 'L1' then ? else ? end"
            " where stability is null",
            (STABILITY_DAYS["L0"], STABILITY_DAYS["L1"], STABILITY_DAYS["L2"]),
        )
        self._memory.execute(
            "update mem_meta set last_access = coalesce(nullif(updated_at,0), nullif(t,0), 0)"
            " where last_access is null or last_access = 0"
        )
        if self._vec_ready:
            self._memory.execute(f"create virtual table if not exists mem_vec using vec0(embedding float[{DIM}])")
        self._rebuild_fts_if_needed()
        self._rebuild_vec_if_needed()
        # 启动时按曲线结算一次：过期标记 + 超期物理删除（结果可从 /dhvw/memory/stats 观察）
        self.boot_forget = self.forget_sweep()

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

    def events_since(self, since_seq: int = 0, limit: int = 40) -> tuple[list[dict], int]:
        """按 seq 增量取未归纳的设备事件，排除高频噪声。"""
        noise = ("debug", "core_ready", "governor:tier", "doctor:action", "wake:silent", "heartbeat")
        placeholders = ",".join("?" for _ in noise)
        with self._lock:
            rows = self._life.execute(
                f"select uuid, seq, t_local, kind, payload from events"
                f" where seq > ? and kind not in ({placeholders}) order by seq asc limit ?",
                (int(since_seq), *noise, int(limit)),
            ).fetchall()
        events = [
            {"uuid": r["uuid"], "seq": r["seq"], "t_local": r["t_local"], "kind": r["kind"], "payload": json.loads(r["payload"] or "{}")}
            for r in rows
        ]
        max_seq = int(rows[-1]["seq"]) if rows else int(since_seq)
        return events, max_seq

    def events_by_kind(self, since_ms: int = 0) -> dict[str, int]:
        with self._lock:
            rows = self._life.execute(
                "select kind, count(*) c from events where received_at >= ? group by kind order by c desc",
                (int(since_ms),),
            ).fetchall()
        return {str(r["kind"]): int(r["c"]) for r in rows}

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
    @staticmethod
    def _load_sqlite_vec(conn: sqlite3.Connection) -> bool:
        try:
            import sqlite_vec

            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
            return True
        except Exception:
            return False

    @staticmethod
    def _serialize_vec(vec: list[float]) -> object:
        try:
            import sqlite_vec

            return sqlite_vec.serialize_float32(vec)
        except Exception:
            return json.dumps(vec)

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

    def _rebuild_vec_if_needed(self) -> int:
        if not (self._vec_ready and self.embedder.available):
            return 0
        with self._lock:
            rows = self._memory.execute(
                "select m.rowid, m.norm from mem_meta m left join mem_vec v on v.rowid = m.rowid where v.rowid is null"
            ).fetchall()
        if not rows:
            return 0
        vecs = self.embedder.encode([r["norm"] for r in rows])
        if len(vecs) != len(rows):
            return 0
        with self._lock, self._memory:
            for r, vec in zip(rows, vecs):
                self._memory.execute(
                    "insert or replace into mem_vec(rowid, embedding) values(?,?)",
                    (r["rowid"], self._serialize_vec(vec)),
                )
        return len(rows)

    def rebuild_indexes(self) -> dict:
        """删除并由 mem_meta 正文重灌 FTS5 与 vec0 索引。"""
        with self._lock, self._memory:
            self._memory.execute("delete from mem_fts")
            if self._vec_ready:
                self._memory.execute("delete from mem_vec")
            rows = self._memory.execute("select rowid, norm from mem_meta").fetchall()
            for row in rows:
                self._memory.execute("insert into mem_fts(rowid, idx) values(?,?)", (row["rowid"], _index_text(row["norm"])))
        vec_built = 0
        if self._vec_ready and self.embedder.available and rows:
            vecs = self.embedder.encode([r["norm"] for r in rows])
            if len(vecs) == len(rows):
                with self._lock, self._memory:
                    for row, vec in zip(rows, vecs):
                        self._memory.execute(
                            "insert into mem_vec(rowid, embedding) values(?,?)",
                            (row["rowid"], self._serialize_vec(vec)),
                        )
                vec_built = len(rows)
        return {"total": len(rows), "fts": len(rows), "vec": vec_built, "semantic": self._vec_ready and self.embedder.available}

    def upsert_facts(self, facts: list[dict], src: str = "device") -> dict:
        accepted: list[str] = []
        merged: list[str] = []
        rejected: list[dict] = []
        new_rows: list[tuple[int, str]] = []
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
                # updated_at 用服务端接收时间：设备（或脚本）给的 t 可能是事件时刻、甚至是未来的值，
                # 拿它当游标会把之后写入的事实挡在增量之外
                updated = now
                existing = self._memory.execute("select rowid, id, conf, updated_at from mem_meta where norm=?", (text,)).fetchone()
                if existing:
                    # LWW：同文本取 conf 高者，时间戳相同时 pc 覆盖 device
                    keep_new = existing["updated_at"] <= updated or src == "pc"
                    if keep_new:
                        # 再次被提起 = 复习：复活已遗忘的行，稳定性不低于层初值，最后接触时间刷新
                        tier = str(fact.get("tier") or "L2")
                        self._memory.execute(
                            "update mem_meta set conf=max(coalesce(conf,0),?), updated_at=?,"
                            " tier=coalesce(?, tier), forgotten_at=null, last_access=?,"
                            " stability=max(coalesce(stability, 0), ?) where id=?",
                            (
                                float(fact.get("conf") or 0.6),
                                updated,
                                fact.get("tier"),
                                updated,
                                stability_for(tier),
                                existing["id"],
                            ),
                        )
                    merged.append(existing["id"])
                    continue
                tier = str(fact.get("tier") or "L2")
                cur = self._memory.execute(
                    "insert into mem_meta(id, text, norm, tier, conf, t, updated_at, src, stability, recalls, last_access)"
                    " values(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        fact_id,
                        text,
                        text,
                        tier,
                        float(fact.get("conf") or 0.6),
                        int(fact.get("t") or 0),
                        updated,
                        src,
                        stability_for(tier),
                        0,
                        updated,
                    ),
                )
                rowid = int(cur.lastrowid)
                self._memory.execute("insert into mem_fts(rowid, idx) values(?,?)", (rowid, _index_text(text)))
                supersedes_id = str(fact.get("supersedes") or "").strip()
                if supersedes_id:
                    self._memory.execute("update mem_meta set superseded_by=? where id=?", (fact_id, supersedes_id))
                new_rows.append((rowid, text, fact_id, not bool(supersedes_id)))
                accepted.append(fact_id)
        if new_rows and self._vec_ready and self.embedder.available:
            vecs = self.embedder.encode([t for _, t, _, _ in new_rows])
            if len(vecs) == len(new_rows):
                with self._lock, self._memory:
                    for (rowid, text, fact_id, auto_super), vec in zip(new_rows, vecs):
                        if auto_super:
                            has_cue = bool(_UPDATE_CUES.search(text))
                            max_dist = 0.72 if has_cue else 0.42
                            near = self._memory.execute(
                                "select rowid, distance from mem_vec where embedding match ? order by distance limit 3",
                                (self._serialize_vec(vec),),
                            ).fetchall()
                            for nr in near:
                                nrowid, dist = int(nr["rowid"]), float(nr["distance"])
                                if nrowid != rowid and dist <= max_dist:
                                    self._memory.execute(
                                        "update mem_meta set superseded_by=? where rowid=? and (superseded_by is null or superseded_by='')",
                                        (fact_id, nrowid),
                                    )
                        self._memory.execute(
                            "insert or replace into mem_vec(rowid, embedding) values(?,?)",
                            (rowid, self._serialize_vec(vec)),
                        )
        return {"accepted": accepted, "merged": merged, "rejected": rejected}

    def _fts_candidates(self, query: str, limit: int) -> dict[int, float]:
        tokens = _bigrams(query)
        if not tokens:
            return {}
        for joiner in (" AND ", " OR "):
            expr = joiner.join(f'"{t}"' for t in tokens)
            try:
                with self._lock:
                    rows = self._memory.execute(
                        "select rowid, bm25(mem_fts) as rank from mem_fts where mem_fts match ? order by rank limit ?",
                        (expr, limit),
                    ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            if rows:
                return {int(r["rowid"]): 1.0 / (1.0 + abs(float(r["rank"]))) for r in rows}
        return {}

    def _reinforce(self, rowids: list[int], now_ms: int) -> None:
        """间隔重复：被召回一次就把稳定性拉长 REINFORCE_FACTOR（封顶 MAX_STABILITY）。"""
        if not rowids:
            return
        placeholders = ",".join("?" for _ in rowids)
        with self._lock, self._memory:
            rows = self._memory.execute(
                f"select rowid, stability, recalls from mem_meta where rowid in ({placeholders})",
                rowids,
            ).fetchall()
            for r in rows:
                base = float(r["stability"] or DEFAULT_STABILITY)
                grown = min(MAX_STABILITY, base * (1.0 + REINFORCE_FACTOR))
                self._memory.execute(
                    "update mem_meta set stability=?, recalls=coalesce(recalls,0)+1, last_access=? where rowid=?",
                    (grown, now_ms, int(r["rowid"])),
                )

    def forget_sweep(self, now_ms: int | None = None, dry_run: bool = False) -> dict:
        """按遗忘曲线结算：低于阈值的行标 forgotten_at（退出检索），超期行物理删除。L0 永不自遗忘。"""
        now = int(now_ms or time.time() * 1000)
        marked = purged = checked = 0
        with self._lock, self._memory:
            rows = self._memory.execute(
                "select rowid, tier, stability, last_access, updated_at, forgotten_at, superseded_by from mem_meta"
            ).fetchall()
            for r in rows:
                checked += 1
                if r["forgotten_at"]:
                    continue
                if str(r["tier"] or "L2") == "L0":
                    continue
                stability = r["stability"] if r["stability"] is not None else stability_for(r["tier"])
                last = int(r["last_access"] or r["updated_at"] or 0)
                if retention_of(stability, last, now) < RETENTION_FLOOR:
                    marked += 1
                    if not dry_run:
                        self._memory.execute(
                            "update mem_meta set forgotten_at=? where rowid=?", (now, int(r["rowid"]))
                        )
            cutoff_forgot = now - FORGOT_KEEP_DAYS * DAY_MS
            cutoff_super = now - SUPERSEDED_KEEP_DAYS * DAY_MS
            dead = self._memory.execute(
                "select rowid from mem_meta where (forgotten_at is not null and forgotten_at <= ?)"
                " or ((superseded_by is not null and superseded_by != '') and coalesce(updated_at, 0) <= ?)",
                (cutoff_forgot, cutoff_super),
            ).fetchall()
            purged = len(dead)
            if not dry_run:
                for r in dead:
                    rowid = int(r["rowid"])
                    self._memory.execute("delete from mem_meta where rowid=?", (rowid,))
                    try:
                        self._memory.execute("delete from mem_fts where rowid=?", (rowid,))
                    except sqlite3.OperationalError:
                        pass
                    if self._vec_ready:
                        try:
                            self._memory.execute("delete from mem_vec where rowid=?", (rowid,))
                        except sqlite3.OperationalError:
                            pass
        return {
            "ok": True,
            "checked": checked,
            "marked": marked,
            "purged": purged,
            "dryRun": bool(dry_run),
            "floor": RETENTION_FLOOR,
            "keepForgottenDays": FORGOT_KEEP_DAYS,
            "keepSupersededDays": SUPERSEDED_KEEP_DAYS,
        }

    def memory_curve(self, k: int = 12, now_ms: int | None = None) -> dict:
        """最接近遗忘的一批活跃记忆：按保持率升序，附稳定性/年龄/召回次数。"""
        now = int(now_ms or time.time() * 1000)
        with self._lock:
            rows = self._memory.execute(
                "select id, text, tier, stability, last_access, updated_at, recalls from mem_meta"
                " where (superseded_by is null or superseded_by='') and forgotten_at is null"
            ).fetchall()
        items = []
        for r in rows:
            stability = float(r["stability"] or stability_for(r["tier"]))
            last = int(r["last_access"] or r["updated_at"] or 0)
            retention = retention_of(stability, last, now)
            items.append(
                {
                    "id": r["id"],
                    "text": r["text"],
                    "tier": r["tier"],
                    "retention": round(retention, 4),
                    "stabilityDays": round(stability, 1),
                    "halfLifeDays": round(half_life_days(stability), 1),
                    "ageDays": round(max(0.0, (now - last) / DAY_MS), 2),
                    "recalls": int(r["recalls"] or 0),
                    "protected": str(r["tier"] or "L2") == "L0",
                }
            )
        items.sort(key=lambda it: it["retention"])
        return {
            "now": now,
            "floor": RETENTION_FLOOR,
            "reinforceFactor": REINFORCE_FACTOR,
            "stabilityDays": dict(STABILITY_DAYS),
            "active": len(items),
            "average": round(sum(i["retention"] for i in items) / len(items), 4) if items else None,
            "items": items[: max(1, int(k))],
        }

    def search_hybrid(
        self, text: str, k: int = 8, min_score: float = 0.0, mood: dict | None = None
    ) -> tuple[list[dict], bool]:
        """三路融合检索（0.5×向量 + 0.3×FTS5 + 0.2×时间衰减 + 情绪共鸣微调）；无向量模型时降级纯 FTS5。"""
        query = _normalize(text)
        if not query:
            return [], False
        cand_limit = max(k * 3, 12)
        fts_scores = self._fts_candidates(query, cand_limit)

        if self._vec_ready and self.embedder.available:
            qvec = self.embedder.encode_one(query)
            if qvec is not None:
                with self._lock:
                    vec_rows = self._memory.execute(
                        "select rowid, distance from mem_vec where embedding match ? order by distance limit ?",
                        (self._serialize_vec(qvec), cand_limit),
                    ).fetchall()
                vec_scores = {int(r["rowid"]): 1.0 / (1.0 + float(r["distance"])) for r in vec_rows}
                all_ids = sorted(set(vec_scores) | set(fts_scores))
                if not all_ids:
                    return [], True
                placeholders = ",".join("?" for _ in all_ids)
                with self._lock:
                    meta_rows = self._memory.execute(
                        f"select rowid, id, text, tier, t, stability, last_access, recalls from mem_meta"
                        f" where rowid in ({placeholders}) and (superseded_by is null or superseded_by='')"
                        f" and forgotten_at is null",
                        all_ids,
                    ).fetchall()
                now_ms = int(time.time() * 1000)
                scored: list[tuple[float, dict]] = []
                for r in meta_rows:
                    rowid = int(r["rowid"])
                    ts_ms = int(r["t"] or 0)
                    retention = retention_of(r["stability"], int(r["last_access"] or ts_ms), now_ms)
                    score = (
                        0.5 * vec_scores.get(rowid, 0.0)
                        + 0.3 * fts_scores.get(rowid, 0.0)
                        + 0.2 * retention
                        + _mood_boost(str(r["text"]), str(r["tier"] or ""), mood)
                    )
                    if min_score > 0.0 and score < min_score:
                        continue
                    scored.append(
                        (
                            score,
                            {
                                "id": r["id"],
                                "text": r["text"],
                                "tier": r["tier"],
                                "ts": ts_ms,
                                "score": round(score, 4),
                                "retention": round(retention, 3),
                                "rowid": rowid,
                            },
                        )
                    )
                scored.sort(key=lambda item: -item[0])
                top = [item[1] for item in scored[:k]]
                self._reinforce([int(h["rowid"]) for h in top], now_ms)
                for h in top:
                    h.pop("rowid", None)
                return top, True

        if not fts_scores:
            return [], False
        ids = list(fts_scores.keys())
        placeholders = ",".join("?" for _ in ids)
        with self._lock:
            meta_rows = self._memory.execute(
                f"select rowid, id, text, tier, t from mem_meta where rowid in ({placeholders})"
                f" and (superseded_by is null or superseded_by='') and forgotten_at is null",
                ids,
            ).fetchall()
        meta_map = {int(r["rowid"]): r for r in meta_rows}
        now_ms = int(time.time() * 1000)
        hits = []
        hit_rowids: list[int] = []
        for rowid, sc in sorted(fts_scores.items(), key=lambda kv: -kv[1])[:k]:
            r = meta_map.get(rowid)
            if r:
                hits.append({"id": r["id"], "text": r["text"], "tier": r["tier"], "ts": r["t"], "score": round(sc, 4)})
                hit_rowids.append(rowid)
        self._reinforce(hit_rowids, now_ms)
        return hits, False

    def search(self, text: str, k: int = 8) -> list[dict]:
        hits, _ = self.search_hybrid(text, k)
        return hits

    def get_l0_facts(self, limit: int = 3) -> list[dict]:
        """取核心偏好/禁忌（L0）用于显现常驻上下文。"""
        with self._lock:
            rows = self._memory.execute(
                "select id, text, tier, t from mem_meta"
                " where tier='L0' and (superseded_by is null or superseded_by='') and forgotten_at is null"
                " order by updated_at desc limit ?",
                (int(limit),),
            ).fetchall()
        return [{"id": r["id"], "text": r["text"], "tier": r["tier"], "ts": int(r["t"] or 0)} for r in rows]

    def memory_stats(self) -> dict:
        with self._lock:
            total = int(self._memory.execute("select count(*) c from mem_meta").fetchone()["c"])
            forgotten = int(
                self._memory.execute("select count(*) c from mem_meta where forgotten_at is not null").fetchone()["c"]
            )
            superseded = int(
                self._memory.execute(
                    "select count(*) c from mem_meta where superseded_by is not null and superseded_by != ''"
                ).fetchone()["c"]
            )
            active = int(
                self._memory.execute(
                    "select count(*) c from mem_meta where forgotten_at is null"
                    " and (superseded_by is null or superseded_by='')"
                ).fetchone()["c"]
            )
            fts = int(self._memory.execute("select count(*) c from mem_fts").fetchone()["c"])
            vec = int(self._memory.execute("select count(*) c from mem_vec").fetchone()["c"]) if self._vec_ready else 0
        model_dir = self.embedder.model_dir
        model_files = bool(
            model_dir
            and (model_dir / "model.onnx").is_file()
            and (model_dir / "tokenizer.json").is_file()
        )
        db_file = self.root / "memory.db"
        try:
            db_bytes = db_file.stat().st_size
        except OSError:
            db_bytes = 0
        return {
            "total": total,
            "fts": fts,
            "vec": vec,
            "vec_ready": self._vec_ready,
            "semantic": self._vec_ready and self.embedder.available,
            "model": MODEL_NAME,
            "dim": DIM,
            "model_dir": str(model_dir) if model_dir else None,
            "model_files": model_files,
            "embed_error": self.embedder.error,
            "deps": runtime_versions(),
            "db_path": str(db_file),
            "db_bytes": db_bytes,
            "forgotten": forgotten,
            "superseded": superseded,
            "active": active,
            "avg_retention": self.memory_curve(k=1).get("average"),
            "forgetting": {
                "floor": RETENTION_FLOOR,
                "reinforceFactor": REINFORCE_FACTOR,
                "stabilityDays": dict(STABILITY_DAYS),
                "keepForgottenDays": FORGOT_KEEP_DAYS,
                "keepSupersededDays": SUPERSEDED_KEEP_DAYS,
            },
        }

    def facts_since(self, since: int = 0, limit: int = 200) -> tuple[list[dict], int]:
        """按 updated_at 增量取事实，供 memory:facts 回流设备。返回 (facts, 本批最大 updated_at)。"""
        with self._lock:
            rows = self._memory.execute(
                "select id, text, tier, conf, t, updated_at from mem_meta where updated_at > ?"
                " order by updated_at asc limit ?",
                (int(since), int(limit)),
            ).fetchall()
        facts = [
            {"id": r["id"], "text": r["text"], "t": r["t"], "tier": r["tier"], "conf": r["conf"]} for r in rows
        ]
        return facts, (int(rows[-1]["updated_at"]) if rows else int(since))

    def memory_count(self) -> int:
        with self._lock:
            return int(self._memory.execute("select count(*) c from mem_meta").fetchone()["c"])

    def close(self) -> None:
        self._life.close()
        self._memory.close()
