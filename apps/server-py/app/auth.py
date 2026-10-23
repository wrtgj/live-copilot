"""鉴权：JWT 签发/校验 + FastAPI 依赖。"""
import time
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request

from .config import env

_ALGO = "HS256"


def make_token(uid: int) -> str:
    exp = int(time.time()) + env.JWT_EXPIRES_IN
    return jwt.encode({"uid": uid, "exp": exp}, env.JWT_SECRET, algorithm=_ALGO)


def verify_token(token: str | None) -> int | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, env.JWT_SECRET, algorithms=[_ALGO])
        return int(payload["uid"])
    except Exception:
        return None


def get_uid(request: Request) -> int:
    h = request.headers.get("authorization", "")
    token = h[7:] if h.startswith("Bearer ") else ""
    uid = verify_token(token)
    if uid is None:
        raise HTTPException(status_code=401, detail="未登录或登录已失效")
    return uid


Uid = Annotated[int, Depends(get_uid)]
