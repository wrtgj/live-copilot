"""REST 路由层：鉴权、人设 CRUD、会话与历史、反馈与用量。"""
import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import bcrypt

from . import db
from .auth import Uid, make_token
from .config import env

router = APIRouter()

# ---- 响应封装（与 Node 版保持 {code,message,data} 形态，前端 api.ts 依赖此结构） ----
def ok(data: Any = None) -> JSONResponse:
    return JSONResponse({"code": 0, "message": "ok", "data": data})


def fail(code: int, message: str) -> JSONResponse:
    return JSONResponse({"code": code, "message": message, "data": None}, status_code=code)


# ---- 简易限流（防刷） ----
_buckets: dict[str, list[float]] = {}


def rate_limit(key: str, limit: int, window_s: int) -> bool:
    now = time.time()
    ts = _buckets.get(key, [])
    ts = [t for t in ts if now - t < window_s]
    if len(ts) >= limit:
        _buckets[key] = ts
        return False
    ts.append(now)
    _buckets[key] = ts
    return True


# ---- 请求体 ----
class RegisterBody(BaseModel):
    email: str
    password: str
    nickname: str | None = None


class LoginBody(BaseModel):
    email: str
    password: str


class PersonaBody(BaseModel):
    name: str
    scene: str | None = "live"
    style: str | None = "gentle"
    tone: str | None = ""
    category: str | None = ""
    forbiddenWords: list[str] | None = None
    isDefault: bool | None = False


# ---- 工具 ----
def map_persona(row: dict) -> dict:
    out = dict(row)
    try:
        out["forbiddenWords"] = json.loads(row.get("forbidden_words") or "[]")
    except (json.JSONDecodeError, TypeError):
        out["forbiddenWords"] = []
    return out


def seed_default_persona(uid: int) -> None:
    db.execute(
        """INSERT INTO personas
           (user_id, name, scene, style, tone, category, forbidden_words, is_default, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (uid, "亲和逼单（预设）", "sales", "push", "轻快有能量", "综合带货",
         json.dumps(["最好", "第一", "根治"]), 1, "active", db.now(), db.now()),
    )


# ---- 路由 ----
@router.get("/healthz")
def healthz():
    return ok({"status": "ok", "time": db.now(),
               "generate": env.FEATURE_GENERATE, "llm": env.LLM_PROVIDER})


@router.post("/api/auth/register")
def register(body: RegisterBody, request: Request):
    if not body.email or not body.password:
        return fail(400, "邮箱和密码必填")
    if len(body.password) < 6:
        return fail(400, "密码至少 6 位")
    if not rate_limit(f"reg:{request.client.host if request.client else '?'}", 5, 60):
        return fail(429, "注册过于频繁，请稍后再试")

    if db.query_one("SELECT id FROM users WHERE email = ?", (body.email,)):
        return fail(409, "该邮箱已注册")

    pw_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt(rounds=10)).decode()
    cur = db.execute(
        "INSERT INTO users (email, password_hash, nickname, created_at, updated_at) VALUES (?,?,?,?,?)",
        (body.email, pw_hash, body.nickname or "", db.now(), db.now()),
    )
    uid = db.last_insert_id(cur)
    seed_default_persona(uid)
    token = make_token(uid)
    return ok({"token": token, "userId": uid})


@router.post("/api/auth/login")
def login(body: LoginBody, request: Request):
    if not rate_limit(f"login:{request.client.host if request.client else '?'}", 20, 60):
        return fail(429, "尝试过于频繁")
    row = db.query_one("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", (body.email,))
    if not row or not bcrypt.checkpw(body.password.encode(), row["password_hash"].encode()):
        return fail(401, "账号或密码错误")
    token = make_token(int(row["id"]))
    return ok({"token": token, "userId": int(row["id"]), "nickname": row.get("nickname", "")})


@router.get("/api/auth/me")
def me(uid: Uid):
    row = db.query_one("SELECT id, email, nickname, plan FROM users WHERE id = ?", (uid,))
    return ok(row)


@router.get("/api/personas")
def list_personas(uid: Uid):
    rows = db.query(
        "SELECT * FROM personas WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, id DESC",
        (uid,),
    )
    return ok([map_persona(r) for r in rows])


@router.post("/api/personas")
def create_persona(body: PersonaBody, uid: Uid):
    if not body.name:
        return fail(400, "人设名称必填")
    cur = db.execute(
        """INSERT INTO personas
           (user_id, name, scene, style, tone, category, forbidden_words, is_default, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (uid, body.name, body.scene or "live", body.style or "gentle", body.tone or "",
         body.category or "", json.dumps(body.forbiddenWords or []),
         1 if body.isDefault else 0, "active", db.now(), db.now()),
    )
    return ok({"id": db.last_insert_id(cur)})


@router.delete("/api/personas/{pid}")
def delete_persona(pid: int, uid: Uid):
    db.execute("UPDATE personas SET deleted_at = ? WHERE id = ? AND user_id = ?",
               (db.now(), pid, uid))
    return ok(True)


# ---- 声纹（说话人识别） ----
class VoiceprintBody(BaseModel):
    pcm_b64: str
    sample_rate: int = 16000


def _own_persona(pid: int, uid: int) -> dict | None:
    return db.query_one(
        "SELECT * FROM personas WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        (pid, uid),
    )


@router.post("/api/personas/{pid}/voiceprint")
def enroll_voiceprint(pid: int, body: VoiceprintBody, uid: Uid):
    if not _own_persona(pid, uid):
        return fail(404, "人设不存在")
    try:
        import base64

        pcm = base64.b64decode(body.pcm_b64)
    except Exception:
        return fail(400, "pcm_b64 非法")
    if len(pcm) < 8000:  # < 0.25s @16k 视为无效
        return fail(400, "音频过短，请录制至少 1 秒")
    if len(pcm) > 30 * 16000 * 2:  # 上限 30s
        return fail(400, "音频过长（上限 30 秒）")

    from .voiceprint import get_voiceprint

    try:
        res = get_voiceprint().enroll(pcm, body.sample_rate)
    except Exception as e:
        return fail(500, f"声纹注册失败：{e}")

    db.execute(
        "UPDATE personas SET voiceprint_b64 = ?, voiceprint_backend = ?, voiceprint_enrolled_at = ? "
        "WHERE id = ?",
        (res["embedding_b64"], res["backend"], db.now(), pid),
    )
    return ok({"backend": res["backend"], "dims": res["dims"], "enrolledAt": db.now()})


@router.get("/api/personas/{pid}/voiceprint")
def get_voiceprint_status(pid: int, uid: Uid):
    row = _own_persona(pid, uid)
    if not row:
        return fail(404, "人设不存在")
    enrolled = bool(row.get("voiceprint_b64"))
    return ok({
        "enrolled": enrolled,
        "backend": row.get("voiceprint_backend") or None,
        "enrolledAt": row.get("voiceprint_enrolled_at") or None,
    })


@router.delete("/api/personas/{pid}/voiceprint")
def clear_voiceprint(pid: int, uid: Uid):
    if not _own_persona(pid, uid):
        return fail(404, "人设不存在")
    db.execute(
        "UPDATE personas SET voiceprint_b64 = '', voiceprint_backend = '', voiceprint_enrolled_at = NULL "
        "WHERE id = ?",
        (pid,),
    )
    return ok(True)


@router.get("/api/sessions")
def list_sessions(uid: Uid, page: int = 1, pageSize: int = 20):
    page = max(1, page)
    pageSize = min(50, max(1, pageSize))
    rows = db.query(
        """SELECT s.*, (SELECT COUNT(*) FROM suggestions g WHERE g.session_id = s.id) AS suggestion_count
           FROM sessions s WHERE s.user_id = ? AND s.deleted_at IS NULL
           ORDER BY s.id DESC LIMIT ? OFFSET ?""",
        (uid, pageSize, (page - 1) * pageSize),
    )
    return ok(rows)


@router.get("/api/sessions/{sid}/detail")
def session_detail(sid: int, uid: Uid):
    session = db.query_one("SELECT * FROM sessions WHERE id = ? AND user_id = ?", (sid, uid))
    if not session:
        return fail(404, "会话不存在")
    utterances = db.query("SELECT * FROM utterances WHERE session_id = ? ORDER BY seq ASC", (sid,))
    suggestions = db.query(
        "SELECT id, content, source, style, risk_level, latency_first_token_ms, latency_total_ms, created_at "
        "FROM suggestions WHERE session_id = ? ORDER BY id ASC",
        (sid,),
    )
    return ok({"session": session, "utterances": utterances, "suggestions": suggestions})


@router.get("/api/history/scripts")
def history_scripts(uid: Uid):
    rows = db.query(
        """SELECT g.id, g.content, g.source, g.style, g.created_at, se.id AS session_id
           FROM suggestions g JOIN sessions se ON se.id = g.session_id
           WHERE se.user_id = ? ORDER BY g.id DESC LIMIT 200""",
        (uid,),
    )
    return ok(rows)


@router.post("/api/suggestions/{sid}/feedback")
def suggestion_feedback(sid: int, body: dict, uid: Uid):
    own = db.query_one(
        "SELECT s.id FROM suggestions s JOIN sessions se ON se.id = s.session_id WHERE s.id = ? AND se.user_id = ?",
        (sid, uid),
    )
    if not own:
        return fail(404, "无权操作")
    action = (body or {}).get("action", "copy")
    db.execute(
        "INSERT INTO feedback (suggestion_id, user_id, action, created_at) VALUES (?,?,?,?)",
        (sid, uid, action, db.now()),
    )
    return ok(True)


@router.get("/api/usage/me")
def usage_me(uid: Uid):
    row = db.query_one(
        """SELECT COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
                  COALESCE(SUM(completion_tokens),0) AS completion_tokens,
                  COALESCE(SUM(cost_micros),0) AS cost_micros, COUNT(*) AS calls
           FROM suggestions g JOIN sessions se ON se.id = g.session_id WHERE se.user_id = ?""",
        (uid,),
    )
    return ok(row)
