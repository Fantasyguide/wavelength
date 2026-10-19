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
  const actions = [];
  const source = http.createServer((req, res) => {
    actions.push(req.url);
    req.resume();
    res.writeHead(rejectClose && req.url.endsWith("/close") ? 503 : 200);
    res.end("{}");
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
    await controller.$eval("details.advanced", el => { el.open = true; });
    await controller.$eval("#thccb-enabled", el => { el.checked = true; });
    await controller.$eval("#thccb-url", (el, value) => { el.value = value; }, "http://127.0.0.1:" + source.address().port);
    const secret = "browser-test-secret-at-least-32-characters";
    await controller.$eval("#thccb-secret", (el, value) => { el.value = value; }, secret);
    await controller.click("#thccb-save");
    await controller.waitForFunction(() => document.getElementById("thccb-config-message").textContent.includes("已保存"));
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
    await intent("startDialTimer", { timerSeconds: 60, guessTimerSeconds: 7 });
    await intent("donePsychic");
    await intent("setDial", { value: 750 });
    state.timerEnd = Date.now() - 1501;
    await controller.waitForSelector("#btn-thccb-retry:not(.hidden)");
    assert.equal(state.phase, "dial");
    assert.match(await controller.$eval("#thccb-status", el => el.textContent), /通知失败/);
    assert(await controller.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "long round identifiers fit a phone");
    rejectClose = false;
    await controller.click("#btn-thccb-retry");
    await controller.waitForFunction(() => document.body.dataset.phase === "guess" && document.getElementById("btn-thccb-retry").classList.contains("hidden"));
    assert.equal(state.dial, 750);
    assert.match(await controller.$eval("#thccb-status", el => el.textContent), /已封盘/);
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
    assert.equal(await monitor.evaluate(() => fetch('/api/ping').then(r => r.json()).then(j => j.authed)), false);
    assert.equal(await monitor.evaluate(() => fetch('/api/thccb').then(r => r.status)), 401, "spectator has no bridge privileges");
    assert(await monitor.$eval("#thccb-settings", el => el.hidden), "monitor has no bridge configuration controls");
    assert(await monitor.$eval("#thccb-status", el => el.classList.contains("hidden")), "monitor does not show controller-only bridge details");
    assert.equal(await monitor.$$("#audience-panel").then(els => els.length), 0, "no legacy QQ leaderboard remains");
    assert.equal(await intent("newGame"), 200);
    assert.deepEqual(errors, []);
    console.log("THCCB BROWSER TEST PASSED: mobile configuration, secret clearing, automatic failure and retry, monitor boundaries");
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    source.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => source.close(resolve))]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
