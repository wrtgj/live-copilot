"""配置层：加载 .env（项目根目录），提供与 Node 版等价的默认值。"""
import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# apps/server-py/app/config.py -> parents[3] == live-script-copilot/
ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")


def _num(v: str | None, d: int) -> int:
    if v is None or v == "":
        return d
    try:
        return int(v)
    except ValueError:
        return d


def _float(v: str | None, d: float) -> float:
    if v is None or v == "":
        return d
    try:
        return float(v)
    except ValueError:
        return d


def _bool(v: str | None, d: bool) -> bool:
    if v is None:
        return d
    return v.lower() in ("on", "true", "1")


def _parse_expiry(v: str | None, d: str) -> int:
    """把 '2h' / '30m' / '60' 解析为秒数。"""
    v = (v or d).strip().lower()
    m = re.match(r"^(\d+)\s*([hsm]?)$", v)
    if not m:
        return 7200
    n = int(m.group(1))
    unit = m.group(2)
    mul = {"h": 3600, "m": 60, "s": 1, "": 1}[unit]
    return n * mul


@dataclass(frozen=True)
class Env:
    NODE_ENV: str = os.getenv("NODE_ENV", "development")
    PORT: int = _num(os.getenv("PORT"), 8787)
    CORS_ORIGIN: str = os.getenv("CORS_ORIGIN", "http://localhost:5173")

    JWT_SECRET: str = os.getenv("JWT_SECRET", "dev-secret-change-me")
    JWT_EXPIRES_IN: int = _parse_expiry(os.getenv("JWT_EXPIRES_IN"), "2h")

    DATABASE_URL: str = os.getenv("DATABASE_URL", "./data/app.db")

    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "deepseek")
    LLM_BASE_URL: str = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
    LLM_API_KEY: str = os.getenv("LLM_API_KEY", "")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "deepseek-chat")
    LLM_TEMPERATURE: float = _float(os.getenv("LLM_TEMPERATURE"), 0.8)
    LLM_MAX_TOKENS: int = _num(os.getenv("LLM_MAX_TOKENS"), 120)
    LLM_TOP_P: float = _float(os.getenv("LLM_TOP_P"), 0.95)
    LLM_TIMEOUT_MS: int = _num(os.getenv("LLM_TIMEOUT_MS"), 8000)

    SLICER_SILENCE_MS: int = _num(os.getenv("SLICER_SILENCE_MS"), 350)
    SLICER_MAX_PENDING_MS: int = _num(os.getenv("SLICER_MAX_PENDING_MS"), 2500)
    SLICER_MIN_CHARS: int = _num(os.getenv("SLICER_MIN_CHARS"), 4)
    GEN_MIN_INTERVAL_MS: int = _num(os.getenv("GEN_MIN_INTERVAL_MS"), 1200)
    GEN_DEDUP_MS: int = _num(os.getenv("GEN_DEDUP_MS"), 3000)

    WS_HEARTBEAT_MS: int = _num(os.getenv("WS_HEARTBEAT_MS"), 15000)
    WS_TIMEOUT_MS: int = _num(os.getenv("WS_TIMEOUT_MS"), 45000)

    FEATURE_GENERATE: bool = _bool(os.getenv("FEATURE_GENERATE"), True)
    MAX_LLM_CALLS_PER_SESSION: int = _num(os.getenv("MAX_LLM_CALLS_PER_SESSION"), 400)

    # 声纹（说话人识别）
    VOICEPRINT_BACKEND: str = os.getenv("VOICEPRINT_BACKEND", "auto")  # auto | wespeaker | mfcc
    VOICEPRINT_HOST_THRESHOLD: float = _float(os.getenv("VOICEPRINT_HOST_THRESHOLD"), 0.80)
    VOICEPRINT_CHUNK_MS: int = _num(os.getenv("VOICEPRINT_CHUNK_MS"), 1000)

    @property
    def db_path(self) -> Path:
        p = Path(self.DATABASE_URL)
        if not p.is_absolute():
            p = ROOT / p
        return p


env = Env()
