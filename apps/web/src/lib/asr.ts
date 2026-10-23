/**
 * 浏览器 Web Speech API 封装（A 路 ASR，零成本）
 * 局限：仅 Chrome/Edge 支持；国内网络可能不可达；Safari/Firefox 需降级。
 * 降级顺序：Web Speech -> 手动输入文本（本 MVP）-> 云端 ASR（进阶接入服务端 pcm 上行）
 */

type Listener = {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (reason: string) => void;
};

// Web Speech API 尚未进入 TS 标准 DOM lib，这里做最小类型声明
interface ResultLike {
  isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string } | undefined;
}
interface ResultEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: ResultLike };
}
interface ErrorEventLike {
  error: string;
}

interface SR extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: ResultEventLike) => void) | null;
  onerror: ((e: ErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

export function isWebSpeechSupported(): boolean {
  return typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
}

export class VoiceRecognizer {
  private rec: SR | null = null;
  private running = false;
  private restartTimer: number | null = null;

  constructor(private l: Listener) {}

  get isRunning() {
    return this.running;
  }

  start(lang = "zh-CN") {
    if (!isWebSpeechSupported()) {
      this.l.onError("NOT_SUPPORTED");
      return false;
    }
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SR }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;
    if (!Ctor) {
      this.l.onError("NOT_SUPPORTED");
      return false;
    }

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e: ResultEventLike) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) this.l.onFinal(t.trim());
        else interim += t;
      }
      if (interim) this.l.onInterim(interim.trim());
    };

    rec.onerror = (e: ErrorEventLike) => {
      if (e.error === "network") this.l.onError("NETWORK");
      else if (e.error === "not-allowed") this.l.onError("PERMISSION_DENIED");
      else if (e.error === "no-speech") return; // 静音，正常
      else this.l.onError(e.error);
    };

    // continuous=true 时某些版本会自动结束，需要自动重启保持收音
    rec.onend = () => {
      if (this.running) {
        this.restartTimer = window.setTimeout(() => {
          try {
            rec.start();
          } catch {
            /* ignore */
          }
        }, 250);
      }
    };

    this.rec = rec;
    this.running = true;
    try {
      rec.start();
      return true;
    } catch {
      this.l.onError("START_FAILED");
      return false;
    }
  }

  stop() {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
  }
}
