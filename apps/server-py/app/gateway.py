"""WebSocket 网关：把「转写文本 -> 切片 -> 生成 -> 流式下发」串起来。

关键机制：genId 单调递增，客户端只接受最新 genId 的 delta（解决取消竞态）。
"""
import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from . import db
from .auth import verify_token
from .config import env
from .llm import create_llm
from .prompt import (
    Turn,
    PersonaBrief,
    build_system_prompt,
    build_user_prompt,
    parse_candidates,
)
from .risk import detect_risk, safe_rewrite
from .slicer import create_slicer
from .singleflight import SingleFlight
from .templates import match_template
from .voiceprint import get_voiceprint

llm = create_llm()


@dataclass
class ConnState:
    ws: WebSocket | None = None
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    uid: int = 0
    session_id: int = 0
    persona: PersonaBrief | None = None
    turns: list[Turn] = field(default_factory=list)
    summary: str = ""
    seq: int = 0
    llm_calls: int = 0
    last_active_at: float = 0.0
    generate_enabled: bool = True
    slicer = None
    sf: SingleFlight = field(default_factory=SingleFlight)
    loop: asyncio.AbstractEventLoop | None = None
    vp_enrolled: str | None = None          # 已注册声纹的 base64 嵌入
    vp_host_score: float = 0.0               # 当前说话人是主播的概率（平滑后）


def _make_on_flush(state: ConnState):
    async def on_flush(text: str, reason: str):
        go, _, gen_id = state.sf.request(text)
        if not go:
            return
        task = asyncio.ensure_future(_generate(state, gen_id, text, reason, False))
        state.sf.bind(gen_id, task)

    return on_flush


async def _send(state: ConnState, msg: dict[str, Any]) -> None:
    async with state.send_lock:
        try:
            if state.ws is not None:
                await state.ws.send_json(msg)
        except Exception:
            pass


async def _heartbeat(state: ConnState) -> None:
    while True:
        await asyncio.sleep(env.WS_HEARTBEAT_MS / 1000.0)
        if state.ws is None:
            return
        if time.time() * 1000 - state.last_active_at > env.WS_TIMEOUT_MS:
            await _send(state, {"t": "error", "code": "HEARTBEAT_TIMEOUT",
                                "message": "心跳超时", "retryable": True})
            try:
                await state.ws.close(code=1011, reason="heartbeat timeout")
            except Exception:
                pass
            return


# ===== 数据与鉴权辅助 =====
def load_persona(uid: int, persona_id: int | None) -> PersonaBrief:
    if persona_id:
        row = db.query_one(
            "SELECT * FROM personas WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
            (persona_id, uid),
        )
    else:
        row = db.query_one(
            "SELECT * FROM personas WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, id DESC LIMIT 1",
            (uid,),
        )
    if not row:
        return PersonaBrief(name="默认主播", scene="live", style="gentle",
                            tone="轻快", category="综合", forbidden_words=["最好", "第一"])
    try:
        banned = json.loads(row.get("forbidden_words") or "[]")
    except (json.JSONDecodeError, TypeError):
        banned = []
    return PersonaBrief(
        name=str(row.get("name", "主播")),
        scene=str(row.get("scene", "live")),
        style=str(row.get("style", "gentle")),
        tone=str(row.get("tone", "")),
        category=str(row.get("category", "")),
        forbidden_words=banned if isinstance(banned, list) else [],
    )


def create_session(uid: int, persona_id: int | None) -> int:
    cur = db.execute(
        "INSERT INTO sessions (user_id, persona_id, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        (uid, persona_id, "active", db.now(), db.now(), db.now()),
    )
    return db.last_insert_id(cur)


def end_session(state: ConnState) -> None:
    try:
        db.execute(
            "UPDATE sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ?",
            (db.now(), db.now(), state.session_id),
        )
    except Exception:
        pass


def save_utterance(state: ConnState, text: str, is_final: bool, speaker: str) -> None:
    if not text:
        return
    state.seq += 1
    db.execute(
        "INSERT INTO utterances (session_id, seq, speaker, text, asr_provider, is_final, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (state.session_id, state.seq, speaker, text, "webspeech", 1 if is_final else 0, db.now()),
    )


def last_utterance_id(session_id: int) -> int | None:
    row = db.query_one("SELECT id FROM utterances WHERE session_id = ? ORDER BY id DESC LIMIT 1", (session_id,))
    return int(row["id"]) if row else None


# ===== 生成核心 =====
async def _generate(state: ConnState, gen_id: int, text: str, reason: str, force: bool) -> None:
    if not state.generate_enabled:
        await _send(state, {"t": "suggestion", "genId": 0, "index": 0, "phase": "done",
                           "source": "template", "blocked": True,
                           "reason": "生成能力已被运维关闭（降级为仅转写）"})
        return

    if state.llm_calls >= env.MAX_LLM_CALLS_PER_SESSION:
        await _emit_templates(state, text)
        return

    await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                       "phase": "start", "source": "llm"})

    t0 = time.time() * 1000
    buffer = ""
    first_ms = 0
    prompt_tokens = 0
    completion_tokens = 0

    async def on_delta(chunk: str) -> None:
        nonlocal buffer, first_ms
        if not chunk:
            return
        buffer += chunk
        if first_ms == 0:
            first_ms = int(time.time() * 1000 - t0)
            await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                                "phase": "delta", "text": "", "source": "llm",
                                "latencyFirstTokenMs": first_ms})
        await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                            "phase": "delta", "text": chunk, "source": "llm"})

    try:
        system = build_system_prompt(state.persona)
        user = build_user_prompt(text, state.turns[-8:-1], state.summary)
        prompt_tokens, completion_tokens = await llm.stream(system, user, on_delta)

        # 合规第二层：输出拦截
        candidates = parse_candidates(buffer)
        kept: list[tuple[str, int]] = []
        for raw in candidates:
            level, hits = detect_risk(raw, state.persona.forbidden_words)
            if level == 0:
                kept.append((raw, 0))
            else:
                fixed = safe_rewrite(raw, hits)
                if fixed is not None:
                    re_level, _ = detect_risk(fixed, state.persona.forbidden_words)
                    if re_level == 0:
                        kept.append((fixed, 1))
            if len(kept) >= 3:
                break

        if not kept:
            await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                                "phase": "abort", "source": "llm", "reason": "content_blocked"})
            await _emit_templates(state, text)
            return

        state.llm_calls += 1
        total_ms = int(time.time() * 1000 - t0)
        cost = (prompt_tokens * 2 + completion_tokens * 8) * 1000

        utt_id = last_utterance_id(state.session_id)
        for i, (c_text, c_level) in enumerate(kept):
            db.execute(
                """INSERT INTO suggestions
                   (session_id, utterance_id, seq, model, source, content, style, status, risk_level,
                    prompt_tokens, completion_tokens, cost_micros, latency_first_token_ms, latency_total_ms, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (state.session_id, utt_id, i, env.LLM_MODEL, "llm", c_text,
                 state.persona.style, "done", c_level, prompt_tokens, completion_tokens,
                 int(cost), first_ms, total_ms, db.now()),
            )

        await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                            "phase": "done", "source": "llm",
                            "text": json.dumps([k[0] for k in kept]),
                            "latencyFirstTokenMs": first_ms})
        await _send(state, {"t": "usage", "promptTokens": prompt_tokens,
                            "completionTokens": completion_tokens, "costMicros": int(cost)})

        if len(state.turns) > 20:
            state.turns = state.turns[-10:]
    except asyncio.CancelledError:
        await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                            "phase": "abort", "source": "llm"})
        return
    except Exception as e:
        print("[generate] failed:", repr(e))
        await _send(state, {"t": "error", "code": "LLM_FAILED",
                            "message": "AI 生成失败，已切模板兜底", "retryable": True})
        await _emit_templates(state, text)
    finally:
        state.sf.finish(gen_id)


async def _emit_templates(state: ConnState, text: str) -> None:
    scripts = match_template(text)["scripts"]
    gen_id = state.sf.reserve()
    await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                        "phase": "start", "source": "template"})
    await _send(state, {"t": "suggestion", "genId": gen_id, "index": 0,
                        "phase": "done", "source": "template",
                        "text": json.dumps(scripts)})


# ===== 连接入口 =====
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    state = ConnState()
    state.ws = websocket
    state.loop = asyncio.get_running_loop()
    state.last_active_at = time.time() * 1000
    heartbeat_task: asyncio.Task | None = None

    try:
        while True:
            raw = await websocket.receive_text()
            state.last_active_at = time.time() * 1000
            try:
                msg = json.loads(raw)
            except Exception:
                await _send(state, {"t": "error", "code": "BAD_JSON",
                                    "message": "非法消息格式", "retryable": False})
                continue

            t = msg.get("t")

            if t == "hello":
                auth = verify_token(msg.get("token"))
                if not auth:
                    await _send(state, {"t": "error", "code": "UNAUTHORIZED",
                                        "message": "登录已失效", "retryable": False})
                    continue
                state.uid = auth
                state.persona = load_persona(auth, msg.get("personaId"))
                state.session_id = msg.get("sessionId") or create_session(auth, msg.get("personaId"))
                state.generate_enabled = env.FEATURE_GENERATE
                state.slicer = create_slicer({}, _make_on_flush(state), state.loop)

                # 载入该人设已注册的声纹（用于主播/对方分离）
                row = db.query_one(
                    "SELECT voiceprint_b64 FROM personas WHERE id = ?",
                    (msg.get("personaId"),),
                ) if msg.get("personaId") else None
                if row and row.get("voiceprint_b64"):
                    state.vp_enrolled = row["voiceprint_b64"]

                await _send(state, {"t": "status", "state": "ready",
                                    "asrProvider": "client-webspeech", "llmProvider": llm.name(),
                                    "sessionId": state.session_id,
                                    "generateEnabled": state.generate_enabled,
                                    "voiceprintActive": state.vp_enrolled is not None})
                heartbeat_task = asyncio.create_task(_heartbeat(state))

            elif t == "asr_text":
                if state.persona is None:
                    continue
                text = str(msg.get("text", ""))
                # 若有声纹：按当前 host 概率动态判定说话人；否则沿用客户端上报/默认 peer
                if state.vp_enrolled is not None:
                    speaker = "host" if state.vp_host_score >= env.VOICEPRINT_HOST_THRESHOLD else "peer"
                else:
                    speaker = str(msg.get("speaker", "peer"))
                save_utterance(state, text, bool(msg.get("isFinal")), speaker)
                if speaker == "peer":
                    state.turns.append(Turn(speaker="peer", text=text))
                    if state.slicer is not None:
                        state.slicer.push(text, bool(msg.get("isFinal")))
                await _send(state, {"t": "transcript", "id": str(msg.get("id", "")),
                                    "speaker": speaker, "text": text,
                                    "isFinal": bool(msg.get("isFinal")), "at": int(time.time() * 1000)})

            elif t == "audio":
                # 声纹鉴别：客户端定期把主播麦克风 PCM 发来，判定当前是否为主播本人在说话
                if state.vp_enrolled is None:
                    continue
                b64 = str(msg.get("pcmB64", ""))
                if not b64:
                    continue
                try:
                    import base64

                    pcm = base64.b64decode(b64)
                except Exception:
                    continue
                try:
                    res = get_voiceprint().verify(pcm, int(msg.get("sampleRate", 16000)), state.vp_enrolled)
                except Exception as e:  # pragma: no cover
                    print("[voiceprint] verify failed:", repr(e))
                    continue
                # 时间平滑：新分数权重更高以便快速生效，同时抑制单帧抖动
                state.vp_host_score = 0.4 * state.vp_host_score + 0.6 * float(res.get("score", 0.0))
                await _send(state, {"t": "voiceprint",
                                    "isHost": state.vp_host_score >= env.VOICEPRINT_HOST_THRESHOLD,
                                    "score": round(state.vp_host_score, 4),
                                    "backend": res.get("backend", ""),
                                    "threshold": env.VOICEPRINT_HOST_THRESHOLD})

            elif t == "control":
                op = msg.get("op")
                if op == "ping":
                    await _send(state, {"t": "pong", "ts": int(time.time() * 1000)})
                elif op == "cancel":
                    state.sf.abort()
                elif op == "stop":
                    end_session(state)
                    await _send(state, {"t": "status", "state": "ready",
                                        "asrProvider": "client-webspeech", "llmProvider": llm.name(),
                                        "sessionId": state.session_id,
                                        "generateEnabled": state.generate_enabled})
                elif op == "start":
                    await _send(state, {"t": "status", "state": "listening",
                                        "asrProvider": "client-webspeech", "llmProvider": llm.name(),
                                        "sessionId": state.session_id,
                                        "generateEnabled": state.generate_enabled})
                elif op == "regenerate":
                    last = next((x for x in reversed(state.turns) if x.speaker == "peer"), None)
                    if last:
                        state.sf.abort()
                        gen_id = state.sf.reserve()
                        task = asyncio.ensure_future(_generate(state, gen_id, last.text, "asr_final", True))
                        state.sf.bind(gen_id, task)

            elif t == "feedback":
                sid = int(msg.get("suggestionId", 0))
                own = db.query_one(
                    "SELECT s.id FROM suggestions s JOIN sessions se ON se.id = s.session_id "
                    "WHERE s.id = ? AND se.user_id = ?",
                    (sid, state.uid),
                )
                if not own:
                    await _send(state, {"t": "error", "code": "FORBIDDEN",
                                        "message": "无权操作", "retryable": False})
                    continue
                db.execute(
                    "INSERT INTO feedback (suggestion_id, user_id, action, created_at) VALUES (?,?,?,?)",
                    (sid, state.uid, str(msg.get("action", "copy")), db.now()),
                )

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print("[ws] connection error:", repr(e))
    finally:
        if heartbeat_task is not None:
            heartbeat_task.cancel()
        state.sf.abort()
        if state.persona is not None:
            end_session(state)
