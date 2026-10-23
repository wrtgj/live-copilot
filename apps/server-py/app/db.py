"""SQLite 数据层（标准库 sqlite3，与 Node 版共用同一份库文件）。

为与 asyncio 事件循环配合，采用「单连接 + 全局锁」模型：所有访问都在
同一个事件循环线程内串行执行，足够支撑 MVP 的并发量（200 WS 连接量级）。
后续若要横向扩展，可平滑替换为 aiosqlite 或 PostgreSQL。
"""
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from .config import env

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def init() -> None:
    global _conn
    if _conn is not None:
        return
    path = env.db_path
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(path), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode = WAL")
    _conn.execute("PRAGMA busy_timeout = 5000")
    _conn.execute("PRAGMA foreign_keys = ON")
    _conn.executescript(SCHEMA)
    _conn.commit()
    _migrate()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conn_get() -> sqlite3.Connection:
    if _conn is None:
        init()
    assert _conn is not None
    return _conn


def execute(sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
    with _lock:
        cur = _conn_get().execute(sql, tuple(params))
        _conn_get().commit()
        return cur


def query(sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
    with _lock:
        cur = _conn_get().execute(sql, tuple(params))
        return [dict(r) for r in cur.fetchall()]


def query_one(sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def last_insert_id(cur: sqlite3.Cursor) -> int:
    return int(cur.lastrowid)


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT 'live',
  style TEXT NOT NULL DEFAULT 'gentle',
  tone TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  forbidden_words TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_personas_user ON personas(user_id, status);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  persona_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  asr_provider TEXT NOT NULL DEFAULT '',
  is_final INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utt_session ON utterances(session_id, seq);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  utterance_id INTEGER,
  seq INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'llm',
  content TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done',
  risk_level INTEGER NOT NULL DEFAULT 0,
  hit_words TEXT NOT NULL DEFAULT '[]',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  latency_first_token_ms INTEGER,
  latency_total_ms INTEGER,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sug_session ON suggestions(session_id, created_at);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_sug ON feedback(suggestion_id);
"""


def _migrate() -> None:
    """对已存在的库做幂等迁移（新增列），避免破坏旧数据。"""
    with _lock:
        cols = {r[1] for r in _conn_get().execute("PRAGMA table_info(personas)")}
        needed = {
            "voiceprint_b64": "TEXT NOT NULL DEFAULT ''",
            "voiceprint_backend": "TEXT NOT NULL DEFAULT ''",
            "voiceprint_enrolled_at": "TEXT",
        }
        for col, typ in needed.items():
            if col not in cols:
                try:
                    _conn_get().execute(f"ALTER TABLE personas ADD COLUMN {col} {typ}")
                    _conn_get().commit()
                except Exception as e:  # pragma: no cover
                    print("[db] migrate failed:", col, repr(e))
