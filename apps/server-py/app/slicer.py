"""语义切片器：从连续 ASR 输出里切出「完整的一句话」，再送去生成。

三重触发：1) ASR final 强切  2) 语气词收尾+静音尾  3) 超时强切。
实现基于 asyncio 事件循环定时器，与 Node 版 setTimeout 语义一致。
"""
import asyncio
import re
import time

from .config import env

TAIL = re.compile(
    r"(吧|呢|吗|啊|哦|嘛|对不对|是不是|行不行|多少钱|怎么卖|可以吗|好不好|真的假的)[，。！？,.!?]?$"
)

FlushReason = str  # "asr_final" | "tail_word" | "silence" | "timeout" | "reset"


class Slicer:
    def __init__(self, cfg: dict | None, on_flush, loop: asyncio.AbstractEventLoop):
        self._silence_ms = (cfg or {}).get("silenceMs", env.SLICER_SILENCE_MS)
        self._max_pending_ms = (cfg or {}).get("maxPendingMs", env.SLICER_MAX_PENDING_MS)
        self._min_chars = (cfg or {}).get("minChars", env.SLICER_MIN_CHARS)
        self._on_flush = on_flush
        self._loop = loop

        self._buf = ""
        self._started_at = 0
        self._timer: asyncio.TimerHandle | None = None

    def _clear(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _flush(self, reason: FlushReason) -> None:
        self._clear()
        text = self._buf.strip()
        self._buf = ""
        self._started_at = 0
        if len(text) >= self._min_chars:
            asyncio.ensure_future(self._on_flush(text, reason))

    def push(self, text: str, is_final: bool) -> None:
        trimmed = text.strip()
        if not trimmed:
            return
        if not self._started_at:
            self._started_at = time.time() * 1000

        changed = trimmed != self._buf
        self._buf = trimmed

        # VAD 门控：重置静音定时器
        self._clear()
        self._timer = self._loop.call_later(self._silence_ms / 1000.0, lambda: self._flush("silence"))

        if is_final:
            self._flush("asr_final")
            return
        if changed and len(self._buf) >= self._min_chars and TAIL.search(self._buf):
            self._flush("tail_word")
            return
        if time.time() * 1000 - self._started_at >= self._max_pending_ms:
            self._flush("timeout")

    def reset(self) -> None:
        self._clear()
        self._buf = ""
        self._started_at = 0


def create_slicer(cfg: dict | None, on_flush, loop: asyncio.AbstractEventLoop) -> Slicer:
    return Slicer(cfg, on_flush, loop)
