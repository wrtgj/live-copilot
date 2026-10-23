import { useEffect, useState } from "react";
import { api, type Persona, type VoiceprintStatus } from "../lib/api";
import { AudioCapture } from "../lib/audio_capture";

interface Props {
  personas: Persona[];
  activeId: number;
  onRefresh: () => void;
}

const SCENES = [
  { v: "sales", l: "带货讲解与砍价" },
  { v: "pk", l: "连麦 PK / 打榜" },
  { v: "fan", l: "粉丝连麦互动" },
  { v: "biz", l: "商务合作连麦" },
  { v: "defend", l: "黑粉质疑应对" },
  { v: "live", l: "日常直播互动" },
];

const STYLES = [
  { v: "gentle", l: "温柔亲和" },
  { v: "push", l: "果断逼单" },
  { v: "funny", l: "幽默接梗" },
  { v: "pro", l: "专业克制" },
  { v: "roast", l: "犀利反击" },
];

export default function PersonaPage({ personas, activeId, onRefresh }: Props) {
  const [name, setName] = useState("");
  const [scene, setScene] = useState("sales");
  const [style, setStyle] = useState("push");
  const [tone, setTone] = useState("轻快有能量");
  const [category, setCategory] = useState("");
  const [ban, setBan] = useState("最好, 第一, 根治, 永久");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // 声纹校准
  const [vp, setVp] = useState<VoiceprintStatus | null>(null);
  const [vpBusy, setVpBusy] = useState(false);
  const [vpMsg, setVpMsg] = useState("");

  const styleLabel = (v: string) => STYLES.find((s) => s.v === v)?.l ?? v;
  const sceneLabel = (v: string) => SCENES.find((s) => s.v === v)?.l ?? v;

  useEffect(() => {
    if (personas.length === 0) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setVp(null);
    api.getVoiceprint(activeId).then(setVp).catch(() => setVp(null));
  }, [activeId]);

  const enrollVoiceprint = async () => {
    if (!activeId) return setVpMsg("请先选择一个当前人设");
    setVpMsg("");
    setVpBusy(true);
    try {
      const cap = new AudioCapture();
      const { b64, sr } = await cap.recordOnce(3);
      cap.stop();
      await api.enrollVoiceprint(activeId, b64, sr);
      setVp(await api.getVoiceprint(activeId));
      setVpMsg("声纹已录入，直播时将自动识别你本人");
    } catch (e) {
      setVpMsg((e as Error).message || "录制失败，请检查麦克风权限");
    } finally {
      setVpBusy(false);
    }
  };

  const clearVoiceprint = async () => {
    if (!activeId) return;
    setVpBusy(true);
    try {
      await api.deleteVoiceprint(activeId);
      setVp(await api.getVoiceprint(activeId));
      setVpMsg("已清除声纹");
    } catch (e) {
      setVpMsg((e as Error).message);
    } finally {
      setVpBusy(false);
    }
  };

  const submit = async () => {
    if (!name.trim()) return setErr("请填写人设名称");
    setErr("");
    setLoading(true);
    try {
      await api.createPersona({
        name,
        scene,
        style,
        tone,
        category,
        forbiddenWords: ban.split(/[,，\s]+/).filter(Boolean),
      });
      setName("");
      onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <div className="info-box">
        人设决定 AI 说话的口气。配置越贴近你本人，生成的话术越像你自己说的 —— 建议为「带货」「连麦 PK」「应对黑粉」各建一套。
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 24, maxWidth: 620 }}>
        <div className="panel-title">声纹校准（主播/对方分离）</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          录入你本人的声音后，直播时系统会自动识别「正在说话的是不是主播」，只针对对方的提问生成话术，避免你念稿时被误判为对方。
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={enrollVoiceprint} disabled={vpBusy || !activeId}>
            {vpBusy ? "录制中…（请朗读 3 秒）" : "录制 3 秒声纹"}
          </button>
          {vp?.enrolled && (
            <button className="btn ghost" onClick={clearVoiceprint} disabled={vpBusy}>
              清除
            </button>
          )}
          <span className="hint">
            {vp?.enrolled
              ? `已录入 · 引擎 ${vp.backend}`
              : activeId
                ? "当前人设尚未录入声纹"
                : "请先在下方选择/新建人设"}
          </span>
        </div>
        {vpMsg && <div className="err" style={{ marginTop: 8 }}>{vpMsg}</div>}
      </div>

      <div className="grid-2" style={{ marginBottom: 24 }}>
        {personas.map((p) => (
          <div className="card persona-card" key={p.id}>
            <h4>
              {p.name} {p.id === activeId && <span className="badge green">当前使用</span>}
            </h4>
            <div className="hint">
              场景：{sceneLabel(p.scene)} · 风格：{styleLabel(p.style)}
              {p.category ? ` · 类目：${p.category}` : ""}
              {p.tone ? ` · 节奏：${p.tone}` : ""}
            </div>
            <div className="tagrow">
              {(p.forbiddenWords ?? []).slice(0, 6).map((w) => (
                <span className="badge red" key={w}>禁 {w}</span>
              ))}
            </div>
            <div className="script-meta">
              <span className="spacer" />
              <button
                className="btn ghost"
                onClick={async () => {
                  await api.deletePersona(p.id);
                  onRefresh();
                }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 22, maxWidth: 620 }}>
        <div className="panel-title">新建人设</div>
        <div className="field">
          <label>人设名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：亲和逼单 · 女装专场" />
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>直播场景</label>
            <select value={scene} onChange={(e) => setScene(e.target.value)}>
              {SCENES.map((s) => (
                <option key={s.v} value={s.v}>{s.l}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>话术风格</label>
            <select value={style} onChange={(e) => setStyle(e.target.value)}>
              {STYLES.map((s) => (
                <option key={s.v} value={s.v}>{s.l}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>行业类目</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="例如：美妆护肤" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>口播节奏</label>
            <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="例如：轻快有能量" />
          </div>
        </div>
        <div className="field">
          <label>自定义禁词（逗号分隔）</label>
          <input value={ban} onChange={(e) => setBan(e.target.value)} />
        </div>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" style={{ marginTop: 8 }} onClick={submit} disabled={loading}>
          {loading ? "保存中…" : "保存人设"}
        </button>
      </div>
    </div>
  );
}
