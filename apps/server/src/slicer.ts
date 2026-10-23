/**
 * 语义切片器：从连续的 ASR 输出里切出"完整的一句话"，再送去生成。
 * 三重触发：1) ASR final 强切  2) 语气词收尾+静音尾  3) 超时强切
 */
import { env } from "./env.js";

const TAIL = /(吧|呢|吗|啊|哦|嘛|对不对|是不是|行不行|多少钱|怎么卖|行不行|可以吗|好不好|真的假的)[，。！？,.!?]?$/;

export interface SlicerConfig {
  silenceMs: number;
  maxPendingMs: number;
  minChars: number;
}

type FlushReason = "asr_final" | "tail_word" | "silence" | "timeout" | "reset";

export function createSlicer(
  cfg: Partial<SlicerConfig> = {},
  onFlush: (text: string, reason: FlushReason) => void
) {
  const c: SlicerConfig = {
    silenceMs: cfg.silenceMs ?? env.SLICER_SILENCE_MS,
    maxPendingMs: cfg.maxPendingMs ?? env.SLICER_MAX_PENDING_MS,
    minChars: cfg.minChars ?? env.SLICER_MIN_CHARS,
  };

  let buf = "";
  let startedAt = 0;
  let timer: NodeJS.Timeout | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (reason: FlushReason) => {
    clear();
    const text = buf.trim();
    buf = "";
    startedAt = 0;
    if (text.length >= c.minChars) onFlush(text, reason);
  };

  return {
    push(text: string, isFinal: boolean) {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!startedAt) startedAt = Date.now();

      const changed = trimmed !== buf;
      buf = trimmed;

      // VAD 门控：静音期不触发生成
      clear();
      timer = setTimeout(() => flush("silence"), c.silenceMs);

      if (isFinal) return flush("asr_final");
      if (changed && buf.length >= c.minChars && TAIL.test(buf)) return flush("tail_word");
      if (Date.now() - startedAt >= c.maxPendingMs) return flush("timeout");
    },
    reset() {
      clear();
      buf = "";
      startedAt = 0;
    },
  };
}
