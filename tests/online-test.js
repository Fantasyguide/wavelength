process.env.PORT = "0";
const fixture = require("./server-fixture");
fixture.configure();
let cookie = "";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const WL = require("../game.js");
const { server } = require(path.join(__dirname, "..", "server.js"));

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const defaultDeck = WL.parseDeck(fs.readFileSync(path.join(ROOT, "cards.yaml"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = "";

class FakeES {
  constructor(url) {
    this.onmessage = null;
    this.onopen = null;
    this._buf = "";
    const req = http.get(new URL(url, BASE), { headers: { Cookie: cookie } }, (res) => {
      setTimeout(() => { if (this.onopen) this.onopen(); }, 10);
      res.on("data", (c) => {
        this._buf += c.toString();
        let idx;
        while ((idx = this._buf.indexOf("\n\n")) !== -1) {
          const frame = this._buf.slice(0, idx);
          this._buf = this._buf.slice(idx + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data && this.onmessage) this.onmessage({ data });
        }
      });
    });
    req.on("error", () => {});
    this.close = () => { try { req.destroy(); } catch (e) {} };
  }
}

function makePage() {
  return new JSDOM(html, {
    url: BASE + "/index.html",
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (u, opts) => global.fetch(new URL(u, BASE + "/").href,
        { ...opts, headers: { ...opts?.headers, Cookie: cookie } });
      window.EventSource = FakeES;
    }
  });
}

async function waitFor(fn, msg, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (fn()) return; } catch (e) {}
    await sleep(50);
  }
  throw new Error("TIMEOUT waiting for: " + msg);
}

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok: " + msg);
}

function click(doc, id) {
  const el = typeof id === "string" ? doc.getElementById(id) : id;
  if (!el) throw new Error("missing #" + id);
  el.dispatchEvent(new doc.defaultView.Event("click", { bubbles: true }));
}

(async function () {
  await new Promise((r) => server.once("listening", r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  cookie = await fixture.login(BASE);

  const controller = makePage();
  const monitor = makePage();
  const cdoc = controller.window.document;
  const mdoc = monitor.window.document;

  await waitFor(() => cdoc.getElementById("role-modal").className.indexOf("hidden") === -1, "controller sees role modal");
  await waitFor(() => mdoc.getElementById("conn-badge").textContent.indexOf("已连接") !== -1, "monitor badge connected");

  click(cdoc, "btn-role-controller");
  click(mdoc, "btn-role-monitor");

  await waitFor(() => cdoc.getElementById("setup-modal").className.indexOf("hidden") === -1, "controller setup modal");
  await waitFor(() => mdoc.getElementById("btn-restart").style.display === "none", "monitor restart hidden");

  click(cdoc, cdoc.querySelector("details.rules > summary"));
  await waitFor(() => mdoc.querySelector("details.rules").open, "controller opens monitor rules");
  click(mdoc, mdoc.querySelector("details.rules > summary"));
  assert(mdoc.querySelector("details.rules").open, "monitor cannot dismiss shared rules locally");
  click(cdoc, cdoc.querySelector("details.rules > summary"));
  await waitFor(() => !mdoc.querySelector("details.rules").open, "controller closes monitor rules");

  async function expectDeck(deck, label) {
    const info = deck.name + " · " + deck.cards.length + " 张卡";
    await waitFor(() => [cdoc, mdoc].every((doc) =>
      doc.getElementById("deck-info").textContent === info &&
      doc.getElementById("deck-badge").textContent === deck.name
    ), label);
    assert(true, label);
  }

  await expectDeck(defaultDeck, "controller and monitor start with original cards.yaml deck name and count");
  await waitFor(() => cdoc.getElementById("deck-select").children.length > 1, "deck select populated from folder");
  const chosenFile = "儿童版.json";
  const chosenDeck = WL.parseDeck(fs.readFileSync(path.join(ROOT, "decks", chosenFile), "utf8"));
  const sel = cdoc.getElementById("deck-select");
  sel.value = chosenFile;
  assert(sel.value === chosenFile, "controller can select a different folder deck");
  sel.dispatchEvent(new cdoc.defaultView.Event("change", { bubbles: true }));
  await expectDeck(chosenDeck, "folder deck name and count sync to controller and monitor");

  click(cdoc, "btn-reset-deck");
  await expectDeck(defaultDeck, "reset after folder selection restores original cards.yaml deck on both devices");
  assert(sel.value === "", "reset clears the folder deck selection");

  click(cdoc, "btn-builtin-deck");
  await expectDeck({ name: "通用题库", cards: WL.BUILTIN_DECK }, "separate generic deck button syncs original builtin cards to both devices");
  click(cdoc, "btn-reset-deck");
  await expectDeck(defaultDeck, "reset after generic selection restores original cards.yaml deck on both devices");

  cdoc.getElementById("input-nameA").value = "蓝队";
  cdoc.getElementById("input-nameB").value = "粉队";
  cdoc.getElementById("select-first").value = "A";
  click(cdoc, "btn-start");

  await waitFor(() => mdoc.querySelectorAll(".card-choice").length === 2 && cdoc.querySelectorAll(".card-choice").length === 2, "both devices receive two candidates");
  assert(cdoc.getElementById("hint").textContent.includes("蓝队") && cdoc.getElementById("turn-indicator").textContent.includes("选题"), "controller identifies the team selecting a topic");
  assert(mdoc.getElementById("sides").textContent === cdoc.getElementById("sides").textContent.replaceAll("选择这道题 →", "等待控制器选择"), "candidate topics match across devices");
  click(mdoc, mdoc.querySelector(".card-choice"));
  assert(mdoc.querySelectorAll(".card-choice").length === 2, "monitor cannot choose a card");
  click(cdoc, cdoc.querySelectorAll(".card-choice")[1]);
  await waitFor(() => mdoc.getElementById("hint").textContent.indexOf("查看目标") !== -1, "monitor sees psychic phase");
  assert(cdoc.getElementById("scoreB").textContent === "0", "controller sees B start at 0 with default balanced rules");

  const mSides = mdoc.getElementById("sides").children;
  for (let i = 0; i < mSides.length; i++) {
    assert(!mSides[i].disabled, "monitor side not greyed");
    assert(mSides[i].className.indexOf("readonly") !== -1, "monitor side readonly");
  }

  click(cdoc, cdoc.getElementById("controls").children[0]);
  assert(cdoc.getElementById("screen").className.indexOf("open") !== -1, "controller screen open for psychic");
  assert(cdoc.getElementById("hint").textContent.includes("给出线索") && cdoc.getElementById("hint").textContent.includes("出题完成"), "viewing the target advances the instruction to giving a clue");
  await sleep(150);
  assert(mdoc.getElementById("screen").className.indexOf("open") === -1, "monitor screen stays closed (secret)");
  await waitFor(() => mdoc.getElementById("timer-display").textContent === "01:00" || mdoc.getElementById("timer-display").textContent === "00:59", "monitor receives 60-second dial timer");

  click(cdoc, cdoc.getElementById("controls").children[0]);
  await waitFor(() => mdoc.body.dataset.phase === "dial", "monitor sees dial phase with the configured terminology");

  const axis = cdoc.getElementById("axis");
  axis.getBoundingClientRect = () => ({ left: 0, width: 1000 });
  const interact = cdoc.getElementById("interact");
  const PE = controller.window.PointerEvent || controller.window.MouseEvent;
  interact.dispatchEvent(new PE("pointerdown", { clientX: 250, pointerId: 1, bubbles: true }));
  await waitFor(() => mdoc.getElementById("dial").style.left === "25%", "monitor receives the first pointer movement before release");
  interact.dispatchEvent(new PE("pointermove", { clientX: 600, pointerId: 1, bubbles: true }));
  interact.dispatchEvent(new controller.window.Event("pointerup", { bubbles: true }));
  await waitFor(() => mdoc.getElementById("dial").style.left === "60%", "monitor dial synced to 60%");

  click(cdoc, "btn-lock");
  await waitFor(() => mdoc.getElementById("hint").textContent.indexOf("左边") !== -1, "monitor sees guess phase");
  await waitFor(() => cdoc.body.dataset.phase === "guess", "controller sees guess phase");
  assert(cdoc.getElementById("turn-indicator").textContent.includes("粉队") && !cdoc.getElementById("turn-indicator").textContent.includes("蓝队"), "turn indicator hands the action to the opposing team for left/right guessing");
  assert(cdoc.getElementById("hint").textContent.includes("粉队"), "controller prompt agrees with the guessing team's turn indicator");
  assert(cdoc.querySelector(".team.b").classList.contains("is-active"), "guessing team's card agrees with the action instruction");
  await waitFor(() => mdoc.getElementById("timer-display").textContent === "00:15" || mdoc.getElementById("timer-display").textContent === "00:14", "monitor receives 15-second guess timer");
  click(cdoc, cdoc.getElementById("controls").children[1]);
  await waitFor(() => mdoc.getElementById("hint").textContent.indexOf("揭示目标") !== -1, "monitor sees reveal phase");
  await waitFor(() => cdoc.body.dataset.phase === "reveal", "controller sees reveal phase");
  assert(cdoc.getElementById("turn-indicator").textContent.includes("蓝队"), "revealing returns the action to the clue-giving team");
  assert(cdoc.querySelector(".team.a").classList.contains("is-active"), "revealing highlights the clue-giving team again");
  await waitFor(() => mdoc.querySelector(".guess-choice") && mdoc.querySelector(".guess-choice").textContent.indexOf("右边") !== -1, "monitor prominently shows opponent right-side choice");
  assert(mdoc.getElementById("timer-display").classList.contains("hidden"), "monitor clears timer after left/right choice");

  click(cdoc, cdoc.getElementById("controls").children[0]);
  await waitFor(() => mdoc.getElementById("screen").className.indexOf("open") !== -1, "monitor screen open after reveal");
  assert(mdoc.querySelector(".guess-choice") && mdoc.querySelector(".guess-result").textContent.indexOf("等待揭示") === -1, "monitor keeps choice and shows its result after reveal");
  await waitFor(() => mdoc.getElementById("log").children.length === 1, "monitor log has 1 entry");
  await waitFor(() => cdoc.body.dataset.phase === "revealed", "controller sees round result");
  assert(cdoc.getElementById("hint").textContent.includes("下一轮") && cdoc.getElementById("hint").textContent.includes("出题"), "round result tells the next team to appoint a clue giver");

  click(cdoc, cdoc.getElementById("controls").children[0]);
  await waitFor(() => mdoc.getElementById("hint").textContent.indexOf("粉队") !== -1, "monitor turn switched to B");
  await waitFor(() => mdoc.querySelectorAll(".card-choice").length === 2, "monitor receives next-round candidates");

  await waitFor(() => cdoc.querySelectorAll(".card-choice").length === 2, "controller receives next-round candidates");
  click(cdoc, cdoc.querySelector(".card-choice"));
  await waitFor(() => cdoc.body.dataset.phase === "psychic", "controller enters next clue phase");
  assert(!cdoc.getElementById("btn-penalty-lock"), "penalty is unavailable while giving the clue");
  click(cdoc, cdoc.getElementById("controls").children[0]);
  click(cdoc, cdoc.getElementById("controls").children[0]);
  await waitFor(() => cdoc.body.dataset.phase === "dial" && mdoc.body.dataset.phase === "dial", "both devices enter discussion");
  assert(!mdoc.getElementById("btn-penalty-lock"), "monitor cannot apply a speaking penalty");
  controller.window.confirm = () => true;
  click(cdoc, "btn-penalty-lock");
  await waitFor(() => cdoc.body.dataset.phase === "guess" && mdoc.body.dataset.phase === "guess", "penalty locks on both devices");
  assert(cdoc.getElementById("dial").style.left === mdoc.getElementById("dial").style.left,
    "controller and monitor receive the same server-selected penalty position");
  assert(!mdoc.getElementById("screen").classList.contains("open"), "penalty does not reveal the secret target");

  click(cdoc, cdoc.getElementById("btn-restart"));
  await waitFor(() => mdoc.getElementById("hint").textContent.indexOf("等待控制器开始游戏") !== -1, "monitor sees waiting hint after restart");

  server.close();
  console.log("ONLINE TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
