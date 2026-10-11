process.env.PORT = "0";
const http = require("http");
const path = require("path");
const puppeteer = require("puppeteer-core");
const findChrome = require("./chrome.js");
const { server, state } = require(path.join(__dirname, "..", "server.js"));

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

function postIntent(port, intent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(intent);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/intent",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) }
    }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end(raw);
  });
}

(async function () {
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const anchorsByViewport = new Map();
  async function assertReadableLayout(phase) {
    const problems = await page.evaluate(() => {
      const issues = [];
      const groups = [
        [".card-frame", ".card-label, .side-tag, .con"],
        ["#hint", ".phase-message, .guess-choice"],
        [".scoreboard", ".tname, .tscore, .active-turn, .score-track"],
        [".spectrum-wrap", ".tick-number, .spectrum-labels span"],
        ["#score-pop", null]
      ];
      for (const [containerSelector, contentSelector] of groups) {
        const container = document.querySelector(containerSelector);
        const bounds = container.getBoundingClientRect();
        const elements = contentSelector ? container.querySelectorAll(contentSelector) : [container];
        for (const el of elements) {
          if (!el.getClientRects().length || !el.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(el);
          const r = range.getBoundingClientRect();
          if (r.left < Math.max(0, bounds.left) - 1 || r.right > Math.min(innerWidth, bounds.right) + 1 ||
              r.top < Math.max(0, bounds.top) - 1 || r.bottom > Math.min(innerHeight, bounds.bottom) + 1) {
            issues.push(`${containerSelector}: ${el.textContent}`);
          }
        }
      }
      for (const team of document.querySelectorAll(".team")) {
        const bounds = team.getBoundingClientRect();
        const name = team.querySelector(".tname").getBoundingClientRect();
        const score = team.querySelector(".tscore").getBoundingClientRect();
        const diamonds = Array.from(team.querySelectorAll(".score-track i"), el => el.getBoundingClientRect());
        if (diamonds.some(r => r.top < Math.max(name.bottom, score.bottom) || r.bottom > bounds.bottom + 1 ||
            r.left < bounds.left - 1 || r.right > bounds.right + 1)) issues.push("progress diamonds overlap or leave their team row");
      }
      return issues;
    });
    assert(problems.length === 0, `${phase}: enlarged text stays fully visible (${problems.join("; ")})`);
    const layout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const anchors = [".card-frame", ".card-label", ".phase-message", "#axis", "#score-pop"]
        .map(selector => [selector, rect(selector).top]);
      const scale = innerWidth / 3904;
      const guess = document.querySelector(".guess-choice");
      const gaps = [
        rect(".phase-message").top - rect(".card-frame").bottom,
        rect("#score-pop").top - rect("#tick-labels").bottom
      ];
      if (guess) {
        gaps.push(rect(".guess-choice").top - rect(".phase-message").bottom);
        gaps.push(rect(".dial .arrow").top - rect(".guess-choice").bottom);
      }
      return { viewport: `${innerWidth}x${innerHeight}`, anchors, gaps: gaps.map(gap => gap / scale) };
    });
    const initial = anchorsByViewport.get(layout.viewport);
    if (initial) {
      assert(layout.anchors.every(([selector, top], i) => selector === initial[i][0] && Math.abs(top - initial[i][1]) < .5),
        `${phase}: card, headline, spectrum and result keep their positions`);
    } else {
      anchorsByViewport.set(layout.viewport, layout.anchors);
    }
    assert(layout.gaps.every(gap => gap >= 10), `${phase}: central text and dial retain breathing room (${layout.gaps.map(x => x.toFixed(1)).join(", ")}px)`);
  }
  await page.setViewport({ width: 3904, height: 672, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("#role-modal:not(.hidden)", { timeout: 5000 });
  const roleFits = await page.$eval("#role-modal .modal", (el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight &&
      parseFloat(getComputedStyle(el.querySelector(".btn")).fontSize) >= 28;
  });
  assert(roleFits, "role selection is readable and fully visible on the physical display");
  await page.click("#btn-role-monitor");
  await postIntent(port, { type: "setup", teamA: "蓝队", teamB: "粉队", first: "A" });
  await page.waitForFunction(() => document.body.classList.contains("monitor-mode") && document.getElementById("sides").children.length > 0);
  const choicesFit = await page.$$eval(".card-choice", (els) => els.length === 2 && els.every((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight));
  assert(choicesFit, "two candidates fit the ultra-wide monitor card area");
  const readableType = await page.evaluate(() => {
    const size = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return devicePixelRatio === 1 && size(".card-choice .con") >= 40 && size("#hint") >= 32 &&
      size(".tname") >= 40 && size(".tscore") >= 112 && size(".tick-number") >= 24;
  });
  assert(readableType, "key text is readable at native 3904x672 pixels, without browser scaling");
  const teamStyle = await page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    const name = style(".tname");
    return parseFloat(name.fontSize) >= 80 && parseFloat(name.paddingTop) === parseFloat(name.fontSize) / 2 &&
      parseFloat(name.paddingBottom) === parseFloat(name.fontSize) / 2 && parseFloat(style(".score-track i").width) >= 20 &&
      style("#nameA").color === style("#scoreA").color && style("#nameB").color === style("#scoreB").color &&
      style("#nameA").color !== style("#nameB").color && style("#card-label").color === "rgb(0, 0, 0)";
  });
  assert(teamStyle, "larger team names and diamonds use team colors; the card heading is black");
  await assertReadableLayout("chooseCard");
  await postIntent(port, { type: "selectCard", index: 0 });
  await page.waitForFunction(() => document.body.dataset.phase === "psychic");
  await assertReadableLayout("psychic");
  await postIntent(port, { type: "selectSide", side: 0 });
  await postIntent(port, { type: "donePsychic" });
  await page.waitForFunction(() => document.body.dataset.phase === "dial");
  await assertReadableLayout("dial");
  await postIntent(port, { type: "setDial", value: 600 });
  await postIntent(port, { type: "lock" });
  await page.waitForFunction(() => document.getElementById("hint").textContent.includes("中心楔形"));
  await assertReadableLayout("guess");
  const selectedTopic = await page.$$eval(".sides .side", (els) => {
    const visible = els.filter(el => el.getClientRects().length);
    return visible.length === 1 && visible[0].classList.contains("selected") &&
      parseFloat(getComputedStyle(visible[0].querySelector(".con")).fontSize) >= 52;
  });
  assert(selectedTopic, "monitor focuses on the chosen side in large type after the clue is given");
  const guessPromptFit = await page.$eval("#hint", (el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    bottom: el.getBoundingClientRect().bottom
  }));
  assert(guessPromptFit.scrollHeight <= guessPromptFit.clientHeight && guessPromptFit.bottom <= 672, "long left/right prompt stays inside its grid area");
  const timerAndTicks = await page.evaluate(() => {
    const timer = document.getElementById("timer-display").getBoundingClientRect();
    const axis = document.getElementById("axis").getBoundingClientRect();
    const tickLabels = Array.from(document.querySelectorAll("#tick-labels .tick-number"));
    return {
      timerText: document.getElementById("timer-display").textContent,
      timerTop: timer.top,
      timerBottom: timer.bottom,
      tickLabels: tickLabels.map((el) => el.textContent),
      labelsBelow: tickLabels.every((el) => el.getBoundingClientRect().top >= axis.bottom),
      ticksFit: tickLabels.every((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= axis.left && r.right <= axis.right;
      })
    };
  });
  assert(["00:15", "00:14"].includes(timerAndTicks.timerText) && timerAndTicks.timerTop >= 0 && timerAndTicks.timerBottom <= 672, "guess timer is visible inside the ultra-wide display");
  assert(timerAndTicks.tickLabels.join(",") === "0%,25%,50%,75%,100%" && timerAndTicks.labelsBelow && timerAndTicks.ticksFit, "percentage tick labels fit below the ultra-wide axis");
  await postIntent(port, { type: "guess", guess: "R" });
  await page.waitForSelector(".guess-choice");

  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      scoreboard: rect(".scoreboard"),
      card: rect(".card-area"),
      axis: rect(".axis"),
      log: rect(".log"),
      guess: rect(".guess-choice"),
      guessText: document.querySelector(".guess-choice").textContent,
      controls: getComputedStyle(document.getElementById("controls")).display,
      rules: getComputedStyle(document.querySelector("details.rules")).display,
      bodyClass: document.body.className
    };
  });

  assert(layout.viewport.width === 3904 && layout.viewport.height === 672, "uses exact 3904x672 viewport");
  assert(layout.bodyClass.includes("monitor-mode"), "monitor role enables wide-screen layout");
  assert(layout.scroll.width <= 3904 && layout.scroll.height <= 672, "layout has no page overflow");
  assert(layout.scoreboard.width >= 500 && layout.card.width >= 2500 && layout.log.width >= 600, "main game area uses at least 2500 pixels while side panels remain readable");
  assert(layout.scoreboard.right < layout.card.left && layout.card.right < layout.log.left, "three columns do not overlap");
  assert(layout.axis.width >= 1800 && layout.axis.height >= 72, "spectrum is wide and readable");
  assert(layout.guess.width >= 500 && layout.guessText.includes("右边"), "ultra-wide monitor prominently shows the opponent choice");
  assert(layout.scoreboard.bottom <= 672 && layout.log.bottom <= 672, "side panels fit the low-height display");
  assert(layout.controls === "none" && layout.rules === "block", "monitor layout hides controls and keeps rules button");
  await assertReadableLayout("reveal");
  await postIntent(port, { type: "reveal" });
  await page.waitForFunction(() => document.body.dataset.phase === "revealed");
  await assertReadableLayout("revealed");
  const logReadable = await page.$eval("#log li", (el) => parseFloat(getComputedStyle(el).fontSize) >= 28);
  assert(logReadable, "round history uses at least 28px type on the physical display");

  await page.click("details.rules > summary");
  const rulesOverlay = await page.evaluate(() => {
    const details = document.querySelector("details.rules");
    const r = details.getBoundingClientRect();
    const listStyle = getComputedStyle(details.querySelector("ul"));
    return {
      open: details.open,
      width: r.width,
      height: r.height,
      fontSize: parseFloat(listStyle.fontSize),
      columns: listStyle.columnCount
    };
  });
  assert(rulesOverlay.open, "rules button opens the overlay");
  assert(rulesOverlay.width >= 3800 && rulesOverlay.height >= 620, "rules overlay fills almost the entire display");
  assert(rulesOverlay.fontSize >= 22 && rulesOverlay.columns === "2", "rules use large two-column text");

  await page.click("details.rules > summary");
  await postIntent(port, { type: "newGame" });
  await postIntent(port, { type: "setup", teamA: "超长名称幻想乡队", teamB: "超长名称外来人队", first: "A" });
  await postIntent(port, { type: "selectCard", index: 1 });
  await postIntent(port, { type: "selectSide", side: 0 });
  await postIntent(port, { type: "donePsychic" });
  await postIntent(port, { type: "setDial", value: 600 });
  await postIntent(port, { type: "lock" });
  await page.setViewport({ width: 1952, height: 336, deviceScaleFactor: 1 });
  await page.waitForFunction(() => innerWidth === 1952 && document.getElementById("hint").textContent.includes("中心楔形"));
  const scaledLayout = await page.evaluate(() => {
    const hint = document.getElementById("hint");
    const r = hint.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      hintClientHeight: hint.clientHeight,
      hintScrollHeight: hint.scrollHeight,
      hintBottom: r.bottom
    };
  });
  assert(scaledLayout.scrollWidth <= 1952 && scaledLayout.scrollHeight <= 336, "layout also fits a 200%-scaled 3904x672 display");
  assert(scaledLayout.hintScrollHeight <= scaledLayout.hintClientHeight && scaledLayout.hintBottom <= 336, "long prompt remains contained under display scaling");
  const scaledCardFits = await page.$$eval(".sides .side", (els) => els.length > 0 && els.every((el) =>
    el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth));
  assert(scaledCardFits, "selected card text is fully visible under 200% display scaling");
  const scaledHeaderFits = await page.evaluate(() => {
    const title = document.getElementById("title-main").getBoundingClientRect();
    const rules = document.querySelector("details.rules > summary").getBoundingClientRect();
    const log = document.querySelector(".log").getBoundingClientRect();
    return title.top >= 0 && rules.bottom <= log.top;
  });
  assert(scaledHeaderFits, "scaled header stays on screen and rules button does not overlap the log");
  await assertReadableLayout("eight-character team names at 200% scaling");
  await postIntent(port, { type: "guess", guess: "L" });
  await page.waitForFunction(() => document.body.dataset.phase === "reveal");
  await assertReadableLayout("long names with left/right choice at 200% scaling");
  await postIntent(port, { type: "reveal" });
  await page.waitForFunction(() => document.body.dataset.phase === "revealed");
  await assertReadableLayout("long names with result at 200% scaling");

  // Fixture changes are confined to this test's ephemeral server; exercise the longest result states.
  for (const special of ["catchup", "sudden"]) {
    await postIntent(port, { type: "newGame" });
    await postIntent(port, { type: "setup", teamA: "超长名称幻想乡队", teamB: "超长名称外来人队", first: "A" });
    await postIntent(port, { type: "selectCard", index: 0 });
    await postIntent(port, { type: "donePsychic" });
    state.teams.B.score = special === "catchup" ? 9 : 4;
    if (special === "sudden") state.round = 10;
    await postIntent(port, { type: "setDial", value: state.target.center });
    await postIntent(port, { type: "lock" });
    await postIntent(port, { type: "guess", guess: "R" });
    await postIntent(port, { type: "reveal" });
    await page.waitForFunction(() => document.body.dataset.phase === "revealed" && document.querySelector(".guess-choice.neutral"));
    assert(state[special], `${special} result fixture reached the intended state`);
    for (const [width, height] of [[1952, 336], [3904, 672]]) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await assertReadableLayout(`${special} with perfect-hit result at ${width}x${height}`);
    }
    if (special === "catchup") {
      assert(await page.$eval("#banner", el => getComputedStyle(el).display === "none"), "catch-up notice stays in the sidebar instead of covering the card");
    }
  }

  // Sample the actual painted pixels where the cursor, target marker and border overlap.
  for (const position of [0, 500, 1000]) {
    state.target.center = position;
    state.dial = position;
    await postIntent(port, { type: "setDial", value: position });
    await page.waitForFunction(p => document.getElementById("dial").style.left === `${p / 10}%`, {}, position);
    const clip = await page.$eval("#axis", el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const png = await page.screenshot({ clip, encoding: "base64" });
    const colors = await page.evaluate(async ({ png, position }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + png;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const x = Math.min(img.width - 1, Math.floor(img.width * position / 1000));
      const direction = position === 1000 ? -1 : 1;
      const pixel = (dx, y) => Array.from(ctx.getImageData(x + dx * direction, y, 1, 1).data).slice(0, 3).join(",");
      return { border: pixel(8, 1), cursor: pixel(0, 4), band: pixel(30, Math.floor(img.height * .8)) };
    }, { png, position });
    assert(colors.border === "34,34,34", `black frame remains above the color band and target marker at ${position / 10}%`);
    assert(colors.cursor === "148,101,26", `player cursor remains above the target marker at ${position / 10}%`);
    assert(["240,211,119", "237,184,108", "231,160,187"].includes(colors.band), "foreground frame leaves the colored bands visible");
  }

  await postIntent(port, { type: "newGame" });
  await postIntent(port, { type: "loadDeck", cards: [
    ["讨好型人格", "反驳型人格", "太快乐了🤗", "太痛苦了😫"],
    ["人类友好度高", "人类友好度低", "岁月静好", "负重前行"]
  ] });
  await postIntent(port, { type: "setup", first: "A" });
  await page.waitForSelector(".card-choice");
  for (const [width, height] of [[1952, 336], [3904, 672]]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const doubleChoicesFit = await page.$$eval(".card-choice", (els) => els.length === 2 && els.every((el) => {
      const r = el.getBoundingClientRect();
      return el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth && r.top >= 0 && r.bottom <= innerHeight;
    }));
    assert(doubleChoicesFit, `both sides of long candidate cards fit at ${width}x${height}`);
    await assertReadableLayout(`long candidates at ${width}x${height}`);
  }

  // Long historical titles must wrap at the normal type size and remain reachable by scrolling.
  const longChinese = "这是一张用于检查超长中文卡片名称是否能够完整换行显示的测试题目".repeat(3);
  const longLatin = "WavelengthSuperLongCardName".repeat(8);
  const historyPairs = [
    [longChinese, longChinese + "另一端"],
    [longLatin, longLatin + "Opposite"],
    ["<特别篇>&卡片名称", "仍然按原文显示"]
  ];
  state.log = historyPairs.map((pair, i) => ({ round: 3 - i, team: "A", targetPct: 42, dialPct: 45, pair, pts: 3, oppPts: 1 }));
  await postIntent(port, { type: "selectCard", index: 0 });
  await page.waitForFunction(() => document.querySelectorAll("#log li").length === 3);
  for (const [width, height] of [[3904, 672], [1952, 336]]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const historyLayout = await page.evaluate((pairs) => {
      const list = document.getElementById("log");
      list.scrollTop = 0;
      const rows = Array.from(list.children);
      const headingTop = document.querySelector(".log h3").getBoundingClientRect().top;
      const axisTop = document.getElementById("axis").getBoundingClientRect().top;
      const wrapped = rows.every((el, index) => {
        const round = el.querySelector(".log-round").getBoundingClientRect();
        const card = el.querySelector(".log-card").getBoundingClientRect();
        const score = el.querySelector(".log-score").getBoundingClientRect();
        return card.top >= round.bottom && score.top >= card.bottom &&
          el.querySelector(".log-card b").textContent === pairs[index].join(" — ") &&
          el.scrollWidth <= el.clientWidth + 1 &&
          Array.from(el.querySelectorAll(".log-separator")).every(sep => getComputedStyle(sep).display === "none");
      });
      list.scrollTop = list.scrollHeight;
      const lastScore = rows.at(-1).querySelector(".log-score").getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return {
        wrapped,
        fontSize: parseFloat(getComputedStyle(rows[0]).fontSize),
        scrollable: list.scrollHeight > list.clientHeight && list.scrollTop > 0,
        lastVisible: lastScore.top >= bounds.top && lastScore.bottom <= bounds.bottom + 1,
        noOverflow: list.scrollWidth <= list.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
        stable: document.querySelector(".log h3").getBoundingClientRect().top === headingTop && document.getElementById("axis").getBoundingClientRect().top === axisTop
      };
    }, historyPairs);
    assert(historyLayout.wrapped && historyLayout.fontSize >= 29 * width / 3904,
      `Chinese and unbroken Latin history titles wrap fully at normal type size at ${width}x${height}`);
    assert(historyLayout.scrollable && historyLayout.lastVisible && historyLayout.noOverflow && historyLayout.stable,
      `long history scrolls to its final score without moving the heading or central stage at ${width}x${height}`);
  }
  await page.setViewport({ width: 1280, height: 960, deviceScaleFactor: 1 });
  const regularSeparators = await page.$$eval("#log .log-separator", els => els.every(el => getComputedStyle(el).display === "inline"));
  assert(regularSeparators, "ordinary screen widths retain both inline separators");
  await page.setViewport({ width: 3904, height: 672, deviceScaleFactor: 1 });

  if (process.argv.includes("--screenshot")) {
    await page.screenshot({ path: path.join(__dirname, "ultrawide-qa.png") });
  }
  await browser.close();
  server.close();
  console.log("ULTRAWIDE MONITOR TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
