/**
 * 合规守卫：生成前后的双层拦截
 * 第一层：注入 system prompt 的禁词与表述约束（见 llm/prompt.ts）
 * 第二层：本文件的红线词库，对 LLM 输出做命中检测 → 拦截/替换/降级为模板话术
 */

/** 广告法极限词 */
const SUPERLATIVE = [
  "最好", "最佳", "最优", "最强", "最低价", "全网最低", "史上最低", "第一品牌", "国家级",
  "世界级", "顶级", "极品", "绝无仅有", "史无前例", "独一无二", "永久", "终身",
  "根治", "药到病除", "无副作用", "100%有效", "百分百", "万无一失", "一劳永逸",
];

/** 医疗/功效暗示 */
const MEDICAL = [
  "包治", "治疗", "疗效", "治愈", "抗癌", "消炎", "降血糖", "降血压", "减肥特效", "丰胸", "壮阳",
  "美白瘦身", "祛斑根治", "增强免疫", "包好", "彻底治好",
];

/** 诱导打赏 / 情感操控 */
const TIP_BAITING = [
  "不刷就是不爱我", "不刷礼物", "不打赏就", "榜一才有资格", "必须刷", "赶紧刷礼物",
  "不刷就滚", "刷多少才算爱",
];

/** 人身攻击与低俗 */
const ABUSE = [
  "傻逼", "智障", "去死", "丑八怪", "废物", "神经病", "滚蛋", "有病吧", "白痴", "傻子",
];

/** 涉政涉赌涉黄 */
const ILLEGAL = [
  "六合彩", "赌博", "赌场", "博彩", "刷单赚钱", "一夜暴富", "包赢", "内部渠道",
];

/** 金融承诺 */
const FINANCE = [
  "保本保息", "稳赚不赔", "包赚", "收益保证", "零风险", "翻倍收益", "内幕消息",
];

export interface RuleHit {
  text: string;
  category: string;
  reason: string;
}

const RULES: Array<{ category: string; reason: string; words: string[] }> = [
  { category: "superlative", reason: "广告法极限词", words: SUPERLATIVE },
  { category: "medical", reason: "医疗功效暗示", words: MEDICAL },
  { category: "tip_baiting", reason: "诱导打赏", words: TIP_BAITING },
  { category: "abuse", reason: "人身攻击/低俗", words: ABUSE },
  { category: "illegal", reason: "违法违规内容", words: ILLEGAL },
  { category: "finance", reason: "金融收益承诺", words: FINANCE },
];

/** 检测一段文本命中的红线规则 */
export function detectRisk(
  text: string,
  extraForbidden: string[] = []
): { level: 0 | 1 | 2; hits: RuleHit[] } {
  const hits: RuleHit[] = [];
  for (const rule of RULES) {
    for (const w of rule.words) {
      if (text.includes(w)) hits.push({ text: w, category: rule.category, reason: rule.reason });
    }
  }
  for (const w of extraForbidden) {
    if (w && text.includes(w)) hits.push({ text: w, category: "custom", reason: "主播自定义禁词" });
  }

  const highRisk = hits.some((h) =>
    ["tip_baiting", "abuse", "illegal", "finance", "medical"].includes(h.category)
  );
  const level: 0 | 1 | 2 = hits.length === 0 ? 0 : highRisk ? 2 : 1;
  return { level, hits };
}

/** 尽力做安全替换（把红线词换成安全表述），无法替换时返回 null */
export function safeRewrite(text: string, hits: RuleHit[]): string | null {
  const REPLACEMENTS: Record<string, string> = {
    最好: "很不错", 最佳: "很合适", 最优: "很合适", 最强: "很能打", 最低价: "很实惠",
    全网最低: "很实惠", 史上最低: "很实惠", 国家级: "高品质", 世界级: "高品质",
    顶级: "高品质", 极品: "很不错", 百分百: "基本都", 100: "", 根治: "改善", 包治: "有助于",
  };
  let out = text;
  let changed = false;
  for (const h of hits) {
    const rep = REPLACEMENTS[h.text];
    if (rep !== undefined) {
      out = out.split(h.text).join(rep);
      changed = true;
    }
  }
  out = out.replace(/不刷.{0,6}就是不爱我/g, "喜欢的话可以支持一下").trim();
  if (out !== text) changed = true;
  // 高危词无法安全替换 -> 直接判定不可修复
  // 注意：medical 也纳入不可修复——"包治/根治"等医疗功效暗示一旦改写仍可能遗留误导，
  // 应整条丢弃并降级模板，而非尝试"洗白"后放行。
  if (hits.some((h) => ["abuse", "illegal", "finance", "tip_baiting", "medical"].includes(h.category))) {
    return null;
  }
  return changed ? out : null;
}
