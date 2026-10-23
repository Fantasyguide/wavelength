var http = require("http");
var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var WL = require("./game.js");

var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3100;
var ROOT = __dirname;
var CONFIG_PATH = process.env.WL_CONFIG || path.join(ROOT, "config.json");
var AUTH_SESSIONS_PATH = process.env.WL_AUTH_SESSIONS || path.join(ROOT, "auth-sessions.json");
var AUTH_COOKIE = "wl_auth";
var AUTH_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
var MAX_BODY_BYTES = 256 * 1024;
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8"
};

var state = WL.createGame();
var clients = new Map();
var ControllerTimer = require("./controller-timer.js");
var controllerTimer = new ControllerTimer(state, { graceMs: WL.TIMER_GRACE_MS });

function controllerId(req, id) {
  if (typeof id !== "string" || id.length > 100) return null;
  for (var client of clients.values()) {
    if (client.controller && client.id === id && safeEqual(authToken(client.req), authToken(req)) && isAuthed(client.req)) return id;
  }
  return null;
}

function timerOwner(preferred) {
  var available = Array.from(clients.values()).filter(function (c) { return c.controller && c.id && isAuthed(c.req); });
  var chosen = available.find(function (c) { return c.id === preferred; }) ||
    available.find(function (c) { return c.id === controllerTimer.lastOwner; }) || available[0];
  return chosen ? chosen.id : null;
}

function syncControllerTimer(preferred) { controllerTimer.sync(timerOwner(preferred)); }
var DECKS_DIR = path.join(ROOT, "decks");

function loadConfig() {
  try {
    var c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    c.password = typeof c.password === "string" ? c.password : "";
    return c;
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error("无法读取服务器配置：" + e.message);
    return { password: "" };
  }
}

var config = loadConfig();
var bridge = Object.assign({ enabled: false, base_url: "", secret: "" }, config.thccb);
var bridgeRound = null;
var gameKey = crypto.randomUUID();
var attemptKey = crypto.randomUUID();
var adminRevision = 0;
var completedOperations = new Set();
var pendingTransition = null;
var bridgeError = "";
var timerBlocked = false;
var timerPending = false;
var bridgeHealthRequest = null;
var ThccbBridge = require("./thccb-bridge.js");
var bridgeManager = new ThccbBridge({
  file: process.env.WL_BRIDGE_STORE || path.join(path.dirname(CONFIG_PATH), "data", "thccb-journal.json"),
  config: function () { return bridge; },
  changed: function () { bridgeSnapshot(); broadcast(); }
});

// Each callback mutates local state synchronously before returning a remote promise.
// Independent requests never wait behind a THCCB network operation.
function serial(res, action) {
  return Promise.resolve().then(action).catch(function (e) {
    if (res && !res.writableEnded) sendJson(res, e.status || 400, { ok: false, error: String(e.message || e) });
  });
}
function activeBridgeRound() {
  return bridgeRound && !["result", "cancelled", "rewards_retained"].includes(bridgeRound.status);
}
function bridgeSnapshot() {
  state.control = { game_key: gameKey, attempt_key: attemptKey, revision: adminRevision };
  state.audience_linked = !!(bridge.enabled && bridgeRound && ["open", "closed", "result"].includes(bridgeRound.status));
  state.thccb_connection = Object.assign({}, bridgeManager.health, { status: bridge.enabled ? bridgeManager.health.status : "disabled" });
  state.thccb = {
    enabled: !!bridge.enabled, round_key: bridgeRound ? bridgeRound.key : null,
    status: bridgeRound ? bridgeRound.status : !bridge.enabled ? "disabled" :
      ["setup", "chooseCard", "psychic"].includes(state.phase) ? "armed" : "unlinked",
    timer_blocked: timerBlocked, waiting: !!pendingTransition, pending: !!(pendingTransition && pendingTransition.running),
    retryable: !!pendingTransition || !!bridgeManager.pending().length || !!bridgeManager.conflict,
    results: bridgeRound ? bridgeRound.results || null : null,
    results_error: bridgeRound ? bridgeRound.results_error || "" : "",
    error: bridgeManager.storageError || bridgeError,
    jobs: bridgeManager.diagnostics(), conflict: bridgeManager.conflict
  };
}
bridgeSnapshot();
async function checkBridgeConnection() {
  if ((!bridge.enabled && !bridgeManager.pending().length) || bridgeHealthRequest) return;
  bridgeHealthRequest = bridgeManager.inspect();
  try { await bridgeHealthRequest; } catch (e) {}
  finally { bridgeHealthRequest = null; bridgeSnapshot(); broadcast(); }
}
function requireBridgeAuth(req, res, cb) {
  if (!config.password) return sendJson(res, 403, { ok: false, error: "请先在服务器 config.json 设置共享密码并重启，再登录配置资金联动" });
  return requireAuth(req, res, cb);
}
function publicBridge() {
  return { enabled: !!bridge.enabled, base_url: bridge.base_url, secret_configured: !!bridge.secret };
}
function checkedBridge(body) {
  if (!body || typeof body.enabled !== "boolean" || typeof body.base_url !== "string" ||
      (body.secret !== undefined && typeof body.secret !== "string")) throw new Error("联动配置格式错误");
  var candidate = { enabled: body.enabled, base_url: body.base_url.trim(), secret: body.secret || bridge.secret };
  if (candidate.base_url) {
    var parsed;
    try { parsed = new URL(candidate.base_url); } catch (e) { throw new Error("THCCB 地址必须是合法的 http(s) 地址"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.search || parsed.hash || /[?#]/.test(candidate.base_url) || /^https?:\/\/[^/]*@/i.test(candidate.base_url)) throw new Error("THCCB 地址不能包含用户信息、查询参数或片段");
    candidate.base_url = parsed.href.replace(/\/$/, "");
  }
  if (candidate.secret && candidate.secret.length < 32) throw new Error("联动密钥至少需要 32 个字符");
  if (candidate.enabled && (!candidate.base_url || !candidate.secret)) throw new Error("开启联动前请填写地址和密钥");
  return candidate;
}
function saveBridgeConfig(candidate) {
  var next = Object.assign({}, config, { thccb: candidate });
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 }); }
  catch (e) { throw new Error("配置写入失败，请检查服务器文件权限后重试"); }
  config = next; bridge = candidate;
}
function scheduleBridgeResults(round) {
  setTimeout(async function () {
    function current() { return bridge.enabled && bridgeRound === round && round.status === "result"; }
    if (!current()) return;
    try {
      var data = await bridgeManager.request("/rounds/" + encodeURIComponent(round.key) + "/results");
      if (data.round_key !== round.key || !Array.isArray(data.top_five) || !Number.isInteger(data.target_position)) throw new Error("Invalid results");
      if (!current()) return;
      round.results = { round_key: data.round_key, target_position: data.target_position,
        top_five: data.top_five.slice(0, 5).map(function (e) { return { username: String(e.username), position: e.position, distance: e.distance, payout: e.payout }; }) };
    } catch (e) {
      if (!current()) return;
      round.results_error = "前五名暂时未能加载，竞猜已结算，可在 THCCB 竞猜页查看。";
    }
    bridgeSnapshot(); broadcast();
  }, 500).unref();
}
function newAttempt(newGame) {
  attemptKey = crypto.randomUUID();
  if (newGame) gameKey = crypto.randomUUID();
  bridgeRound = null; bridgeError = ""; timerBlocked = false;
}
function applyLocal(intent) {
  var previousRound = state.round;
  WL.applyIntent(state, intent.type === "resetDeck" ? { type: "loadDeck", name: defaultDeck.name,
    cards: JSON.parse(JSON.stringify(defaultDeck.cards)) } : intent, { deferTimers: true });
  if (["setup", "newGame", "voidRound"].includes(intent.type) || previousRound !== state.round) {
    newAttempt(intent.type === "setup" || intent.type === "newGame");
  }
  syncControllerTimer(intent._timerOwner);
  // Viewing already starts the controller clock at the click. Include that
  // first sample in the same intent instead of waiting for another round trip.
  if (intent.type === "startDialTimer" && state.timerSync && state.timerSync.status === "waiting") {
    controllerTimer.report({ type: "started", timerId: state.timerSync.id,
      elapsedMs: intent.timer_start_elapsed_ms }, intent._timerOwner);
  }
}
function timerDue(now) { return controllerTimer.due(now); }
function finishLocalTransition(transition) {
  if (transition.intent.type === "timer") {
    // Do not consume the guessing period while waiting for the close acknowledgement.
    state.timerEnd = Date.now() - WL.TIMER_GRACE_MS;
    WL.advanceTimers(state, Date.now(), { singleStep: !!timerOwner() });
    syncControllerTimer();
  } else applyLocal(transition.intent);
  timerBlocked = false;
}
function detachTransition(resume) {
  var transition = pendingTransition;
  pendingTransition = null; timerBlocked = false; bridgeError = "";
  if (transition) {
    if (resume) finishLocalTransition(transition);
    if (transition.release) transition.release();
  }
}
function beginTransition(intent, action, payload, retry) {
  var transition = pendingTransition || { intent: Object.assign({}, intent), action, payload, round: bridgeRound, attempt: attemptKey };
  if (transition.running) return transition.promise;
  pendingTransition = transition;
  transition.running = true;
  bridgeError = "";
  var released = new Promise(function (resolve) { transition.release = resolve; });
  var remote = bridgeManager.confirm(transition.round, transition.action, transition.payload, retry).then(function () {
    if (pendingTransition !== transition || transition.attempt !== attemptKey) return;
    pendingTransition = null;
    finishLocalTransition(transition);
    bridgeError = "";
    if (transition.action === "result") scheduleBridgeResults(transition.round);
  }).catch(function (e) {
    if (pendingTransition !== transition || transition.attempt !== attemptKey) return;
    timerBlocked = timerDue(Date.now());
    bridgeError = e.message;
    var error = new Error(e.message); error.status = 502; throw error;
  }).finally(function () {
    transition.running = false;
    bridgeSnapshot(); broadcast();
  });
  transition.promise = Promise.race([remote, released]);
  bridgeSnapshot(); broadcast();
  return transition.promise;
}
function advanceOnlineTimers(now) {
  if (pendingTransition || !timerDue(now)) return false;
  if (bridge.enabled && bridgeRound && bridgeRound.status === "open" && state.timerKind === "dial" && state.phase === "dial") {
    return beginTransition({ type: "timer" }, "close");
  }
  // Psychic timeout has no audience betting window; don't create a closed round.
  var changed = WL.advanceTimers(state, now, { singleStep: !!timerOwner() });
  syncControllerTimer();
  if (changed) { bridgeSnapshot(); broadcast(); }
  return changed;
}
function validateIntentFence(intent) {
  var admin = ["setThccbEnabled", "voidRound", "resetGame", "cancelOldThccb"].includes(intent.type);
  if (admin && (!intent.control || !intent.operation_id)) throw new Error("管理员操作缺少轮次信息，请刷新操控端");
  if (intent.control && (intent.control.game_key !== gameKey || intent.control.attempt_key !== attemptKey ||
      (admin && intent.control.revision !== adminRevision))) throw new Error("对局状态已变化，本次旧操作未执行，请确认当前画面后重试");
}
function applyOnlineIntent(req, intent, receivedAt) {
  if (!intent || typeof intent.type !== "string") throw new Error("操作格式错误");
  var type = intent.type;
  if (intent.operation_id && completedOperations.has(intent.operation_id)) return;
  validateIntentFence(intent);
  intent._timerOwner = controllerId(req, intent.client_id);
  var admin = ["setThccbEnabled", "voidRound", "resetGame", "cancelOldThccb"].includes(type);
  if (admin || type === "newGame") {
    if (type === "setThccbEnabled") {
      if (typeof intent.value !== "boolean") throw new Error("联动开关格式错误");
      var candidate = checkedBridge(Object.assign({}, bridge, { enabled: intent.value }));
      // Switch locally even if persistence fails; report it without re-locking play.
      var saveError = "";
      try { saveBridgeConfig(candidate); } catch (e) { bridge = candidate; saveError = e.message; }
      if (!intent.value) {
        var old = bridgeRound;
        detachTransition(true);
        bridgeRound = null;
        bridgeManager.cancel(old);
      }
      bridgeError = saveError;
    } else if (type === "cancelOldThccb") {
      bridgeManager.cancelKnown(intent.round_key);
    } else {
      if (type === "voidRound" && state.phase === "setup") throw new Error("当前没有可作废的轮次");
      if (type === "resetGame" && ["setup", "over"].includes(state.phase)) throw new Error("当前无需强制重置；正常终局请使用再来一局");
      var abandoned = bridgeRound;
      var audit = { action: type, round: state.round, team: state.active, at: Date.now(), round_key: abandoned && abandoned.key };
      detachTransition(false);
      applyLocal({ type: type === "voidRound" ? "voidRound" : "newGame", _timerOwner: intent._timerOwner });
      state.admin_log = (state.admin_log || []).concat(audit).slice(-50);
      bridgeManager.cancel(abandoned);
    }
    adminRevision++;
    if (intent.operation_id) {
      completedOperations.add(intent.operation_id);
      if (completedOperations.size > 256) completedOperations.delete(completedOperations.values().next().value);
    }
    bridgeSnapshot(); return;
  }
  if (type === "retryThccb") {
    var retryAttempt = attemptKey, retryRevision = adminRevision;
    bridgeManager.retry().catch(function (e) {
      if (retryAttempt !== attemptKey || retryRevision !== adminRevision) return;
      bridgeError = e.message; bridgeSnapshot(); broadcast();
    });
    if (pendingTransition) return beginTransition(null, null, null, true);
    if (bridgeRound && bridgeRound.status === "result") scheduleBridgeResults(bridgeRound);
    return;
  }
  if (type === "setRulesOpen") { applyLocal(intent); bridgeSnapshot(); return; }
  if (intent.timer_id && (!state.timerSync || intent.timer_id !== state.timerSync.id)) return;
  if (state.timerSync && state.timerSync.ownerId === intent._timerOwner &&
      Number.isFinite(intent.timer_elapsed_ms) && intent.timer_elapsed_ms >= state.timerSync.durationMs + WL.TIMER_GRACE_MS) {
    controllerTimer.report({ type: "expired", timerId: state.timerSync.id, elapsedMs: intent.timer_elapsed_ms }, intent._timerOwner);
    return advanceOnlineTimers(Date.now());
  }
  if (pendingTransition) throw new Error("THCCB 正在等待确认；可重试，或在管理员菜单关闭联动、作废、重置");
  if (timerDue(receivedAt === undefined ? Date.now() : receivedAt)) return advanceOnlineTimers(Date.now());
  if (activeBridgeRound() && ["setup", "skipCard", "redrawCards", "loadDeck", "resetDeck", "selectSide", "selectCard"].includes(type)) throw new Error("请先完成或作废当前竞猜，再更换题目");
  if (bridge.enabled && type === "donePsychic" && state.phase === "psychic" && !bridgeManager.blocked()) {
    if (!bridgeRound) {
      var pair = WL.cardSides(state.card)[state.side];
      bridgeRound = bridgeManager.create({ round_key: gameKey + ":" + state.round + ":" + attemptKey,
        game_key: gameKey, round_number: state.round, left_label: pair[0], right_label: pair[1], team_name: state.teams[state.active].name });
    }
    return beginTransition(intent, "start", bridgeRound.payload);
  }
  if (bridge.enabled && bridgeRound) {
    if (["lock", "penaltyLock"].includes(type) && state.phase === "dial") return beginTransition(intent, "close");
    if (type === "reveal" && state.phase === "reveal") return beginTransition(intent, "result", { target_position: state.target.center });
  }
  applyLocal(intent);
  bridgeSnapshot();
}
var passwordHash = crypto.createHash("sha256").update(config.password).digest("hex");
var authStore = { version: 1, passwordHash: passwordHash, sessions: [] };

try {
  var savedSessions = JSON.parse(fs.readFileSync(AUTH_SESSIONS_PATH, "utf8"));
  if (savedSessions && savedSessions.version === 1 &&
      savedSessions.passwordHash === passwordHash && Array.isArray(savedSessions.sessions)) {
    authStore.sessions = savedSessions.sessions.filter(function (session) {
      return session && typeof session.hash === "string" &&
        typeof session.expiresAt === "number" && session.expiresAt > Date.now();
    });
  }
} catch (e) {}

function saveAuthStore() {
  try {
    fs.writeFileSync(AUTH_SESSIONS_PATH, JSON.stringify(authStore, null, 2));
  } catch (e) {}
}

function pruneSessions() {
  var before = authStore.sessions.length;
  var now = Date.now();
  authStore.sessions = authStore.sessions.filter(function (session) {
    return session.expiresAt > now;
  });
  if (authStore.sessions.length !== before) saveAuthStore();
}

function parseCookies(req) {
  var out = {};
  String(req.headers.cookie || "").split(";").forEach(function (part) {
    var idx = part.indexOf("=");
    if (idx === -1) return;
    var key = part.slice(0, idx).trim();
    var value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function authToken(req) {
  return parseCookies(req)[AUTH_COOKIE] || "";
}

function safeEqual(a, b) {
  var ba = Buffer.from(String(a));
  var bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isAuthed(req) {
  if (!config.password) return false;
  var token = authToken(req);
  if (!token) return false;
  pruneSessions();
  var hash = tokenHash(token);
  return authStore.sessions.some(function (session) {
    return safeEqual(session.hash, hash);
  });
}

function requireAuth(req, res, cb) {
  if (!config.password) return sendJson(res, 403, { ok: false, error: "服务器尚未设置控制器密码，请设置后重启；观看战况和本机游玩无需密码" });
  if (isAuthed(req)) return cb();
  sendJson(res, 401, { ok: false, error: "操作联网对局需要控制器密码" });
}

function listDecks() {
  var out = [];
  var files;
  try {
    files = fs.readdirSync(DECKS_DIR);
  } catch (e) {
    return out;
  }
  files.filter(function (f) {
    return /\.(json|ya?ml)$/i.test(f);
  }).forEach(function (f) {
    try {
      var parsed = WL.parseDeck(fs.readFileSync(path.join(DECKS_DIR, f), "utf8"));
      out.push({ file: f, name: parsed.name || f.replace(/\.(json|ya?ml)$/i, ""), cards: parsed.cards.length });
    } catch (e) {
      out.push({ file: f, name: f, cards: 0, error: String(e.message) });
    }
  });
  return out;
}

var deckFile = null;
try {
  deckFile = fs.readFileSync(path.join(ROOT, "cards.yaml"), "utf8");
} catch (e) {
  try {
    deckFile = fs.readFileSync(path.join(ROOT, "cards.json"), "utf8");
  } catch (e2) {}
}
if (deckFile) {
  try {
    var parsed = WL.parseDeck(deckFile);
    WL.applyIntent(state, { type: "loadDeck", name: parsed.name || "cards", cards: parsed.cards });
  } catch (e) {
    console.log("默认题库解析失败：" + e.message);
  }
} else {
  console.log("未找到 cards.yaml / cards.json，使用内置题库");
}

// Keep the startup deck separate from later controller selections.
var defaultDeck = {
  name: state.deckName,
  cards: JSON.parse(JSON.stringify(state.cards))
};

function publicState(controller) {
  var snapshot = Object.assign({}, state, { serverNow: Date.now() });
  if (controller) return snapshot;
  snapshot.target = ["revealed", "over"].includes(state.phase) ? state.target : null;
  delete snapshot.control;
  delete snapshot.admin_log;
  // Monitors receive only the revealed audience result, never controller diagnostics.
  if (bridge.enabled && ["revealed", "over"].includes(state.phase) && bridgeRound &&
      bridgeRound.status === "result" && state.round === bridgeRound.payload.round_number) {
    snapshot.thccb = { enabled: true, results: state.thccb.results, results_error: state.thccb.results_error };
  } else {
    delete snapshot.thccb;
  }
  return snapshot;
}

function streamAuthorized(res, client) {
  if (!client.controller || isAuthed(client.req)) return true;
  clients.delete(res);
  res.end();
  return false;
}

function broadcast() {
  var publicPayload = "data: " + JSON.stringify(publicState(false)) + "\n\n";
  var controllerPayload = "data: " + JSON.stringify(publicState(true)) + "\n\n";
  clients.forEach(function (client, res) {
    try {
      if (streamAuthorized(res, client)) res.write(client.controller ? controllerPayload : publicPayload);
    } catch (e) {
      clients.delete(res);
    }
  });
}

var keepalive = setInterval(function () {
  clients.forEach(function (client, res) {
    try {
      if (streamAuthorized(res, client)) res.write(": keepalive\n\n");
    } catch (e) {
      clients.delete(res);
    }
  });
}, 15000);
keepalive.unref();

var bridgeHealthTimer = setInterval(checkBridgeConnection, 30000);
bridgeHealthTimer.unref();

// A live owner reports expiry. Only an unresponsive owner's server fallback can
// advance independently; spectator clocks never trigger automatic actions.
var gameTimer = setInterval(function () {
  if (controllerTimer.fallback()) broadcast();
  if (timerPending || timerBlocked || pendingTransition || !timerDue(Date.now())) return;
  timerPending = true;
  serial(null, async function () {
    try { await advanceOnlineTimers(Date.now()); }
    finally { timerPending = false; }
  });
}, 100);
gameTimer.unref();

function sendJson(res, code, obj, headers) {
  var allHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  Object.keys(headers || {}).forEach(function (key) { allHeaders[key] = headers[key]; });
  res.writeHead(code, allHeaders);
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, res, cb) {
  var declared = Number(req.headers["content-length"]);
  if (isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    sendJson(res, 413, { ok: false, error: "请求体不能超过 256 KiB" });
    return;
  }
  var chunks = [];
  var size = 0;
  var finished = false;
  req.on("data", function (c) {
    if (finished) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      finished = true;
      chunks = [];
      sendJson(res, 413, { ok: false, error: "请求体不能超过 256 KiB" });
      return;
    }
    chunks.push(c);
  });
  req.on("end", function () {
    if (finished) return;
    finished = true;
    try {
      cb(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: "请求 JSON 格式错误" });
    }
  });
  req.on("error", function () {
    if (finished) return;
    finished = true;
    sendJson(res, 400, { ok: false, error: "请求读取失败" });
  });
}

function authCookie(req, token, maxAge) {
  var cookie = AUTH_COOKIE + "=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + maxAge;
  var forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (req.socket.encrypted || forwardedProto === "https") cookie += "; Secure";
  return cookie;
}

var server = http.createServer(function (req, res) {
  var url;
  try { url = decodeURIComponent((req.url || "/").split("?")[0]); }
  catch (e) { return sendJson(res, 400, { ok: false, error: "无效路径" }); }
  if (url.includes("\0") || url.includes("\\")) return sendJson(res, 400, { ok: false, error: "无效路径" });

  if (url === "/api/thccb" && ["GET", "POST"].includes(req.method)) {
    return requireBridgeAuth(req, res, function () {
      if (req.method === "GET") return sendJson(res, 200, { ok: true, config: publicBridge() });
      readJsonBody(req, res, function (body) {
        serial(res, function () {
          var candidate = checkedBridge(body);
          var changed = JSON.stringify(candidate) !== JSON.stringify(bridge);
          if ((activeBridgeRound() || bridgeManager.pending().length || bridgeManager.storageError) && changed) throw new Error("当前联动竞猜尚未结束，请先完成或取消后再修改配置");
          if (state.phase !== "setup" && changed) throw new Error("请在开局前修改联动配置");
          saveBridgeConfig(candidate);
          if (changed) bridgeManager.capability = undefined;
          bridgeSnapshot();
          broadcast();
          sendJson(res, 200, { ok: true, config: publicBridge() });
          checkBridgeConnection();
        });
      });
    });
  }

  if (req.method === "GET" && url === "/api/ping") {
    return sendJson(res, 200, {
      ok: true,
      serverNow: Date.now(),
      authRequired: true,
      controllerAvailable: !!config.password,
      authed: isAuthed(req),
      deck: state.deckName,
      cards: state.cards.length
    });
  }

  if (req.method === "POST" && url === "/api/auth") {
    if (!config.password) return requireAuth(req, res, function () {});
    return readJsonBody(req, res, function (body) {
      var pass = typeof body.password === "string" ? body.password : "";
      if (safeEqual(pass, config.password)) {
        var token = crypto.randomBytes(32).toString("base64url");
        var now = Date.now();
        authStore.sessions.push({
          hash: tokenHash(token),
          createdAt: now,
          expiresAt: now + AUTH_MAX_AGE_SECONDS * 1000
        });
        saveAuthStore();
        sendJson(res, 200, { ok: true }, {
          "Set-Cookie": authCookie(req, token, AUTH_MAX_AGE_SECONDS)
        });
      } else {
        sendJson(res, 403, { ok: false, error: "密码错误" });
      }
    });
  }

  if (req.method === "POST" && url === "/api/logout") {
    var logoutToken = authToken(req);
    if (logoutToken) {
      var logoutHash = tokenHash(logoutToken);
      authStore.sessions = authStore.sessions.filter(function (session) {
        return !safeEqual(session.hash, logoutHash);
      });
      saveAuthStore();
    }
    broadcast();
    return sendJson(res, 200, { ok: true }, {
      "Set-Cookie": authCookie(req, "", 0)
    });
  }

  if (req.method === "GET" && url === "/api/decks") {
    return requireAuth(req, res, function () {
      sendJson(res, 200, { ok: true, decks: listDecks() });
    });
  }

  if (req.method === "POST" && url === "/api/deck/load") {
    return requireAuth(req, res, function () {
      readJsonBody(req, res, function (d) {
        var receivedAt = Date.now();
        serial(res, async function () {
          if (activeBridgeRound()) throw new Error("请先完成或取消当前联动竞猜，再修改题库");
          var found = null;
          listDecks().forEach(function (x) {
            if (x.file === d.file && !x.error) found = x;
          });
          if (!found) throw new Error("未找到题库文件：" + (d.file || ""));
          var parsed = WL.parseDeck(fs.readFileSync(path.join(DECKS_DIR, found.file), "utf8"));
          await applyOnlineIntent(req, { type: "loadDeck", name: parsed.name || found.name, cards: parsed.cards }, receivedAt);
          broadcast();
          sendJson(res, 200, { ok: true, name: state.deckName, cards: state.cards.length });
        });
      });
    });
  }

  if (req.method === "GET" && url === "/api/stream") {
    var controller = new URL(req.url, "http://localhost").searchParams.get("role") === "controller";
    var clientId = new URL(req.url, "http://localhost").searchParams.get("client_id");
    var openStream = function () {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive"
      });
      res.write("retry: 2000\n\n");
      res.write("data: " + JSON.stringify(publicState(controller)) + "\n\n");
      clients.set(res, { req: req, controller: controller, id: clientId && clientId.length <= 100 ? clientId : null });
      req.on("close", function () { clients.delete(res); });
    };
    return controller ? requireAuth(req, res, openStream) : openStream();
  }

  if (req.method === "POST" && url === "/api/timer") {
    return requireAuth(req, res, function () {
      readJsonBody(req, res, function (body) {
        serial(res, async function () {
          var changed = controllerTimer.report(body, controllerId(req, body.client_id));
          if (changed) {
            await advanceOnlineTimers(Date.now());
            bridgeSnapshot(); broadcast();
          }
          sendJson(res, 200, { ok: true });
        });
      });
    });
  }

  if (req.method === "POST" && url === "/api/intent") {
    return requireAuth(req, res, function () {
      readJsonBody(req, res, function (intent) {
        var receivedAt = Date.now();
        serial(res, async function () {
          await applyOnlineIntent(req, intent, receivedAt);
          broadcast();
          sendJson(res, 200, { ok: true, phase: state.phase });
        });
      });
    });
  }

  if (req.method === "POST" && url === "/api/deck") {
    return requireAuth(req, res, function () {
      readJsonBody(req, res, function (d) {
        var receivedAt = Date.now();
        serial(res, async function () {
          if (activeBridgeRound()) throw new Error("请先完成或取消当前联动竞猜，再修改题库");
          var parsed = WL.parseDeck(d.text);
          await applyOnlineIntent(req, {
            type: "loadDeck",
            name: parsed.name || d.name || WL.DECK_NAME_DEFAULT,
            cards: parsed.cards
          }, receivedAt);
          broadcast();
          sendJson(res, 200, { ok: true, name: state.deckName, cards: state.cards.length });
        });
      });
    });
  }

  // Serve only browser assets. Configuration, sessions and backend code are private.
  if (url === "/design/color-lab") {
    res.writeHead(302, { "Location": "/design/color-lab/" });
    return res.end();
  }
  var asset = url === "/" ? "index.html" : url.replace(/^\//, "");
  if (asset === "design/color-lab/") asset += "index.html";
  var isColorLab = ["design/color-lab/index.html", "design/color-lab/lab.css", "design/color-lab/lab.js"].includes(asset);
  var isAsset = asset.startsWith("assets/") && asset.split("/").every(function (part) {
    return part && !part.startsWith(".");
  }) && /\.(svg|png|jpe?g|webp|gif|ico|otf|ttf|woff2?)$/i.test(asset);
  if (!["index.html", "app.css", "app.js", "game.js", "target-sampling-config.js", "cards.yaml", "cards.json", "names.json"].includes(asset) &&
      !isAsset && !isColorLab) {
    return sendJson(res, 404, { ok: false, error: "not found" });
  }
  var filePath = path.resolve(ROOT, asset);
  if (!filePath.startsWith(ROOT + path.sep)) return sendJson(res, 404, { ok: false, error: "not found" });
  fs.realpath(filePath, function (err, realPath) {
    var publicRoot = isAsset ? path.join(ROOT, "assets") : isColorLab ? path.join(ROOT, "design/color-lab") : ROOT;
    if (err || !realPath.startsWith(publicRoot + path.sep) ||
        [CONFIG_PATH, AUTH_SESSIONS_PATH].some(function (privatePath) {
          return path.resolve(privatePath) === realPath;
        })) return sendJson(res, 404, { ok: false, error: "not found" });
    fs.readFile(realPath, function (readError, data) {
      if (readError) return sendJson(res, 404, { ok: false, error: "not found" });
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  });
});

server.on("close", function () {
  clearInterval(keepalive);
  clearInterval(gameTimer);
  clearInterval(bridgeHealthTimer);
  bridgeManager.stop();
});

function lanAddresses() {
  var out = [];
  var ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(function (name) {
    ifaces[name].forEach(function (iface) {
      if (iface.family === "IPv4" && !iface.internal) out.push(iface.address);
    });
  });
  return out;
}

server.listen(PORT, function () {
  checkBridgeConnection();
  console.log("Returned 逆转录者 服务器已启动");
  console.log("本机访问：   http://localhost:" + PORT);
  lanAddresses().forEach(function (ip) {
    console.log("局域网访问： http://" + ip + ":" + PORT);
  });
  console.log("iPad 选「控制器」，电脑开监视器，即可开始游戏");
});

module.exports = { server: server, state: state, MAX_BODY_BYTES: MAX_BODY_BYTES };
