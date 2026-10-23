import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";

// 依次尝试根目录与 server 目录的 .env
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
];
for (const c of candidates) {
  if (fs.existsSync(c)) {
    dotenv.config({ path: c });
    break;
  }
}

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
const bool = (v: string | undefined, d: boolean) =>
  v === undefined ? d : v.toLowerCase() === "on" || v === "true" || v === "1";

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: num(process.env.PORT, 8787),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  JWT_SECRET: process.env.JWT_SECRET ?? "dev-secret-change-me",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "2h",

  DATABASE_URL: process.env.DATABASE_URL ?? "./data/app.db",

  LLM_PROVIDER: process.env.LLM_PROVIDER ?? "deepseek",
  LLM_BASE_URL: process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1",
  LLM_API_KEY: process.env.LLM_API_KEY ?? "",
  LLM_MODEL: process.env.LLM_MODEL ?? "deepseek-chat",
  LLM_TEMPERATURE: num(process.env.LLM_TEMPERATURE, 0.8),
  LLM_MAX_TOKENS: num(process.env.LLM_MAX_TOKENS, 120),
  LLM_TOP_P: num(process.env.LLM_TOP_P, 0.95),
  LLM_TIMEOUT_MS: num(process.env.LLM_TIMEOUT_MS, 8000),

  SLICER_SILENCE_MS: num(process.env.SLICER_SILENCE_MS, 350),
  SLICER_MAX_PENDING_MS: num(process.env.SLICER_MAX_PENDING_MS, 2500),
  SLICER_MIN_CHARS: num(process.env.SLICER_MIN_CHARS, 4),
  GEN_MIN_INTERVAL_MS: num(process.env.GEN_MIN_INTERVAL_MS, 1200),
  GEN_DEDUP_MS: num(process.env.GEN_DEDUP_MS, 3000),

  WS_HEARTBEAT_MS: num(process.env.WS_HEARTBEAT_MS, 15000),
  WS_TIMEOUT_MS: num(process.env.WS_TIMEOUT_MS, 45000),

  FEATURE_GENERATE: bool(process.env.FEATURE_GENERATE, true),
  MAX_LLM_CALLS_PER_SESSION: num(process.env.MAX_LLM_CALLS_PER_SESSION, 400),
};

export type Env = typeof env;
