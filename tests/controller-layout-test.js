"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const puppeteer = require("puppeteer-core");
const fixture = require("./server-fixture");

(async () => {
  process.env.PORT = "0";
  fixture.configure();
  // Exercise the normal controller status without contacting the real betting service.
  const source = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url.endsWith("/results") ? {
      round_key: decodeURIComponent(req.url.split("/").at(-2)), target_position: 600, top_five: []
    } : {}));
  });
  let browser, server;
  try {
    await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(process.env.WL_CONFIG, JSON.stringify({ password: fixture.password, thccb: {
      enabled: true, base_url: "http://127.0.0.1:" + source.address().port, secret: "isolated-controller-layout-test-secret"
    } }));
    const backend = require("../server.js");
    server = backend.server;
    const state = backend.state;
    await new Promise(resolve => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const cookie = await fixture.login(base);
    async function intent(type, extra = {}) {
      const response = await fetch(base + "/api/intent", { method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ type, ...extra }) });
      assert.equal(response.status, 200);
    }
    await intent("setup", { first: "A", cardMode: "choice" });
    state.cardChoices = [["人类友好度高", "人类友好度低"], ["豪庭的钥匙", "少女绮想曲"]];
    state.timerEnd = Date.now() + 600000;
    await intent("noop");
    browser = await puppeteer.launch({ executablePath: require("./chrome")(), headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewport({ width: 1194, height: 650, hasTouch: true });
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#role-modal:not(.hidden)");
    await fixture.loginController(page);
    await page.waitForSelector(".card-choice");
    assert(await page.$eval("#btn-thccb-retry", el => !el.checkVisibility()), "healthy bridge hides the retry button");

    async function checkLayout(phase) {
      await page.waitForFunction(expected => document.body.dataset.phase === expected, {}, phase);
      for (const [width, height] of [[1194, 650], [1024, 600], [834, 1010], [768, 900], [390, 844], [360, 640]]) {
        await page.setViewport({ width, height, hasTouch: true });
        await page.evaluate(async () => { window.scrollTo(0, 0); await new Promise(requestAnimationFrame); await document.fonts.ready; });
        const problems = await page.evaluate(() => {
          const issues = [];
          const rect = s => document.querySelector(s).getBoundingClientRect();
          const controls = rect("#controls");
          if (document.documentElement.scrollWidth > innerWidth) issues.push("horizontal page overflow");
          if (innerWidth >= 768 && controls.bottom > innerHeight) issues.push("main controls fall below the tablet viewport");
          if (rect("#interact").bottom > controls.top) issues.push("dial touch area overlaps buttons");
          if (innerWidth >= 901 && innerHeight <= 750 && Math.abs(rect(".scoreboard").top - rect(".card-frame").top) > 1) {
            issues.push("landscape score and topic panels are not alongside each other");
          }
          const sections = ["#controls", "details.rules", ".log", ".audience-results"].map(rect);
          if (sections.some((r, i) => i && r.top < sections[i - 1].bottom)) issues.push("supplementary sections overlap or are out of order");
          for (const el of document.querySelectorAll(".side .con, .team, header")) {
            if (el.scrollWidth > el.clientWidth + 1) issues.push("text overflows " + el.className);
          }
          const headerText = [...document.querySelectorAll("header h1, #sub-title, #conn-badge, #thccb-conn-badge, #timer-display, #btn-restart")]
            .filter(el => el.checkVisibility()).map(el => {
              const range = document.createRange(); range.selectNodeContents(el);
              return { text: el.textContent, rect: range.getBoundingClientRect() };
            });
          for (const [i, a] of headerText.entries()) {
            for (const b of headerText.slice(i + 1)) {
              if (a.rect.left < b.rect.right && b.rect.left < a.rect.right && a.rect.top < b.rect.bottom && b.rect.top < a.rect.bottom) {
                issues.push("header text overlaps: " + a.text + " / " + b.text);
              }
            }
          }
          for (const el of document.querySelectorAll(".side .con :is(.l, .r), .tname, .tick-number")) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const r = range.getBoundingClientRect(), parent = el.closest(".side, .team, .spectrum-wrap").getBoundingClientRect();
            if (r.left < parent.left - 1 || r.right > parent.right + 1 || r.top < parent.top - 1 || r.bottom > parent.bottom + 1) {
              issues.push("text leaves its panel: " + el.textContent);
            }
          }
          for (const el of document.querySelectorAll("#controls .btn")) {
            const r = el.getBoundingClientRect();
            if (r.height < 44) issues.push("touch button is too short");
            if (r.bottom <= innerHeight && !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) issues.push("button is obscured");
          }
          if (parseFloat(getComputedStyle(document.querySelector(".side .con")).fontSize) < 24) issues.push("topic is too small");
          if (parseFloat(getComputedStyle(document.querySelector("#hint")).fontSize) < 17) issues.push("instruction is too small");
          return issues;
        });
        assert.deepEqual(problems, [], `${phase} at ${width}×${height}: ${problems.join("; ")}`);
      }
      console.log("controller layout: " + phase + " passed in tablet landscape, portrait and phone sizes");
    }
    await checkLayout("chooseCard");
    await page.click(".card-choice");
    await checkLayout("psychic");
    await page.click("#controls .primary");
    state.timerEnd = Date.now() + 600000;
    await page.waitForSelector("#screen.open");
    await checkLayout("psychic");
    await page.click("#controls .magenta");
    await checkLayout("dial");
    await page.setViewport({ width: 1024, height: 600, hasTouch: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    const axis = await page.$eval("#axis", el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    await page.touchscreen.touchStart(axis.x + axis.width * .5, axis.y + axis.height / 2);
    // Real drags span frames; a single immediate move can be coalesced by Chrome.
    for (const fraction of [.56, .62, .68, .72]) {
      await new Promise(resolve => setTimeout(resolve, 80));
      await page.touchscreen.touchMove(axis.x + axis.width * fraction, axis.y + axis.height / 2);
    }
    await page.waitForFunction(() => parseFloat(document.getElementById("dial").style.left) > 70);
    await page.touchscreen.touchEnd();
    await page.waitForFunction(() => parseFloat(document.getElementById("dial").style.left) > 70);
    await page.click("#btn-lock");
    state.timerEnd = Date.now() + 600000;
    await checkLayout("guess");
    await intent("guess", { guess: "L" });
    await checkLayout("reveal");
    await intent("reveal");
    await checkLayout("revealed");
    await page.setViewport({ width: 834, height: 1010, hasTouch: true });
    await page.click("details.rules > summary");
    await page.waitForFunction(() => document.querySelector("details.rules").open);
    const rules = await page.$eval("details.rules", el => el.textContent);
    assert(!/宽限|概率|70%|30%|1\.5 秒/.test(rules), "quick rules omit timing and randomization internals");
    assert.match(rules, /说话处罚/);
    assert.match(rules, /2 \/ 3 \/ 4 分/);
    assert.deepEqual(errors, []);
    console.log("CONTROLLER LAYOUT TEST PASSED: visible tablet controls, readable text, touch dragging and section order");
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => source.close(resolve));
  }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
