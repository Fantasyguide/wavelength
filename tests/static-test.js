const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const findChrome = require("./chrome.js");
const WL = require("../game.js");

const ROOT = path.join(__dirname, "..");
const defaultDeck = WL.parseDeck(fs.readFileSync(path.join(ROOT, "cards.yaml"), "utf8"));
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".yaml": "text/plain; charset=utf-8" };
const CHROME = findChrome();

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

(async function () {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(ROOT, url === "/" ? "index.html" : url);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#setup-modal:not(.hidden)", { timeout: 5000 });
  await page.evaluate(() => document.fonts.ready);
  assert(await page.$eval("#conn-badge", (el) => el.textContent.indexOf("本地模式") !== -1), "static host: badge shows local mode");

  async function expectDeck(deck, label) {
    await page.waitForFunction((name, count) =>
      document.getElementById("deck-info").textContent === name + " · " + count + " 张卡" &&
      document.getElementById("deck-badge").textContent === name,
    { timeout: 5000 }, deck.name, deck.cards.length);
    assert(true, label);
  }

  async function reloadDeck(deck, label) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("#setup-modal:not(.hidden)", { timeout: 5000 });
    await expectDeck(deck, label);
    // Custom fonts can change the setup dialog's height after DOMContentLoaded.
    await page.evaluate(() => document.fonts.ready);
    await page.$eval("details.advanced", (el) => { el.open = true; });
  }

  async function resetDeck(label) {
    await page.click("#btn-reset-deck");
    await expectDeck(defaultDeck, label + ": reset restores original cards.yaml name and count");
    assert(await page.evaluate(() => localStorage.getItem("wl_deck") === null), label + ": reset removes the saved selection");
    await reloadDeck(defaultDeck, label + ": refresh keeps the original cards.yaml deck");
    assert(await page.evaluate(() => localStorage.getItem("wl_deck") === null), label + ": refresh does not save the default as a custom selection");
  }

  await expectDeck(defaultDeck, "static host: original cards.yaml deck name and count loaded");
  await page.$eval("details.advanced", (el) => { el.open = true; });

  const customFile = path.join(ROOT, "decks", "儿童版.json");
  const customDeck = WL.parseDeck(fs.readFileSync(customFile, "utf8"));
  await (await page.$("#file-deck")).uploadFile(customFile);
  await expectDeck(customDeck, "static host: custom file deck loaded");
  assert(await page.evaluate(() => localStorage.getItem("wl_deck") !== null), "custom file selection is saved locally");
  await reloadDeck(customDeck, "static host: refresh preserves custom file selection");
  await resetDeck("custom file selection");

  await page.click("#btn-builtin-deck");
  const genericDeck = { name: "通用题库", cards: WL.BUILTIN_DECK };
  await expectDeck(genericDeck, "static host: original builtin cards remain available as the generic deck");
  assert(await page.evaluate(() => localStorage.getItem("wl_deck") !== null), "generic deck selection is saved locally");
  await reloadDeck(genericDeck, "static host: refresh preserves generic deck selection");
  await resetDeck("generic deck selection");

  await page.$eval("#select-first", (el) => { el.value = "A"; });
  await page.click("#btn-start");
  await page.waitForSelector("#btn-reveal-cards");
  await page.click("#btn-reveal-cards");
  await page.waitForSelector(".card-choice");
  assert(await page.$$eval(".card-choice", (els) => els.length) === 2, "static host offers two candidates by default");
  await page.click(".card-choice");
  await page.waitForFunction(() => document.getElementById("hint").textContent.indexOf("查看目标") !== -1, { timeout: 5000 });
  console.log("ok: static host: game playable");

  assert(errors.length === 0, "no page errors: " + errors.join(" | "));
  browser.close();
  server.close();
  console.log("STATIC HOST TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
