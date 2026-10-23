process.env.PORT = "0";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-auth-"));
const configPath = path.join(tmp, "config.json");
const sessionsPath = path.join(tmp, "auth-sessions.json");
fs.writeFileSync(configPath, JSON.stringify({ password: "secret123" }));
process.env.WL_CONFIG = configPath;
process.env.WL_AUTH_SESSIONS = sessionsPath;

const serverPath = path.join(__dirname, "..", "server.js");
let { server } = require(serverPath);

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = "";

function req(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = body ? { "Content-Type": "application/json" } : {};
    if (cookie) headers.Cookie = cookie;
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

function makePage() {
  const jar = { cookie: "" };
  class FakeES {
    constructor(url) {
      this.onmessage = null;
      this.onopen = null;
      this._buf = "";
      const opts = jar.cookie ? { headers: { Cookie: jar.cookie } } : {};
      const rq = http.get(new URL(url, BASE), opts, (res) => {
        if (res.statusCode !== 200) return;
        setTimeout(() => { if (this.onopen) this.onopen(); }, 10);
        res.on("data", (c) => {
          this._buf += c.toString();
          let idx;
          while ((idx = this._buf.indexOf("\n\n")) !== -1) {
            const frame = this._buf.slice(0, idx);
            this._buf = this._buf.slice(idx + 2);
            const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (data && this.onmessage) this.onmessage({ data });
          }
        });
      });
      rq.on("error", () => {});
      this.close = () => { try { rq.destroy(); } catch (e) {} };
    }
  }
  const dom = new JSDOM(html, {
    url: BASE + "/index.html",
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.AbortSignal = global.AbortSignal;
      window.AbortController = global.AbortController;
      window.fetch = async (u, opts) => {
        opts = opts || {};
        opts.headers = Object.assign({}, opts.headers || {});
        if (jar.cookie) opts.headers.Cookie = jar.cookie;
        const res = await global.fetch(new URL(u, BASE + "/").href, opts);
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) {
          const pair = setCookie.split(";", 1)[0];
          jar.cookie = pair.endsWith("=") ? "" : pair;
        }
        return res;
      };
      window.EventSource = FakeES;
    }
  });
  dom.authJar = jar;
  return dom;
}

async function waitFor(fn, msg, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (fn()) return; } catch (e) {}
    await sleep(50);
  }
  throw new Error("TIMEOUT waiting for: " + msg);
}

function click(doc, id) {
  const el = typeof id === "string" ? doc.getElementById(id) : id;
  if (!el) throw new Error("missing #" + id);
  el.dispatchEvent(new doc.defaultView.Event("click", { bubbles: true }));
}

async function openStream(route, cookie) {
  const stream = { snapshots: [], ended: false };
  stream.request = http.get(BASE + route, { headers: cookie ? { Cookie: cookie } : {} }, res => {
    stream.status = res.statusCode;
    let buffer = "";
    res.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) stream.snapshots.push(JSON.parse(frame.slice(6)));
      }
    });
    res.on("end", () => { stream.ended = true; });
  });
  stream.request.on("error", () => {});
  await waitFor(() => stream.snapshots.length > 0, "stream has its initial snapshot");
  return stream;
}

async function stopServer() {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

(async function () {
  await new Promise((r) => server.once("listening", r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  let r = await req("GET", BASE + "/api/ping");
  let j = JSON.parse(r.body);
  assert(r.status === 200 && j.ok && j.authRequired === true && j.authed === false, "ping reports auth required");

  r = await req("GET", BASE + "/api/decks");
  assert(r.status === 401, "unauthenticated /api/decks rejected 401");
  r = await req("POST", BASE + "/api/intent", { type: "newGame" });
  assert(r.status === 401, "unauthenticated /api/intent rejected 401");
  r = await req("POST", BASE + "/api/auth", { password: "wrong" });
  assert(r.status === 403, "wrong password rejected");

  r = await req("POST", BASE + "/api/auth", { password: "secret123" });
  assert(r.status === 200 && Array.isArray(r.headers["set-cookie"]), "correct password sets device cookie");
  const apiCookie = r.headers["set-cookie"][0].split(";", 1)[0];
  assert(r.headers["set-cookie"][0].includes("HttpOnly") && r.headers["set-cookie"][0].includes("SameSite=Strict"), "auth cookie is protected");
  assert((await req("GET", BASE + "/api/decks", null, apiCookie)).status === 200, "authenticated device can use protected API");
  assert((await req("GET", BASE + "/api/decks")).status === 401, "second device on same IP remains unauthenticated");
  assert((await req("GET", BASE + "/api/stream?role=controller")).status === 401, "private SSE rejects missing cookie");
  for (const [route, body] of [["/api/deck", { text: "- [left, right]" }],
    ["/api/deck/load", { file: "儿童版.json" }], ["/api/thccb", { enabled: false }]]) {
    assert((await req("POST", BASE + route, body)).status === 401, "anonymous spectator cannot write " + route);
  }
  assert((await req("GET", BASE + "/api/thccb")).status === 401, "spectator cannot read bridge configuration");

  const publicStream = await openStream("/api/stream");
  const signedInMonitor = await openStream("/api/stream?role=monitor", apiCookie);
  const controllerStream = await openStream("/api/stream?role=controller", apiCookie);
  const spectators = [publicStream, signedInMonitor];
  assert(publicStream.status === 200, "anonymous spectator can subscribe to live state");
  async function move(intent, phase) {
    assert((await req("POST", BASE + "/api/intent", intent, apiCookie)).status === 200, "controller can " + intent.type);
    await waitFor(() => [...spectators, controllerStream].every(s => s.snapshots.at(-1).phase === phase), "phase sync: " + phase);
    for (const stream of spectators) {
      const latest = stream.snapshots.at(-1);
      assert(!Object.hasOwn(latest, "thccb"), "spectator does not receive private bridge state");
      if (!["revealed", "over"].includes(phase)) assert(latest.target === null, "spectator receives no hidden target in " + phase);
    }
  }
  await move({ type: "setup", cardMode: "single" }, "psychic");
  assert(controllerStream.snapshots.at(-1).target !== null, "authenticated controller receives the secret target");
  await move({ type: "donePsychic" }, "dial");
  await move({ type: "lock" }, "guess");
  await move({ type: "guess", guess: "L" }, "reveal");
  await move({ type: "reveal" }, "revealed");
  assert(publicStream.snapshots.at(-1).target !== null && publicStream.snapshots.at(-1).log.length === 1,
    "spectator receives target and history after revelation");
  await move({ type: "nextRound" }, "psychic");
  await move({ type: "newGame" }, "setup");

  const guestPage = makePage();
  const gdoc = guestPage.window.document;
  await waitFor(() => !gdoc.getElementById("role-modal").classList.contains("hidden"), "guest sees role selection first");
  assert(gdoc.getElementById("auth-modal").classList.contains("hidden"), "initial role choice has no password prompt");
  click(gdoc, "btn-role-local");
  await waitFor(() => gdoc.getElementById("setup-modal").className.indexOf("hidden") === -1, "guest enters setup modal (local hot-seat)");
  assert(gdoc.getElementById("conn-badge").textContent.indexOf("本地模式") !== -1, "guest badge shows local mode");
  assert(gdoc.getElementById("thccb-conn-badge").hidden, "local mode does not claim a THCCB connection");
  gdoc.getElementById("select-first").value = "A";
  click(gdoc, "btn-start");
  await waitFor(() => gdoc.querySelectorAll(".card-choice").length === 2, "guest receives default two-card choice");
  click(gdoc, gdoc.querySelector(".card-choice"));
  await waitFor(() => gdoc.getElementById("hint").textContent.indexOf("查看目标") !== -1, "guest can play a full local round");
  console.log("ok: guest plays local hot-seat without password");

  const monitorPage = makePage();
  const mdoc = monitorPage.window.document;
  await waitFor(() => !mdoc.getElementById("role-modal").classList.contains("hidden"), "spectator sees role choice");
  click(mdoc, "btn-role-monitor");
  await waitFor(() => mdoc.getElementById("conn-badge").textContent.includes("已连接"), "anonymous monitor is connected");
  assert(monitorPage.authJar.cookie === "" && mdoc.getElementById("auth-modal").classList.contains("hidden"), "watching requires no password or session");

  const page = makePage();
  const doc = page.window.document;
  await waitFor(() => !doc.getElementById("role-modal").classList.contains("hidden"), "controller selects role before authentication");
  click(doc, "btn-role-controller");
  await waitFor(() => !doc.getElementById("auth-modal").classList.contains("hidden"), "controller password modal shown");

  doc.getElementById("auth-password").value = "wrong";
  click(doc, "btn-auth");
  await waitFor(() => doc.getElementById("auth-msg").textContent.indexOf("密码错误") !== -1, "wrong password error shown");

  doc.getElementById("auth-password").value = "secret123";
  click(doc, "btn-auth");
  await waitFor(() => !doc.getElementById("setup-modal").classList.contains("hidden") && doc.getElementById("auth-modal").classList.contains("hidden"), "correct password enters controller directly");
  await waitFor(() => doc.getElementById("conn-badge").textContent.indexOf("已连接") !== -1, "badge connected after auth");

  r = await req("GET", BASE + "/api/ping", null, page.authJar.cookie);
  j = JSON.parse(r.body);
  assert(j.authed === true, "device cookie remembered as authed");
  const saved = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  assert(saved.sessions.length === 2 && !JSON.stringify(saved).includes(apiCookie.split("=")[1]), "only token hashes persisted");

  await req("POST", BASE + "/api/logout", null, apiCookie);
  await waitFor(() => controllerStream.ended, "logout terminates an already open private stream");
  assert(!publicStream.ended && !signedInMonitor.ended, "logout keeps spectator streams available");
  // Restore the API session for the persistence checks below.
  r = await req("POST", BASE + "/api/auth", { password: "secret123" });
  const persistentCookie = r.headers["set-cookie"][0].split(";", 1)[0];
  for (const stream of [...spectators, controllerStream]) stream.request.destroy();
  for (const dom of [guestPage, monitorPage, page]) dom.window.close();

  await stopServer();
  delete require.cache[require.resolve(serverPath)];
  ({ server } = require(serverPath));
  await new Promise((resolve) => server.once("listening", resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  assert((await req("GET", BASE + "/api/decks", null, persistentCookie)).status === 200, "device session survives server restart");

  r = await req("POST", BASE + "/api/logout", null, persistentCookie);
  assert(r.status === 200 && r.headers["set-cookie"][0].includes("Max-Age=0"), "logout clears cookie");
  assert((await req("GET", BASE + "/api/decks", null, persistentCookie)).status === 401, "logout revokes current device session");

  await new Promise((resolve) => server.close(resolve));
  const expiredStore = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  expiredStore.sessions.forEach((session) => { session.expiresAt = 0; });
  fs.writeFileSync(sessionsPath, JSON.stringify(expiredStore));
  delete require.cache[require.resolve(serverPath)];
  ({ server } = require(serverPath));
  await new Promise((resolve) => server.once("listening", resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  assert((await req("GET", BASE + "/api/decks", null, page.authJar.cookie)).status === 401, "expired session is rejected");

  r = await req("POST", BASE + "/api/auth", { password: "secret123" });
  const cookieBeforeDelete = r.headers["set-cookie"][0].split(";", 1)[0];
  await new Promise((resolve) => server.close(resolve));
  fs.unlinkSync(sessionsPath);
  delete require.cache[require.resolve(serverPath)];
  ({ server } = require(serverPath));
  await new Promise((resolve) => server.once("listening", resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  assert((await req("GET", BASE + "/api/decks", null, cookieBeforeDelete)).status === 401, "deleting session file revokes all devices");

  r = await req("POST", BASE + "/api/auth", { password: "secret123" });
  const cookieBeforePasswordChange = r.headers["set-cookie"][0].split(";", 1)[0];
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(configPath, JSON.stringify({ password: "changed-password" }));
  delete require.cache[require.resolve(serverPath)];
  ({ server } = require(serverPath));
  await new Promise((resolve) => server.once("listening", resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  assert((await req("GET", BASE + "/api/decks", null, cookieBeforePasswordChange)).status === 401, "password change invalidates old sessions");

  await stopServer();
  fs.writeFileSync(configPath, JSON.stringify({ password: "" }));
  delete require.cache[require.resolve(serverPath)];
  ({ server } = require(serverPath));
  await new Promise(resolve => server.once("listening", resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const unconfigured = JSON.parse((await req("GET", BASE + "/api/ping")).body);
  assert(!unconfigured.authed && !unconfigured.controllerAvailable, "empty password does not grant control");
  assert((await req("POST", BASE + "/api/auth", { password: "" })).status === 403, "empty password cannot create a controller session");
  for (const [method, route, body] of [["GET", "/api/stream?role=controller"], ["POST", "/api/intent", { type: "newGame" }], ["GET", "/api/thccb"]]) {
    assert((await req(method, BASE + route, body)).status === 403, "unconfigured server blocks " + route);
  }
  const unconfiguredMonitor = await openStream("/api/stream");
  assert(unconfiguredMonitor.status === 200, "unconfigured server still allows spectators");
  unconfiguredMonitor.request.destroy();
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("AUTH TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
