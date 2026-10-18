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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warningBeeps = 0;
window.AudioContext = class {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  createOscillator() {
    return { frequency: { setValueAtTime() {} }, connect() {}, start() { warningBeeps++; }, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
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
  assert(doc.getElementById("controls").children.length === 0, "cannot view target before choosing a card");
  assert(doc.getElementById("bands").children.length === 0, "no target rendered while choosing");
  click(doc.querySelector(".card-choice"));
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
  assert(!!skipBtn, "skip button present in psychic phase");
  click(skipBtn);
  assert(doc.querySelectorAll(".card-choice").length === 2, "skip draws two fresh candidates");
  click(doc.querySelector(".card-choice"));
  assert(doc.getElementById("hint").textContent.indexOf("查看目标") !== -1, "still psychic phase after skip");
  assert(doc.getElementById("card-label").textContent.indexOf("第 1 轮") !== -1, "round unchanged after skip");

  click(doc.getElementById("controls").children[0]);
  assert(doc.getElementById("screen").className.indexOf("open") !== -1, "screen opened for psychic");
  assert(!doc.getElementById("timer-display").classList.contains("hidden") && doc.getElementById("timer-display").textContent === "01:00", "60-second dial timer starts when target is viewed");
  const realDateNow = window.Date.now;
  const warningNow = realDateNow();
  window.Date.now = () => warningNow + 55000;
  await sleep(250);
  assert(doc.getElementById("timer-display").classList.contains("warning") && doc.getElementById("timer-display").textContent === "00:05", "timer turns red with five seconds remaining");
  assert(warningBeeps === 1, "five-second warning sound plays once");
  await sleep(250);
  assert(warningBeeps === 1, "warning sound does not repeat");
  window.Date.now = realDateNow;
  click(doc.getElementById("controls").children[0]);
  assert(doc.getElementById("screen").className.indexOf("open") === -1, "screen closed after psychic done");
  assert(doc.getElementById("hint").textContent.indexOf("拖动金色拨杆") !== -1, "dial phase");

  const interact = doc.getElementById("interact");
  const axis = doc.getElementById("axis");
  axis.getBoundingClientRect = () => ({ left: 0, width: 1000 });
  const PE = window.PointerEvent || window.MouseEvent;
  interact.dispatchEvent(new PE("pointerdown", { clientX: 750, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new PE("pointermove", { clientX: 750, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  assert(doc.getElementById("dial").style.left !== "50%", "dial moved to " + doc.getElementById("dial").style.left);

  click("btn-lock");
  assert(doc.getElementById("hint").textContent.indexOf("左边") !== -1, "guess phase");
  assert(doc.getElementById("guess-region").hidden && doc.getElementById("direction-frame").hidden, "no direction highlight before the opponent chooses");
  assert(doc.getElementById("timer-display").textContent === "00:15", "15-second guess timer starts after locking dial");
  const expiryNow = realDateNow();
  window.Date.now = () => expiryNow + 16000;
  await sleep(250);
  assert(doc.getElementById("timer-display").textContent === "00:00" && doc.getElementById("hint").textContent.indexOf("左边") !== -1, "expired timer stays at zero without forcing an action");
  window.Date.now = realDateNow;
  click(doc.getElementById("controls").children[1]);
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

  console.log("ALL TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
