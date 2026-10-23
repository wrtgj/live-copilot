import http from "node:http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { env } from "./env.js";
import { registerRoutes } from "./http/api.js";
import { handleConnection } from "./realtime/gateway.js";
import { WS_PATH } from "./protocol.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: env.CORS_ORIGIN.split(","), credentials: true }));

registerRoutes(app);

app.use((_req, res) => res.status(404).json({ code: 404, message: "Not Found", data: null }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (ws) => {
  console.log("[ws] client connected, total =", wss.clients.size);
  handleConnection(ws);
  ws.on("close", () => console.log("[ws] client disconnected, total =", wss.clients.size));
});

server.listen(env.PORT, () => {
  console.log(`\n  Live Script Copilot · API 已启动`);
  console.log(`  REST:  http://localhost:${env.PORT}/healthz`);
  console.log(`  WS:    ws://localhost:${env.PORT}${WS_PATH}`);
  console.log(`  LLM:   ${env.LLM_PROVIDER}${env.LLM_API_KEY && !env.LLM_API_KEY.startsWith("sk-xxx") ? " (已配置)" : " (mock 模式)"}`);
  console.log(`  生成:  ${env.FEATURE_GENERATE ? "开启" : "已关闭（降级为仅转写）"}\n`);
});

process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, closing...");
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});
