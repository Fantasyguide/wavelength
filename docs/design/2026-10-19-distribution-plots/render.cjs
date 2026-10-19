"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH,
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1680, height: 1200, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href, { waitUntil: "load" });
    await page.waitForFunction(() => window.plotsReady, { polling: 100, timeout: 60000 });
    assert.deepEqual(errors, []);
    const figures = await page.evaluate(() => Object.keys(window.plotCharts));
    const bounds = [];
    for (const id of figures) {
      const { svg, outside } = await page.evaluate(id => {
        const el = document.querySelector('#chart-' + id + ' svg');
        const rect = el.getBoundingClientRect();
        const outside = [...el.querySelectorAll('text')].filter(t => {
          const b = t.getBoundingClientRect();
          return b.width > 0 && (b.left < rect.left - 2 || b.top < rect.top - 2 || b.right > rect.right + 2 || b.bottom > rect.bottom + 2);
        }).map(t => t.textContent);
        let svg = new XMLSerializer().serializeToString(el);
        svg = svg.replace(/(<svg[^>]*>)/, '$1<defs><style><![CDATA[' + window.plotFontCSS + ']]></style></defs>');
        return { svg, outside };
      }, id);
      assert.deepEqual(outside, [], id + " text must fit inside the exported figure");
      fs.writeFileSync(path.join(__dirname, id + ".svg"), svg);
      await (await page.$("#chart-" + id)).screenshot({ path: path.join(__dirname, id + ".png") });
      bounds.push({ id, outside });
    }
    await page.select("#history", "HHE");
    await page.$eval("#strength", el => { el.value = "0"; el.dispatchEvent(new Event("input")); });
    let state = await page.evaluate(() => window.currentCalculation);
    assert(Math.abs(state.state.q - .4462394350881921) < 1e-10);
    assert.equal(state.accepted.easy, 1);
    assert.equal(state.accepted.hard, 1);
    await page.$eval("#strength", el => { el.value = "0.6"; el.dispatchEvent(new Event("input")); });
    state = await page.evaluate(() => window.currentCalculation);
    assert(Math.abs(state.state.q - .6494704182469379) < 1e-10);
    await page.select("#history", "EEE");
    await page.select("#caps", "0.2,0.8");
    state = await page.evaluate(() => window.currentCalculation);
    assert.equal(state.state.q, .2);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ exported: figures, layout: bounds, interactiveChecks: "passed", browserErrors: errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
