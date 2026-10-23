import type { Speaker } from "../protocol.js";

export interface PersonaBrief {
  name: string;
  scene: string;
  style: string;
  tone: string;
  category: string;
  forbiddenWords: string[];
}

export interface Turn {
  speaker: Speaker;
  text: string;
}

const STYLE_DESC: Record<string, string> = {
  funny: "幽默接梗、轻松抖包袱，能一句话把气氛炒热",
  pro: "专业克制、有理有据，用参数与事实说话",
  gentle: "温柔亲和、关心体贴，像朋友聊天一样亲切",
  push: "果断逼单、制造稀缺感和紧迫感，推动立刻下单",
  roast: "犀利反击、不吃亏，能怼回去但不失体面、不带脏字",
  // 兼容中文入参
  搞笑: "幽默接梗、轻松抖包袱，能一句话把气氛炒热",
  专业: "专业克制、有理有据，用参数与事实说话",
  温柔: "温柔亲和、关心体贴，像朋友聊天一样亲切",
  逼单: "果断逼单、制造稀缺感和紧迫感，推动立刻下单",
  怼人: "犀利反击、不吃亏，能怼回去但不失体面、不带脏字",
};

const SCENE_DESC: Record<string, string> = {
  pk: "直播连麦 PK / 打榜",
  fan: "粉丝连麦互动",
  sales: "带货讲解与砍价",
  biz: "商务合作连麦",
  defend: "黑粉质疑 / 舆情应对",
  live: "日常直播互动",
};

/**
 * 组装话术生成的 system prompt。
 * 设计原则：prompt 尽量短（context 压缩），因为 token 长度直接决定首 token 延迟。
 */
export function buildSystemPrompt(p: PersonaBrief): string {
  const style = STYLE_DESC[p.style] ?? STYLE_DESC.gentle;
  const scene = SCENE_DESC[p.scene] ?? SCENE_DESC.live;
  const ban = p.forbiddenWords.length ? p.forbiddenWords.slice(0, 30).join("、") : "无";

  return [
    "你是一名资深直播运营专家，任务是为主播生成「下一句立刻可以说出口」的话术。",
    "",
    `【人设】${p.name}｜场景：${scene}｜风格：${style}`,
    p.category ? `【行业类目】${p.category}` : "",
    p.tone ? `【口播节奏】${p.tone}` : "",
    "",
    "【输出要求】",
    "1. 输出 3 条候选，每条独立一行，行首标注 1) 2) 3)，不要任何序号以外的符号。",
    "2. 每条 20~40 字，口语化短句，主播可以直接照念。",
    "3. 不要加引号、不要加解释、不要用表情符号、不要用括号补充说明。",
    "4. 三条之间要有明显差异：分别偏「接话」「化解」「推进」三种策略。",
    "",
    "【绝对禁止】",
    `1. 禁止使用这些词或同类表达：${ban}`,
    "2. 禁止虚假宣传：不得承诺疗效、不得承诺收益、不得使用极限词（最好/第一/国家级/根治等）。",
    "3. 禁止诱导打赏、不得道德绑架观众。",
    "4. 禁止低俗辱骂、人身攻击、涉政涉黄涉赌内容。",
    "5. 不得捏造商品参数、优惠、库存、发货时间等具体事实。",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

export function buildUserPrompt(current: string, history: Turn[], summary: string): string {
  const lines: string[] = [];
  if (summary) lines.push(`【更早对话摘要】${summary}`);
  if (history.length) {
    lines.push("【最近对话】");
    for (const t of history.slice(-6)) {
      lines.push(`${t.speaker === "peer" ? "对方" : "主播"}：${t.text}`);
    }
  }
  lines.push(`【对方刚说】${current}`);
  lines.push("请给出主播此刻最该回的 3 句话：");
  return lines.join("\n");
}

/** 把 LLM 输出解析成 3 条候选话术 */
export function parseCandidates(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*\d\s*[)）.、:：]\s*(.+)$/);
    if (m) {
      const t = m[1].replace(/^["'「『]|["'」』]$/g, "").trim();
      if (t) out.push(t);
      continue;
    }
    const plain = line.trim();
    // 没有序号时，接受长度合适的独立短句
    if (!plain || plain.startsWith("【") || plain.startsWith("```")) continue;
    if (plain.length >= 6 && plain.length <= 60 && /[，。！？吧呢啊嘛]$/.test(plain)) out.push(plain);
  }
  return out.slice(0, 3);
}
