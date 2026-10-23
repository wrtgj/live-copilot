import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient } from "../lib/ws";
import { VoiceRecognizer, isWebSpeechSupported } from "../lib/asr";
import { AudioCapture } from "../lib/audio_capture";
import { api, type Persona } from "../lib/api";
import type { S2C } from "../lib/protocol";

interface Props {
  token: string;
  personaId: number;
  personas: Persona[];
  onPersonaChange: (id: number) => void;
}

interface Candidate {
  text: string;
  risk: number;
  source: string;
}

interface Line {
  id: string;
  speaker: "peer" | "host";
  text: string;
  final: boolean;
}

export default function Live({ token, personaId, personas, onPersonaChange }: Props) {
  const [running, setRunning] = useState(false);
  const [conn, setConn] = useState<"connecting" | "open" | "closed" | "reconnecting">("closed");
  const [lines, setLines] = useState<Line[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [asrError, setAsrError] = useState<string>("");
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const [source, setSource] = useState<"llm" | "template">("llm");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [generating, setGenerating] = useState(false);
  const [manual, setManual] = useState("");
  const [elapsed, setElapsed] = useState(0);

  // 声纹鉴别
  const [vpActive, setVpActive] = useState(false); // 当前人设是否已录入声纹
  const [vpOn, setVpOn] = useState(false);          // 是否开启直播鉴别
  const [vpHost, setVpHost] = useState(false);       // 当前判定：主播本人在说话
  const [vpScore, setVpScore] = useState(0);
  const vpCapRef = useRef<AudioCapture | null>(null);

  const clientRef = useRef<RealtimeClient | null>(null);
  const recRef = useRef<VoiceRecognizer | null>(null);
  const latestGenRef = useRef(0);
  const streamBufRef = useRef("");

  const supported = useMemo(() => isWebSpeechSupported(), []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1600);
  }, []);

  // WS 连接
  useEffect(() => {
    if (!token || !personaId) return;
    const c = new RealtimeClient();
    clientRef.current = c;
    c.onState = setConn;
    c.onMessage = (m: S2C) => {
      switch (m.t) {
        case "status":
          setSessionId(m.sessionId);
          setVpActive(!!m.voiceprintActive);
          setVpHost(false);
          setVpScore(0);
          break;
        case "voiceprint":
          setVpHost(m.isHost);
          setVpScore(m.score);
          break;
        case "transcript":
          setLines((prev) => {
            const exist = prev.findIndex((l) => l.id === m.id);
            if (exist >= 0) {
              const copy = [...prev];
              copy[exist] = { id: m.id, speaker: m.speaker, text: m.text, final: m.isFinal };
              return copy;
            }
            return [...prev, { id: m.id, speaker: m.speaker, text: m.text, final: m.isFinal }];
          });
          break;
        case "suggestion": {
          if (m.phase === "start") {
            streamBufRef.current = "";
            latestGenRef.current = m.genId;
            setGenerating(true);
            setSource(m.source);
            return;
          }
          // 旧 genId 的 delta 全部丢弃（取消竞态治理）
          if (m.genId !== latestGenRef.current) return;

          if (m.phase === "delta") {
            streamBufRef.current += m.text ?? "";
            if (m.latencyFirstTokenMs) setFirstTokenMs(m.latencyFirstTokenMs);
            return;
          }
          if (m.phase === "abort") {
            setGenerating(false);
            return;
          }
          if (m.phase === "done") {
            setGenerating(false);
            setSource(m.source);
            if (m.latencyFirstTokenMs) setFirstTokenMs(m.latencyFirstTokenMs);
            try {
              const arr = JSON.parse(m.text ?? "[]") as string[];
              if (Array.isArray(arr) && arr.length) {
                setCandidates(arr.map((t, i) => ({ text: t, risk: 0, source: m.source })));
              }
            } catch {
              /* ignore */
            }
          }
          break;
        }
        case "error":
          flash(m.message);
          break;
        default:
          break;
      }
    };
    c.connect(token, personaId);
    return () => c.close();
  }, [token, personaId, flash]);

  // 计时
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // 声纹鉴别：开播且开启时，持续把主播麦克风 PCM 发往服务端做说话人判定
  useEffect(() => {
    if (!running || !vpOn || !vpActive || conn !== "open") return;
    let cancelled = false;
    (async () => {
      try {
        const cap = new AudioCapture();
        vpCapRef.current = cap;
        await cap.start((b64, sr) => {
          clientRef.current?.send({ t: "audio", pcmB64: b64, sampleRate: sr });
        }, 1000);
      } catch (e) {
        flash("声纹鉴别启动失败：" + (e as Error).message);
        setVpOn(false);
      }
    })();
    return () => {
      cancelled = true;
      vpCapRef.current?.stop();
      vpCapRef.current = null;
      setVpHost(false);
      setVpScore(0);
    };
  }, [running, vpOn, vpActive, conn, flash]);

  const pushToServer = useCallback((text: string, isFinal: boolean) => {
    clientRef.current?.send({
      t: "asr_text",
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      isFinal,
      speaker: "peer",
    });
  }, []);

  const start = () => {
    setAsrError("");
    setElapsed(0);
    setRunning(true);
    clientRef.current?.send({ t: "control", op: "start" });

    if (!supported) {
      setAsrError("当前浏览器不支持语音识别（请用 Chrome / Edge），已切换为手动输入模式");
      return;
    }
    const rec = new VoiceRecognizer({
      onInterim: (t) => pushToServer(t, false),
      onFinal: (t) => pushToServer(t, true),
      onError: (r) => {
        if (r === "NETWORK") setAsrError("语音识别服务不可达（可能是网络限制），已支持手动输入兜底");
        else if (r === "PERMISSION_DENIED") setAsrError("麦克风权限被拒绝，请在浏览器地址栏左侧重新授权，或使用下方手动输入");
        else if (r === "NOT_SUPPORTED") setAsrError("浏览器不支持语音识别，已切换为手动输入模式");
        else setAsrError(`识别异常：${r}`);
      },
    });
    recRef.current = rec;
    rec.start("zh-CN");
  };

  const stop = () => {
    setRunning(false);
    recRef.current?.stop();
    clientRef.current?.send({ t: "control", op: "stop" });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash("已复制到剪贴板");
    } catch {
      flash("复制失败，请手动选中文本");
    }
  };

  // 快捷键：Alt/Cmd/Ctrl + 1/2/3 复制第 N 条
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 3 && candidates[n - 1]) {
        e.preventDefault();
        void copy(candidates[n - 1].text);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [candidates]);

  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="container">
      <div className="statusbar">
        {running ? (
          <span className="pill rec">
            <span className="pulse" /> REC {mmss(elapsed)}
          </span>
        ) : (
          <span className="pill">未开播</span>
        )}
        <span className={`pill ${conn === "open" ? "ok" : conn === "closed" ? "" : "warn"}`}>
          {conn === "open" ? "已连接" : conn === "connecting" ? "连接中…" : conn === "reconnecting" ? "重连中…" : "未连接"}
        </span>
        {firstTokenMs !== null && <span className="pill">AI 首字 {firstTokenMs}ms</span>}
        {source === "template" && <span className="pill warn">模板兜底模式</span>}
        {generating && <span className="pill">正在生成…</span>}
        {vpActive && (
          <span className={`pill ${vpOn ? (vpHost ? "ok" : "") : ""}`}>
            声纹 {vpOn ? (vpHost ? "主播在说话" : "对方在说话") : "未开启"}
          </span>
        )}
        {vpActive && (
          <button className="btn" onClick={() => setVpOn((v) => !v)} disabled={!running}>
            {vpOn ? "关闭鉴别" : "开启鉴别"}
          </button>
        )}
        <span className="spacer" />
        <select className="select-inline" value={personaId} onChange={(e) => onPersonaChange(Number(e.target.value))}>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {running ? (
          <button className="btn" onClick={stop}>结束本场</button>
        ) : (
          <button className="btn primary" onClick={start} disabled={!personaId}>开始收音</button>
        )}
      </div>

      {asrError && <div className="warning-box">{asrError}</div>}
      {sessionId === null && <div className="info-box">正在建立会话…（会话 ID 建立后即可开始收音）</div>}

      <div className="live-grid">
        <div className="card">
          <div style={{ padding: "16px 20px 0" }} className="panel-title">实时转写（对方语音）</div>
          <div className="transcript">
            {lines.length === 0 && <div className="empty">尚未收到语音 —— 打开「开始收音」后，对方的说话内容会实时出现在这里。</div>}
            {lines.slice(-40).map((l) => (
              <div className="line" key={l.id}>
                <span className={`who ${l.speaker}`}>{l.speaker === "peer" ? "对方" : "主播"}</span>
                <span className="txt" style={{ opacity: l.final ? 1 : 0.55 }}>{l.text}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div style={{ padding: "16px 16px 0" }} className="panel-title">AI 建议话术</div>
          <div className="suggest-list">
            {candidates.length === 0 && (
              <div className="empty" style={{ color: "var(--text-dim)", padding: "16px 4px", lineHeight: 1.8 }}>
                对方说完一句话后，这里会浮出 3 条可直接照念的回应。<br />
                最长 20~40 字，不用改就能说出口。
              </div>
            )}
            {candidates.map((c, i) => (
              <div key={`${i}-${c.text}`} className={`script-card ${i === 0 ? "primary" : ""}`}>
                <div className="script-text">{c.text}</div>
                <div className="script-meta">
                  <span className="badge">方案 {i + 1}</span>
                  {i === 0 && <span className="badge green">首推</span>}
                  {c.source === "template" && <span className="badge amber">模板</span>}
                  <span className="spacer" />
                  <span className="kbd">{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+{i + 1}</span>
                  <button className="btn" onClick={() => copy(c.text)}>复制</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20, padding: 16 }}>
        <div className="panel-title">手动兜底输入（ASR 不可用时使用）</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            className="select-inline"
            style={{ flex: 1 }}
            placeholder="把对方刚才说的话敲进来，回车即可生成话术"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manual.trim()) {
                pushToServer(manual.trim(), true);
                setManual("");
              }
            }}
          />
          <button
            className="btn"
            onClick={() => {
              if (manual.trim()) {
                pushToServer(manual.trim(), true);
                setManual("");
              }
            }}
          >
            生成
          </button>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          提示：macOS 上浏览器无法直接采集系统音频。若要采集连麦对方的声音，推荐安装虚拟声卡（BlackHole）后把播放器输出路由进浏览器；
          或用麦克风拾取外放声音；也可以直接用上面的手动输入框。快捷键 <span className="kbd">⌘/Ctrl + 1~3</span> 复制对应话术。
        </div>
      </div>

      <div className="hint" style={{ marginTop: 14, textAlign: "center" }}>
        AI 生成内容仅供参考，直播内容合规责任由主播本人承担 · 音频不落盘，仅保留转写文本
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
