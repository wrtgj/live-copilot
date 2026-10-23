"""模板话术兜底：LLM 不可用 / 熔断时，按意图关键词返回行业模板话术。

保证「永远有卡片可读」——这是 L1 降级的核心。
"""


class IntentTemplate:
    def __init__(self, intent: str, keywords: list[str], scripts: list[str]):
        self.intent = intent
        self.keywords = keywords
        self.scripts = scripts


TEMPLATES: list[IntentTemplate] = [
    IntentTemplate("bargain", ["便宜", "降价", "多少钱", "贵", "优惠", "砍价", "最低"], [
        "宝子这个价我已经是给到底了，不信你去看看别家同款。",
        "今天这个优惠是我掏腰包补贴的，过了今天就恢复原价。",
        "你要真想要，我再给你申请一份小礼物，但不能再便宜了。",
    ]),
    IntentTemplate("quality", ["质量", "好用吗", "靠谱", "行不行", "坏", "退", "保修"], [
        "质量问题你放心，七天无理由，坏了我们直接换新。",
        "我自己也在用这款，用了三个月没出任何问题。",
        "咱们家售后是实打实的，有问题找客服秒回。",
    ]),
    IntentTemplate("mock", ["骗人", "假的", "智商税", "差评", "投诉", "黑"], [
        "你有顾虑很正常，我先给你看点真实反馈再下结论。",
        "我不急着让你下单，你先了解一下再决定也不迟。",
        "这话我听过很多次，咱们用事实说话好不好。",
    ]),
    IntentTemplate("size", ["尺码", "多大", "号", "适合", "胖", "瘦", "身材"], [
        "你告诉我身高体重，我直接帮你挑最合适的号。",
        "这款版型偏宽松，按平时穿的号拍就可以。",
        "拿不准的话拍大一码，换货我们包邮。",
    ]),
    IntentTemplate("shipping", ["发货", "快递", "几天", "物流", "什么时候到"], [
        "今天拍下今天发，正常两三天就能到。",
        "现货现发，不用等预售，拍下就有单号。",
        "偏远地区可能多两天，其他都很快。",
    ]),
    IntentTemplate("pk", ["pk", "连麦", "打榜", "比", "输", "赢", "榜"], [
        "来啊，谁怕谁，今晚就看看谁的粉丝更给力。",
        "这把我要是输了，当场给大家表演一个才艺。",
        "家人们，这一波就靠你们了，咱们一起冲上去。",
    ]),
    IntentTemplate("praise", ["好看", "厉害", "喜欢你", "漂亮", "支持", "爱"], [
        "谢谢宝子，被你这么一说我今晚更有劲儿了。",
        "有你们在，我播到凌晨都不觉得累。",
        "喜欢的话点点关注，下次开播我第一时间叫你。",
    ]),
    IntentTemplate("hesitate", ["考虑", "再看看", "犹豫", "要不要", "不确定"], [
        "可以先放购物车，但这个库存真的撑不到明天。",
        "你要是还在犹豫，我帮你把优缺点说一下再定。",
        "先别急着决定，我再给你看一眼细节。",
    ]),
]

GENERIC = ["宝子你再说细一点，我给你一个准话。",
           "这个我懂，你把情况说完我来帮你拿主意。",
           "别急，咱们一步一步把这个事捋清楚。"]


def match_template(text: str) -> dict:
    best = None
    for t in TEMPLATES:
        hit = sum(1 for k in t.keywords if k in text)
        if hit > 0 and (best is None or hit > best[0]):
            best = (hit, t)
    if best is None:
        return {"intent": "generic", "scripts": GENERIC}
    return {"intent": best[1].intent, "scripts": best[1].scripts}
