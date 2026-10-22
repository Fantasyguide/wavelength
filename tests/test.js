const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dom = new JSDOM(html, {
  url: pathToFileURL(path.join(ROOT, "index.html")).href,
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true
});
const { window } = dom;
const doc = window.document;
const realDateNow = window.Date.now;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warningBeeps = 0;
const tones = [];
window.AudioContext = class {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  createOscillator() {
    const tone = {};
    return {
      frequency: { setValueAtTime(value) { tone.frequency = value; } },
      connect(gain) { tone.levels = gain.levels; },
      start(time) { tone.start = time; tones.push(tone); warningBeeps++; },
      stop(time) { tone.duration = time - tone.start; }
    };
  }
  createGain() {
    const levels = [];
    return { levels, gain: {
      setValueAtTime(value) { levels.push(value); },
      exponentialRampToValueAtTime(value) { levels.push(value); }
    }, connect() {} };
  }
};

function click(id) {
  const el = typeof id === "string" ? doc.getElementById(id) : id;
  if (!el) throw new Error("missing #" + id);
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

async function pickFile(name, content, inputId) {
  const input = doc.getElementById(inputId || "file-deck");
  const f = new window.File([content], name, { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [f], configurable: true });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  await sleep(120);
}

(async function () {
  await sleep(400);
  assert(doc.getElementById("setup-modal").className.indexOf("hidden") === -1, "setup modal shown initially");
  assert(doc.getElementById("conn-badge").textContent.indexOf("本地模式") !== -1, "local mode badge shown");
  assert(doc.getElementById("title-main").textContent === "Returned", "default game title");
  assert(doc.getElementById("opt-rule-set").value === "balanced" && doc.getElementById("opt-winscore").value === "8" &&
    doc.getElementById("opt-bandwidth").value === "48", "local setup defaults to balanced rules");
  doc.getElementById("opt-rule-set").value = "original";
  doc.getElementById("opt-rule-set").dispatchEvent(new window.Event("change", { bubbles: true }));

  await pickFile("my.json", JSON.stringify({
    name: "测试题库",
    cards: [["甲左", "甲右"], ["单1", "单2", "双1", "双2"]]
  }));
  assert(doc.getElementById("deck-info").textContent.indexOf("测试题库 · 2 张卡") !== -1, "JSON deck loaded");

  await pickFile("bad.json", '{ "cards": [["只有", "一半", "四个"]] }');
  assert(doc.getElementById("deck-msg").className.indexOf("err") !== -1, "bad JSON shows error");
  assert(doc.getElementById("deck-info").textContent.indexOf("测试题库") !== -1, "failed load keeps previous deck");

  await pickFile("my.yaml", "# 注释\n- [甲, 乙]\n- [丙, 丁, 戊, 己]\n");
  assert(doc.getElementById("deck-info").textContent.indexOf("my · 2 张卡") !== -1, "YAML deck loaded");

  await pickFile("names.json", JSON.stringify({ gameName: "猜心", gameTitle: "GUESSY", teamDefaultA: "蓝左", teamDefaultB: "粉右" }), "file-names");
  assert(doc.getElementById("title-main").textContent === "GUESSY", "custom game title applied");
  assert(doc.getElementById("input-nameA").value === "蓝左", "custom team default applied");

  await pickFile("bad.yaml", "hello world\n");
  assert(doc.getElementById("deck-msg").className.indexOf("err") !== -1, "bad YAML shows error");

  doc.getElementById("opt-ordered").checked = true;
  doc.getElementById("opt-ordered").dispatchEvent(new window.Event("change", { bubbles: true }));
  const wsInput = doc.getElementById("opt-winscore");
  wsInput.value = "3";
  wsInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert(wsInput.value === "3", "win score setting applied");
  wsInput.value = "100";
  wsInput.dispatchEvent(new window.Event("change", { bubbles: true }));

  doc.getElementById("input-nameA").value = "蓝队";
  doc.getElementById("input-nameB").value = "粉队";
  doc.getElementById("select-first").value = "A";
  click("btn-start");

  assert(doc.getElementById("opt-card-mode").value === "choice", "two-choice mode is the default");
  assert(doc.querySelectorAll(".card-choice").length === 2, "two candidate cards shown before psychic phase");
  assert(doc.getElementById("controls").children.length === 1 && doc.getElementById("btn-redraw"), "only redraw is available before choosing a card");
  assert(doc.getElementById("bands").children.length === 0, "no target rendered while choosing");
  assert(doc.querySelector(".card-choice .con i").textContent.trim() === "VS", "candidate concepts use VS");
  assert(doc.getElementById("timer-display").textContent === "00:10", "selection shows ten-second countdown");
  const choiceStart = realDateNow();
  window.Date.now = () => choiceStart + 5000;
  await sleep(250);
  assert(doc.getElementById("timer-display").textContent === "00:05" && warningBeeps === 1, "selection gives one five-second warning");
  assert(tones.at(-1).duration === 0.25, "advance warning lasts a quarter second");
  window.Date.now = () => choiceStart + 11000;
  await sleep(250);
  assert(doc.getElementById("timer-display").textContent === "00:00" && doc.querySelectorAll(".card-choice").length === 2,
    "selection stays actionable at zero during grace");
  assert(warningBeeps === 2 && tones.at(-1).duration === 0.75, "selection zero plays one three-quarter-second tone");
  await sleep(250);
  assert(warningBeeps === 2, "zero tone does not repeat during selection grace");
  click("btn-redraw");
  assert(doc.getElementById("timer-display").textContent === "00:10", "redraw during grace restarts selection countdown");
  assert(doc.getElementById("btn-redraw").disabled, "redraw disabled after this team's single chance");
  assert(doc.getElementById("card-label").textContent.indexOf("第 1 轮") !== -1, "redraw keeps the round number");
  window.Date.now = () => choiceStart + 22000;
  click(doc.querySelector(".card-choice"));
  assert(doc.getElementById("timer-display").classList.contains("hidden"), "manual selection during grace clears its timer");
  window.Date.now = realDateNow;
  assert(doc.getElementById("setup-modal").className.indexOf("hidden") !== -1, "setup modal closed");
  assert(doc.getElementById("scoreA").textContent === "0", "A starts at 0");
  assert(doc.getElementById("scoreB").textContent === "1", "B starts at 1");
  assert(doc.getElementById("hint").textContent.indexOf("查看目标") !== -1, "psychic phase hint");

  const sides = doc.getElementById("sides").children;
  assert(sides.length >= 1 && sides.length <= 2, "card rendered");
  assert(doc.getElementById("trackA").children.length === 40, "win score 100 caps score dots at 40");
  const tickPositions = Array.from(doc.querySelectorAll("#ticks .tick-mark")).map((el) => parseFloat(el.style.left));
  assert(tickPositions.length === 19 && tickPositions.every((x, i) => x === (i + 1) * 5), "ticks use fixed 5% spacing without endpoint lines");
  assert(Array.from(doc.querySelectorAll("#tick-labels .tick-number")).map((el) => el.textContent).join(",") === "-100%,-50%,0%,+50%,+100%", "signed percentage labels render below the bar");

  const skipBtn = Array.from(doc.getElementById("controls").children).find((b) => b.textContent.indexOf("跳过此题") !== -1);
  assert(!skipBtn, "selected choice-mode topic cannot be skipped");
  assert(doc.querySelector(".side .con i").textContent.trim() === "VS", "selected concepts use VS");

  click(doc.getElementById("controls").children[0]);
  assert(doc.getElementById("screen").className.indexOf("open") !== -1, "screen opened for psychic");
  assert(!doc.getElementById("timer-display").classList.contains("hidden") && doc.getElementById("timer-display").textContent === "01:00", "60-second dial timer starts when target is viewed");
  const beepsBeforeDial = warningBeeps;
  const warningNow = realDateNow();
  window.Date.now = () => warningNow + 49000;
  await sleep(250);
  assert(doc.getElementById("timer-display").textContent === "00:11" && warningBeeps === beepsBeforeDial,
    "dial warning does not play before ten seconds remain");
  window.Date.now = () => warningNow + 50000;
  await sleep(250);
  assert(doc.getElementById("timer-display").classList.contains("warning") && doc.getElementById("timer-display").textContent === "00:10", "dial timer warns with ten seconds remaining");
  assert(warningBeeps === beepsBeforeDial + 1, "ten-second warning sound plays once");
  window.Date.now = () => warningNow + 55000;
  await sleep(250);
  assert(warningBeeps === beepsBeforeDial + 1, "dial does not repeat the warning at five seconds");
  window.Date.now = realDateNow;
  click(doc.getElementById("controls").children[0]);
  assert(doc.getElementById("screen").className.indexOf("open") === -1, "screen closed after psychic done");
  assert(doc.getElementById("hint").textContent.indexOf("拖动金色拨杆") !== -1, "dial phase");

  const interact = doc.getElementById("interact");
  const axis = doc.getElementById("axis");
  axis.getBoundingClientRect = () => ({ left: 0, width: 1000 });
  const PE = window.PointerEvent || window.MouseEvent;
  window.Date.now = () => warningNow + 61000;
  await sleep(250);
  assert(doc.getElementById("timer-display").textContent === "00:00", "dial countdown displays zero during grace");
  assert(warningBeeps === beepsBeforeDial + 2 && tones.at(-1).duration === 0.75, "dial zero adds one long tone");
  interact.dispatchEvent(new PE("pointerdown", { clientX: 750, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new PE("pointermove", { clientX: 750, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  assert(doc.getElementById("dial").style.left !== "50%", "dial moved to " + doc.getElementById("dial").style.left);

  click("btn-lock");
  assert(doc.getElementById("hint").textContent.indexOf("左边") !== -1, "guess phase");
  assert(doc.getElementById("guess-region").hidden && doc.getElementById("direction-frame").hidden, "no direction highlight before the opponent chooses");
  assert(doc.getElementById("timer-display").textContent === "00:15", "15-second guess timer starts after locking dial");
  const expiryNow = window.Date.now();
  const realRandom = window.Math.random;
  const beepsBeforeGuess = warningBeeps;
  window.Date.now = () => expiryNow + 10000;
  await sleep(250);
  assert(doc.getElementById("timer-display").textContent === "00:05" && warningBeeps === beepsBeforeGuess + 1,
    "guessing also gives one five-second warning");
  window.Math.random = () => 0.75;
  window.Date.now = () => expiryNow + 16000;
  await sleep(250);
  assert(doc.getElementById("timer-display").textContent === "00:00" && !doc.querySelector(".guess-choice"),
    "guessing remains undecided during grace");
  assert(warningBeeps === beepsBeforeGuess + 2 && tones.at(-1).duration === 0.75, "guess zero adds one long tone");
  window.Date.now = () => expiryNow + 16500;
  await sleep(250);
  assert(doc.getElementById("timer-display").classList.contains("hidden") && doc.getElementById("hint").textContent.indexOf("揭示目标") !== -1, "expired guess timer automatically advances to reveal");
  assert(warningBeeps === beepsBeforeGuess + 2, "end of grace does not repeat the zero tone");
  window.Date.now = realDateNow;
  window.Math.random = realRandom;
  assert(doc.getElementById("hint").textContent.indexOf("揭示目标") !== -1, "reveal phase");
  assert(doc.getElementById("timer-display").classList.contains("hidden"), "guess timer clears after left/right choice");
  assert(doc.querySelector(".guess-choice") && doc.querySelector(".guess-choice").textContent.indexOf("右边") !== -1, "opponent choice shown before reveal");
  const guessRegion = doc.getElementById("guess-region");
  const directionFrame = doc.getElementById("direction-frame");
  assert(!guessRegion.hidden && !directionFrame.hidden && guessRegion.dataset.side === "R", "right choice shows the arrows and selected outer frame");
  assert(guessRegion.style.left === "75%" && guessRegion.style.width === "25%", "right highlight begins at the dial, not at the middle of the bar");
  assert(axis.style.getPropertyValue("--guess-color") === "var(--cB)" && axis.style.getPropertyValue("--guess-clip-left") === "75%" && axis.style.getPropertyValue("--guess-clip-right") === "0%", "right frame follows the choosing purple team and covers only the selected side");

  const a0 = parseInt(doc.getElementById("scoreA").textContent, 10);
  click(doc.getElementById("controls").children[0]);
  assert(parseInt(doc.getElementById("scoreA").textContent, 10) >= a0, "A score updated after reveal");
  assert(doc.querySelector(".guess-result") && doc.querySelector(".guess-result").textContent.indexOf("等待揭示") === -1, "opponent choice result shown after reveal");
  assert(doc.getElementById("screen").className.indexOf("open") !== -1, "screen open after reveal");
  assert(guessRegion.hidden && !directionFrame.hidden, "reveal stops arrows and retains the selected frame");
  assert(doc.getElementById("log").children.length === 1, "round logged");
  const popA = doc.getElementById("score-pop").innerHTML;
  const logA = doc.getElementById("log").children[0].innerHTML;
  assert(popA.indexOf("color:var(--cA)") !== -1, "active team name colored in score pop");
  assert(logA.indexOf("color:var(--cA)") !== -1, "team name colored in log");
  assert(logA.indexOf("目标") !== -1 && logA.indexOf("拨杆") !== -1, "log shows target-dial range");
  const logText = doc.getElementById("log").children[0].textContent;
  assert(doc.querySelector(".log-card b").textContent.includes(" VS "), "history concepts use VS");
  assert(logText.indexOf("% / ") !== -1, "log uses an unambiguous separator for signed values");
  const pcts = logText.match(/[+-]?\d+(?:\.\d)?%/g).map((s) => parseFloat(s));
  assert(pcts.length === 2 && pcts[0] <= pcts[1], "log percents sorted ascending");
  const pointsA = [...doc.querySelectorAll("#log li:first-child .log-points")];
  assert(pointsA.map(el => el.dataset.team).join() === "A,B", "history gains follow physical left/right team order");
  assert(pointsA[0].getAttribute("style").includes("var(--cA)") && pointsA[1].getAttribute("style").includes("var(--cB)"), "history gains keep their team's colors");

  click(doc.getElementById("controls").children[0]);
  assert(doc.getElementById("screen").className.indexOf("open") === -1, "screen reset for new round");
  assert(guessRegion.hidden && directionFrame.hidden, "new round clears the previous direction highlight");
  assert(doc.getElementById("hint").textContent.indexOf("粉队") !== -1, "turn switched to B");

  assert(doc.querySelectorAll(".card-choice").length === 2, "next round starts with two candidates");
  assert(!doc.getElementById("btn-redraw").disabled, "other team retains its redraw chance");
  click(doc.querySelectorAll(".card-choice")[1]);
  click(doc.getElementById("controls").children[0]);
  click(doc.getElementById("controls").children[0]);
  click("btn-lock");
  click(doc.getElementById("controls").children[0]);
  assert(doc.querySelector(".guess-result").textContent.indexOf("等待揭示") !== -1, "new-round guess does not reuse previous reveal result");
  assert(!guessRegion.hidden && guessRegion.dataset.side === "L" && axis.style.getPropertyValue("--guess-color") === "var(--cA)", "left choice follows the choosing red team after the turn changes");
  assert(guessRegion.style.left === "0%" && axis.style.getPropertyValue("--guess-clip-left") === "0%", "left highlight starts at the left endpoint");

  click("btn-restart");
  assert(guessRegion.hidden && directionFrame.hidden, "restart clears direction arrows and frame");
  click("btn-reset-deck");
  assert(doc.getElementById("deck-info").textContent.indexOf("内置题库") !== -1, "reset restores builtin deck");
  assert(doc.getElementById("title-main").textContent === "GUESSY", "custom title persists after deck reset");

  const ws2 = doc.getElementById("opt-winscore");
  ws2.value = "1";
  ws2.dispatchEvent(new window.Event("change", { bubbles: true }));
  doc.getElementById("select-first").value = "A";
  click("btn-start");
  click(doc.querySelector(".card-choice"));
  click(doc.getElementById("controls").children[0]);
  click(doc.getElementById("controls").children[0]);
  const cx = (parseFloat(doc.getElementById("center-mark").style.left) / 100) * 1000;
  const PE2 = window.PointerEvent || window.MouseEvent;
  interact.dispatchEvent(new PE2("pointerdown", { clientX: cx, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new PE2("pointermove", { clientX: cx, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  click("btn-lock");
  click(doc.getElementById("controls").children[0]);
  click(doc.getElementById("controls").children[0]);
  assert(doc.getElementById("over-modal").className.indexOf("hidden") === -1, "game over modal shown");
  click("btn-over-close");
  assert(doc.getElementById("over-modal").className.indexOf("hidden") !== -1, "返回复盘 dismisses modal");
  assert(doc.getElementById("log").children.length >= 1, "board keeps log after 返回复盘");
  assert(doc.getElementById("scoreA").textContent === "4", "final score visible on board");

  click("btn-restart");
  const ws3 = doc.getElementById("opt-winscore");
  ws3.value = "2";
  ws3.dispatchEvent(new window.Event("change", { bubbles: true }));
  doc.getElementById("opt-card-mode").value = "single";
  doc.getElementById("opt-card-mode").dispatchEvent(new window.Event("change", { bubbles: true }));
  doc.getElementById("select-first").value = "A";
  click("btn-start");
  assert(doc.querySelectorAll(".card-choice").length === 0 && doc.getElementById("hint").textContent.includes("查看目标"), "classic mode bypasses card choice");

  const centerOf = () => (parseFloat(doc.getElementById("center-mark").style.left) / 100) * 1000;
  const dragTo2Band = () => {
    const c = centerOf();
    dragTo(c + 70 > 1000 ? c - 70 : c + 70);
  };
  const dragTo = (x) => {
    interact.dispatchEvent(new PE2("pointerdown", { clientX: x, pointerId: 1, bubbles: true }));
    interact.dispatchEvent(new PE2("pointermove", { clientX: x, pointerId: 1, bubbles: true }));
    interact.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  };
  const psychicPass = () => {
    click(doc.getElementById("controls").children[0]);
    click(doc.getElementById("controls").children[0]);
  };
  const guessCorrect = () => {
    const c = (parseFloat(doc.getElementById("center-mark").style.left) / 100) * 1000;
    const d = parseFloat(doc.getElementById("dial").style.left) / 100 * 1000;
    click(doc.getElementById("controls").children[d < c ? 1 : 0]);
  };
  const reveal = () => click(doc.getElementById("controls").children[0]);

  psychicPass();
  dragTo2Band();
  click("btn-lock");
  guessCorrect();
  reveal();
  assert(doc.getElementById("over-modal").className.indexOf("hidden") !== -1, "tie does not end game immediately");
  assert(doc.getElementById("scoreA").textContent === "2" && doc.getElementById("scoreB").textContent === "2", "both reach win score -> tie 2:2");
  assert(doc.getElementById("hint").textContent.indexOf("加时赛") !== -1, "hint announces sudden death");

  click(doc.getElementById("controls").children[0]);
  psychicPass();
  dragTo(centerOf() < 500 ? 1000 : 0);
  click("btn-lock");
  guessCorrect();
  reveal();
  assert(doc.getElementById("over-modal").className.indexOf("hidden") !== -1, "first sudden-death turn alone does not decide");

  click(doc.getElementById("controls").children[0]);
  psychicPass();
  dragTo2Band();
  click("btn-lock");
  guessCorrect();
  reveal();
  assert(doc.getElementById("over-modal").className.indexOf("hidden") === -1, "sudden death decided after both teams' turns");
  assert(doc.getElementById("winner-text").textContent.indexOf("蓝队") !== -1, "higher sudden-death round score wins");

  click("btn-restart");
  doc.getElementById("opt-card-mode").value = "choice";
  doc.getElementById("opt-card-mode").dispatchEvent(new window.Event("change", { bubbles: true }));
  doc.body.setAttribute("data-guess-timer-seconds", "7");
  click("btn-start");
  assert(!doc.getElementById("btn-redraw").disabled, "new match restores redraw allowance");
  click(doc.querySelector(".card-choice"));
  click(doc.getElementById("controls").children[0]);
  const dialExpiry = realDateNow() + 61600;
  window.Math.random = () => 0.25;
  window.Date.now = () => dialExpiry;
  await sleep(250);
  assert(!doc.getElementById("screen").classList.contains("open"), "dial timeout hides the psychic's target");
  assert(doc.getElementById("dial").style.left === "25%", "dial timeout displays the random position");
  assert(doc.getElementById("hint").textContent.includes("左边") && doc.getElementById("timer-display").textContent === "00:07",
    "dial timeout advances to guessing with the configured duration");
  window.Date.now = realDateNow;
  window.Math.random = realRandom;

  click("btn-restart");
  click("btn-start");
  click(doc.querySelector(".card-choice"));
  click(doc.getElementById("controls").children[0]);
  click(doc.getElementById("controls").children[0]);
  const movedDialStart = realDateNow();
  window.Date.now = () => movedDialStart + 61000;
  interact.dispatchEvent(new PE("pointerdown", { clientX: 800, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  window.Math.random = () => 0.25;
  window.Date.now = () => movedDialStart + 61600;
  await sleep(250);
  assert(doc.getElementById("dial").style.left === "80%" && doc.getElementById("hint").textContent.includes("左边"),
    "local timeout preserves a dial moved during grace and advances without pressing lock");
  assert(doc.getElementById("timer-display").textContent === "00:07", "preserved dial starts the configured guess timer");
  window.Date.now = realDateNow;
  window.Math.random = realRandom;

  click("btn-restart");
  click("btn-start");
  const selectionExpiry = realDateNow() + 11600;
  const beepsBeforeExpiry = warningBeeps;
  // The built-in cards are untagged, so 0.75 selects the right candidate.
  const rightTopic = doc.querySelectorAll(".card-choice")[1].querySelector(".con").textContent;
  let firstSample = true;
  window.Math.random = () => { if (firstSample) { firstSample = false; return 0.75; } return realRandom(); };
  window.Date.now = () => selectionExpiry;
  await sleep(250);
  assert(doc.querySelectorAll(".card-choice").length === 0 && doc.getElementById("hint").textContent.includes("查看目标"),
    "selection timeout enters psychic phase without another click");
  assert(doc.querySelector(".side .con").textContent === rightTopic, "equal-tag timeout selects the sampled candidate");
  assert(!doc.getElementById("screen").classList.contains("open") && doc.getElementById("timer-display").classList.contains("hidden"),
    "automatic selection keeps target hidden and waits to start the next timer");
  assert(warningBeeps === beepsBeforeExpiry, "resuming past grace does not play stale tones");
  assert(tones.every(tone => tone.frequency === 880 && Math.max(...tone.levels) === 0.32),
    "short and long tones share 880Hz and peak gain 0.32");
  window.Date.now = realDateNow;
  window.Math.random = realRandom;

  assert(!doc.getElementById("btn-penalty-lock"), "speaking penalty is unavailable before closing the target");
  psychicPass();
  assert(doc.getElementById("btn-lock").nextElementSibling.id === "btn-penalty-lock",
    "speaking penalty appears beside the regular lock during discussion");
  dragTo(800);
  const originalConfirm = window.confirm;
  let confirmation = "";
  window.confirm = message => { confirmation = message; return false; };
  click("btn-penalty-lock");
  assert(confirmation.includes("说话违规") && confirmation.includes("随机") && confirmation.includes("立即锁定"),
    "penalty confirmation explains the violation and irreversible random lock");
  assert(doc.body.dataset.phase === "dial" && doc.getElementById("dial").style.left === "80%",
    "cancelling the penalty preserves the position and discussion phase");
  window.confirm = () => true;
  window.Math.random = () => 0.25;
  click("btn-penalty-lock");
  window.Math.random = realRandom;
  window.confirm = originalConfirm;
  assert(doc.body.dataset.phase === "guess" && doc.getElementById("dial").style.left === "25%",
    "confirming the penalty replaces a moved dial and locks immediately");
  assert(doc.getElementById("timer-display").textContent === "00:07", "penalty uses the configured guess timer");
  assert(!doc.getElementById("btn-lock") && !doc.getElementById("btn-penalty-lock") &&
    !doc.getElementById("screen").classList.contains("open"), "penalty removes lock actions and keeps the target hidden");
  dragTo(600);
  assert(doc.getElementById("dial").style.left === "25%", "penalized dial cannot be dragged after locking");

  console.log("ALL TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
