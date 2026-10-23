"""FastAPI 应用装配：CORS、REST 路由、/ws 网关、可选静态资源托管。"""
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .config import env
from .routes import router
from .gateway import ws_endpoint

db.init()

app = FastAPI(title="Live Script Copilot API (Python)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=env.CORS_ORIGIN.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.add_api_websocket_route("/ws", ws_endpoint)

# 可选：若前端已构建（apps/web/dist），则由其托管静态资源，方便单机部署
_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa_index(full_path: str):
        index = _DIST / "index.html"
        # 非静态资源请求回落到 SPA 首页（REST/WS 已由上面路由处理）
        if full_path.startswith("api") or full_path.startswith("ws") or full_path.startswith("healthz"):
            return {"detail": "not found"}
        if ( _DIST / full_path).exists() and full_path:
            return FileResponse(str(_DIST / full_path))
        return FileResponse(str(index))


@app.on_event("startup")
async def _startup() -> None:
    db.init()
    mode = "mock 模式" if (not env.LLM_API_KEY or env.LLM_API_KEY.startswith("sk-xxx")) else "已配置真实 LLM"
    print(f"\n  Live Script Copilot · Python 后端已启动")
    print(f"  REST:  http://localhost:{env.PORT}/healthz")
    print(f"  WS:    ws://localhost:{env.PORT}/ws")
    print(f"  LLM:   {env.LLM_PROVIDER}（{mode}）")
    print(f"  生成:  {'开启' if env.FEATURE_GENERATE else '已关闭（降级为仅转写）'}\n")
