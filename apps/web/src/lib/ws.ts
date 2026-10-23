import type { C2S, S2C } from "./protocol";
import { WS_PATH } from "./protocol";

const HEARTBEAT_MS = 15000;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private hb: number | null = null;
  private retries = 0;
  private closedByUser = false;

  onMessage: (m: S2C) => void = () => {};
  onState: (state: "connecting" | "open" | "closed" | "reconnecting") => void = () => {};

  connect(token: string, personaId: number, sessionId?: number) {
    this.closedByUser = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}${WS_PATH}`;
    this.onState("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this.onState("open");
      this.send({ t: "hello", token, personaId, sessionId });
      this.hb = window.setInterval(() => this.send({ t: "control", op: "ping" }), HEARTBEAT_MS);
    };

    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data) as S2C);
      } catch {
        /* ignore */
      }
    };

    ws.onclose = () => {
      if (this.hb) clearInterval(this.hb);
      if (this.closedByUser) return this.onState("closed");
      if (this.retries >= 3) return this.onState("closed");
      this.retries++;
      this.onState("reconnecting");
      window.setTimeout(() => this.connect(token, personaId, sessionId), 1000 * 2 ** (this.retries - 1));
    };

    ws.onerror = () => {
      /* onclose 会接管重连 */
    };
  }

  send(m: C2S) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.closedByUser = true;
    if (this.hb) clearInterval(this.hb);
    this.ws?.close();
    this.ws = null;
  }
}
