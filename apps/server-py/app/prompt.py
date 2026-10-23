"""话术生成的 Prompt 工程：system / user 组装 + 输出解析。"""
import re
from dataclasses import dataclass, field
from typing import Literal

Speaker = Literal["peer", "host"]

STYLE_DESC: dict[str, str] = {
    "funny": "幽默接梗、轻松抖包袱，能一句话把气氛炒热",
    "pro": "专业克制、有理有据，用参数与事实说话",
    "gentle": "温柔亲和、关心体贴，像朋友聊天一样亲切",
    "push": "果断逼单、制造稀缺感和紧迫感，推动立刻下单",
    "roast": "犀利反击、不吃亏，能怼回去但不失体面、不带脏字",
    # 兼容中文入参
    "搞笑": "幽默接梗、轻松抖包袱，能一句话把气氛炒热",
    "专业": "专业克制、有理有据，用参数与事实说话",
    "温柔": "温柔亲和、关心体贴，像朋友聊天一样亲切",
    "逼单": "果断逼单、制造稀缺感和紧迫感，推动立刻下单",
    "怼人": "犀利反击、不吃亏，能怼回去但不失体面、不带脏字",
}

SCENE_DESC: dict[str, str] = {
    "pk": "直播连麦 PK / 打榜",
    "fan": "粉丝连麦互动",
    "sales": "带货讲解与砍价",
    "biz": "商务合作连麦",
    "defend": "黑粉质疑 / 舆情应对",
    "live": "日常直播互动",
}


@dataclass
class PersonaBrief:
    name: str = "默认主播"
    scene: str = "live"
    style: str = "gentle"
    tone: str = ""
    category: str = ""
    forbidden_words: list[str] = field(default_factory=list)


@dataclass
class Turn:
    speaker: Speaker
    text: str


def build_system_prompt(p: PersonaBrief) -> str:
    style = STYLE_DESC.get(p.style, STYLE_DESC["gentle"])
    scene = SCENE_DESC.get(p.scene, SCENE_DESC["live"])
    ban = "、".join(p.forbidden_words[:30]) if p.forbidden_words else "无"

    lines = [
        "你是一名资深直播运营专家，任务是为主播生成「下一句立刻可以说出口」的话术。",
        "",
        f"【人设】{p.name}｜场景：{scene}｜风格：{style}",
        f"【行业类目】{p.category}" if p.category else "",
        f"【口播节奏】{p.tone}" if p.tone else "",
        "",
        "【输出要求】",
        "1. 输出 3 条候选，每条独立一行，行首标注 1) 2) 3)，不要任何序号以外的符号。",
        "2. 每条 20~40 字，口语化短句，主播可以直接照念。",
        "3. 不要加引号、不要加解释、不要用表情符号、不要用括号补充说明。",
        "4. 三条之间要有明显差异：分别偏「接话」「化解」「推进」三种策略。",
        "",
        "【绝对禁止】",
        f"1. 禁止使用这些词或同类表达：{ban}",
        "2. 禁止虚假宣传：不得承诺疗效、不得承诺收益、不得使用极限词（最好/第一/国家级/根治等）。",
        "3. 禁止诱导打赏、不得道德绑架观众。",
        "4. 禁止低俗辱骂、人身攻击、涉政涉黄涉赌内容。",
        "5. 不得捏造商品参数、优惠、库存、发货时间等具体事实。",
    ]
    return "\n".join(s for s in lines if s != "")


def build_user_prompt(current: str, history: list[Turn], summary: str) -> str:
    lines: list[str] = []
    if summary:
        lines.append(f"【更早对话摘要】{summary}")
    if history:
        lines.append("【最近对话】")
        for t in history[-6:]:
            lines.append(f"{'对方' if t.speaker == 'peer' else '主播'}：{t.text}")
    lines.append(f"【对方刚说】{current}")
    lines.append("请给出主播此刻最该回的 3 句话：")
    return "\n".join(lines)


_CAND_RE = re.compile(r"^\s*\d\s*[)）.、:：]\s*(.+)$")
_TAIL_OK = re.compile(r"[，。！？吧呢啊嘛]$")


def parse_candidates(raw: str) -> list[str]:
    out: list[str] = []
    for line in raw.split("\n"):
        m = _CAND_RE.match(line)
        if m:
            t = m.group(1).strip().strip("\"'`「『\"'」』")
            if t:
                out.append(t)
            continue
        plain = line.strip()
        if not plain or plain.startswith("【") or plain.startswith("```"):
            continue
        if 6 <= len(plain) <= 60 and _TAIL_OK.search(plain):
            out.append(plain)
    return out[:3]
