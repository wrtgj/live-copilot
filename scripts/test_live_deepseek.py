"""Live 冒烟测试：用真实 DeepSeek key 验证整条生成链路。

流程：注册 -> 取人设 -> WS hello -> 发一条对方话术(asr_text, peer) ->
验证 DeepSeek 通过 LangChain 流式返回 suggestion（delta 帧 + done 终态），
并抓取最终话术文本确认非空。

注意：本测试需要 .env 里 LLM_API_KEY 为真实 DeepSeek key（非 mock）。
"""
import asyncio
import json
import sys
import time

import httpx
import websockets

ROOT = "http://127.0.0.1:8787"
WS = "ws://127.0.0.1:8787/ws"
sys.path.insert(0, "apps/server-py")


async def main():
    checks = []
    def check(name, ok, detail=""):
        checks.append((name, ok, detail))
        print(("PASS" if ok else "FAIL"), name, ("- " + detail) if detail else "")

    async with httpx.AsyncClient(base_url=ROOT, timeout=20) as c:
        email = f"live_test_{int(time.time())}@local.test"
        r = await c.post("/api/auth/register",
                         json={"email": email, "password": "test123456", "nickname": "live"})
        check("注册成功", r.status_code == 200 and r.json().get("code") == 0, str(r.status_code))
        token = r.json()["data"]["token"]

        r = await c.get("/api/personas", headers={"Authorization": f"Bearer {token}"})
        pid = r.json()["data"][0]["id"]
        check("取得人设", pid > 0, f"pid={pid}")

        async with websockets.connect(WS) as ws:
            await ws.send(json.dumps({"t": "hello", "token": token, "personaId": pid}))
            hello = json.loads(await ws.recv())
            print("  hello:", {k: v for k, v in hello.items() if k != "rules"})
            check("WS hello 成功", hello.get("t") == "status" or "personaId" in hello or "voiceprintActive" in hello,
                  str(hello.get("t")))

            # 发一条对方话术（未录声纹 -> 用传入 speaker=peer 直接走生成）
            await ws.send(json.dumps({
                "t": "asr_text", "id": "live1", "text": "这款面膜适合敏感肌吗？孕妇能用不？",
                "isFinal": True, "speaker": "peer",
            }))

            got_transcript = False
            got_start = False
            delta_count = 0
            got_done = False
            suggestions = []  # 累积 suggestion 文本
            deadline = time.time() + 40  # 真实 DeepSeek 留足时间
            while time.time() < deadline:
                try:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
                except asyncio.TimeoutError:
                    break
                t = m.get("t")
                if t == "transcript":
                    got_transcript = True
                elif t == "suggestion":
                    ph = m.get("phase")
                    if ph == "start":
                        got_start = True
                    elif ph == "delta":
                        delta_count += 1
                        if m.get("text"):
                            suggestions.append(m["text"])
                    elif ph in ("done", "abort"):
                        got_done = (ph == "done")
                        break

            full_text = "".join(suggestions)
            check("收到 transcript", got_transcript, f"got_transcript={got_transcript}")
            check("收到 suggestion start", got_start, f"got_start={got_start}")
            check("收到流式 delta 帧", delta_count > 0, f"delta_count={delta_count}")
            check("收到 suggestion done", got_done, f"got_done={got_done}")
            check("DeepSeek 返回非空话术", len(full_text.strip()) > 0,
                  f"chars={len(full_text.strip())} text={full_text[:60]!r}...")

    failed = [c for c in checks if not c[1]]
    print(f"\n=== Live DeepSeek 冒烟：{len(checks)-len(failed)}/{len(checks)} 通过 ===")
    print("生成话术预览：", full_text[:200])
    if failed:
        print("失败项：", [c[0] for c in failed])
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    asyncio.run(main())
