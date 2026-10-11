const path = require("path");
const { pathToFileURL } = require("url");
const puppeteer = require("puppeteer-core");
const findChrome = require("./chrome.js");

const ROOT = path.join(__dirname, "..");
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

(async function () {
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 640, isMobile: true, hasTouch: true });
  await page.goto(pathToFileURL(path.join(ROOT, "index.html")).href, { waitUntil: "load", timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 600));

  await page.evaluate(() => {
    document.querySelector("details.advanced").open = true;
  });
  await new Promise((r) => setTimeout(r, 200));

  const before = await page.evaluate(() => {
    const mask = document.getElementById("setup-modal");
    const modal = mask.querySelector(".modal");
    const btn = document.getElementById("btn-start");
    const r = btn.getBoundingClientRect();
    return {
      modalScroll: modal.scrollHeight,
      maskClient: mask.clientHeight,
      overflow: getComputedStyle(mask).overflowY,
      btnOnScreen: r.top >= 0 && r.bottom <= window.innerHeight
    };
  });
  assert(before.modalScroll > before.maskClient, "modal content taller than viewport (scrollable content)");
  assert(before.overflow === "auto", "modal mask scrollable");

  await page.evaluate(() => document.getElementById("btn-start").scrollIntoView({ block: "center" }));
  await new Promise((r) => setTimeout(r, 300));
  const visibleNow = await page.evaluate(() => {
    const r = document.getElementById("btn-start").getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  assert(visibleNow, "start button scrollable into view on phone");

  await page.evaluate(() => document.getElementById("btn-start").click());
  await page.waitForSelector(".card-choice");
  const choicesFit = await page.$$eval(".card-choice", (els) => els.length === 2 && els.every((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth;
  }));
  assert(choicesFit, "both candidate topics fit the phone width");
  await page.click(".card-choice");
  await new Promise((r) => setTimeout(r, 500));
  const hint = await page.evaluate(() => document.getElementById("hint").textContent);
  assert(hint.indexOf("查看目标") !== -1, "game started after scrolling + tapping start");

  await browser.close();
  console.log("MOBILE TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
