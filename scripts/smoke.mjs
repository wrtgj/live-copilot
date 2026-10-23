/**
 * 端到端冒烟脚本：注册 -> 登录 -> 取人设 -> WS 全链路话术生成 -> 去重/节流/越权 -> 历史入库
 *
 * 运行方式（需先启动后端）：
 *   cd live-script-copilot
 *   NODE_PATH=$(pwd)/node_modules node scripts/smoke.mjs
 *
 * 说明：未配置 LLM_API_KEY 时后端自动走 mock 模式，本脚本零费用即可跑通。
 */
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://localhost:8787";
const WS_URL = process.env.WS_URL ?? "ws://localhost:8787/ws";
const email = `smoke_${Date.now()}@test.com`;

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`${path} -> ${json.message}`);
  return json.data;
}
async function get(path, token) {
  const json = await fetch(BASE + path, { headers: { Authorization: "Bearer " + token } }).then((r) => r.json());
  if (json.code !== 0) throw new Error(`${path} -> ${json.message}`);
  return json.data;
}
async function del(path, token) {
  const res = await fetch(BASE + path, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
  return res.status;
}

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  ::  " + extra : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("== Live Script Copilot 端到端冒烟 ==\n");

// ---------- 1. 账号与人设 ----------
const { token } = await post("/api/auth/register", { email, password: "pass1234", nickname: "冒烟主播" });
check("注册并拿到 token", !!token);

let personas = await get("/api/personas", token);
check("注册即自动种入预设人设", personas.length > 0, `count=${personas.length}`);

const newP = await post("/api/personas", {
  name: "女装专场 · 温柔",
  scene: "sales",
  style: "gentle",
  category: "女装",
  forbiddenWords: ["最好", "第一"],
}, token);
check("新建人设成功", !!newP.id, `id=${newP.id}`);

personas = await get("/api/personas", token);
const personaId = personas[0].id;

// ---------- 2. WS 全链路 ----------
const events = [];
await new Promise((resolve) => {
  const ws = new WebSocket(WS_URL);
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const uid = () => "u_" + Math.random().toString(36).slice(2, 8);
  const say = (text) => ws.send(JSON.stringify({ t: "asr_text", id: uid(), text, isFinal: true, speaker: "peer" }));

  let registered = false;
  let sessionReady = false;
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", token, personaId })));

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "status" && m.sessionId) {
      events.push({ t: "status", at: at(), sessionId: m.sessionId });
      if (!sessionReady) {
        sessionReady = true;
        ws.send(JSON.stringify({ t: "control", op: "start" }));
        setTimeout(() => {
          say("这个能不能再便宜点啊");                        // 正常句子 -> 应生成
          setTimeout(() => say("这个能不能再便宜点啊"), 200);  // 3 秒内的重复句 -> 应被 md5 去重拦截
          setTimeout(() => say("发货要等多久呢"), 1600);       // 新句子 -> 应生成新一轮
        }, 100);
      }
      return;
    }
    if (m.t === "suggestion" && m.phase === "start") events.push({ t: "start", at: at(), genId: m.genId });
    if (m.t === "suggestion" && m.phase === "done") {
      const list = JSON.parse(m.text ?? "[]");
      events.push({ t: "done", at: at(), genId: m.genId, source: m.source, count: list.length, firstTokenMs: m.latencyFirstTokenMs, list });
    }
  });

  setTimeout(() => {
    ws.close();
    resolve();
  }, 6000);
});

const statusEvt = events.find((e) => e.t === "status");
check("WS 握手并建立会话", !!statusEvt && statusEvt.sessionId > 0, `sessionId=${statusEvt?.sessionId}`);

const dones = events.filter((e) => e.t === "done");
check("ASR 文本触发话术生成", dones.length >= 1, `轮次=${dones.length}`);
if (dones[0]) {
  check("返回 3 条候选话术", dones[0].count === 3, `count=${dones[0].count} source=${dones[0].source} 首字=${dones[0].firstTokenMs}ms`);
  console.log("      示例:");
  dones[0].list.forEach((t, i) => console.log(`        ${i + 1}) ${t}`));
}

const starts = events.filter((e) => e.t === "start");
// 共说了 3 句话，其中第 2 句是第 1 句的重复，应被 md5 去重拦截 => 只应触发 2 次生成
check("md5 去重生效（重复句未触发新生成）", starts.length === 2, `说了 3 句 -> 实际生成 ${starts.length} 次`);
check("新句子触发新一轮生成（非全局节流卡死）", starts.length >= 2, `start 次数=${starts.length}`);
if (starts.length >= 2) {
  const gap = starts[1].at - starts[0].at;
  check("节流间隔符合配置（GEN_MIN_INTERVAL_MS）", gap >= 1200, `间隔=${gap}ms`);
}

// ---------- 3. 越权与历史 ----------
const other = await post("/api/auth/register", { email: `other_${Date.now()}@test.com`, password: "pass1234" }, "");
const sessions = await get("/api/sessions?page=1&pageSize=5", token);
check("会话列表可读且归属本人", Array.isArray(sessions) && sessions.length > 0, `count=${sessions.length}`);

let denied = false;
try {
  await get(`/api/sessions/${statusEvt.sessionId}/detail`, other.token);
} catch (e) {
  denied = String(e.message).includes("不存在") || String(e.message).includes("无权");
}
check("跨用户访问会话被拦截（防水平越权）", denied);

const usage = await get("/api/usage/me", token);
check("用量统计可读", typeof usage.calls === "number" && usage.calls > 0, `calls=${usage.calls} tokens=${usage.prompt_tokens + usage.completion_tokens}`);

const scripts = await get("/api/history/scripts", token);
check("话术沉淀入库", scripts.length > 0, `条数=${scripts.length}`);

const delStatus = await del(`/api/personas/${newP.id}`, token);
check("删除人设可用", delStatus === 200, `HTTP ${delStatus}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
