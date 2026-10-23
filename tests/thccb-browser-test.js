"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const puppeteer = require("puppeteer-core");

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-thccb-browser-"));
  process.env.PORT = "0";
  process.env.WL_CONFIG = path.join(dir, "config.json");
  process.env.WL_AUTH_SESSIONS = path.join(dir, "sessions.json");
  fs.writeFileSync(process.env.WL_CONFIG, JSON.stringify({ password: "browser-test-password" }));
  let rejectClose = true;
  let notificationDelay = 0;
  let resultMode = "ranked";
  let resultTarget = 500;
  const topFive = [
    { username: "博丽灵梦", position: 500, distance: 0, payout: "1280" },
    { username: "雾雨魔理沙", position: 501, distance: 1, payout: "960" },
    { username: "一位名字特别长的幻想乡观众", position: 499, distance: 1, payout: "720" },
    { username: "<img src=x onerror=alert(1)>", position: 516, distance: 16, payout: "360" },
    { username: "东风谷早苗", position: 556, distance: 56, payout: "120" }
  ];
  const actions = [];
  const rounds = new Map();
  const source = http.createServer(async (req, res) => {
    if (req.url === "/api/v1/returned/current") {
      res.writeHead(200);
      res.end('null');
      return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : {};
    const key = body.round_key || decodeURIComponent(req.url.split('/').at(-2));
    const action = req.url.split('/').at(-1);
    if (action === 'capabilities') { res.end(JSON.stringify({ round_state: true, durable_cancel: true })); return; }
    if (action === 'state') { const r = rounds.get(key); res.end(JSON.stringify({ round_key: key, status: r ? r.status : 'missing', exists: !!r, summary: r || null })); return; }
    if (action === 'abort') { const r = rounds.get(key); if (r && r.status !== 'settled') r.status = 'cancelled'; res.end(JSON.stringify({ round_key: key, status: r ? r.status : 'cancelled', exists: !!r, summary: r || null })); return; }
    actions.push(req.url);
    if (action === 'start') rounds.set(key, { ...body, status: 'open' });
    if (action === 'close' && !rejectClose) rounds.get(key).status = 'closed';
    if (action === 'result') { rounds.get(key).status = 'settled'; rounds.get(key).target_position = body.target_position; }
    const results = req.url.endsWith("/results");
    if (notificationDelay) await new Promise(resolve => setTimeout(resolve, notificationDelay));
    res.writeHead((rejectClose && req.url.endsWith("/close")) || (results && resultMode === "error") ? 503 : 200);
    res.end(JSON.stringify(results ? {
      round_key: decodeURIComponent(req.url.split("/").at(-2)), target_position: resultTarget,
      top_five: resultMode === "empty" ? [] : topFive
    } : rounds.get(key) || {}));
  });
  const { server, state } = require("../server.js");
  let browser;
  try {
    await once(server, "listening");
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    browser = await puppeteer.launch({ executablePath: require("./chrome.js")(), headless: true, args: ["--no-sandbox"] });
    const controller = await browser.newPage();
    const errors = [];
    controller.on("pageerror", error => errors.push(error.message));
    await controller.setViewport({ width: 390, height: 844 });
    await controller.goto(base, { waitUntil: "domcontentloaded" });
    await controller.waitForSelector("#role-modal:not(.hidden)");
    await controller.click("#btn-role-controller");
    await controller.waitForSelector("#auth-modal:not(.hidden)");
    await controller.type("#auth-password", "browser-test-password");
    await controller.click("#btn-auth");
    await controller.waitForFunction(() => document.getElementById("thccb-secret-state").textContent.includes("尚未"));
    assert.equal(await controller.$eval("#conn-badge", el => el.textContent), "RETURNED已连接");
    assert.equal(await controller.$eval("#thccb-conn-badge", el => el.textContent), "THCCB未启用");
    await controller.$eval("details.advanced", el => { el.open = true; });
    await controller.$eval("#thccb-url", (el, value) => { el.value = value; }, "http://127.0.0.1:" + source.address().port);
    const secret = "browser-test-secret-at-least-32-characters";
    await controller.$eval("#thccb-secret", (el, value) => { el.value = value; }, secret);
    await controller.click("#thccb-save");
    await controller.waitForFunction(() => document.getElementById("thccb-config-message").textContent.includes("已保存"));
    await controller.click("#btn-restart");
    await controller.click("#thccb-enabled");
    await controller.waitForFunction(() => document.getElementById("thccb-conn-badge").textContent === "THCCB已连接");
    await controller.click("#admin-close");
    assert.equal(await controller.$eval("#thccb-secret", el => el.value), "", "saving clears the password field");
    assert.equal(JSON.parse(fs.readFileSync(process.env.WL_CONFIG)).thccb.secret, secret);
    assert.equal(await controller.$$("#audience-panel, #audience-final").then(els => els.length), 0);

    async function intent(type, extra = {}) {
      return controller.evaluate(async payload => {
        const response = await fetch("/api/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        return response.status;
      }, { type, ...extra });
    }
    assert.equal(await intent("setup", { cardMode: "single" }), 200);
    state.target.center = 500;
    await intent("startDialTimer", { timerSeconds: 60, guessTimerSeconds: 7 });
    await intent("donePsychic");
    await intent("setDial", { value: 750 });
    // Force expiry only after the visible controller has acknowledged its clock;
    // otherwise that initial acknowledgement legitimately sets a fresh deadline.
    for (let tries = 0; state.timerSync.status !== "running" && tries < 100; tries++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state.timerSync.status, "running", "controller has started the dial clock");
    await controller.evaluate(timer => fetch("/api/timer", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "expired", client_id: timer.ownerId, timerId: timer.id, elapsedMs: timer.durationMs + 1500 }) }), state.timerSync);
    await controller.waitForFunction(() => document.getElementById("thccb-status-message").textContent.includes("操作待处理"));
    await controller.click("#btn-restart");
    assert.equal(state.phase, "dial");
    assert.match(await controller.$eval("#admin-thccb-detail", el => el.textContent), /HTTP 503/);
    assert.equal(await controller.$eval("#thccb-conn-badge", el => el.textContent), "THCCB已连接");
    assert(await controller.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "long round identifiers fit a phone");
    notificationDelay = 600;
    const failedAttempts = actions.filter(url => url.endsWith('/close')).length;
    await controller.click("#btn-thccb-retry");
    assert.deepEqual(await controller.$eval("#btn-thccb-retry", el => [el.textContent, el.disabled, el.getAttribute('aria-busy')]),
      ["重试中…", true, 'true'], "retry immediately shows progress and prevents repeat clicks");
    assert.equal(await controller.$eval("#admin-menu", el => el.hidden), false);
    await controller.$eval("#btn-thccb-retry", el => el.click());
    await controller.waitForFunction(() => !document.getElementById("btn-thccb-retry").disabled &&
      document.getElementById("admin-thccb-detail").textContent.includes("HTTP 503"));
    assert.equal(actions.filter(url => url.endsWith('/close')).length, failedAttempts + 1, "double-click cannot send another retry");
    assert.equal(await controller.$eval("#btn-thccb-retry", el => el.textContent), "重试联动");
    rejectClose = false;
    await controller.click("#btn-thccb-retry");
    await controller.waitForFunction(() => document.body.dataset.phase === "guess" && !document.getElementById("btn-thccb-retry").disabled);
    assert.equal(state.dial, 750);
    assert.match(await controller.$eval("#thccb-status", el => el.textContent), /已封盘/);
    await controller.click("#admin-close");
    assert(await controller.evaluate(() => document.getElementById("thccb-status").getBoundingClientRect().top >= document.getElementById("controls").getBoundingClientRect().bottom), "bridge status sits below game controls");
    assert.equal(await controller.$eval("#thccb-conn-badge", el => el.textContent), "THCCB已连接");
    notificationDelay = 0;
    assert.equal(actions.filter(url => url.endsWith("/start")).length, 1, "retry does not reopen the question");
    assert(!JSON.stringify(state).includes(secret));

    const monitorContext = await browser.createBrowserContext();
    const monitor = await monitorContext.newPage();
    monitor.on("pageerror", error => errors.push(error.message));
    await monitor.setViewport({ width: 3904, height: 672 });
    await monitor.goto(base, { waitUntil: "domcontentloaded" });
    await monitor.waitForSelector("#role-modal:not(.hidden)");
    assert(await monitor.$eval("#auth-modal", el => el.classList.contains("hidden")), "anonymous monitor chooses a role without a password");
    await monitor.click("#btn-role-monitor");
    await monitor.waitForFunction(() => document.body.dataset.phase === "guess");
    assert.equal(await monitor.$eval("#thccb-conn-badge", el => el.textContent), "THCCB已连接");
    assert(await monitor.evaluate(() => {
      const thccb = document.getElementById('thccb-conn-badge').getBoundingClientRect();
      const returned = document.getElementById('conn-badge').getBoundingClientRect();
      return thccb.width > 0 && thccb.right <= returned.left && Math.abs(thccb.top - returned.top) < 1;
    }), "THCCB badge sits visibly to the left of RETURNED on the monitor");
    assert.equal(await monitor.evaluate(() => fetch('/api/ping').then(r => r.json()).then(j => j.authed)), false);
    assert.equal(await monitor.evaluate(() => fetch('/api/thccb').then(r => r.status)), 401, "spectator has no bridge privileges");
    assert(await monitor.$eval("#thccb-settings", el => el.hidden), "monitor has no bridge configuration controls");
    assert(await monitor.$eval("#thccb-status", el => el.classList.contains("hidden")), "monitor does not show controller-only bridge details");
    assert.equal(await monitor.$$("#audience-panel").then(els => els.length), 0, "no legacy QQ leaderboard remains");

    async function checkView(view, phase) {
      if (view === "qr" && ["setup", "chooseCard", "psychic"].includes(phase)) view = "paused";
      await monitor.waitForFunction((view, phase) => document.body.dataset.phase === phase &&
        document.getElementById("audience-results").dataset.view === view, {}, view, phase);
      assert(await monitor.$eval(view === "qr" ? "#audience-qr" : view === "paused" ? "#audience-paused" : "#audience-results-board", el => el.checkVisibility()), `${view} is actually visible during ${phase}`);
      assert(await monitor.$eval(view === "qr" ? "#audience-results-board" : "#audience-qr", el => !el.checkVisibility()), "the other view is hidden, not just assigned a class");
    }
    async function screenshot(name) {
      if (!process.env.WL_AUDIENCE_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.WL_AUDIENCE_SCREENSHOT_DIR, { recursive: true });
      await monitor.screenshot({ path: path.join(process.env.WL_AUDIENCE_SCREENSHOT_DIR, name + ".png") });
      await (await monitor.$("#audience-results")).screenshot({ path: path.join(process.env.WL_AUDIENCE_SCREENSHOT_DIR, name + "-card.png") });
    }
    await monitor.bringToFront();
    await checkView("qr", "guess");
    await monitor.evaluate(() => document.fonts.ready);
    const qr = await monitor.$eval("#audience-qr img", img => {
      const card = img.closest("section").getBoundingClientRect(), r = img.getBoundingClientRect();
      return { loaded: img.complete && img.naturalWidth === 450, fill: r.height / card.height,
        contained: r.top >= card.top && r.bottom <= card.bottom && r.left >= card.left && r.right <= card.right,
        fit: getComputedStyle(img).objectFit };
    });
    assert(qr.loaded && qr.fill > .91 && qr.contained && qr.fit === "contain", "original QR fills the inner frame without cropping or distortion");
    await screenshot("qr");
    await intent("guess", { guess: "L" });
    await checkView("qr", "reveal");
    await intent("reveal");
    await checkView("results", "revealed");
    assert.match(await monitor.$eval("#audience-results-note", el => el.textContent), /正在同步/);
    await monitor.waitForFunction(() => document.querySelectorAll("#audience-results-rows li").length === 5);
    assert.deepEqual(await monitor.$$eval(".audience-player", els => els.map(el => el.textContent)), topFive.map(entry => entry.username));
    assert.equal(await monitor.$$("#audience-results-rows img").then(els => els.length), 0, "no avatars or HTML from external usernames");
    assert.equal(await monitor.$eval(".audience-position", el => el.textContent), "0%");
    assert.equal(await monitor.$eval(".audience-error", el => el.textContent), "正中");
    assert.deepEqual(await monitor.$$eval(".audience-error", els => els.map(el => el.textContent)),
      ["正中", "差 +0.2%", "差 -0.2%", "差 +3.2%", "差 +11.2%"], "errors show guess minus target with the correct sign");
    assert.deepEqual(await monitor.$$eval(".audience-error", els => els.map(el => getComputedStyle(el).color)),
      ["rgb(0, 133, 68)", "rgb(57, 118, 25)", "rgb(57, 118, 25)", "rgb(71, 118, 25)", "rgb(102, 118, 25)"],
      "exact hits have exclusive emerald; even the smallest nonzero errors use a distinct yellow-green, symmetric on both sides");
    assert(await monitor.$$eval(".audience-error", els => els.every(el =>
      getComputedStyle(el).color !== getComputedStyle(el.parentElement.querySelector(".audience-position")).color)),
      "signed errors have a different color from the guess position");
    assert.equal(await monitor.$eval(".audience-payout", el => el.textContent), "1,280");
    for (const [width, height] of [[3904, 672], [1952, 336], [390, 844]]) {
      await monitor.setViewport({ width, height });
      await monitor.evaluate(() => document.fonts.ready);
      assert(await monitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}×${height}`);
      assert(await monitor.$$eval(".audience-winners li", rows => rows.every(row => row.scrollWidth <= row.clientWidth)), "long names stay inside rows");
      if (width >= 1800) {
        assert(await monitor.$eval(".audience-player", el => parseFloat(getComputedStyle(el).fontSize) >= 36 * innerWidth / 3904), "nicknames retain the old large type");
        assert(await monitor.$eval("#audience-results", el => {
          const card = el.getBoundingClientRect(), team = document.querySelector(".team.b").getBoundingClientRect();
          return card.top > team.bottom && card.bottom <= innerHeight;
        }), "audience card fits below the right team");
      }
    }
    await monitor.setViewport({ width: 3904, height: 672 });
    await monitor.$eval("#audience-results-rows", el => { el.scrollTop = 0; });
    await screenshot("leaderboard");
    await monitor.waitForFunction(() => {
      const list = document.getElementById("audience-results-rows");
      return list.lastElementChild.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
    }, { timeout: 20000 });
    assert(await monitor.$eval("#audience-results-rows", el => el.scrollTop > 0), "automatic scrolling exposes the fifth place without monitor input");
    await intent("nextRound");
    await checkView("qr", "psychic");
    assert.equal(await monitor.$$("#audience-results-rows li").then(els => els.length), 0, "next round clears old winners");

    // The regular two-card flow switches at selection, including after final recap.
    await intent("newGame");
    await checkView("qr", "setup");
    await intent("setup", { cardMode: "choice", ruleSet: "original", winScore: 0 });
    await checkView("qr", "chooseCard");
    for (const mode of ["empty", "error", "ranked"]) {
      resultMode = mode;
      if (mode === "ranked") {
        state.round = 10;
        state.teams.A.score = 6;
        state.teams.B.score = 0;
        resultTarget = 1000;
        [1000, 900, 850, 849, 0].forEach((position, i) => {
          topFive[i].position = position;
          topFive[i].distance = Math.abs(position - resultTarget);
        });
      }
      await intent("selectCard", { index: 0 });
      if (mode === "ranked") state.target.center = resultTarget;
      await checkView("qr", "psychic");
      await intent("donePsychic");
      await checkView("qr", "dial");
      await intent("lock");
      await checkView("qr", "guess");
      await intent("guess", { guess: "R" });
      await checkView("qr", "reveal");
      await intent("reveal");
      await checkView("results", mode === "ranked" ? "over" : "revealed");
      if (mode === "ranked") {
        await monitor.waitForFunction(() => document.querySelectorAll("#audience-results-rows li").length === 5);
        await monitor.reload({ waitUntil: "domcontentloaded" });
        await monitor.waitForSelector("#role-modal:not(.hidden)");
        await monitor.click("#btn-role-monitor");
        await checkView("results", "over");
        assert.deepEqual(await monitor.$$eval(".audience-error", els => els.map(el => el.textContent)),
          ["正中", "差 -20.0%", "差 -30.0%", "差 -30.2%", "差 -200.0%"], "signed errors use the returned target, including the maximum possible distance");
        assert.deepEqual(await monitor.$$eval(".audience-error", els => els.map(el => getComputedStyle(el).color)),
          ["rgb(0, 133, 68)", "rgb(118, 87, 25)", "rgb(118, 25, 25)", "rgb(118, 25, 25)", "rgb(118, 25, 25)"],
          "20 points is orange; 30 points and larger errors stay red");
        for (const [width, height] of [[3904, 672], [1952, 336], [390, 844]]) {
          await monitor.setViewport({ width, height });
          assert(await monitor.$$eval(".audience-error", els => els.every(el => el.scrollWidth <= el.clientWidth + 1)),
            `the sign and full 200-point error fit at ${width}×${height}`);
        }
      } else {
        await monitor.waitForFunction(text => document.getElementById("audience-results-note").textContent.includes(text), {}, mode === "empty" ? "没有观众" : "未能加载");
        assert.equal(await monitor.$$("#audience-results-rows li").then(els => els.length), 0);
        await intent("nextRound");
        await checkView("qr", "chooseCard");
      }
    }
    assert.equal(await intent("newGame"), 200);
    await checkView("qr", "setup");
    assert.deepEqual(errors, []);
    console.log("THCCB BROWSER TEST PASSED: configuration, retry, monitor privacy, large avatar-free rankings, QR/settlement transitions, automatic scrolling and responsive layouts");
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    source.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => source.close(resolve))]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
