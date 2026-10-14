"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const puppeteer = require("puppeteer-core");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-rules-"));
  let browser, server;
  try {
    process.env.PORT = "0";
    process.env.WL_CONFIG = path.join(tmp, "config.json");
    process.env.WL_AUTH_SESSIONS = path.join(tmp, "auth.json");
    fs.writeFileSync(process.env.WL_CONFIG, JSON.stringify({ password: "", qq: { enabled: false } }));
    const backend = require("../server.js");
    server = backend.server;
    await new Promise(resolve => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const state = backend.state;
    async function intent(type, extra = {}) {
      const response = await fetch(base + "/api/intent", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...extra }) });
      assert.equal(response.status, 200);
    }
    browser = await puppeteer.launch({ executablePath: require("./chrome.js")(), headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const errors = [];
    async function page(width, height) {
      const p = await browser.newPage();
      p.on("pageerror", e => errors.push(e.message));
      await p.setViewport({ width, height });
      await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      return p;
    }
    async function text(p, selector) { return p.$eval(selector, el => el.textContent); }
    async function shot(p, name) {
      if (!process.env.WL_RULES_SCREENSHOTS) return;
      fs.mkdirSync(process.env.WL_RULES_SCREENSHOTS, { recursive: true });
      await p.bringToFront();
      await p.screenshot({ path: path.join(process.env.WL_RULES_SCREENSHOTS, name + ".png") });
    }

    // Offline mobile setup uses the same presets and keeps them on restart.
    const local = await page(390, 844);
    await local.goto(pathToFileURL(path.join(__dirname, "..", "index.html")).href);
    await local.waitForSelector("#setup-modal:not(.hidden)");
    assert.equal(await local.$eval("#opt-rule-set", el => el.value), "original");
    await local.select("#opt-rule-set", "balanced");
    assert.equal(await local.$eval("#opt-winscore", el => el.value), "8");
    assert.equal(await local.$eval("#opt-bandwidth", el => el.value), "48");
    assert(await local.$eval("#opt-winscore", el => el.disabled));
    assert(await local.$eval("#opt-bandwidth", el => el.disabled));
    assert.match(await text(local, "#rule-summary"), /双方 0 分/);
    assert(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile setup has no horizontal overflow");
    await local.evaluate(() => document.fonts.ready);
    await shot(local, "mobile-setup");
    await local.select("#select-first", "B");
    await local.click("#btn-start");
    await local.waitForSelector(".card-choice");
    assert.equal(await text(local, "#scoreA"), "0");
    assert.equal(await text(local, "#scoreB"), "0");
    await local.click("#btn-restart");
    assert.equal(await local.$eval("#opt-rule-set", el => el.value), "balanced");
    await local.select("#opt-rule-set", "original");
    assert.equal(await local.$eval("#opt-winscore", el => el.disabled), false);
    assert.equal(await local.$eval("#opt-winscore", el => el.value), "10");
    assert.equal(await text(local, "#scoreA"), "1", "original restores second-team bonus with B first");
    await local.close();
    console.log("rules QA: offline mobile presets passed");

    const controller = await page(1280, 960);
    const monitor = await page(3904, 672);
    for (const [p, role] of [[controller, "controller"], [monitor, "monitor"]]) {
      await p.bringToFront();
      await p.goto(base, { waitUntil: "domcontentloaded" });
      await p.waitForSelector("#role-modal:not(.hidden)");
      await p.click("#btn-role-" + role);
      await p.evaluate(() => document.fonts.ready);
    }
    await controller.bringToFront();
    await controller.select("#opt-rule-set", "balanced");
    await monitor.waitForFunction(() => document.getElementById("rule-turns").textContent.includes("平衡快局"), { polling: 50 });
    assert.equal(state.ruleSet, "balanced", "preset is held by the server");
    assert.match(await text(monitor, "#rule-overtime"), /仍平则和局/);
    await controller.select("#select-first", "B");
    await controller.select("#opt-card-mode", "single");
    await controller.click("#btn-start");
    await monitor.waitForFunction(() => document.body.dataset.phase === "psychic", { polling: 50 });
    assert.equal(state.active, "B");
    assert.deepEqual([state.teams.A.score, state.teams.B.score], [0, 0]);
    assert.equal(state.target.dist, "recommended");
    assert.match(await text(monitor, "#card-label"), /平衡快局/);
    await controller.click("details.rules > summary");
    await monitor.waitForFunction(() => document.querySelector("details.rules").open, { polling: 50 });
    assert(await monitor.$eval("details.rules", el => el.scrollHeight <= el.clientHeight), "balanced rules fit the wide display");
    await shot(monitor, "wide-rules");
    await controller.bringToFront();
    await controller.click("details.rules > summary");
    await monitor.waitForFunction(() => !document.querySelector("details.rules").open, { polling: 50 });
    await intent("setRuleSet", { value: "original" });
    assert.equal(state.ruleSet, "balanced", "API cannot switch rules mid-game");
    console.log("rules QA: network preset and help passed");

    // Reach the regular cap with 0:0, then complete a tied overtime pair.
    for (let round = 1; round <= 8; round++) {
      assert.equal(state.round, round);
      assert.equal(state.active, round % 2 ? "B" : "A");
      state.target.center = 500;
      await intent("donePsychic");
      await intent("setDial", { value: 700 });
      await intent("lock", { timerSeconds: 0 });
      await intent("guess", { guess: "R" });
      await intent("reveal");
      await monitor.waitForFunction(r => document.querySelectorAll("#log li").length === r, { polling: 50 }, round);
      if (round === 6) {
        assert.equal(state.sudden, true);
        assert.match(await text(monitor, "#overtimeA"), /加时 0 分 · 待出题/);
      }
      if (round === 7) {
        assert.match(await text(monitor, "#overtimeB"), /已出题/);
        assert.match(await text(monitor, "#overtimeA"), /待出题/);
        for (const selector of ["#overtimeA", "#overtimeB"]) {
          assert(await monitor.$eval(selector, el => {
            const r = el.getBoundingClientRect(), team = el.closest(".team").getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.left >= team.left && r.right <= team.right && r.bottom <= team.bottom;
          }), "overtime score stays visible inside the team card");
        }
        await shot(monitor, "wide-overtime");
      }
      if (round < 8) await intent("nextRound");
    }
    await controller.waitForSelector("#over-modal:not(.hidden)");
    assert.match(await text(controller, "#winner-text"), /双方和局/);
    assert.match(await text(controller, "#final-score"), /加时 0 : 0，仍平/);
    assert.match(await text(monitor, "#hint"), /和局复盘/);
    assert.equal(await monitor.$$(".team.is-winner").then(els => els.length), 0);
    assert(await monitor.$eval("#over-modal", el => el.classList.contains("hidden")), "monitor goes straight to recap");
    await shot(monitor, "wide-draw");
    await monitor.setViewport({ width: 1280, height: 960 });
    await intent("noop");
    await monitor.waitForFunction(() => document.getElementById("hint").textContent.includes("双方和局"), { polling: 50 });
    assert.match(await text(monitor, "#overtimeA"), /加时 0 分/);
    await monitor.reload({ waitUntil: "domcontentloaded" });
    await monitor.waitForSelector("#role-modal:not(.hidden)");
    await monitor.click("#btn-role-monitor");
    await monitor.waitForFunction(() => document.body.dataset.phase === "over", { polling: 50 });
    assert.match(await text(monitor, "#hint"), /双方和局/, "draw survives reconnect");
    await controller.bringToFront();
    await controller.click("#btn-playagain");
    await controller.waitForSelector("#setup-modal:not(.hidden)");
    assert.equal(await controller.$eval("#opt-rule-set", el => el.value), "balanced");
    await controller.select("#opt-rule-set", "original");
    await monitor.waitForFunction(() => document.getElementById("rule-turns").textContent.startsWith("原版"), { polling: 50 });
    assert.deepEqual([state.winScore, state.bandWidth], [10, 40]);
    assert.deepEqual(errors, [], "no browser errors, including draw rendering");
    console.log("RULES BROWSER TEST PASSED: local mobile, shared presets, overtime scores, draw recap, reconnect, and restart");
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
