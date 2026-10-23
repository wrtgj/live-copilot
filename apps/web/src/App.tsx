import { useCallback, useEffect, useState } from "react";
import { api, tokenStore, type Persona } from "./lib/api";
import Live from "./pages/Live";
import PersonaPage from "./pages/Persona";
import History from "./pages/History";

type View = "live" | "persona" | "history";

function Auth() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [pwd, setPwd] = useState("");
  const [nick, setNick] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr("");
    setLoading(true);
    try {
      const r = mode === "login" ? await api.login(email, pwd) : await api.register(email, pwd, nick);
      tokenStore.set(r.token);
      location.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card auth-wrap">
      <h2>{mode === "login" ? "登录 Live Script Copilot" : "注册主播账号"}</h2>
      <div className="sub">实时听懂对方的话，3 秒内给你可直接照念的回应</div>
      <div className="field">
        <label>邮箱</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </div>
      {mode === "register" && (
        <div className="field">
          <label>昵称</label>
          <input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="主播昵称" />
        </div>
      )}
      <div className="field">
        <label>密码</label>
        <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="至少 6 位" />
      </div>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" style={{ width: "100%", marginTop: 10 }} onClick={submit} disabled={loading}>
        {loading ? "处理中…" : mode === "login" ? "登录" : "注册并进入"}
      </button>
      <div style={{ marginTop: 14, textAlign: "center" }}>
        <button className="btn ghost" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "还没有账号？去注册" : "已有账号？去登录"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const token = tokenStore.get();
  const [view, setView] = useState<View>("live");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveId] = useState<number>(0);

  const loadPersonas = useCallback(async () => {
    try {
      const list = await api.listPersonas();
      setPersonas(list);
      if (list.length && !activeId) setActiveId(list[0].id);
    } catch {
      tokenStore.clear();
    }
  }, [activeId]);

  useEffect(() => {
    if (token) void loadPersonas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) {
    return (
      <div className="app">
        <div className="topbar">
          <div className="logo"><span className="dot" /> Live Script Copilot</div>
          <span className="spacer" />
          <span className="hint">AI 实时话术辅助 · 直播友好</span>
        </div>
        <div className="main">
          <Auth />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo"><span className="dot" /> Live Script Copilot</div>
        <div className="navlinks">
          <button className={view === "live" ? "active" : ""} onClick={() => setView("live")}>实时辅助</button>
          <button className={view === "persona" ? "active" : ""} onClick={() => setView("persona")}>人设管理</button>
          <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}>话术沉淀</button>
        </div>
        <span className="spacer" />
        <button
          className="btn ghost"
          onClick={() => {
            tokenStore.clear();
            location.reload();
          }}
        >
          退出
        </button>
      </div>
      <div className="main">
        {view === "live" && (
          <Live token={token} personaId={activeId} personas={personas} onPersonaChange={setActiveId} />
        )}
        {view === "persona" && (
          <PersonaPage personas={personas} activeId={activeId} onRefresh={loadPersonas} />
        )}
        {view === "history" && <History />}
      </div>
    </div>
  );
}
