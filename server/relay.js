/**
 * 心拍ローカル中継サーバー
 * 同一WiFi内で M5Stack → PC → スマホ の経路にし、Firebase 往復のラグを削減する。
 * POST /beat でタイムスタンプを受信し、WebSocket 接続中のクライアントに即時配信する。
 */

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = 8765;
const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let clientCount = 0;

wss.on("connection", (ws, req) => {
  clientCount++;
  console.log(`[relay] WebSocket 接続 (合計 ${clientCount})`);
  ws.on("close", () => {
    clientCount--;
    console.log(`[relay] WebSocket 切断 (残り ${clientCount})`);
  });
});

// M5Stack から心拍を受信（ts, count をそのまま配信）
app.post("/beat", (req, res) => {
  const body = req.body || {};
  const ts = body.ts !== undefined ? body.ts : Date.now();
  const count = body.count !== undefined ? body.count : null;
  const payload = JSON.stringify({ ts, count });
  let sent = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
      sent++;
    }
  });
  console.log(`[relay] beat received (#${count}, ts=${ts}) → ${sent} client(s)`);
  res.status(200).send("ok");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[relay] 心拍中継サーバー http://0.0.0.0:${PORT}`);
  console.log(`[relay] M5Stack は POST http://<このPCのIP>:${PORT}/beat に送信`);
  console.log(`[relay] ウェブは ws://<このPCのIP>:${PORT} で接続`);
});
