"""single-flight 控制：节流 + 文本去重 + 取消在途生成。

目的：防止 ASR 的 interim 抖动导致 LLM 被疯狂调用（成本与时延双重风险）。
async 版本：用 asyncio.Task 的 cancel 实现「取消在途请求」。
"""
import asyncio
import hashlib
import re
import time

from .config import env

_NORMALIZE_RE = re.compile(r"[\s，。！？,.!?、啊呃嗯]")


def _normalize(t: str) -> str:
    return _NORMALIZE_RE.sub("", t)


def _key(t: str) -> str:
    return hashlib.md5(_normalize(t).encode("utf-8")).hexdigest()


class SingleFlight:
    def __init__(self):
        self._recent: dict[str, float] = {}
        self._current: dict | None = None  # {gen_id, at, task}
        self._next = 1

    def request(self, text: str) -> tuple[bool, str | None, int]:
        """判定是否可发起新生成。返回 (go, reason, gen_id)。go=False 时不调 LLM。"""
        now = time.time() * 1000
        key = _key(text)

        # 1) 去重：短时间内重复文本
        last = self._recent.get(key)
        if last is not None and now - last < env.GEN_DEDUP_MS:
            return False, "dup", 0

        # 2) 节流：与上次间隔不足
        if self._current is not None and now - self._current["at"] < env.GEN_MIN_INTERVAL_MS:
            return False, "throttle", 0

        # 3) 取消在途请求（主播又说了新的一句话）
        self._cancel_current()

        self._recent[key] = now
        gen_id = self._next
        self._next += 1
        self._current = {"gen_id": gen_id, "at": now, "task": None}
        return True, None, gen_id

    def bind(self, gen_id: int, task: asyncio.Task) -> None:
        if self._current is not None and self._current["gen_id"] == gen_id:
            self._current["task"] = task

    def abort(self) -> None:
        self._cancel_current()

    def finish(self, gen_id: int) -> None:
        if self._current is not None and self._current["gen_id"] == gen_id:
            self._current = None

    def next_gen_id(self) -> int:
        g = self._next
        self._next += 1
        return g

    def reserve(self) -> int:
        """强制预占一个 genId（用于 regenerate，跳过去重/节流）。"""
        gen_id = self._next
        self._next += 1
        self._current = {"gen_id": gen_id, "at": time.time() * 1000, "task": None}
        return gen_id

    def _cancel_current(self) -> None:
        if self._current is not None and self._current.get("task") is not None:
            self._current["task"].cancel()
        self._current = None
