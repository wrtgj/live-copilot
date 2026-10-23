#!/usr/bin/env python3
"""
Live Script Copilot · 数据库初始化脚本

作用：
  1. 确认 SQLite 数据目录存在
  2. 校验核心表是否齐备
  3. 可选：写入一份演示用的预设人设（供 UI 首次登录时展示）

用法：
  python3 scripts/seed.py
  python3 scripts/seed.py --db ./data/app.db --demo-persona
"""
import argparse
import os
import sqlite3
import sys

REQUIRED_TABLES = ["users", "personas", "sessions", "utterances", "suggestions", "feedback"]

DEMO_PERSONAS = [
    ("亲和逼单 · 综合带货", "sales", "push", "轻快有能量", "综合带货",
     ["最好", "第一", "根治", "全网最低"]),
    ("温柔陪伴 · 粉丝连麦", "fan", "gentle", "慢条斯理", "", ["傻逼", "去死"]),
    ("幽默接梗 · 连麦 PK", "pk", "funny", "快节奏", "", ["傻逼", "智障"]),
]


def ensure_schema(con: sqlite3.Connection) -> bool:
    cur = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    existing = {r[0] for r in cur.fetchall()}
    missing = [t for t in REQUIRED_TABLES if t not in existing]
    if missing:
        print(f"[seed] 缺少表: {', '.join(missing)}")
        print("[seed] 请先启动一次后端服务（启动时会自动建表），再运行本脚本。")
        return False
    print(f"[seed] 表结构齐备: {', '.join(REQUIRED_TABLES)}")
    return True


def seed_demo_personas(con: sqlite3.Connection) -> int:
    """写入演示人设（挂到 id 最小的用户上）"""
    row = con.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
    if not row:
        print("[seed] 尚无用户，跳过演示人设。请先注册一个账号。")
        return 0
    user_id = row[0]
    n = 0
    for name, scene, style, tone, category, banned in DEMO_PERSONAS:
        exists = con.execute(
            "SELECT id FROM personas WHERE user_id=? AND name=?", (user_id, name)
        ).fetchone()
        if exists:
            continue
        import json
        from datetime import datetime, timezone
        ts = datetime.now(timezone.utc).isoformat()
        con.execute(
            "INSERT INTO personas (user_id, name, scene, style, tone, category,"
            " forbidden_words, is_default, status, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,0,'active',?,?)",
            (user_id, name, scene, style, tone, category, json.dumps(banned, ensure_ascii=False), ts, ts),
        )
        n += 1
    con.commit()
    print(f"[seed] 新增演示人设 {n} 条（用户 {user_id}）")
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="./data/app.db")
    ap.add_argument("--demo-persona", action="store_true", help="写入演示用预设人设")
    args = ap.parse_args()

    db_path = os.path.abspath(args.db)
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    if not os.path.exists(db_path):
        print(f"[seed] 数据库不存在: {db_path}")
        print("[seed] 请先启动后端服务一次完成建表：npm run dev")
        return 1

    con = sqlite3.connect(db_path)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    try:
        if not ensure_schema(con):
            return 1
        if args.demo_persona:
            seed_demo_personas(con)
        size_mb = os.path.getsize(db_path) / 1024 / 1024
        print(f"[seed] 完成。当前库大小 {size_mb:.2f} MB")
        return 0
    except sqlite3.Error as e:
        print(f"[seed] 失败: {e}", file=sys.stderr)
        return 1
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
