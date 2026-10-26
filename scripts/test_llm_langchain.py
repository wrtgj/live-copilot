"""LangChain LLM 适配层单元测试（不依赖真实 API Key / 网络）。

覆盖：
1. create_llm() 在无 Key 时降级为 MockLlm；
2. LangChainLlm 走 astream 流式，逐块回调 on_delta，并能从 usage_metadata 抽取 token 数；
3. _extract_text 正确处理 content 为 str / list[str] / list[dict] / None 的形态；
4. signal 已取消时流式提前终止，不阻塞。

运行：
    python scripts/test_llm_langchain.py
"""
import asyncio
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "apps", "server-py"))

from langchain_core.messages import AIMessageChunk  # noqa: E402

from app.llm import LangChainLlm, MockLlm, create_llm  # noqa: E402

_PASSED = 0
_FAILED = 0


def check(name: str, cond: bool, info: str = "") -> bool:
    global _PASSED, _FAILED
    if cond:
        _PASSED += 1
        print("PASS " + name + (f"  [{info}]" if info else ""))
    else:
        _FAILED += 1
        print("FAIL " + name + (f"  [{info}]" if info else ""))
    return cond


class FakeStreamModel:
    """最小的异步流式模型：分块吐字，最后一块带 usage_metadata。"""

    def __init__(self, pieces, prompt_tokens=10, completion_tokens=6):
        self._pieces = pieces
        self._pt = prompt_tokens
        self._ct = completion_tokens

    async def astream(self, messages):
        for i, piece in enumerate(self._pieces):
            chunk = AIMessageChunk(content=piece)
            if i == len(self._pieces) - 1:
                chunk.usage_metadata = {
                    "input_tokens": self._pt,
                    "output_tokens": self._ct,
                    "total_tokens": self._pt + self._ct,
                }
            yield chunk


async def _on_delta(buf, c):
    buf.append(c)


async def test_langchain_stream():
    lc = LangChainLlm()
    check("LangChainLlm.name() 以 langchain: 开头", lc.name().startswith("langchain:"), lc.name())

    lc._model = FakeStreamModel(["你好，", "这是", "流式测试。"])

    chunks = []
    pt, ct = await lc.stream("sys-prompt", "user-text", lambda c: _on_delta(chunks, c))
    text = "".join(chunks)
    check("流式文本拼接正确", text == "你好，这是流式测试。", repr(text))
    check("on_delta 被逐块回调(>=3 次)", len(chunks) >= 3, f"chunks={len(chunks)}")
    check("从 usage_metadata 取到 prompt_tokens", pt == 10, f"pt={pt}")
    check("从 usage_metadata 取到 completion_tokens", ct == 6, f"ct={ct}")


async def test_signal_cancel():
    lc = LangChainLlm()

    class ImmediateCancel:
        def cancelled(self):
            return True

    lc._model = FakeStreamModel(["a", "b", "c"])
    chunks = []
    await lc.stream("s", "u", lambda c: _on_delta(chunks, c), signal=ImmediateCancel())
    check("signal 已取消时返回空(无阻塞)", chunks == [], f"chunks={chunks}")


def test_extract_text():
    class _C:
        def __init__(self, content):
            self.content = content

    check("extract str", LangChainLlm._extract_text(_C("hi")) == "hi")
    check("extract list[str]", LangChainLlm._extract_text(_C(["a", "b"])) == "ab")
    check("extract list[dict text]", LangChainLlm._extract_text(_C([{"text": "x"}, {"text": "y"}])) == "xy")
    check("extract list[mixed]", LangChainLlm._extract_text(_C(["a", {"text": "b"}, "c"])) == "abc")
    check("extract None", LangChainLlm._extract_text(_C(None)) == "")
    check("extract int fallback", LangChainLlm._extract_text(_C(123)) == "123")


def test_create_llm_fallback():
    llm = create_llm()
    check("无 Key 时 create_llm() 返回 MockLlm", isinstance(llm, MockLlm))
    check("MockLlm.name() == 'mock'", llm.name() == "mock")


async def main_async():
    test_create_llm_fallback()
    await test_langchain_stream()
    await test_signal_cancel()
    test_extract_text()


def main() -> int:
    asyncio.run(main_async())
    print(f"\n=== summary: {_PASSED} passed, {_FAILED} failed ===")
    return 1 if _FAILED > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
