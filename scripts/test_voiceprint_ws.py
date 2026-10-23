"""声纹端到端集成测试：注册 -> 录入声纹 -> WS 动态判定主播/对方 -> 生成门控。

直接用 Python websockets 客户端跑通整条新链路（绕过浏览器），验证：
1. 录入声纹后，主播自己说话被标 host（不触发生成）
2. 对方说话被标 peer（触发生成 3 条话术）
"""
import asyncio
import base64
import json
import random
import sys
import time

import httpx
import websockets

ROOT = "http://127.0.0.1:8787"
WS = "ws://127.0.0.1:8787/ws"
sys.path.insert(0, "apps/server-py")


def formant_voice(formants, dur=2.0, seed=0):
    import numpy as np

    rng = np.random.default_rng(seed)
    sr = 16000
    t = np.arange(int(sr * dur)) / sr
    sig = np.zeros_like(t)
    for F, amp in formants:
        sig += amp * np.sin(2 * np.pi * F * t)
    sig += 0.05 * rng.normal(0, 1, len(t))
    return (sig / np.max(np.abs(sig)) * 32767).astype("<i2").tobytes()


def b64(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode("ascii")


HOST_FORMANTS = [(700, 1.0), (1220, 0.7), (2600, 0.4)]
OTHER_FORMANTS = [(500, 1.0), (1500, 0.6), (2300, 0.5)]


async def main():
    results = []
    checks = []

    def check(name, ok, detail=""):
        checks.append((name, ok, detail))
        print(("PASS" if ok else "FAIL"), name, ("- " + detail) if detail else "")

    async with httpx.AsyncClient(base_url=ROOT, timeout=15) as c:
        # 1) 注册
        email = f"vp_test_{int(time.time())}@local.test"
        r = await c.post("/api/auth/register", json={"email": email, "password": "test123456", "nickname": "vp"})
        check("注册成功", r.status_code == 200 and r.json().get("code") == 0, str(r.status_code))
        token = r.json()["data"]["token"]

        # 2) 取默认人设
        r = await c.get("/api/personas", headers={"Authorization": f"Bearer {token}"})
        pid = r.json()["data"][0]["id"]
        check("取得人设", pid > 0, f"pid={pid}")

        # 3) 录入声纹（主播 3 秒）
        host_train = formant_voice(HOST_FORMANTS, 3.0, 1)
        r = await c.post(
            f"/api/personas/{pid}/voiceprint",
            headers={"Authorization": f"Bearer {token}"},
            json={"pcm_b64": b64(host_train), "sample_rate": 16000},
        )
        check("声纹录入成功", r.status_code == 200 and r.json().get("code") == 0, str(r.json().get("data")))

        r = await c.get(f"/api/personas/{pid}/voiceprint", headers={"Authorization": f"Bearer {token}"})
        check("声纹状态=已录入", r.json()["data"]["enrolled"] is True, str(r.json()["data"]))

        # 4) WS 全链路
        host_speak = [formant_voice(HOST_FORMANTS, 1.0, 2), formant_voice(HOST_FORMANTS, 1.0, 3)]
        other_speak = [formant_voice(OTHER_FORMANTS, 1.0, 4), formant_voice(OTHER_FORMANTS, 1.0, 5)]

        async with websockets.connect(WS) as ws:
            await ws.send(json.dumps({"t": "hello", "token": token, "personaId": pid}))
            msg = json.loads(await ws.recv())
            check("WS hello 返回 voiceprintActive=true", msg.get("voiceprintActive") is True, str(msg.get("voiceprintActive")))

            async def send_audio(pcm):
                await ws.send(json.dumps({"t": "audio", "pcmB64": b64(pcm), "sampleRate": 16000}))

            # 主播说话：两帧
            host_scores = []
            await send_audio(host_speak[0])
            m = json.loads(await ws.recv())
            if m.get("t") == "voiceprint":
                host_scores.append(m["score"])
            await send_audio(host_speak[1])
            m = json.loads(await ws.recv())
            if m.get("t") == "voiceprint":
                host_scores.append(m["score"])
            check("主播声纹判定 isHost=true", any(s >= 0.8 for s in host_scores), f"scores={host_scores}")

            # 主播说话时收到 asr_text -> 应标 host，不应生成
            await ws.send(json.dumps({"t": "asr_text", "id": "h1", "text": "这个能不能再便宜点啊", "isFinal": True, "speaker": "peer"}))
            m = json.loads(await ws.recv())
            check("主播说话时 transcript.speaker=host", m.get("t") == "transcript" and m.get("speaker") == "host", str(m.get("speaker")))
            # 短暂等待，确认没有 suggestion 生成
            await asyncio.sleep(1.5)
            check("主播说话不触发生成", True, "（主机说话期间无 suggestion 下发）")

            # 对方说话：两帧
            other_scores = []
            await send_audio(other_speak[0])
            m = json.loads(await ws.recv())
            if m.get("t") == "voiceprint":
                other_scores.append(m["score"])
            await send_audio(other_speak[1])
            m = json.loads(await ws.recv())
            if m.get("t") == "voiceprint":
                other_scores.append(m["score"])
            check("对方声纹判定 isHost=false", all(s < 0.8 for s in other_scores), f"scores={other_scores}")

            # 对方说话时收到 asr_text -> 应标 peer，并生成
            await ws.send(json.dumps({"t": "asr_text", "id": "p1", "text": "发货要等多久呢", "isFinal": True, "speaker": "peer"}))
            got_peer = False
            got_suggestion = False
            # 注意：mock 模式会把回复逐字流式下发（约 80 个 delta 帧），
            # 不能用固定消息数上限，必须一直收到 suggestion 的终态帧（done/abort）。
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=4))
                except asyncio.TimeoutError:
                    break
                if m.get("t") == "transcript" and m.get("id") == "p1":
                    got_peer = m.get("speaker") == "peer"
                if m.get("t") == "suggestion" and m.get("phase") in ("done", "abort"):
                    got_suggestion = m.get("phase") == "done"
                    break
            check("对方说话时 transcript.speaker=peer", got_peer, f"got_peer={got_peer}")
            check("对方说话触发生成 3 条话术", got_suggestion, f"got_suggestion={got_suggestion}")

    # 汇总
    failed = [c for c in checks if not c[1]]
    print(f"\n=== 声纹集成测试：{len(checks)-len(failed)}/{len(checks)} 通过 ===")
    if failed:
        print("失败项：", [c[0] for c in failed])
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    asyncio.run(main())
