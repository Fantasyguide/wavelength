process.env.PORT = "3101";
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
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  await page.goto("http://127.0.0.1:3101/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#role-modal:not(.hidden)", { timeout: 5000 });
  console.log("ok: role modal appeared");
  await page.waitForFunction(() => document.getElementById("conn-badge").textContent.indexOf("已连接") !== -1, { timeout: 5000 });
  console.log("ok: connection badge connected");

  await page.click("#btn-role-controller");
  await sleep(300);
  assert(await page.$eval("#setup-modal", (el) => el.className.indexOf("hidden") === -1), "setup modal shown for controller");
  await page.$eval("#select-first", (el) => { el.value = "A"; });
  await page.click("#btn-start");
  await page.waitForSelector(".card-choice");
  await page.click(".card-choice");
  await sleep(500);

  const hint = await page.$eval("#hint", (el) => el.textContent);
  assert(hint.indexOf("Psychic") !== -1, "game started");
  assert(await page.$eval("#scoreB", (el) => el.textContent) === "1", "B score 1");

  await page.click("#controls .btn");
  await sleep(200);
  assert(await page.$eval("#screen", (el) => el.className.indexOf("open") !== -1), "psychic view opens screen");
  await page.click("#controls .btn");
  await sleep(300);
  assert(await page.$eval("#screen", (el) => el.className.indexOf("open") === -1), "screen closed after psychic done");
  const hint2 = await page.$eval("#hint", (el) => el.textContent);
  assert(hint2.indexOf("拨杆") !== -1, "dial phase reached");
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
  const { server: server2 } = require(serverPath);
  await new Promise((r) => server2.once("listening", r));

  await page.waitForFunction(() => document.getElementById("conn-badge").textContent.indexOf("已连接") !== -1, { timeout: 15000 });
  console.log("ok: auto reconnected after server restart");
  await page.waitForSelector("#setup-modal:not(.hidden)", { timeout: 5000 });
  await page.evaluate(() => document.getElementById("btn-start").click());
  await page.waitForSelector(".card-choice");
  await page.click(".card-choice");
  await sleep(500);
  const hint3 = await page.$eval("#hint", (el) => el.textContent);
  assert(hint3.indexOf("Psychic") !== -1, "game works again after reconnect");

  console.log("JS errors on page:", consoleErrors.length === 0 ? "none" : consoleErrors.join(" | "));
  browser.close();
  server2.close();
  console.log("REAL BROWSER TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
