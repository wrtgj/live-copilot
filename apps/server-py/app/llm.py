"""LLM Provider（OpenAI 兼容协议，默认 DeepSeek）。

支持 mock 模式：CI / 无 Key 本地演示时使用，不产生任何费用。
"""
import asyncio
import json

import httpx

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


class OpenAICompatLlm(LlmHandle):
    def __init__(self):
        self._client = httpx.AsyncClient(
            base_url=env.LLM_BASE_URL,
            headers={"Authorization": f"Bearer {env.LLM_API_KEY or 'sk-empty'}"},
            timeout=env.LLM_TIMEOUT_MS / 1000.0,
        )

    def name(self) -> str:
        return env.LLM_PROVIDER

    async def stream(self, system: str, user: str, on_delta, signal=None) -> tuple[int, int]:
        url = "/chat/completions"
        payload = {
            "model": env.LLM_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": env.LLM_TEMPERATURE,
            "top_p": env.LLM_TOP_P,
            "max_tokens": env.LLM_MAX_TOKENS,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        prompt_tokens = 0
        completion_tokens = 0
        async with self._client.stream("POST", url, json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = obj.get("choices") or []
                if choices:
                    delta = (choices[0].get("delta") or {}).get("content") or ""
                    if delta:
                        await on_delta(delta)
                usage = obj.get("usage")
                if usage:
                    prompt_tokens = usage.get("prompt_tokens", 0) or prompt_tokens
                    completion_tokens = usage.get("completion_tokens", 0) or completion_tokens
        return prompt_tokens, completion_tokens


def create_llm() -> LlmHandle:
    if not env.LLM_API_KEY or env.LLM_API_KEY.startswith("sk-xxx"):
        print("[llm] 未配置 LLM_API_KEY，已降级为 mock 模式（演示可用，不产生费用）")
        return MockLlm()
    return OpenAICompatLlm()
