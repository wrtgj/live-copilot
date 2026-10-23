/**
 * 浏览器路径自测：所有请求走 http://127.0.0.1:5173（由 Vite 代理转发到后端），
 * 与真实浏览器访问完全一致，验证「注册 -> 默认人设 -> WS 会话 -> 生成话术 -> 落库」全链路。
 */
const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:5173";
const WS_URL = process.env.WS_ORIGIN || WEB.replace(/^http/i, "ws") + "/ws";

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${extra ? "  (" + extra + ")" : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "  (" + extra + ")" : ""}`);
  }
}

async function api(path, init) {
  const res = await fetch(WEB + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init && init.headers ? init.headers : {}) },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 0) throw new Error((json && json.message) || `HTTP ${res.status}`);
  return json.data;
}

async function main() {
  console.log(`\n=== Live Script Copilot 浏览器路径自测 ===\n目标: ${WEB}\n`);

  const hzRaw = await fetch(WEB + "/healthz").then((r) => r.json());
  const hz = (hzRaw && hzRaw.data) || {};
  check("代理健康检查可达", hz.status === "ok", `generate=${hz.generate} llm=${hz.llm}`);

  const email = `selftest_${Date.now()}@local.test`;
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "test123456", nickname: "自测主播" }),
  });
  const token = reg.token;
  check("注册成功并返回 token", !!token);

  const auth = { Authorization: `Bearer ${token}` };
  const personas = await api("/api/personas", { headers: auth });
  check("注册自动下发默认人设", Array.isArray(personas) && personas.length > 0, `数量=${personas && personas.length}`);
  const personaId = personas[0].id;

  let blocked = false;
  try {
    await api("/api/personas");
  } catch {
    blocked = true;
  }
  check("无 token 访问人设接口被拒绝", blocked);

  const { default: WS } = await import("ws");
  const events = [];
  const t0 = Date.now();
  const at = () => Date.now() - t0;

  await new Promise((resolve) => {
    const ws = new WS(WS_URL);
    let started = false;

    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", token, personaId })));
    ws.on("error", (e) => {
      check("WS 连接建立", false, String(e.message));
      resolve();
    });

    const say = (text) =>
      ws.send(
        JSON.stringify({
          t: "asr_text",
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text,
          isFinal: true,
          speaker: "peer",
        })
      );

    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "status" && m.sessionId && !started) {
        started = true;
        events.push({ t: "status", at: at(), sessionId: m.sessionId });
        ws.send(JSON.stringify({ t: "control", op: "start" }));
        setTimeout(() => say("这个能不能再便宜点啊"), 150);
        setTimeout(() => say("这个能不能再便宜点啊"), 350);
        setTimeout(() => say("包邮吗"), 1800);
        setTimeout(() => say("这个产品包治百病对吧"), 3300);
      }
      if (m.t === "transcript") events.push({ t: "transcript", at: at(), text: m.text });
      if (m.t === "suggestion" && m.phase === "start") events.push({ t: "start", at: at(), genId: m.genId });
      if (m.t === "suggestion" && m.phase === "delta" && !events.some((e) => e.t === "delta"))
        events.push({ t: "delta", at: at(), latency: m.latencyFirstTokenMs });
      if (m.t === "suggestion" && m.phase === "done")
        events.push({ t: "done", at: at(), genId: m.genId, source: m.source, text: m.text, risk: m.riskLevel });
      if (m.t === "error") events.push({ t: "error", at: at(), message: m.message });
    });

    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve();
    }, 6500);
  });

  const status = events.find((e) => e.t === "status");
  check("WS 会话建立并下发 sessionId", !!status, `sessionId=${status && status.sessionId}`);

  const starts = events.filter((e) => e.t === "start");
  const dones = events.filter((e) => e.t === "done");
  check("触发了话术生成", starts.length >= 1, `start=${starts.length}`);
  check("重复句未重复调用 LLM（md5 去重生效）", starts.length < 3, `4 句输入 / start=${starts.length}`);
  check("生成有结果返回", dones.length >= 1, `done=${dones.length}`);

  if (dones[0]) {
    let arr = [];
    try {
      arr = JSON.parse(dones[0].text || "[]");
    } catch {
      arr = [];
    }
    check("返回 3 条候选话术", arr.length === 3, `实际=${arr.length}`);
    console.log(`\n  --- 样例输出（人设: ${personas[0].name}）---`);
    arr.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    console.log("");
  }

  const delta = events.find((e) => e.t === "delta");
  check("流式输出（含首 token 延迟）", !!delta, delta ? `首字 ${delta.latency}ms` : "无 delta");
  const e2e = delta ? delta.at : null;
  check("端到端首字 < 3000ms（本地基线）", e2e !== null && e2e < 3000, e2e ? `${e2e}ms` : "N/A");

  const sessions = await api("/api/sessions?limit=5", { headers: auth });
  check("会话已落库", Array.isArray(sessions) && sessions.length > 0, `数量=${sessions && sessions.length}`);

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  console.log(`自测账号：${email} / test123456\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("自测脚本异常:", e);
  process.exit(1);
});
