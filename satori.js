"use strict";

var qqId = require("./audience.js").qqId;

function isQQ(platform) { return platform === "qq" || platform === "llonebot"; }

function normalizeConfig(raw) {
  raw = raw || {};
  var config = {
    enabled: raw.enabled === true,
    groupId: qqId(raw.groupId),
    url: typeof raw.url === "string" ? raw.url : "ws://127.0.0.1:5500/v1/events",
    token: typeof raw.token === "string" ? raw.token : "",
    topN: raw.topN === undefined ? 5 : raw.topN,
    guessPolicy: raw.guessPolicy === undefined ? "last" : raw.guessPolicy
  };
  if (config.enabled) {
    var url;
    try { url = new URL(config.url); } catch (e) {}
    if (!config.groupId || !url || !["ws:", "wss:"].includes(url.protocol) ||
        url.username || url.password || url.hash || url.search ||
        !Number.isInteger(config.topN) || config.topN < 1 || config.topN > 10 ||
        !["first", "last"].includes(config.guessPolicy)) {
      throw new Error("QQ 配置无效：需要 groupId、Satori ws/wss 地址、1–10 的 topN 和 first/last 的 guessPolicy");
    }
  }
  return config;
}

function normalizeEvent(event) {
  if (!event || event.type !== "message-created") return null;
  var login = event.login || {};
  var user = event.user || {};
  var channel = event.channel || {};
  var message = event.message || {};
  // Older Satori v1 implementations use platform/self_id on the event itself.
  if (!isQQ(login.platform || event.platform) || channel.type !== 0 || user.is_bot ||
      String(user.id) === String((login.user || {}).id || event.self_id)) return null;
  var names = [(event.member || {}).nick, user.nick, user.name];
  var nickname = names.find(function (name) { return typeof name === "string" && name.trim(); });
  var avatarUrl = "";
  try {
    var avatar = new URL(user.avatar);
    if (avatar.protocol === "https:" && !avatar.username && !avatar.password) avatarUrl = avatar.href;
  } catch (e) {}
  return {
    groupId: qqId(channel.id),
    userId: qqId(user.id),
    messageId: message.id,
    text: message.content,
    sentAt: message.created_at == null ? event.timestamp : message.created_at,
    eventAt: event.timestamp,
    nickname: nickname,
    avatarUrl: avatarUrl
  };
}

function connectSatori(config, onEvent, onStatus) {
  if (!config.enabled) return { connected: function () { return false; }, stop: function () {} };
  var WebSocket = require("ws");
  var socket;
  var retry;
  var heartbeat;
  var readyTimeout;
  var stopped = false;
  var ready = false;
  var logins = new Map();
  var delay = 1000;
  var sn;
  var awaitingPong = false;
  var authWarning = false;

  function loginKey(login) {
    return login.sn == null ? login.platform + ":" + ((login.user || {}).id || login.self_id) : login.sn;
  }
  function connected() {
    return ready && Array.from(logins.values()).some(function (login) {
      return isQQ(login.platform) && login.status === 1;
    });
  }
  function connect() {
    if (stopped) return;
    socket = new WebSocket(config.url, { maxPayload: 256 * 1024, handshakeTimeout: 10000 });
    socket.on("error", function () {}); // close schedules retries, including refused connections.
    socket.on("open", function () {
      var body = {};
      if (config.token) body.token = config.token;
      if (sn !== undefined) body.sn = sn;
      socket.send(JSON.stringify({ op: 3, body: body }));
      readyTimeout = setTimeout(function () { socket.terminate(); }, 10000);
      readyTimeout.unref();
      awaitingPong = false;
      heartbeat = setInterval(function () {
        if (awaitingPong) return socket.terminate();
        awaitingPong = true;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 1 }));
      }, 10000);
      heartbeat.unref();
    });
    socket.on("message", function (data, binary) {
      if (binary) return;
      var frame;
      try { frame = JSON.parse(data.toString()); } catch (e) { return; }
      if (!frame || typeof frame !== "object") return;
      if (frame.op === 2) awaitingPong = false;
      if (frame.op === 4 && frame.body && Array.isArray(frame.body.logins)) {
        clearTimeout(readyTimeout);
        logins.clear();
        frame.body.logins.forEach(function (login) {
          if (login) logins.set(loginKey(login), login);
        });
        ready = true;
        authWarning = false;
        delay = 1000;
        onStatus();
      }
      if (frame.op !== 0 || !ready || !frame.body || typeof frame.body !== "object") return;
      var event = frame.body;
      if (["login-added", "login-updated", "login-removed"].includes(event.type)) {
        if (!event.login) return;
        var key = loginKey(event.login);
        if (event.type === "login-removed") logins.delete(key);
        else logins.set(key, event.login);
        onStatus();
        return;
      }
      // id was the event sequence field in older Satori v1 implementations.
      var eventSn = event.sn == null ? event.id : event.sn;
      if (Number.isSafeInteger(eventSn)) sn = eventSn;
      var message = normalizeEvent(event);
      if (message) onEvent(message);
    });
    socket.on("close", function (code) {
      clearInterval(heartbeat);
      clearTimeout(readyTimeout);
      ready = false;
      logins.clear();
      onStatus();
      if (stopped) return;
      if (code === 4004 && !authWarning) {
        console.error("Satori 鉴权失败，请检查 config.json 中 qq.token 与 LLBot 的令牌是否一致");
        authWarning = true;
      }
      retry = setTimeout(connect, delay);
      retry.unref();
      delay = Math.min(delay * 2, 10000);
    });
  }
  function stop() {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(readyTimeout);
    clearInterval(heartbeat);
    if (socket) socket.terminate();
  }
  connect();
  return { connected: connected, stop: stop };
}

module.exports = { normalizeConfig: normalizeConfig, normalizeEvent: normalizeEvent, connectSatori: connectSatori };
