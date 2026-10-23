// 前端 WS 协议定义（与 apps/server/src/protocol.ts 保持一致）

export type Speaker = "peer" | "host";
export type GenSource = "llm" | "template";
export type GenPhase = "start" | "delta" | "done" | "abort";

export type C2S =
  | { t: "hello"; token: string; personaId: number; sessionId?: number }
  | { t: "asr_text"; id: string; text: string; isFinal: boolean; speaker: Speaker }
  | { t: "audio"; pcmB64: string; sampleRate: number }
  | { t: "control"; op: "start" | "stop" | "ping" | "cancel" | "regenerate" }
  | { t: "feedback"; suggestionId: number; action: "copy" | "adopt" | "skip" | "dislike" };

export type S2C =
  | { t: "status"; state: "ready" | "listening" | "generating" | "degraded" | "blocked";
      asrProvider: string; llmProvider: string; sessionId: number; generateEnabled: boolean;
      voiceprintActive?: boolean }
  | { t: "transcript"; id: string; speaker: Speaker; text: string; isFinal: boolean; at: number }
  | { t: "voiceprint"; isHost: boolean; score: number; backend: string; threshold: number }
  | { t: "suggestion"; genId: number; index: number; phase: GenPhase;
      text?: string; source: GenSource; latencyFirstTokenMs?: number; blocked?: boolean; reason?: string }
  | { t: "usage"; promptTokens: number; completionTokens: number; costMicros: number }
  | { t: "error"; code: string; message: string; retryable: boolean }
  | { t: "pong"; ts: number };

export const WS_PATH = "/ws";
