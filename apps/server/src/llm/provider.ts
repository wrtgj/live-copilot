/**
 * LLM Provider（OpenAI 兼容协议，默认 DeepSeek）
 * 支持 mock 模式：CI / 无 Key 本地演示时使用，不产生任何费用。
 */
import OpenAI from "openai";
import { env } from "../env.js";

export interface StreamChunk {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmHandle {
  stream(
    system: string,
    user: string,
    onDelta: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<{ firstTokenMs: number; promptTokens: number; completionTokens: number }>;
  name(): string;
}

class MockLlm implements LlmHandle {
  name() {
    return "mock";
  }
  async stream(_s: string, user: string, onDelta: (c: string) => void) {
    await new Promise((r) => setTimeout(r, 260)); // 模拟首 token 延迟
    const reply = [
      "1) 宝子你问的这个点我给你说清楚，先别急着下结论。",
      "2) 这个问题问得好，咱先看看到底适不适合你再决定。",
      "3) 你要是信得过我，我给你一个最实在的建议。",
    ].join("\n");
    for (const ch of reply) {
      onDelta(ch);
      await new Promise((r) => setTimeout(r, 12));
    }
    return { firstTokenMs: 280, promptTokens: 320, completionTokens: 64 };
  }
}

class OpenAICompatLlm implements LlmHandle {
  private client: OpenAI;
  constructor() {
    this.client = new OpenAI({
      apiKey: env.LLM_API_KEY || "sk-empty",
      baseURL: env.LLM_BASE_URL,
      timeout: env.LLM_TIMEOUT_MS,
      maxRetries: 1,
    });
  }
  name() {
    return env.LLM_PROVIDER;
  }
  async stream(
    system: string,
    user: string,
    onDelta: (c: string) => void,
    signal?: AbortSignal
  ) {
    const t0 = Date.now();
    let firstTokenMs = 0;
    const stream = await this.client.chat.completions.create(
      {
        model: env.LLM_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: env.LLM_TEMPERATURE,
        top_p: env.LLM_TOP_P,
        max_tokens: env.LLM_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      } as never,
      { signal }
    );

    let promptTokens = 0;
    let completionTokens = 0;
    const iterable = stream as unknown as AsyncIterable<{
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>;
    for await (const part of iterable) {
      const delta = part.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        if (!firstTokenMs) firstTokenMs = Date.now() - t0;
        onDelta(delta);
      }
      const usage = (part as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      if (usage) {
        promptTokens = usage.prompt_tokens ?? 0;
        completionTokens = usage.completion_tokens ?? 0;
      }
    }
    return { firstTokenMs: firstTokenMs || Date.now() - t0, promptTokens, completionTokens };
  }
}

export function createLlm(): LlmHandle {
  if (!env.LLM_API_KEY || env.LLM_API_KEY.startsWith("sk-xxx")) {
    console.warn("[llm] 未配置 LLM_API_KEY，已降级为 mock 模式（演示可用，不产生费用）");
    return new MockLlm();
  }
  return new OpenAICompatLlm();
}
