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
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8"
};

var state = WL.createGame();
var clients = new Set();
var DECKS_DIR = path.join(ROOT, "decks");

function loadConfig() {
  try {
    var c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { password: typeof c.password === "string" ? c.password : "" };
  } catch (e) {
    return { password: "" };
  }
}

var config = loadConfig();
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
  if (!config.password) return true;
  var token = authToken(req);
  if (!token) return false;
  pruneSessions();
  var hash = tokenHash(token);
  return authStore.sessions.some(function (session) {
    return safeEqual(session.hash, hash);
  });
}

function requireAuth(req, res, cb) {
  if (isAuthed(req)) return cb();
  sendJson(res, 401, { ok: false, error: "需要密码" });
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
  cards: state.cards.map(function (card) { return card.slice(); })
};

function broadcast() {
  var payload = "data: " + JSON.stringify(state) + "\n\n";
  clients.forEach(function (res) {
    try {
      res.write(payload);
    } catch (e) {
      clients.delete(res);
    }
  });
}

var keepalive = setInterval(function () {
  clients.forEach(function (res) {
    try {
      res.write(": keepalive\n\n");
    } catch (e) {
      clients.delete(res);
    }
  });
}, 15000);
keepalive.unref();

function sendJson(res, code, obj, headers) {
  var allHeaders = { "Content-Type": "application/json; charset=utf-8" };
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
  var url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (req.method === "GET" && url === "/api/ping") {
    return sendJson(res, 200, {
      ok: true,
      authRequired: !!config.password,
      authed: isAuthed(req),
      deck: state.deckName,
      cards: state.cards.length
    });
  }

  if (req.method === "POST" && url === "/api/auth") {
    return readJsonBody(req, res, function (body) {
      var pass = typeof body.password === "string" ? body.password : "";
      if (!config.password || safeEqual(pass, config.password)) {
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
        try {
          var found = null;
          listDecks().forEach(function (x) {
            if (x.file === d.file && !x.error) found = x;
          });
          if (!found) throw new Error("未找到题库文件：" + (d.file || ""));
          var parsed = WL.parseDeck(fs.readFileSync(path.join(DECKS_DIR, found.file), "utf8"));
          WL.applyIntent(state, { type: "loadDeck", name: parsed.name || found.name, cards: parsed.cards });
          broadcast();
          sendJson(res, 200, { ok: true, name: state.deckName, cards: state.cards.length });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e.message || e) });
        }
      });
    });
  }

  if (req.method === "GET" && url === "/api/stream") {
    return requireAuth(req, res, function () {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      res.write("retry: 2000\n\n");
      res.write("data: " + JSON.stringify(state) + "\n\n");
      clients.add(res);
      req.on("close", function () { clients.delete(res); });
    });
  }

  if (req.method === "POST" && url === "/api/intent") {
    return requireAuth(req, res, function () {
      readJsonBody(req, res, function (intent) {
        try {
          WL.applyIntent(state, intent && intent.type === "resetDeck" ? {
            type: "loadDeck",
            name: defaultDeck.name,
            cards: defaultDeck.cards.map(function (card) { return card.slice(); })
          } : intent);
          broadcast();
          sendJson(res, 200, { ok: true, phase: state.phase });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e.message || e) });
        }
      });
    });
  }

  if (req.method === "POST" && url === "/api/deck") {
    return requireAuth(req, res, function () {
      readJsonBody(req, res, function (d) {
        try {
          var parsed = WL.parseDeck(d.text);
          WL.applyIntent(state, {
            type: "loadDeck",
            name: parsed.name || d.name || WL.DECK_NAME_DEFAULT,
            cards: parsed.cards
          });
          broadcast();
          sendJson(res, 200, { ok: true, name: state.deckName, cards: state.cards.length });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e.message || e) });
        }
      });
    });
  }

  var filePath = path.normalize(path.join(ROOT, url === "/" ? "index.html" : url));
  if (filePath.indexOf(ROOT) !== 0) {
    return sendJson(res, 403, { ok: false, error: "forbidden" });
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
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
  console.log("Wavelength 服务器已启动");
  console.log("本机访问：   http://localhost:" + PORT);
  lanAddresses().forEach(function (ip) {
    console.log("局域网访问： http://" + ip + ":" + PORT);
  });
  console.log("iPad 选「控制器」，电脑开监视器，即可开始游戏");
});

module.exports = { server: server, state: state, MAX_BODY_BYTES: MAX_BODY_BYTES };
