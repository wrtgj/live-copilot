const BASE = "/api";

const TOKEN_KEY = "lsc_token";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? "",
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 0) {
    throw new Error(json?.message ?? `请求失败 (${res.status})`);
  }
  return json.data as T;
}

export interface UserInfo {
  id: number;
  email: string;
  nickname: string;
  plan: string;
}

export interface Persona {
  id: number;
  name: string;
  scene: string;
  style: string;
  tone: string;
  category: string;
  forbiddenWords: string[];
  is_default: number;
}

export interface ScriptItem {
  id: number;
  content: string;
  source: string;
  style: string;
  created_at: string;
  session_id: number;
}

export interface VoiceprintStatus {
  enrolled: boolean;
  backend: string | null;
  enrolledAt: string | null;
}

export const api = {
  register: (email: string, password: string, nickname: string) =>
    req<{ token: string; userId: number }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, nickname }),
    }),

  login: (email: string, password: string) =>
    req<{ token: string; userId: number; nickname: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () => req<UserInfo>("/auth/me"),

  listPersonas: () => req<Persona[]>("/personas"),

  createPersona: (p: Partial<Persona> & { name: string }) =>
    req<{ id: number }>("/personas", { method: "POST", body: JSON.stringify(p) }),

  deletePersona: (id: number) => req<boolean>(`/personas/${id}`, { method: "DELETE" }),

  listSessions: (page = 1, pageSize = 20) =>
    req<Array<Record<string, unknown>>>(`/sessions?page=${page}&pageSize=${pageSize}`),

  sessionDetail: (id: number) =>
    req<{ session: Record<string, unknown>; utterances: unknown[]; suggestions: unknown[] }>(
      `/sessions/${id}/detail`
    ),

  historyScripts: () => req<ScriptItem[]>("/history/scripts"),

  feedback: (id: number, action: string) =>
    req<boolean>(`/suggestions/${id}/feedback`, { method: "POST", body: JSON.stringify({ action }) }),

  usage: () =>
    req<{ prompt_tokens: number; completion_tokens: number; cost_micros: number; calls: number }>("/usage/me"),

  // 声纹
  enrollVoiceprint: (pid: number, pcm_b64: string, sampleRate: number) =>
    req<{ backend: string; dims: number; enrolledAt: string }>(`/personas/${pid}/voiceprint`, {
      method: "POST",
      body: JSON.stringify({ pcm_b64, sample_rate: sampleRate }),
    }),

  getVoiceprint: (pid: number) => req<VoiceprintStatus>(`/personas/${pid}/voiceprint`),

  deleteVoiceprint: (pid: number) => req<boolean>(`/personas/${pid}/voiceprint`, { method: "DELETE" }),
};
