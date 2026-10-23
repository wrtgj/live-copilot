#!/usr/bin/env bash
# 启动 Python 后端（与前端 Vite 代理约定：REST/WS 均在 8787）
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "${PORT:-8787}" --log-level info
