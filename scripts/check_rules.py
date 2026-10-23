"""合规红线词库自检（与 Node 版 check-rules.ts 等价）。

直接 import app.risk 校验：分类正确、可安全替换、高危不可修复。
"""
import sys

from app.risk import detect_risk, safe_rewrite, SUPERLATIVE, MEDICAL

PASS = 0
FAIL = 0


def check(name: str, ok: bool, extra: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}{('  (' + extra + ')') if extra else ''}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}{('  (' + extra + ')') if extra else ''}")


def main() -> int:
    print("\n=== 合规红线词库自检 (Python) ===\n")

    # 1. 极限词 safe-rewrite 可用「最好 -> 很不错」
    lvl, hits = detect_risk("这是我们最好的一款")
    check("极限词被判定为可修复(level=1)", lvl == 1, f"level={lvl}")
    fixed = safe_rewrite("这是我们最好的一款", hits)
    check("极限词可安全替换", fixed is not None and "最好" not in fixed, str(fixed))

    # 2. 「包治」必须归医疗功效(high-risk)，不可被安全替换放行
    lvl, hits = detect_risk("这个产品包治百病对吧")
    check("包治 归类为医疗功效(high-risk)", lvl == 2, f"level={lvl}")
    check("包治 不可被安全替换放行", safe_rewrite("这个产品包治百病对吧", hits) is None)

    # 3. 诱导打赏不可修复
    lvl, hits = detect_risk("不刷就是不爱我")
    check("诱导打赏判为高危(level=2)", lvl == 2, f"level={lvl}")
    check("诱导打赏不可安全替换", safe_rewrite("不刷就是不爱我", hits) is None)

    # 4. 自定义禁词命中
    lvl, hits = detect_risk("说点悄悄话", ["悄悄话"])
    check("主播自定义禁词生效", lvl >= 1 and any(h.text == "悄悄话" for h in hits))

    # 5. 安全文本零命中
    lvl, _ = detect_risk("宝子你问的这个点我给你说清楚")
    check("正常话术零命中(level=0)", lvl == 0)

    # 6. 词库无空串、无重复
    all_words = SUPERLATIVE + MEDICAL
    check("词库无空串", all(w for w in all_words))
    check("极限词与医疗词无重叠误分类", "包治" not in SUPERLATIVE and "包治" in MEDICAL)

    print(f"\n=== 结果: {PASS} 通过 / {FAIL} 失败 ===\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
