/**
 * single-flight 控制：节流 + 文本去重 + 取消在途生成
 * 目的：防止 ASR 的 interim 抖动导致 LLM 被疯狂调用（成本与时延双重风险）
 */
import crypto from "node:crypto";
import { env } from "./env.js";

interface Inflight {
  genId: number;
  ac: AbortController;
  at: number;
}

const recent = new Map<string, number>(); // md5(归一化文本) -> ts

const normalize = (t: string) => t.replace(/[\s，。！？,.!?、啊呃嗯]/g, "");
const keyOf = (t: string) => crypto.createHash("md5").update(normalize(t)).digest("hex");

export function createSingleFlight() {
  let inflight: Inflight | null = null;
  let nextGenId = 1;

  return {
    nextGenId: () => nextGenId++,
    /**
     * 判定是否可以发起一次新的生成。可以则返回一个新的 AbortController。
     * 返回 go=false 时不调用 LLM（省成本 + 保持 UI 稳定）。
     */
    request(text: string): { go: boolean; reason?: string; genId: number; ac: AbortController | null } {
      const now = Date.now();
      const key = keyOf(text);

      // 1) 去重：短时间内重复文本
      const last = recent.get(key);
      if (last && now - last < env.GEN_DEDUP_MS) {
        return { go: false, reason: "dup", genId: 0, ac: null };
      }

      // 2) 节流：与上次的间隔不足
      if (inflight && now - inflight.at < env.GEN_MIN_INTERVAL_MS) {
        return { go: false, reason: "throttle", genId: 0, ac: null };
      }

      // 3) 取消在途请求（主播又说了新的一句话）
      if (inflight) inflight.ac.abort();

      recent.set(key, now);
      const ac = new AbortController();
      const genId = nextGenId++;
      inflight = { genId, ac, at: now };
      return { go: true, genId, ac };
    },

    abort() {
      if (inflight) inflight.ac.abort();
      inflight = null;
    },

    finish(genId: number) {
      if (inflight && inflight.genId === genId) inflight = null;
    },

    currentGenId: () => (inflight ? inflight.genId : 0),
  };
}
