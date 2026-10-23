#!/usr/bin/env python3
"""
Live Script Copilot · SQLite 备份脚本

对应《运维保障方案》：每日 03:00 全量备份，本机保留 7 天 + 异地留存 30 天。

用法：
  python3 scripts/backup_db.py                       # 备份到 ./data/backup
  python3 scripts/backup_db.py --keep-days 7
  python3 scripts/backup_db.py --remote cos://xxx    # 需要已安装并配置 coscli

cron（每日 03:00）：
  0 3 * * * /usr/bin/python3 /opt/live-script/current/scripts/backup_db.py >> /var/log/live-script/backup.log 2>&1
"""
import argparse
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import time


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def purge_old(backup_dir: str, keep_days: int) -> int:
    cutoff = time.time() - keep_days * 86400
    removed = 0
    for name in os.listdir(backup_dir):
        p = os.path.join(backup_dir, name)
        if name.startswith("copilot-") and (name.endswith(".db") or name.endswith(".sha256")):
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
                removed += 1
    return removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="./data/app.db")
    ap.add_argument("--out", default="./data/backup")
    ap.add_argument("--keep-days", type=int, default=7)
    ap.add_argument("--remote", default="", help="异地目标路径，例如 cos://bucket/prefix/")
    args = ap.parse_args()

    src = os.path.abspath(args.db)
    backup_dir = os.path.abspath(args.out)
    os.makedirs(backup_dir, exist_ok=True)

    if not os.path.exists(src):
        print(f"[backup] 源文件不存在: {src}", file=sys.stderr)
        return 1

    ts = time.strftime("%Y%m%d-%H%M%S")
    dst = os.path.join(backup_dir, f"copilot-{ts}.db")

    try:
        # VACUUM INTO 产出一致性快照，不中断线上读写
        con = sqlite3.connect(src)
        con.execute("PRAGMA busy_timeout=5000")
        con.execute(f"VACUUM INTO '{dst}'")
        con.close()

        size = os.path.getsize(dst)
        if size < 1024:
            raise RuntimeError(f"备份文件过小 ({size} bytes)，判定失败")

        digest = sha256_of(dst)
        with open(f"{dst}.sha256", "w") as f:
            f.write(digest)

        removed = purge_old(backup_dir, args.keep_days)

        remote_msg = ""
        if args.remote:
            subprocess.run(["coscli", "cp", dst, args.remote.rstrip("/") + "/"], check=True)
            remote_msg = f" -> {args.remote}"

        print(
            f"[backup] OK {ts}  size={size / 1024:.0f}KB  sha256={digest[:16]}"
            f"  cleaned={removed}{remote_msg}"
        )
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[backup] FAIL {ts}: {e}", file=sys.stderr)
        if os.path.exists(dst):
            try:
                shutil.rmtree(dst, ignore_errors=True)
                os.remove(dst)
            except OSError:
                pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
