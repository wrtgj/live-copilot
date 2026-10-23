/**
 * WebSocket 网关：把「转写文本 → 切片 → 生成 → 流式下发」串起来。
 * 关键机制：genId 单调递增，客户端只接受最新 genId 的 delta（解决取消竞态）。
 */
import type { WebSocket } from "ws";
import jwt from "jsonwebtoken";
import type { C2S, S2C, Speaker, Turn } from "../protocol.js";
import { db, now } from "../db.js";
import { env } from "../env.js";
import { createSlicer } from "../slicer.js";
import { createSingleFlight } from "../singleflight.js";
import { buildSystemPrompt, buildUserPrompt, parseCandidates, type PersonaBrief } from "../llm/prompt.js";
import { createLlm } from "../llm/provider.js";
import { matchTemplate } from "../templates.js";
import { detectRisk, safeRewrite } from "../guard/risk.js";

const llm = createLlm();

interface SessionCtx {
  userId: number;
  sessionId: number;
  persona: PersonaBrief;
  turns: Turn[];
  summary: string;
  seq: number;
  llmCalls: number;
  lastActiveAt: number;
  timer?: NodeJS.Timeout;
  generateEnabled: boolean;
}

const ctxs = new WeakMap<WebSocket, SessionCtx>();

const send = (ws: WebSocket, msg: S2C) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

export function handleConnection(ws: WebSocket) {
  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;
  const sf = createSingleFlight();

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
  };

  ws.on("message", async (raw) => {
    let msg: C2S;
    try {
      msg = JSON.parse(String(raw)) as C2S;
    } catch {
      return send(ws, { t: "error", code: "BAD_JSON", message: "非法消息格式", retryable: false });
    }

    const ctx = ctxs.get(ws);
    ctx && (ctx.lastActiveAt = Date.now());

    switch (msg.t) {
      case "hello": {
        const auth = verifyToken(msg.token);
        if (!auth) return send(ws, { t: "error", code: "UNAUTHORIZED", message: "登录已失效", retryable: false });

        const persona = loadPersona(auth.userId, msg.personaId);
        const sessionId = msg.sessionId ?? createSession(auth.userId, msg.personaId);

        const c: SessionCtx = {
          userId: auth.userId,
          sessionId,
          persona,
          turns: [],
          summary: "",
          seq: 0,
          llmCalls: 0,
          lastActiveAt: Date.now(),
          generateEnabled: env.FEATURE_GENERATE,
        };
        ctxs.set(ws, c);

        const slicer = createSlicer({}, (text, reason) => {
          void generate(ws, c, sf, text, reason);
        });

        send(ws, {
          t: "status",
          state: "ready",
          asrProvider: "client-webspeech",
          llmProvider: llm.name(),
          sessionId,
          generateEnabled: c.generateEnabled,
        });

        heartbeat = setInterval(() => {
          const cc = ctxs.get(ws);
          if (!cc) return;
          if (Date.now() - cc.lastActiveAt > env.WS_TIMEOUT_MS) {
            send(ws, { t: "error", code: "HEARTBEAT_TIMEOUT", message: "心跳超时", retryable: true });
            ws.close(1011, "heartbeat timeout");
          }
        }, env.WS_HEARTBEAT_MS);

        // 保存 slicer 到 socket 上，供 asr_text 使用
        (ws as unknown as { __slicer?: ReturnType<typeof createSlicer> }).__slicer = slicer;
        break;
      }

      case "asr_text": {
        if (!ctx) return;
        const slicer = (ws as unknown as { __slicer?: ReturnType<typeof createSlicer> }).__slicer;
        saveUtterance(ctx, msg.text, msg.isFinal, msg.speaker);
        if (msg.speaker === "peer") {
          ctx.turns.push({ speaker: "peer", text: msg.text });
          slicer?.push(msg.text, msg.isFinal);
        }
        send(ws, {
          t: "transcript",
          id: msg.id,
          speaker: msg.speaker,
          text: msg.text,
          isFinal: msg.isFinal,
          at: Date.now(),
        });
        break;
      }

      case "control": {
        if (!ctx && msg.op !== "ping") return;
        if (msg.op === "ping") return send(ws, { t: "pong", ts: Date.now() });
        if (msg.op === "cancel") return sf.abort();
        if (msg.op === "stop") {
          endSession(ctx!);
          return send(ws, { t: "status", state: "ready", asrProvider: "client-webspeech", llmProvider: llm.name(), sessionId: ctx!.sessionId, generateEnabled: ctx!.generateEnabled });
        }
        if (msg.op === "start") {
          return send(ws, { t: "status", state: "listening", asrProvider: "client-webspeech", llmProvider: llm.name(), sessionId: ctx!.sessionId, generateEnabled: ctx!.generateEnabled });
        }
        if (msg.op === "regenerate") {
          const last = [...ctx!.turns].reverse().find((t) => t.speaker === "peer");
          if (last) void generate(ws, ctx!, sf, last.text, "asr_final", true);
        }
        break;
      }

      case "feedback": {
        if (!ctx) return;
        const own = db
          .prepare(
            `SELECT s.id FROM suggestions s JOIN sessions se ON se.id = s.session_id
             WHERE s.id = ? AND se.user_id = ?`
          )
          .get(msg.suggestionId, ctx.userId) as { id: number } | undefined;
        if (!own) return send(ws, { t: "error", code: "FORBIDDEN", message: "无权操作", retryable: false });
        db.prepare(
          "INSERT INTO feedback (suggestion_id, user_id, action, created_at) VALUES (?,?,?,?)"
        ).run(msg.suggestionId, ctx.userId, msg.action, now());
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    closed = true;
    cleanup();
    const c = ctxs.get(ws);
    if (c) endSession(c);
  });

  ws.on("error", cleanup);
}

/** 核心：一次话术生成（含合规过滤与降级） */
async function generate(
  ws: WebSocket,
  c: SessionCtx,
  sf: ReturnType<typeof createSingleFlight>,
  text: string,
  reason: string,
  force = false
) {
  if (!c.generateEnabled) {
    return send(ws, {
      t: "suggestion",
      genId: 0,
      index: 0,
      phase: "done",
      source: "template",
      blocked: true,
      reason: "生成能力已被运维关闭（降级为仅转写）",
    });
  }

  const quotaExceeded = c.llmCalls >= env.MAX_LLM_CALLS_PER_SESSION;
  if (quotaExceeded) {
    return emitTemplates(ws, c, sf, text);
  }

  const req = sf.request(text);
  if (!req.go && !force) return; // 去重 / 节流命中：不调用 LLM

  const genId = req.genId;
  const ac = req.ac!;
  const t0 = Date.now();

  send(ws, { t: "suggestion", genId, index: 0, phase: "start", source: "llm" });

  try {
    const system = buildSystemPrompt(c.persona);
    const user = buildUserPrompt(text, c.turns.slice(-8, -1), c.summary);

    let buffer = "";
    let firstTokenMs = 0;
    let usage = { promptTokens: 0, completionTokens: 0 };

    usage = await llm.stream(
      system,
      user,
      (chunk) => {
        if (ac.signal.aborted) return;
        buffer += chunk;
        if (!firstTokenMs) {
          firstTokenMs = Date.now() - t0;
          send(ws, { t: "suggestion", genId, index: 0, phase: "delta", text: "", source: "llm", latencyFirstTokenMs: firstTokenMs });
        }
        send(ws, { t: "suggestion", genId, index: 0, phase: "delta", text: chunk, source: "llm" });
      },
      ac.signal
    );

    if (ac.signal.aborted) {
      send(ws, { t: "suggestion", genId, index: 0, phase: "abort", source: "llm" });
      return;
    }

    c.llmCalls++;
    const totalMs = Date.now() - t0;

    // ==== 合规第二层：输出拦截 ====
    const candidates = parseCandidates(buffer);
    const kept: Array<{ text: string; level: number }> = [];

    for (const raw of candidates) {
      const { level, hits } = detectRisk(raw, c.persona.forbiddenWords);
      if (level === 0) {
        kept.push({ text: raw, level: 0 });
      } else {
        const fixed = safeRewrite(raw, hits);
        if (fixed) {
          const re = detectRisk(fixed, c.persona.forbiddenWords);
          if (re.level === 0) kept.push({ text: fixed, level: 1 }); // 已做安全替换
        }
        // level===2 或无法安全替换 -> 丢弃
      }
      if (kept.length >= 3) break;
    }

    if (kept.length === 0) {
      // 全部被拦截 -> 降级模板
      send(ws, { t: "suggestion", genId, index: 0, phase: "abort", source: "llm", reason: "content_blocked" });
      return emitTemplates(ws, c, sf, text);
    }

    const utteranceId = lastUtteranceId(c.sessionId);
    for (let i = 0; i < kept.length; i++) {
      db.prepare(
        `INSERT INTO suggestions
         (session_id, utterance_id, seq, model, source, content, style, status, risk_level, prompt_tokens, completion_tokens, cost_micros, latency_first_token_ms, latency_total_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        c.sessionId,
        utteranceId,
        i,
        env.LLM_MODEL,
        "llm",
        kept[i].text,
        c.persona.style,
        "done",
        kept[i].level,
        usage.promptTokens,
        usage.completionTokens,
        Math.round((usage.promptTokens * 2 + usage.completionTokens * 8) * 1000),
        firstTokenMs,
        totalMs,
        now()
      );
    }

    send(ws, {
      t: "suggestion",
      genId,
      index: 0,
      phase: "done",
      source: "llm",
      text: JSON.stringify(kept.map((k) => k.text)),
      latencyFirstTokenMs: firstTokenMs,
    });
    send(ws, {
      t: "usage",
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costMicros: Math.round((usage.promptTokens * 2 + usage.completionTokens * 8) * 1000),
    });

    // 上下文滚动：超过 20 轮截断，避免 prompt 无限膨胀
    if (c.turns.length > 20) c.turns = c.turns.slice(-10);
  } catch (e) {
    if (ac.signal.aborted) return;
    console.error("[generate] failed", e);
    send(ws, { t: "error", code: "LLM_FAILED", message: "AI 生成失败，已切模板兜底", retryable: true });
    emitTemplates(ws, c, sf, text);
  } finally {
    sf.finish(genId);
  }
}

function emitTemplates(ws: WebSocket, c: SessionCtx, sf: ReturnType<typeof createSingleFlight>, text: string) {
  const { scripts } = matchTemplate(text);
  const genId = sf.nextGenId();
  send(ws, { t: "suggestion", genId, index: 0, phase: "start", source: "template" });
  send(ws, {
    t: "suggestion",
    genId,
    index: 0,
    phase: "done",
    source: "template",
    text: JSON.stringify(scripts),
  });
}

// ===== 数据与鉴权辅助 =====

function verifyToken(token: string): { userId: number } | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { uid: number };
    return { userId: payload.uid };
  } catch {
    return null;
  }
}

function loadPersona(userId: number, personaId?: number): PersonaBrief {
  const row = (
    personaId
      ? db.prepare("SELECT * FROM personas WHERE id = ? AND user_id = ? AND deleted_at IS NULL").get(personaId, userId)
      : db.prepare("SELECT * FROM personas WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, id DESC LIMIT 1").get(userId)
  ) as Record<string, unknown> | undefined;

  if (!row) {
    return { name: "默认主播", scene: "live", style: "gentle", tone: "轻快", category: "综合", forbiddenWords: ["最好", "第一"] };
  }
  let banned: string[] = [];
  try {
    banned = JSON.parse(String(row.forbidden_words ?? "[]"));
  } catch {
    banned = [];
  }
  return {
    name: String(row.name ?? "主播"),
    scene: String(row.scene ?? "live"),
    style: String(row.style ?? "gentle"),
    tone: String(row.tone ?? ""),
    category: String(row.category ?? ""),
    forbiddenWords: banned,
  };
}

function createSession(userId: number, personaId?: number): number {
  const r = db
    .prepare("INSERT INTO sessions (user_id, persona_id, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(userId, personaId ?? null, "active", now(), now(), now());
  return Number(r.lastInsertRowid);
}

function endSession(c: SessionCtx) {
  try {
    db.prepare("UPDATE sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), c.sessionId);
  } catch {
    /* ignore */
  }
}

function saveUtterance(c: SessionCtx, text: string, isFinal: boolean, speaker: Speaker) {
  if (!text) return;
  c.seq++;
  db.prepare(
    "INSERT INTO utterances (session_id, seq, speaker, text, asr_provider, is_final, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(c.sessionId, c.seq, speaker, text, "webspeech", isFinal ? 1 : 0, now());
}

function lastUtteranceId(sessionId: number): number | null {
  const r = db.prepare("SELECT id FROM utterances WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as
    | { id: number }
    | undefined;
  return r ? r.id : null;
}
