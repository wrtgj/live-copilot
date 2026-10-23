"""声纹（说话人识别）模块。

设计目标：让系统「提前录入主播声音」，直播时判定当前说话人是不是主播本人，
从而把 asr_text 动态标成 host / peer，解决「只给对方的提问生成话术」的核心问题。

两条后端：
- wespeaker（真实说话人嵌入，需 torch + 模型，生产推荐）：自动探测，可用则启用；
- MFCC 基线（纯 numpy 自实现，零额外依赖）：作为兜底 / 本地跑通流程用，
  准确率有限，**仅用于演示链路**，生产务必切换 wespeaker。

输入约定：前端统一发送 16kHz 单声道 PCM16（Int16）的 base64，服务端不再做编解码。
"""
import base64
import io
import threading
from typing import Any

import numpy as np

from .config import env

try:
    import wespeaker  # type: ignore
    _WESPEAKER_OK = True
except Exception:  # pragma: no cover
    _WESPEAKER_OK = False


def _hz2mel(hz: float) -> float:
    return 2595.0 * np.log10(1.0 + hz / 700.0)


def _mel2hz(mel: float) -> float:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def _mel_filterbank(nfilt: int, nfft: int, sr: int) -> np.ndarray:
    """构建 Mel 三角滤波器组 (nfilt, nfft//2+1)。"""
    low = _hz2mel(0.0)
    high = _hz2mel(sr / 2.0)
    mel_pts = np.linspace(low, high, nfilt + 2)
    hz_pts = _mel2hz(mel_pts)
    bin_pts = np.floor((nfft + 1) * hz_pts / sr).astype(int)
    fb = np.zeros((nfilt, nfft // 2 + 1), dtype=np.float32)
    for i in range(nfilt):
        l, c, r = bin_pts[i], bin_pts[i + 1], bin_pts[i + 2]
        if c == l:
            c = l + 1
        if r == c:
            r = c + 1
        for k in range(l, c):
            fb[i, k] = (k - l) / (c - l)
        for k in range(c, r):
            fb[i, k] = (r - k) / (r - c)
    return fb


def _dct2(n: int, k: int) -> np.ndarray:
    """DCT-II 变换矩阵 (k, n)。"""
    x = np.arange(n)[None, :] * (2 * np.arange(k)[:, None] + 1) * np.pi / (2.0 * n)
    return np.cos(x)


def _mfcc_numpy(wav: np.ndarray, sr: int = 16000, numcep: int = 13,
                nfilt: int = 26, nfft: int = 512, winlen: float = 0.025,
                winstep: float = 0.01) -> np.ndarray:
    """纯 numpy 的 MFCC（含预加重、Hamming 窗、Mel 滤波、对数、DCT-II）。"""
    if wav.size < int(winlen * sr):
        return np.zeros((1, numcep), dtype=np.float32)
    preemph = 0.97
    emph = np.append(wav[0], wav[1:] - preemph * wav[:-1]).astype(np.float32)

    frame_len = int(winlen * sr)
    frame_step = int(winstep * sr)
    nframes = 1 + (emph.size - frame_len) // frame_step
    if nframes <= 0:
        return np.zeros((1, numcep), dtype=np.float32)

    frames = np.lib.stride_tricks.sliding_window_view(emph, frame_len)[::frame_step][:nframes]
    window = np.hamming(frame_len).astype(np.float32)
    frames = frames * window

    spec = np.abs(np.fft.rfft(frames, n=nfft)) ** 2
    fb = _mel_filterbank(nfilt, nfft, sr)
    fbank = spec @ fb.T
    fbank = np.where(fbank == 0, 1e-10, fbank)
    fbank = np.log(fbank)

    dct = _dct2(nfilt, numcep)
    feats = fbank @ dct.T
    # 第 0 系数（总能量）波动大，置零，保留 1..numcep-1 的谱包络作为说话人特征
    feats[:, 0] = 0.0
    return feats.astype(np.float32)


def _resample_pcm16(pcm: bytes, sample_rate: int, target: int = 16000) -> np.ndarray:
    """PCM16 字节 -> 目标采样率的 float32 波形（线性插值重采样）。"""
    if len(pcm) < 2:
        return np.zeros(1, dtype=np.float32)
    ints = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if sample_rate == target:
        return ints
    ratio = target / float(sample_rate)
    new_len = max(1, int(round(len(ints) * ratio)))
    idx = np.arange(new_len) / ratio
    lo = np.floor(idx).astype(np.int64)
    hi = np.minimum(lo + 1, len(ints) - 1)
    frac = (idx - lo).astype(np.float32)
    out = ints[lo] * (1 - frac) + ints[hi] * frac
    return out.astype(np.float32)


def _ndarray_to_b64(a: np.ndarray) -> str:
    buf = io.BytesIO()
    np.save(buf, a, allow_pickle=False)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _b64_to_ndarray(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    return np.load(io.BytesIO(raw), allow_pickle=False)


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape or a.size == 0:
        return 0.0
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


class Voiceprint:
    """声纹注册 / 校验。单例，wespeaker 模型懒加载。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ws_model = None
        self._ws_loaded = False
        self.backend = self._resolve_backend()

    @staticmethod
    def _resolve_backend() -> str:
        if _WESPEAKER_OK and env.VOICEPRINT_BACKEND in ("auto", "wespeaker"):
            return "wespeaker"
        return "mfcc"  # numpy 自实现，永远可用

    # ---- wespeaker 真实后端 ----
    def _ensure_ws(self):
        if self._ws_loaded:
            return self._ws_model
        self._ws_model = wespeaker.load_model()  # 默认中文模型
        self._ws_loaded = True
        return self._ws_model

    def _embed_wespeaker(self, pcm: bytes, sr: int) -> np.ndarray:
        wav = _resample_pcm16(pcm, sr, 16000)
        model = self._ensure_ws()
        emb = model.extract_embedding(wav.astype(np.float32))
        return np.asarray(emb, dtype=np.float32)

    # ---- MFCC 基线后端（纯 numpy） ----
    def _embed_mfcc(self, pcm: bytes, sr: int) -> np.ndarray:
        wav = _resample_pcm16(pcm, sr, 16000)
        peak = np.max(np.abs(wav)) + 1e-6
        wav = wav / peak  # 能量归一，抑制音量差异
        feats = _mfcc_numpy(wav, sr=16000)
        # MSCC：每维系数的均值 + 标准差，比单纯均值更具说话人区分度
        mean = feats.mean(axis=0)
        std = feats.std(axis=0) + 1e-6
        vec = np.concatenate([mean, std]).astype(np.float32)
        n = np.linalg.norm(vec)
        if n > 0:
            vec = vec / n
        return vec

    # ---- 公共接口 ----
    def embed(self, pcm: bytes, sample_rate: int) -> np.ndarray:
        if self.backend == "wespeaker":
            return self._embed_wespeaker(pcm, sample_rate)
        return self._embed_mfcc(pcm, sample_rate)

    def enroll(self, pcm: bytes, sample_rate: int) -> dict[str, Any]:
        emb = self.embed(pcm, sample_rate)
        return {
            "embedding_b64": _ndarray_to_b64(emb),
            "backend": self.backend,
            "dims": int(emb.size),
        }

    def verify(self, chunk_pcm: bytes, chunk_sr: int, enrolled_b64: str) -> dict[str, Any]:
        try:
            enrolled = _b64_to_ndarray(enrolled_b64)
        except Exception:
            return {"is_host": False, "score": 0.0, "backend": self.backend, "error": "enrolled 解析失败"}
        try:
            emb = self.embed(chunk_pcm, chunk_sr)
        except Exception as e:  # pragma: no cover
            return {"is_host": False, "score": 0.0, "backend": self.backend, "error": str(e)}
        score = _cosine(emb, enrolled)
        is_host = score >= env.VOICEPRINT_HOST_THRESHOLD
        return {
            "is_host": bool(is_host),
            "score": round(score, 4),
            "backend": self.backend,
            "threshold": env.VOICEPRINT_HOST_THRESHOLD,
        }


# 模块级单例（同进程内复用 wespeaker 模型）
_vp: Voiceprint | None = None


def get_voiceprint() -> Voiceprint:
    global _vp
    if _vp is None:
        _vp = Voiceprint()
    return _vp
