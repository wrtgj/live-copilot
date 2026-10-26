"""LLM Provider（基于 LangChain，默认 DeepSeek 等 OpenAI 兼容服务）。

设计要点：
- 通过 langchain_openai.ChatOpenAI 接入任意 OpenAI 兼容端点
  （DeepSeek / OpenAI / Azure / 腾讯云 MaaS / 本地 vLLM 等），
  只需改 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 即可切换 provider，无需改代码。
- 保留轻量 MockLlm 供 CI / 无 Key 本地演示使用，零费用。
- 对外接口与旧实现完全一致：
  LlmHandle.stream(system, user, on_delta, signal) -> (prompt_tokens, completion_tokens)
"""
import asyncio

from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage

from .config import env

MOCK_REPLY = (
    "1) 宝子你问的这个点我给你说清楚，先别急着下结论。\n"
    "2) 这个问题问得好，咱先看看到底适不适合你再决定。\n"
    "3) 你要是信得过我，我给你一个最实在的建议。"
)


class LlmHandle:
    async def stream(self, system: str, user: str, on_delta, signal=None) -> tuple[int, int]:
        raise NotImplementedError

    def name(self) -> str:
        raise NotImplementedError


class MockLlm(LlmHandle):
    """无 Key 时的降级实现：逐字符流式吐固定话术，零费用。"""

    def name(self) -> str:
        return "mock"

    async def stream(self, system: str, user: str, on_delta, signal=None) -> tuple[int, int]:
        await asyncio.sleep(0.26)  # 模拟首 token 延迟
        for ch in MOCK_REPLY:
            if signal is not None and signal.cancelled():
                break
            await on_delta(ch)
            await asyncio.sleep(0.012)
        return 320, 64


class LangChainLlm(LlmHandle):
    """基于 LangChain ChatOpenAI 的流式实现（OpenAI 兼容协议）。"""

    def __init__(self):
        self._model = ChatOpenAI(
            model=env.LLM_MODEL,
            temperature=env.LLM_TEMPERATURE,
            top_p=env.LLM_TOP_P,
            max_tokens=env.LLM_MAX_TOKENS,
            openai_api_base=env.LLM_BASE_URL,
            openai_api_key=env.LLM_API_KEY or "sk-empty",
            streaming=True,
            timeout=env.LLM_TIMEOUT_MS / 1000.0,
            max_retries=2,
        )

    def name(self) -> str:
        return f"langchain:{env.LLM_PROVIDER}"

    async def stream(self, system: str, user: str, on_delta, signal=None) -> tuple[int, int]:
        messages = [SystemMessage(content=system), HumanMessage(content=user)]
        prompt_tokens = 0
        completion_tokens = 0
        async for chunk in self._model.astream(messages):
            if signal is not None and signal.cancelled():
                break
            delta = self._extract_text(chunk)
            if delta:
                await on_delta(delta)
            um = getattr(chunk, "usage_metadata", None)
            if um is not None:
                if isinstance(um, dict):
                    prompt_tokens = um.get("input_tokens", prompt_tokens) or prompt_tokens
                    completion_tokens = um.get("output_tokens", completion_tokens) or completion_tokens
                else:
                    prompt_tokens = getattr(um, "input_tokens", prompt_tokens) or prompt_tokens
                    completion_tokens = getattr(um, "output_tokens", completion_tokens) or completion_tokens
        return prompt_tokens, completion_tokens

    @staticmethod
    def _extract_text(chunk) -> str:
        """LangChain 的 content 可能是 str，也可能是多模态 list；统一抽成纯文本。"""
        content = getattr(chunk, "content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    parts.append(item.get("text", ""))
                else:
                    parts.append(str(item))
            return "".join(parts)
        return "" if content is None else str(content)


def create_llm() -> LlmHandle:
    if not env.LLM_API_KEY or env.LLM_API_KEY.startswith("sk-xxx"):
        print("[llm] 未配置 LLM_API_KEY，已降级为 mock 模式（演示可用，不产生费用）")
        return MockLlm()
    return LangChainLlm()
