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
    const errors = [];
    async function makePage() {
      const page = await browser.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.evaluateOnNewDocument(() => {
        const realNow = Date.now.bind(Date), monotonic = performance.now.bind(performance);
        window.clockOffset = 0;
        window.streamDelay = 0;
        window.reportDelay = 0;
        window.timerTexts = [];
        window.tones = [];
        window.phaseChanges = [];
        window.timerReports = [];
        window.realElapsed = () => monotonic() - window.viewStartedAt;
        performance.now = () => monotonic() + window.clockOffset;
        const ES = window.EventSource, nativeFetch = window.fetch;
        window.EventSource = class {
          constructor(url) {
            this.source = new ES(url);
            this.source.onopen = event => this.onopen && this.onopen(event);
            this.source.onerror = event => this.onerror && this.onerror(event);
            this.source.onmessage = event => setTimeout(() => {
              if (this.closed) return;
              window.latestGameState = JSON.parse(event.data);
              if (this.onmessage) this.onmessage(event);
            }, window.streamDelay);
          }
          close() { this.closed = true; this.source.close(); }
        };
        window.fetch = async (url, options) => {
          if (url === "/api/timer") {
            window.timerReports.push(JSON.parse(options.body));
            if (window.reportDelay) await new Promise(resolve => setTimeout(resolve, window.reportDelay));
          }
          return nativeFetch(url, options);
        };
        window.AudioContext = class {
          constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
          createOscillator() {
            let tone;
            return { frequency: { setValueAtTime() {} }, connect() {},
              start() { tone = { at: realNow() }; window.tones.push(tone); },
              stop(time) { tone.duration = time; } };
          }
          createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        };
        document.addEventListener("DOMContentLoaded", () => {
          new MutationObserver(() => {
            const timer = document.getElementById("timer-display");
            if (!timer.classList.contains("hidden") && window.timerTexts.at(-1) !== timer.textContent) {
              window.timerTexts.push(timer.textContent);
            }
          }).observe(document.getElementById("timer-display"), { subtree: true, childList: true, attributes: true });
          new MutationObserver(() => {
            window.phaseChanges.push({ phase: document.body.dataset.phase, at: realNow() });
          }).observe(document.body, { attributes: true, attributeFilter: ["data-phase"] });
        });
      });
      await page.goto("http://127.0.0.1:" + server.address().port);
      await page.waitForSelector("#role-modal:not(.hidden)");
      return page;
    }
    const owner = await makePage();
    await fixture.loginController(owner);
    const monitor = await makePage();
    await monitor.click("#btn-role-monitor");
    await owner.select("#opt-card-mode", "single");
    await owner.click("#btn-start");
    await owner.waitForFunction(() => document.body.dataset.phase === "psychic");
    await monitor.waitForFunction(() => document.body.dataset.phase === "psychic");
    await owner.evaluate(() => { window.streamDelay = 1100; window.reportDelay = 100; });
    await monitor.evaluate(() => { window.streamDelay = 100; window.timerTexts = []; });
    await owner.evaluate(() => {
      window.viewStartedAt = performance.now();
      document.querySelector("#controls .btn").click();
    });
    assert.equal(await owner.$eval("#timer-display", el => el.textContent), "01:00");
    await monitor.waitForFunction(() => window.timerTexts.some(text => /^\d\d:\d\d$/.test(text)));
    assert.equal(await monitor.evaluate(() => window.timerTexts.find(text => /^\d\d:\d\d$/.test(text))), "01:00",
      "the first sixty-second sample reaches the monitor without waiting for a controller round trip");
    await owner.waitForFunction(() => window.latestGameState.timerSync && window.latestGameState.timerSync.source === "controller");
    await owner.evaluate(() => { window.clockOffset = 49050 - window.realElapsed(); });
    await monitor.waitForFunction(() => document.getElementById("timer-display").textContent === "00:11");
    await monitor.evaluate(() => { window.clockOffset += 120000; });
    await sleep(250);
    assert.equal(await monitor.$eval("#timer-display", el => el.textContent), "00:11",
      "a monitor clock jumping forward cannot advance the owner countdown");
    await monitor.waitForFunction(() => window.tones.some(tone => tone.duration === 0.25));
    const ownerWarning = await owner.evaluate(() => window.tones.find(tone => tone.duration === 0.25).at);
    const monitorWarning = await monitor.evaluate(() => window.tones.find(tone => tone.duration === 0.25).at);
    assert(monitorWarning >= ownerWarning, "the monitor cannot sound its warning before the owner");
    await owner.evaluate(() => { window.clockOffset = 59050 - window.realElapsed(); });
    await monitor.waitForFunction(() => window.tones.some(tone => tone.duration === 0.75));
    const ownerZero = await owner.evaluate(() => window.tones.find(tone => tone.duration === 0.75).at);
    const monitorZero = await monitor.evaluate(() => window.tones.find(tone => tone.duration === 0.75).at);
    assert(monitorZero >= ownerZero && monitorZero - ownerZero < 800, "zero sounds follow the same owner event, with only transport delay");
    await sleep(700);
    assert.equal(state.phase, "psychic", "automatic selection waits through the owner's zero grace");
    await monitor.waitForFunction(() => document.body.dataset.phase === "guess");
    const transitioned = await monitor.evaluate(() => window.phaseChanges.find(change => change.phase === "guess").at);
    assert(transitioned - ownerZero >= 1400, "automatic locking cannot precede the owner's grace");
    assert(transitioned - monitorZero >= 1200, "the monitor sees the zero event before the subsequent automatic transition");
    assert(await owner.evaluate(() => window.timerReports.some(report => report.type === "expired" && report.elapsedMs >= 61500)));
    assert.deepEqual(errors, []);
    console.log("MONITOR TIMER TEST PASSED: starts at sixty, mirrors owner seconds, aligned warnings/zero and owner-controlled grace");
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
