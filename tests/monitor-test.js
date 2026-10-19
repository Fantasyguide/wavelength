"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wl-monitor-"));
  let server, browser;
  try {
    process.env.PORT = "0";
    process.env.WL_CONFIG = path.join(tmp, "config.json");
    process.env.WL_AUTH_SESSIONS = path.join(tmp, "auth.json");
    fs.writeFileSync(process.env.WL_CONFIG, JSON.stringify({ password: "" }));
    const backend = require("../server.js");
    server = backend.server;
    await new Promise(resolve => server.once("listening", resolve));
    console.log("monitor QA: isolated server ready");
    const state = backend.state;
    const base = "http://127.0.0.1:" + server.address().port;
    async function intent(type, extra = {}) {
      const res = await fetch(base + "/api/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...extra }) });
      assert.equal(res.status, 200);
    }
    browser = await puppeteer.launch({ executablePath: require("./chrome.js")(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const controller = await browser.newPage();
    const monitor = await browser.newPage();
    await monitor.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    console.log("monitor QA: browser pages ready");
    const errors = [];
    for (const page of [controller, monitor]) page.on("pageerror", error => errors.push(error.message));
    // Drive only the display's clock in the scrolling check, without waiting through every record.
    await monitor.evaluateOnNewDocument(() => {
      const original = window.setInterval;
      window.setInterval = function (callback, delay, ...args) {
        if (delay === 100) window.displayScrollTick = callback;
        return original.call(this, callback, delay, ...args);
      };
    });
    await controller.setViewport({ width: 1280, height: 960 });
    await monitor.setViewport({ width: 3904, height: 672, deviceScaleFactor: 1 });
    for (const [page, role] of [[controller, "controller"], [monitor, "monitor"]]) {
      await page.bringToFront();
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForSelector("#role-modal:not(.hidden)");
      await page.click("#btn-role-" + role);
      console.log("monitor QA: selected " + role);
    }
    await intent("loadDeck", { cards: [["短", "右边较长的概念", "独处", "喜欢热闹"]] });
    await intent("setRuleSet", { value: "original" });
    await intent("setWinScore", { value: 4 });
    await intent("setup", { teamA: "幻想乡", teamB: "外来人", first: "A", cardMode: "single" });
    state.target.center = 250;
    await intent("donePsychic");
    await monitor.waitForFunction(() => document.body.dataset.phase === "dial");
    console.log("monitor QA: game ready");
    await controller.bringToFront();
    await controller.click("details.rules > summary");
    await monitor.bringToFront();
    await monitor.waitForFunction(() => document.querySelector("details.rules").open);
    console.log("monitor QA: shared rules open");
    assert.equal(await monitor.$eval("details.rules > summary", el => getComputedStyle(el).display), "none");
    assert(await monitor.$eval("details.rules", el => el.scrollHeight <= el.clientHeight), "all monitor rules fit without scrolling");
    const screenshotDir = process.env.WL_MONITOR_SCREENSHOTS;
    async function shot(name) {
      await monitor.evaluate(() => document.fonts.ready);
      if (!screenshotDir) return;
      fs.mkdirSync(screenshotDir, { recursive: true });
      await monitor.screenshot({ path: path.join(screenshotDir, name + ".png") });
    }
    await shot("ultrawide-rules");
    await monitor.$eval("details.rules > summary", el => el.click());
    assert(await monitor.$eval("details.rules", el => el.open), "monitor cannot dismiss shared help");
    await controller.bringToFront();
    await controller.click("details.rules > summary");
    await monitor.bringToFront();
    await monitor.waitForFunction(() => !document.querySelector("details.rules").open);
    await monitor.bringToFront();
    await shot("ultrawide-dial");
    await intent("setDial", { value: 250 });
    await intent("lock");
    await intent("guess", { guess: "R" });
    await intent("reveal");
    await monitor.waitForFunction(() => document.body.dataset.phase === "over");
    assert.deepEqual(await monitor.$$eval(".band-label", els => els.map(el => el.textContent)), ["2", "3", "4", "3", "2"], "score bands display digits only");
    assert(await monitor.$eval("#over-modal", el => el.classList.contains("hidden")), "monitor enters recap directly");
    assert(await monitor.$eval("#hint", el => el.textContent === "第 1 轮 · 复盘"));
    assert(await monitor.$eval(".team.a", el => el.classList.contains("is-winner") && el.getAttribute("aria-label").includes("获胜")));
    await controller.bringToFront();
    await controller.waitForSelector("#over-modal:not(.hidden)");
    assert(await controller.$eval("#over-modal", el => !el.classList.contains("hidden")), "controller retains end-game actions");
    await monitor.bringToFront();
    assert(await monitor.$eval("#log", el => el.textContent.includes("-50% / -50%")));
    await shot("ultrawide-recap");
    // More records than can fit: exercise passive history rotation.
    state.log = Array.from({ length: 5 }, (_, i) => ({ ...state.log[0], round: 5 - i }));
    await intent("noop");
    await monitor.waitForFunction(() => document.querySelectorAll("#log li").length === 5);
    for (const [width, height] of [[3904, 672], [1952, 336]]) {
      await monitor.setViewport({ width, height, deviceScaleFactor: 1 });
      const layout = await monitor.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const a = rect(".team.a"), b = rect(".team.b"), card = rect(".card-area");
        const history = rect(".log");
        const pair = rect(".side.selected .con"), dash = rect(".side.selected .con i");
        return {
          sides: a.right < card.left && card.right < b.left,
          panels: history.top > a.bottom && history.height > 0 && history.bottom <= innerHeight,
          centered: Math.abs(pair.left + pair.right - dash.left - dash.right) < 1,
          noOverflow: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight
        };
      });
      assert.deepEqual(layout, { sides: true, panels: true, centered: true, noOverflow: true });
      const visible = await monitor.evaluate(() => {
        const originalNow = Date.now;
        let now = originalNow();
        Date.now = () => now;
        const seen = { log: new Set() };
        try {
          for (let tick = 0; tick < 2500; tick++) {
            now += 250;
            window.displayScrollTick();
            for (const id of Object.keys(seen)) {
              const list = document.getElementById(id), bounds = list.getBoundingClientRect();
              Array.from(list.children).forEach((row, index) => {
                const r = row.getBoundingClientRect();
                if (r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1) seen[id].add(index);
              });
            }
          }
        } finally { Date.now = originalNow; }
        return Object.fromEntries(Object.entries(seen).map(([id, indices]) => [id, indices.size]));
      });
      assert.deepEqual(visible, { log: 5 }, "every record becomes fully visible without monitor input");
    }
    await intent("newGame");
    await monitor.waitForFunction(() => document.body.dataset.phase === "setup");
    assert.equal(await monitor.$$(".team-direction").then(els => els.length), 0, "team cards have no gray arrow elements");
    assert(await monitor.$eval("#over-modal", el => el.classList.contains("hidden")));
    // A reveal animates once, while repeated SSE snapshots and a reconnect do not.
    await monitor.setViewport({ width: 3904, height: 672, deviceScaleFactor: 1 });
    await monitor.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await intent("setWinScore", { value: 10 });
    await intent("setup", { teamA: "幻想乡", teamB: "外来人", first: "A", cardMode: "single" });
    await intent("donePsychic");
    await intent("setDial", { value: state.target.center });
    await intent("lock");
    await intent("guess", { guess: "R" });
    await monitor.waitForFunction(() => document.body.dataset.phase === "reveal");
    await monitor.evaluate(() => {
      window.perfectAnimations = 0;
      document.querySelector(".team.a").addEventListener("animationstart", e => {
        if (e.animationName === "perfect-border") window.perfectAnimations++;
      });
    });
    await intent("reveal");
    await monitor.waitForFunction(() => document.querySelector(".team.a.perfect-hit") && window.perfectAnimations === 1);
    assert.equal(await monitor.$eval("#gainA", el => el.textContent), "+4");
    assert.equal(await monitor.$eval(".phase-message", el => el.textContent), "第 1 轮 · 结算");
    assert(await monitor.$eval(".team.b", el => el.classList.contains("is-active")));
    assert.equal(await monitor.$eval("#score-pop", el => el.textContent), "", "points are communicated by the team card");
    await shot("ultrawide-perfect-hit");
    for (let update = 0; update < 3; update++) await intent("noop");
    await monitor.waitForFunction(() => document.getElementById("scoreA").textContent === "4" && !document.querySelector(".perfect-hit"));
    assert.equal(await monitor.evaluate(() => window.perfectAnimations), 1, "unrelated snapshots do not replay the celebration");
    await monitor.reload({ waitUntil: "domcontentloaded" });
    await monitor.waitForSelector("#role-modal:not(.hidden)");
    await monitor.click("#btn-role-monitor");
    await monitor.waitForFunction(() => document.body.dataset.phase === "revealed");
    assert.equal(await monitor.$$(".perfect-hit, .is-scoring").then(els => els.length), 0, "loading an already revealed round has no celebration");
    assert.equal(await monitor.$eval("#scoreA", el => el.textContent), "4");
    await intent("nextRound");
    await monitor.waitForFunction(() => document.body.dataset.phase === "psychic");
    assert.equal(await monitor.$eval("#gainA", el => el.textContent), "", "the next turn clears transient points");
    await intent("donePsychic");
    await intent("setDial", { value: 745 });
    await intent("lock");
    await intent("guess", { guess: "L" });
    await monitor.waitForFunction(() => document.getElementById("guess-region").dataset.side === "L");
    assert(await monitor.$eval(".team.a", el => el.getAttribute("aria-label").includes("选择左边")), "A's direction is accessible when B takes the dial");
    assert.equal(await monitor.$$(".team-direction").then(els => els.length), 0, "guessing never adds a gray team-card arrow");
    assert.deepEqual(errors, []);
    console.log("PASSIVE MONITOR TEST PASSED: shared rules, opposite teams, history auto-scrolling, automatic recap, centered separator");
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
