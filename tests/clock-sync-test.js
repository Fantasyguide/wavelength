"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "..");
const epoch = 1800000000000;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function page({ initialDelay = 0, fastFollowup = true, initialUplinkDelay = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "index.html"), "utf8"), {
    url: "http://game.test/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const { window } = dom;
  let now = 0, nextId = 1, stream;
  const tasks = new Map(), pings = [];
  window.Date.now = () => epoch + now + 2000;
  window.performance.now = () => now;
  window.setTimeout = (fn, delay) => { const id = nextId++; tasks.set(id, { fn, at: now + delay }); return id; };
  window.setInterval = (fn, delay) => {
    const id = nextId++;
    // Each test explicitly schedules its network probes through visibilitychange.
    if (delay !== 8000) tasks.set(id, { fn, at: now + delay, delay });
    return id;
  };
  window.clearTimeout = window.clearInterval = id => tasks.delete(id);
  window.fetch = url => {
    if (url.endsWith("api/ping")) return new Promise(resolve => pings.push({ resolve, started: now }));
    return Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  };
  window.EventSource = class {
    constructor() { stream = this; }
    close() {}
  };
  for (const file of ["target-sampling-config.js", "game.js", "app.js"]) {
    window.eval(fs.readFileSync(path.join(root, file), "utf8"));
  }
  async function reply(ping, serverTime = epoch + now) {
    ping.resolve({ ok: true, json: async () => ({ serverNow: serverTime, authed: true }) });
    await flush();
  }
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      now = task.at;
      if (task.delay) task.at += task.delay;
      else tasks.delete(id);
      task.fn();
      await flush();
    }
    now = end;
    await flush();
  }
  function publish(kind = "chooseCard", duration = 10, elapsed = 0) {
    const state = window.WL.createGame();
    Object.assign(state, {
      phase: kind === "chooseCard" ? "chooseCard" : kind === "dial" ? "dial" : "guess",
      timerKind: kind, timerEnd: epoch + now + duration * 1000 - elapsed,
      serverNow: epoch + now - elapsed,
      cardChoices: [["左一", "右一"], ["左二", "右二"]]
    });
    stream.onmessage({ data: JSON.stringify(state) });
    return state;
  }
  function heartbeat() {
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    return pings.at(-1);
  }
  const text = () => {
    // Render at the precise simulated time, rather than the preceding 200ms tick.
    window.dispatchEvent(new window.Event("resize"));
    return window.document.getElementById("timer-display").textContent;
  };
  await advance(initialDelay);
  await reply(pings[0], initialUplinkDelay ? epoch + initialDelay : epoch);
  stream.onopen();
  if (fastFollowup) await reply(pings[1]);
  return { window, pings, reply, advance, publish, heartbeat, text, close: () => dom.window.close(), time: () => epoch + now };
}

async function test(name, run, options) {
  const h = await page(options);
  try { await run(h); console.log("ok: " + name); }
  finally { h.close(); }
}

(async () => {
  await test("slow downlink cannot add two seconds to selection, redraw, dial or guessing", async h => {
    const slow = h.heartbeat();
    const sentAt = h.time();
    await h.advance(3900);
    await h.reply(slow, sentAt);
    h.publish();
    assert.equal(h.text(), "00:10", "a delayed heartbeat cannot make a fresh ten-second timer start at 12");
    await h.advance(2000);
    assert.equal(h.text(), "00:08");
    h.publish();
    assert.equal(h.text(), "00:10", "a new redraw deadline restores exactly ten seconds");
    h.publish("dial", 60);
    assert.equal(h.text(), "01:00");
    h.publish("guess", 15);
    assert.equal(h.text(), "00:15");
  });
  await test("slow uplink cannot remove time from a running countdown", async h => {
    h.publish();
    const slow = h.heartbeat();
    await h.advance(3900);
    await h.reply(slow);
    await h.advance(100);
    assert.equal(h.text(), "00:06");
    h.publish();
    assert.equal(h.text(), "00:10");
  });
  for (const initialUplinkDelay of [false, true]) {
    await test("a slow first probe uses snapshot time without inflating or shortening a new timer", async h => {
      h.publish();
      assert.equal(h.text(), "00:10");
      await h.advance(2000);
      assert.equal(h.text(), "00:08");
    }, { initialDelay: 2000, fastFollowup: false, initialUplinkDelay });
  }
  await test("the snapshot bounds small calibration errors and delayed snapshots retain elapsed time", async h => {
    await h.advance(61000); // Expire the old calibration so this sample can be adopted.
    const delayed = h.heartbeat(), sentAt = h.time();
    await h.advance(800);
    await h.reply(delayed, sentAt);
    h.publish();
    assert.equal(h.text(), "00:10", "a 400ms clock underestimate must not round a fresh timer up to 11");
    await h.advance(2000);
    h.publish("chooseCard", 10, 2000);
    assert.equal(h.text(), "00:08", "the same delayed state does not restart the countdown");
  });
  await test("expired and out-of-order responses cannot replace a fresh calibration", async h => {
    await h.advance(61000);
    const old = h.heartbeat(), oldTime = h.time();
    await h.advance(200);
    const fresh = h.heartbeat();
    await h.reply(fresh);
    await h.advance(300);
    await h.reply(old, oldTime);
    h.publish();
    assert.equal(h.text(), "00:10");
    const timedOut = h.heartbeat();
    await h.advance(4500);
    await h.reply(timedOut);
    h.publish();
    assert.equal(h.text(), "00:10");
  });
  await test("small clock corrections cannot extend an active deadline or block a legitimate redraw", async h => {
    await h.advance(61000);
    const upstream = h.heartbeat();
    await h.advance(800);
    await h.reply(upstream); // A permitted sample estimates time 400ms ahead.
    h.publish();
    await h.advance(650);
    h.window.dispatchEvent(new h.window.Event("resize"));
    assert.equal(h.text(), "00:09");
    const better = h.heartbeat();
    await h.reply(better);
    h.window.dispatchEvent(new h.window.Event("resize"));
    assert.equal(h.text(), "00:09", "improving calibration must not rewind 9 to 10");
    h.publish();
    assert.equal(h.text(), "00:10", "a real new deadline can increase the countdown");
    h.window.Date.now = () => epoch + 99999999;
    await h.advance(2000);
    assert.equal(h.text(), "00:08", "device clock changes cannot alter elapsed time");
  });
  await test("resuming a suspended device refreshes an old lower-latency calibration", async h => {
    h.publish();
    await h.advance(1000);
    const resumed = h.heartbeat();
    await h.advance(100);
    // The server advanced during sleep while the browser's monotonic clock paused.
    await h.reply(resumed, h.time() + 60000);
    assert.equal(h.text(), "00:00", "an old near-zero-RTT sample cannot keep an expired timer running");
  });
  console.log("CLOCK SYNC TEST PASSED");
})().catch(error => { console.error(error); process.exitCode = 1; });
