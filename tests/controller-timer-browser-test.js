"use strict";
process.env.PORT = "0";
const fixture = require("./server-fixture");
fixture.configure();
const assert = require("node:assert/strict");
const { once } = require("node:events");
const puppeteer = require("puppeteer-core");
const { server, state } = require("../server");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await once(server, "listening");
  const browser = await puppeteer.launch({ executablePath: require("./chrome")(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      window.streamDelay = 0;
      window.reportDelay = 0;
      window.intentDelay = 0;
      const ES = window.EventSource, fetch = window.fetch;
      window.EventSource = class {
        constructor(url) {
          this.source = new ES(url);
          this.source.onopen = event => { if (this.onopen) this.onopen(event); };
          this.source.onerror = event => { if (this.onerror) this.onerror(event); };
          this.source.onmessage = event => setTimeout(() => {
            if (this.closed) return;
            window.latestGameState = JSON.parse(event.data);
            if (this.onmessage) this.onmessage(event);
          }, window.streamDelay);
        }
        close() { this.closed = true; this.source.close(); }
      };
      window.fetch = async function (url, options) {
        const delay = String(url) === "/api/timer" ? window.reportDelay : String(url) === "/api/intent" ? window.intentDelay : 0;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return fetch.call(this, url, options);
      };
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await fixture.loginController(page);
    await page.evaluate(() => { window.streamDelay = 2000; window.reportDelay = 1200; });
    const timerText = () => page.$eval("#timer-display", el => el.textContent);
    await page.click("#btn-start");
    await sleep(1000);
    assert.equal(state.timerEnd, null, "server does not spend time while cards are in transit");
    await page.waitForFunction(() => document.body.dataset.phase === "chooseCard");
    assert.equal(await timerText(), "00:10");
    await page.evaluate(() => { window.firstChoice = document.querySelector(".card-choice"); });
    await page.waitForFunction(() => document.getElementById("timer-display").textContent === "00:08");
    await page.waitForFunction(() => window.latestGameState.timerSync.status === "running");
    assert(await page.evaluate(() => window.firstChoice === document.querySelector(".card-choice")), "timer acknowledgement keeps cards clickable without replacing their DOM nodes");
    const oldId = state.timerSync.id;
    await page.click("#btn-redraw");
    await page.waitForFunction(id => window.latestGameState.timerSync.id !== id, {}, oldId);
    assert.equal(await timerText(), "00:10", "redraw gets ten seconds after its delayed delivery");
    await page.waitForFunction(() => document.getElementById("timer-display").textContent === "00:01", { timeout: 12000 });
    await page.click(".card-choice");
    await page.waitForFunction(() => document.body.dataset.phase === "psychic");
    assert.equal(state.phase, "psychic", "selection in the last visible second is accepted");
    console.log("ok: delayed selection/redraw retain ten playable seconds, including the last second");

    await page.evaluate(() => { window.intentDelay = 1800; });
    await page.click("#controls .btn");
    assert.equal(await timerText(), "01:00", "viewing starts a full minute immediately, before upload");
    await page.waitForFunction(() => document.getElementById("timer-display").textContent === "00:59");
    assert.equal(state.timerKind, null, "viewing request is still in transit");
    assert.equal(await timerText(), "00:59");
    await page.waitForFunction(() => window.latestGameState.timerKind === "dial" && window.latestGameState.timerSync.status === "running", { timeout: 10000 });
    const before = await timerText();
    assert(before >= "00:50" && before <= "00:58", "server acknowledgement does not reset the minute");
    await page.evaluate(() => { window.intentDelay = 0; });
    const dialId = state.timerSync.id;
    await page.click("#controls .btn");
    await page.waitForFunction(() => document.body.dataset.phase === "dial");
    assert.equal(state.timerSync.id, dialId, "discussion keeps the clue timer");
    console.log("ok: target viewing starts sixty seconds locally and discussion shares the remaining budget");

    await page.click("#btn-lock");
    await page.waitForFunction(() => document.body.dataset.phase === "guess");
    assert.equal(await timerText(), "00:15", "guessing gets fifteen seconds after delayed delivery");
    await page.waitForFunction(() => document.getElementById("timer-display").textContent === "00:11");
    const guessId = state.timerSync.id, guessEnd = state.timerEnd;
    await page.reload();
    await page.waitForSelector("#role-modal:not(.hidden)");
    await page.click("#btn-role-controller");
    await page.waitForFunction(() => document.body.dataset.phase === "guess");
    assert.equal(state.timerSync.id, guessId);
    assert.equal(state.timerEnd, guessEnd, "refresh does not grant another fifteen seconds");
    assert((await timerText()) < "00:15");

    await page.evaluate(() => fetch("/api/intent", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "setup", cardMode: "single" }) }));
    await page.waitForFunction(() => document.body.dataset.phase === "psychic");
    await page.evaluate(() => {
      window.originalRAF = window.requestAnimationFrame;
      window.pendingFrames = [];
      window.requestAnimationFrame = callback => window.pendingFrames.push(callback);
    });
    await page.click("#controls .btn");
    await page.waitForFunction(() => window.latestGameState.timerKind === "dial", { polling: 50 });
    await page.waitForFunction(() => document.getElementById("timer-display").textContent === "00:59", { polling: 50 });
    await page.click("#controls .btn");
    await page.waitForFunction(() => document.body.dataset.phase === "dial", { polling: 50 });
    assert.equal(state.timerSync.status, "running", "an already visible target binds its clock without waiting for another frame");
    await page.evaluate(() => {
      window.requestAnimationFrame = window.originalRAF;
      window.pendingFrames.forEach(callback => window.requestAnimationFrame(callback));
    });
    await sleep(100);
    assert((await timerText()) < "01:00", "quickly completing the clue cannot restart the shared minute");
    assert.deepEqual(errors, []);
    console.log("CONTROLLER TIMER BROWSER TEST PASSED: delayed delivery/upload, full durations, shared clock, quick completion and reload");
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
