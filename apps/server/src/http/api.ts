import type { Express, Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db, now } from "../db.js";
import { env } from "../env.js";

interface AuthRequest extends Request {
  uid?: number;
}

export function authGuard(req: AuthRequest, res: Response, next: NextFunction) {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ code: 401, message: "未登录", data: null });
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { uid: number };
    req.uid = payload.uid;
    next();
  } catch {
    return res.status(401).json({ code: 401, message: "登录已失效", data: null });
  }
}

const ok = (res: Response, data: unknown) => res.json({ code: 0, message: "ok", data });
const fail = (res: Response, code: number, message: string) => res.status(code).json({ code, message, data: null });

// 简易注册源限流（防刷）
const buckets = new Map<string, { n: number; t: number }>();
function rateLimit(key: string, limit: number, windowMs: number) {
  const b = buckets.get(key);
  const nowMs = Date.now();
  if (!b || nowMs - b.t > windowMs) {
    buckets.set(key, { n: 1, t: nowMs });
    return true;
  }
  b.n++;
  return b.n <= limit;
}

export function registerRoutes(app: Express) {
  app.get("/healthz", (_req, res) => {
    ok(res, { status: "ok", time: now(), generate: env.FEATURE_GENERATE, llm: env.LLM_PROVIDER });
  });

  app.post("/api/auth/register", (req: AuthRequest, res) => {
    const { email, password, nickname } = req.body ?? {};
    if (!email || !password) return fail(res, 400, "邮箱和密码必填");
    if (String(password).length < 6) return fail(res, 400, "密码至少 6 位");
    if (!rateLimit(`reg:${req.ip}`, 5, 60_000)) return fail(res, 429, "注册过于频繁，请稍后再试");

    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) return fail(res, 409, "该邮箱已注册");

    const hash = bcrypt.hashSync(String(password), 10);
    const r = db
      .prepare(
        "INSERT INTO users (email, password_hash, nickname, created_at, updated_at) VALUES (?,?,?,?,?)"
      )
      .run(email, hash, nickname ?? "", now(), now());
    const uid = Number(r.lastInsertRowid);
    seedDefaultPersona(uid);
    const token = jwt.sign({ uid }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
    ok(res, { token, userId: uid });
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body ?? {};
    if (!rateLimit(`login:${req.ip}`, 20, 60_000)) return fail(res, 429, "尝试过于频繁");
    const row = db.prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(email) as
      | Record<string, unknown>
      | undefined;
    if (!row) return fail(res, 401, "账号或密码错误");
    if (!bcrypt.compareSync(String(password), String(row.password_hash))) {
      return fail(res, 401, "账号或密码错误");
    }
    const token = jwt.sign({ uid: Number(row.id) }, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN,
    } as jwt.SignOptions);
    ok(res, { token, userId: Number(row.id), nickname: row.nickname ?? "" });
  });

  app.get("/api/auth/me", authGuard, (req: AuthRequest, res) => {
    const row = db.prepare("SELECT id, email, nickname, plan FROM users WHERE id = ?").get(req.uid!);
    ok(res, row);
  });

  // ---- 人设 CRUD ----
  app.get("/api/personas", authGuard, (req: AuthRequest, res) => {
    const rows = db
      .prepare("SELECT * FROM personas WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, id DESC")
      .all(req.uid!);
    ok(res, rows.map(mapPersona));
  });

  app.post("/api/personas", authGuard, (req: AuthRequest, res) => {
    const b = req.body ?? {};
    if (!b.name) return fail(res, 400, "人设名称必填");
    const r = db
      .prepare(
        `INSERT INTO personas (user_id, name, scene, style, tone, category, forbidden_words, is_default, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        req.uid!,
        String(b.name),
        String(b.scene ?? "live"),
        String(b.style ?? "gentle"),
        String(b.tone ?? ""),
        String(b.category ?? ""),
        JSON.stringify(Array.isArray(b.forbiddenWords) ? b.forbiddenWords : []),
        b.isDefault ? 1 : 0,
        "active",
        now(),
        now()
      );
    ok(res, { id: Number(r.lastInsertRowid) });
  });

  app.delete("/api/personas/:id", authGuard, (req: AuthRequest, res) => {
    db.prepare("UPDATE personas SET deleted_at = ? WHERE id = ? AND user_id = ?").run(now(), Number(req.params.id), req.uid!);
    ok(res, true);
  });

  // ---- 会话与历史 ----
  app.get("/api/sessions", authGuard, (req: AuthRequest, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(50, Number(req.query.pageSize ?? 20));
    const rows = db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM suggestions g WHERE g.session_id = s.id) AS suggestion_count
         FROM sessions s WHERE s.user_id = ? AND s.deleted_at IS NULL
         ORDER BY s.id DESC LIMIT ? OFFSET ?`
      )
      .all(req.uid!, pageSize, (page - 1) * pageSize);
    ok(res, rows);
  });

  app.get("/api/sessions/:id/detail", authGuard, (req: AuthRequest, res) => {
    const sid = Number(req.params.id);
    const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ?").get(sid, req.uid!);
    if (!session) return fail(res, 404, "会话不存在");
    const utterances = db.prepare("SELECT * FROM utterances WHERE session_id = ? ORDER BY seq ASC").all(sid);
    const suggestions = db
      .prepare("SELECT id, content, source, style, risk_level, latency_first_token_ms, latency_total_ms, created_at FROM suggestions WHERE session_id = ? ORDER BY id ASC")
      .all(sid);
    ok(res, { session, utterances, suggestions });
  });

  app.get("/api/history/scripts", authGuard, (req: AuthRequest, res) => {
    const rows = db
      .prepare(
        `SELECT g.id, g.content, g.source, g.style, g.created_at, se.id AS session_id
         FROM suggestions g JOIN sessions se ON se.id = g.session_id
         WHERE se.user_id = ? ORDER BY g.id DESC LIMIT 200`
      )
      .all(req.uid!);
    ok(res, rows);
  });

  app.post("/api/suggestions/:id/feedback", authGuard, (req: AuthRequest, res) => {
    const sid = Number(req.params.id);
    const own = db
      .prepare("SELECT s.id FROM suggestions s JOIN sessions se ON se.id = s.session_id WHERE s.id = ? AND se.user_id = ?")
      .get(sid, req.uid!);
    if (!own) return fail(res, 404, "无权操作");
    db.prepare("INSERT INTO feedback (suggestion_id, user_id, action, created_at) VALUES (?,?,?,?)").run(
      sid,
      req.uid!,
      String(req.body?.action ?? "copy"),
      now()
    );
    ok(res, true);
  });

  app.get("/api/usage/me", authGuard, (req: AuthRequest, res) => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens),0) AS completion_tokens,
                COALESCE(SUM(cost_micros),0) AS cost_micros, COUNT(*) AS calls
         FROM suggestions g JOIN sessions se ON se.id = g.session_id WHERE se.user_id = ?`
      )
      .get(req.uid!);
    ok(res, row);
  });
}

function mapPersona(r: unknown) {
  const row = r as Record<string, unknown>;
  let forbiddenWords: string[] = [];
  try {
    forbiddenWords = JSON.parse(String(row.forbidden_words ?? "[]"));
  } catch {
    forbiddenWords = [];
  }
  return { ...row, forbiddenWords };
}

function seedDefaultPersona(userId: number) {
  db.prepare(
    `INSERT INTO personas (user_id, name, scene, style, tone, category, forbidden_words, is_default, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    userId,
    "亲和逼单（预设）",
    "sales",
    "push",
    "轻快有能量",
    "综合带货",
    JSON.stringify(["最好", "第一", "根治"]),
    1,
    "active",
    now(),
    now()
  );
}
