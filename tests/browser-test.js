process.env.PORT = "3101";
const fixture = require("./server-fixture");
fixture.configure();
const path = require("path");
const puppeteer = require("puppeteer-core");
const findChrome = require("./chrome.js");
const { server } = require(path.join(__dirname, "..", "server.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = findChrome();

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

(async function () {
  await new Promise((r) => server.once("listening", r));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const actualNow = Date.now;
    Date.now = () => actualNow() + 2000;
  });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  await page.goto("http://127.0.0.1:3101/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#role-modal:not(.hidden)", { timeout: 5000 });
  console.log("ok: role modal appeared");
  await page.waitForFunction(() => document.getElementById("conn-badge").textContent.indexOf("已连接") !== -1, { timeout: 5000 });
  console.log("ok: connection badge connected");

  await fixture.loginController(page);
  await sleep(300);
  assert(await page.$eval("#setup-modal", (el) => el.className.indexOf("hidden") === -1), "setup modal shown for controller");
  async function delayHeartbeat() {
    await page.evaluate(async () => {
      const originalFetch = window.fetch;
      let hold = true, finished;
      const delivered = new Promise(resolve => { finished = resolve; });
      window.fetch = function (url, options) {
        const response = originalFetch.call(this, url, options);
        if (!hold || !String(url).endsWith("api/ping")) return response;
        hold = false;
        return response.then(async response => {
          const body = await response.text();
          await new Promise(resolve => setTimeout(resolve, 3900));
          return new Response(body, { status: response.status, headers: response.headers });
        }).finally(finished);
      };
      try {
        document.dispatchEvent(new Event("visibilitychange"));
        await delivered;
      } finally { window.fetch = originalFetch; }
    });
  }
  await delayHeartbeat();
  await page.$eval("#select-first", (el) => { el.value = "A"; });
  await page.click("#btn-start");
  await page.waitForSelector(".card-choice");
  assert(await page.$eval("#timer-display", el => el.textContent) === "00:10", "selection starts at ten despite clock skew and a heartbeat delayed by 3.9 seconds");
  await delayHeartbeat();
  await page.click("#btn-redraw");
  await page.waitForFunction(() => document.getElementById("btn-redraw").disabled);
  assert(await page.$eval("#timer-display", el => el.textContent) === "00:10", "redraw restores ten seconds after another delayed heartbeat");
  await page.click(".card-choice");
  await sleep(500);

  assert(await page.$eval("body", el => el.dataset.phase) === "psychic", "game started with the configured role name");
  assert(await page.$eval("#scoreB", (el) => el.textContent) === "0", "B starts at 0 with default balanced rules");

  await page.click("#controls .btn");
  await sleep(200);
  assert(await page.$eval("#screen", (el) => el.className.indexOf("open") !== -1), "psychic view opens screen");
  await page.click("#controls .btn");
  await sleep(300);
  assert(await page.$eval("#screen", (el) => el.className.indexOf("open") === -1), "screen closed after psychic done");
  assert(await page.$eval("body", el => el.dataset.phase) === "dial", "dial phase reached with the configured terminology");
  assert(await page.$eval("#interact", (el) => el.className.indexOf("lock-touch") !== -1), "interact locks touch during dial");
  const sideOpacity = await page.$eval(".side", (el) => getComputedStyle(el).opacity);
  assert(sideOpacity === "1", "card side never grey after psychic");
  await page.$eval("#axis", el => el.scrollIntoView({ block: "center" }));
  const axis = await page.$eval("#axis", el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.mouse.move(axis.x + axis.width * .25, axis.y + axis.height / 2);
  await page.mouse.down();
  await page.mouse.move(axis.x + axis.width * .75, axis.y + axis.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => Math.abs(parseFloat(document.getElementById("dial").style.left) - 75) < 1);
  assert(true, "foreground frame and cursor do not block dragging the dial to 75%");

  const serverPath = path.join(__dirname, "..", "server.js");
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await page.waitForFunction(() => {
    const c = document.getElementById("conn-badge").className;
    return c.indexOf("retry") !== -1 || c.indexOf("bad") !== -1;
  }, { timeout: 10000 });
  console.log("ok: badge detects disconnection");

  delete require.cache[require.resolve(serverPath)];
  const { server: server2, state: state2 } = require(serverPath);
  await new Promise((r) => server2.once("listening", r));

  await page.waitForFunction(() => document.getElementById("conn-badge").textContent.indexOf("已连接") !== -1, { timeout: 15000 });
  console.log("ok: auto reconnected after server restart");
  await page.waitForSelector("#setup-modal:not(.hidden)", { timeout: 5000 });
  await page.evaluate(() => document.getElementById("btn-start").click());
  await page.waitForSelector(".card-choice");
  await page.click(".card-choice");
  await sleep(500);
  assert(await page.$eval("body", el => el.dataset.phase) === "psychic", "game works again after reconnect");

  const guestContext = await browser.createBrowserContext();
  const local = await guestContext.newPage();
  local.on("pageerror", e => consoleErrors.push(e.message));
  await local.goto("http://127.0.0.1:3101/", { waitUntil: "domcontentloaded" });
  await local.waitForSelector("#role-modal:not(.hidden)");
  assert(await local.$eval("#auth-modal", el => el.classList.contains("hidden")), "role choice is public");
  await local.click("#btn-role-local");
  await local.waitForSelector("#setup-modal:not(.hidden)");
  const onlineBefore = JSON.stringify(state2);
  await local.click("#btn-start");
  await local.waitForSelector(".card-choice");
  await local.click(".card-choice");
  await local.waitForFunction(() => document.body.dataset.phase === "psychic");
  assert(JSON.stringify(state2) === onlineBefore, "local game does not change the online match");
  await page.evaluate(() => fetch('/api/intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'newGame' }) }));
  await page.waitForSelector("#setup-modal:not(.hidden)");
  assert(await local.$eval("body", el => el.dataset.phase) === "psychic", "online updates do not replace the local game");
  await guestContext.close();

  await page.evaluate(() => fetch('/api/logout', { method: 'POST' }));
  await page.waitForSelector("#auth-modal:not(.hidden)");
  assert(await page.$eval("#thccb-settings", el => el.hidden), "revoked controller loses private controls");
  await page.click("#btn-auth-monitor");
  await page.waitForFunction(() => document.body.classList.contains('monitor-mode') && document.getElementById('conn-badge').textContent.includes('已连接'));
  assert(await page.$eval("#auth-modal", el => el.classList.contains("hidden")), "revoked controller can continue watching without login");

  console.log("JS errors on page:", consoleErrors.length === 0 ? "none" : consoleErrors.join(" | "));
  browser.close();
  server2.close();
  console.log("REAL BROWSER TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
