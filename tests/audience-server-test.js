"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { once } = require("events");
const { mockSatori, message, waitFor } = require("./qq-test-helpers.js");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-qq-server-"));
  const root = path.join(__dirname, "..");
  const mock = await mockSatori();
  const serverFile = path.join(tmp, "server.js");
  const archiveFile = path.join(tmp, "data", "qq-rounds.jsonl");
  let server;
  let stream;
  let latest;
  let state;
  let base;
  let cookie;
  const snapshots = [];

  async function request(route, body, authenticated = true) {
    const headers = authenticated && cookie ? { Cookie: cookie } : {};
    if (body) headers["Content-Type"] = "application/json";
    return fetch(base + route, { method: body ? "POST" : "GET", headers,
      body: body ? JSON.stringify(body) : undefined });
  }
  async function intent(type, extra = {}) {
    const response = await request("/api/intent", { type, ...extra });
    assert.equal(response.status, 200);
    await response.json();
  }
  function records() {
    if (!fs.existsSync(archiveFile)) return [];
    const text = fs.readFileSync(archiveFile, "utf8");
    if (!text.endsWith("\n")) return [];
    return text.trim().split("\n").filter(Boolean).map(JSON.parse);
  }
  async function start() {
    delete require.cache[require.resolve(serverFile)];
    ({ server, state } = require(serverFile));
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    const auth = await request("/api/auth", { password: "website-password" }, false);
    cookie = auth.headers.get("set-cookie").split(";")[0];
    latest = undefined;
    stream = http.get(base + "/api/stream", { headers: { Cookie: cookie } }, res => {
      let buffer = "";
      res.on("data", data => {
        buffer += data;
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("data: ")) {
            latest = JSON.parse(frame.slice(6));
            snapshots.push(latest);
          }
        }
      });
    });
    stream.on("error", () => {});
    await waitFor(() => latest && latest.audience.connected, "QQ connection status via authenticated SSE");
  }
  async function stop() {
    if (stream) stream.destroy();
    if (server && server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  try {
    // Isolated backend copy allows security fixtures without touching shared UI files.
    for (const name of ["server.js", "game.js", "target-sampling-config.js", "audience.js", "audience-archive.js", "satori.js", "cards.yaml"])
      fs.copyFileSync(path.join(root, name), path.join(tmp, name));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(tmp, "node_modules"), "dir");
    fs.mkdirSync(path.join(tmp, "assets"));
    fs.writeFileSync(path.join(tmp, "assets", "头像.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.writeFileSync(path.join(tmp, "index.html"), "<!doctype html><title>test</title>");
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ password: "website-password", qq: {
      enabled: true, groupId: "123456789", url: mock.url, token: mock.token
    } }));
    fs.symlinkSync(path.join(tmp, "config.json"), path.join(tmp, "assets", "secret.svg"));
    process.env.PORT = "0";
    process.env.WL_CONFIG = path.join(tmp, "config.json");
    process.env.WL_AUTH_SESSIONS = path.join(tmp, "auth-sessions.json");
    process.env.WL_QQ_RESULTS = archiveFile;
    await start();
    assert.equal((await request("/api/stream", undefined, false)).status, 401);
    assert.equal((await request("/api/intent", { type: "setup" }, false)).status, 401);
    for (const route of ["/config.json", "/auth-sessions.json", "/server.js", "/satori.js", "/audience.js",
      "/node_modules/ws/package.json", "/assets/secret.svg", "/assets/%2e%2e/config.json", "/data/qq-rounds.jsonl"])
      assert.equal((await request(route, undefined, false)).status, 404, route + " is private");
    assert.equal((await request("/%ZZ")).status, 400);
    assert.equal((await request("/%00")).status, 400);
    assert.equal((await request("/assets/" + encodeURIComponent("头像.svg"))).status, 200);
    assert.equal((await request("/game.js")).status, 200);

    await intent("setup", { cardMode: "single", first: "A" });
    state.target.center = 670;
    mock.send({ op: 0, body: message("11", "g34%") });
    await intent("donePsychic");
    await waitFor(() => latest.audience.accepting, "answer window opens");
    const sent = [];
    for (let i = 1; i <= 6; i++) {
      const event = message(String(100 + i), `g${(60 + i) * 2 - 100}%`);
      sent.push(event);
      mock.send({ op: 0, body: event });
    }
    await waitFor(() => latest.audience.count === 6, "six participants via real WS and SSE");
    assert.deepEqual(latest.audience.winners, []);
    assert.equal(latest.audience.targetPct, null);
    assert.equal(JSON.stringify(latest.audience).includes("群名片"), false);

    mock.send({ op: 0, body: sent[0] });
    mock.send({ op: 0, body: message("700", "g34%", { channel: { id: "other", type: 0 } }) });
    mock.send({ op: 0, body: message("700", "g34%", { channel: { id: "123456789", type: 1 } }) });
    mock.send({ op: 0, body: message("90001", "g34%") });
    mock.send({ op: 0, body: message("700", "ordinary chat") });
    await intent("lock");
    const correction = message("101", "g34.2%", { member: { nick: "<img src=x onerror=alert(1)>" } });
    mock.send({ op: 0, body: correction });
    // The accepted revision yields a fresh SSE snapshot with unchanged participant count.
    const beforeCorrection = snapshots.length;
    await waitFor(() => snapshots.length > beforeCorrection, "revision broadcast");
    assert.equal(latest.audience.count, 6);
    await intent("guess", { guess: "R" });
    await intent("reveal");
    await waitFor(() => latest.audience.revealed, "reveal broadcasts ranking");
    const winnerSnapshot = JSON.stringify(latest.audience.winners);
    assert.equal(latest.audience.winners.length, 5);
    assert.equal(latest.audience.winners[0].guessPct, 34.2);
    assert.equal(latest.audience.winners[0].errorPct, 0.2);
    assert.equal(latest.audience.winners[0].nickname, "<img src=x onerror=alert(1)>");
    mock.send({ op: 0, body: message("999", "g34%") });
    await intent("noop");
    await waitFor(() => records().length === 1, "round is persisted");
    assert.equal(JSON.stringify(latest.audience.winners), winnerSnapshot);
    const first = records()[0];
    assert.equal(first.ranking.length, 6);
    assert.equal(first.submissions.length, 7);
    assert.equal(first.ranking[0].userId, "101");
    assert.equal(first.ranking[0].messageId, correction.message.id);
    assert.equal(first.targetPct, 34);
    assert.ok(first.question.pair.length === 2);
    assert.ok(first.gameId && first.roundId);
    assert.equal((await request("/data/qq-rounds.jsonl")).status, 404, "existing archive remains private even with login");
    const output = JSON.stringify(snapshots);
    assert.equal(output.includes(mock.token), false);
    assert.equal(output.includes("website-password"), false);
    assert.equal(fs.readFileSync(archiveFile, "utf8").includes("ordinary chat"), false);
    assert.equal(fs.readFileSync(archiveFile, "utf8").includes(mock.token), false);

    await new Promise(resolve => setTimeout(resolve, 20));
    await intent("nextRound");
    await intent("donePsychic");
    const connections = mock.identifies.length;
    mock.connections.at(-1).terminate();
    await waitFor(() => !latest.audience.connected, "disconnect shown over SSE");
    await waitFor(() => mock.identifies.length > connections && latest.audience.connected, "automatic reconnect shown over SSE");
    assert.ok(mock.identifies.at(-1).sn);
    mock.send({ op: 0, body: sent[0] });
    mock.send({ op: 0, body: { ...sent[1], message: { ...sent[1].message, id: "previous-round-replay" } } });
    const nextAnswer = message("888", "g-100%");
    mock.send({ op: 0, body: nextAnswer });
    await waitFor(() => latest.audience.count === 1, "only a fresh answer enters new round");
    await intent("lock");
    await intent("guess", { guess: "L" });
    await intent("reveal");
    await waitFor(() => records().length === 2, "second round archive");
    assert.equal(records()[1].gameId, first.gameId);
    assert.notEqual(records()[1].roundId, first.roundId);
    assert.equal(records()[1].count, 1);

    await stop();
    await start();
    assert.equal(latest.phase, "setup");
    assert.equal(latest.audience.count, 0, "restart does not restore active games");
    assert.equal(records().length, 2, "restart keeps completed history");
    await intent("setup", { cardMode: "single" });
    await intent("donePsychic");
    await intent("lock");
    await intent("guess", { guess: "L" });
    await intent("reveal");
    await waitFor(() => records().length === 3, "post-restart round appends");
    assert.notEqual(records()[2].gameId, first.gameId);
    assert.equal(records()[2].count, 0);
    console.log("AUDIENCE SERVER INTEGRATION TEST PASSED");
  } finally {
    await stop();
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
