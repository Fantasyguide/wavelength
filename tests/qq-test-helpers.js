"use strict";

const { WebSocketServer } = require("ws");
const { once } = require("events");

async function waitFor(check, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out: " + label);
}

async function mockSatori(token = "test-qq-token") {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/v1/events" });
  await once(wss, "listening");
  const mock = {
    url: `ws://127.0.0.1:${wss.address().port}/v1/events`,
    token, connections: [], identifies: [], pings: 0, replyPong: true, rejectAuth: false,
    login: { sn: 1, platform: "llonebot", user: { id: "90001" }, status: 1 }
  };
  wss.on("connection", socket => {
    mock.connections.push(socket);
    socket.on("error", () => {});
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes);
      if (frame.op === 3) {
        mock.identifies.push(frame.body);
        if (frame.body.token !== token || mock.rejectAuth) return socket.close(4004, "invalid token");
        socket.send(JSON.stringify({ op: 4, body: { logins: [mock.login] } }));
      }
      if (frame.op === 1) {
        mock.pings++;
        if (mock.replyPong) socket.send(JSON.stringify({ op: 2 }));
      }
    });
  });
  mock.send = frame => mock.connections.at(-1).send(JSON.stringify(frame));
  mock.close = async () => {
    wss.clients.forEach(socket => socket.terminate());
    await new Promise(resolve => wss.close(resolve));
  };
  return mock;
}

let seq = 0;
function message(userId, content, extra = {}) {
  const sn = ++seq;
  const now = Date.now();
  return { sn, type: "message-created", timestamp: now,
    login: { sn: 1, platform: "llonebot", user: { id: "90001" } },
    channel: { id: "123456789", type: 0 }, guild: { id: "123456789" },
    user: { id: userId, name: "昵称" + userId, avatar: "http://q.qlogo.cn/headimg_dl?dst_uin=" + userId },
    member: { nick: "群名片" + userId },
    message: { id: "2:123456789:" + sn, content, created_at: Math.floor(now / 1000) * 1000 },
    ...extra };
}

module.exports = { waitFor, mockSatori, message };
