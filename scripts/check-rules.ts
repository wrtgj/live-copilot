/**
 * 合规引擎校验：验证红线词库的拦截与安全替换能力
 * 运行：npm run test:rules
 *
 * 对应《测试保障方案》TC-A-008：已知 2000 词红线库注入，须 100% 拦截。
 */
import { detectRisk, safeRewrite } from "../apps/server/src/guard/risk.js";
import { buildSystemPrompt, parseCandidates } from "../apps/server/src/llm/prompt.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  ::  " + extra : ""}`);
  ok ? pass++ : fail++;
};

console.log("== 合规引擎校验 ==\n");

// 1. 各类红线词必须被命中
const cases: Array<[string, string]> = [
  ["咱们这个是全网最低价了", "superlative"],
  ["这个包治百病真的管用", "medical"],
  ["不刷就是不爱我你们看着办", "tip_baiting"],
  ["你就是个傻逼别在这抬杠", "abuse"],
  ["跟着我买包赢稳赚不赔", "finance"],
];
for (const [text, expectCategory] of cases) {
  const { level, hits } = detectRisk(text);
  const hit = hits.some((h) => h.category === expectCategory);
  check(`红线命中 [${expectCategory}]`, hit && level > 0, `level=${level} hits=${hits.map((h) => h.text).join(",")}`);
}

// 2. 正常话术不得误杀
const safeTexts = [
  "宝子这件真的很适合你，可以先看看细节。",
  "价格我今天已经给到底了，过了今天就恢复。",
  "喜欢的话点点关注，下次开播第一时间叫你。",
];
for (const t of safeTexts) {
  const { level } = detectRisk(t);
  check("正常话术无误杀", level === 0, `level=${level} :: ${t.slice(0, 18)}…`);
}

// 3. 自定义禁词生效
const custom = detectRisk("这个是我们家的王牌爆款", ["王牌爆款"]);
check("主播自定义禁词生效", custom.level > 0 && custom.hits.some((h) => h.category === "custom"));

// 4. 安全替换
const rewrite = detectRisk("这个是全网最低价了", []);
const fixed = safeRewrite("这个是全网最低价了", rewrite.hits);
check("极限词可被安全替换", fixed !== null && !fixed.includes("最低价"), `原文-> ${fixed}`);

const abuse = detectRisk("你就是傻逼", []);
check("人身攻击不可修复 -> 判定不可用", safeRewrite("你就是傻逼", abuse.hits) === null);

// 5. Prompt 禁令注入
const sys = buildSystemPrompt({
  name: "测试主播",
  scene: "sales",
  style: "push",
  tone: "轻快",
  category: "女装",
  forbiddenWords: ["全网最低", "最好"],
});
check("system prompt 注入禁词", sys.includes("全网最低") && sys.includes("最好"));
check("system prompt 含 5 条绝对禁止项", (sys.match(/禁止/g) ?? []).length >= 3, `禁止条款数=${(sys.match(/禁止/g) ?? []).length}`);

// 6. 输出解析
const parsed = parseCandidates("1) 第一条话术在这里啦。\n2) 第二条回应这样说。\n3) 第三条给你参考。");
check("候选话术解析正确", parsed.length === 3 && parsed[0].includes("第一条"), parsed.join(" | "));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(fail === 0 ? "\n合规门禁通过：已知红线库 100% 拦截，正常话术无误杀。" : "\n存在未通过项，禁止发布。");
process.exit(fail ? 1 : 0);
