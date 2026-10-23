import { useCallback, useEffect, useState } from "react";
import { api, type ScriptItem } from "../lib/api";

export default function History() {
  const [scripts, setScripts] = useState<ScriptItem[]>([]);
  const [sessions, setSessions] = useState<Array<Record<string, unknown>>>([]);
  const [usage, setUsage] = useState<{ prompt_tokens: number; completion_tokens: number; cost_micros: number; calls: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, se, u] = await Promise.all([api.historyScripts(), api.listSessions(1, 10), api.usage()]);
      setScripts(s);
      setSessions(se);
      setUsage(u);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="container">
      <div className="stat-row">
        <div className="card stat">
          <div className="num">{usage?.calls ?? 0}</div>
          <div className="lbl">累计生成话术（条）</div>
        </div>
        <div className="card stat">
          <div className="num">¥{((usage?.cost_micros ?? 0) / 1_000_000).toFixed(2)}</div>
          <div className="lbl">累计 LLM 成本</div>
        </div>
        <div className="card stat">
          <div className="num">{sessions.length}</div>
          <div className="lbl">直播场次</div>
        </div>
        <div className="card stat">
          <div className="num">{scripts.filter((s) => s.source === "llm").length}</div>
          <div className="lbl">AI 生成（非模板兜底）</div>
        </div>
      </div>

      <div className="card">
        <div style={{ padding: "16px 18px 0" }} className="panel-title">话术沉淀（最近 200 条）</div>
        {loading && <div className="list-item hint">加载中…</div>}
        {!loading && scripts.length === 0 && (
          <div className="list-item hint">还没有话术记录。去「实时辅助」开一场直播，AI 的建议会自动沉淀到这里。</div>
        )}
        {scripts.slice(0, 40).map((s) => (
          <div className="list-item" key={s.id}>
            <div className="body">
              <div className="title">{s.content}</div>
              <div className="time">
                {new Date(s.created_at).toLocaleString("zh-CN")} · 场次 #{s.session_id} · {s.source === "llm" ? "AI 生成" : "模板兜底"}
              </div>
            </div>
            <button className="btn" onClick={() => navigator.clipboard.writeText(s.content)}>复制</button>
          </div>
        ))}
      </div>
    </div>
  );
}
