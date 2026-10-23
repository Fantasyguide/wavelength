"use strict";
process.env.PORT = "0";
const fixture = require("./server-fixture");
fixture.configure();
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { server, state } = require("../server");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const cookie = await fixture.login(base);
  const streams = [];
  async function connect(id) {
    await new Promise(resolve => {
      const req = http.get(base + "/api/stream?role=controller&client_id=" + id, { headers: { Cookie: cookie } }, response => {
        response.once("data", resolve);
        response.resume();
      });
      streams.push(req);
    });
  }
  async function post(route, body, auth = true) {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Cookie: "theme=dark; " + cookie } : {}) }, body: JSON.stringify(body) });
    return response.status;
  }
  const intent = (type, client_id = "a", extra = {}) => post("/api/intent", { type, client_id, ...extra });
  const report = (type, client_id, elapsedMs, timerId = state.timerSync.id) => post("/api/timer", { type, client_id, elapsedMs, timerId });
  await connect("a"); await connect("b");
  await intent("setup");
  assert.equal(state.timerSync.ownerId, "a");
  const choice = state.timerSync.id;
  await sleep(1200);
  assert.equal(state.timerEnd, null, "server waits while the controller has not displayed the stage");
  assert.equal(await post("/api/timer", { type: "started", client_id: "a", elapsedMs: 0, timerId: choice }, false), 401);
  await report("started", "b", 0);
  assert.equal(state.timerEnd, null, "another controller cannot start the owner's clock");
  await report("started", "a", 0);
  assert(state.timerEnd > Date.now() + 9900);
  const end = state.timerEnd;
  await report("started", "a", 0);
  assert.equal(state.timerEnd, end);
  await intent("redrawCards", "b", { timer_id: choice });
  assert.equal(state.timerSync.ownerId, "b", "redraw uses its initiating controller");
  await report("expired", "a", 11500, choice);
  assert.equal(state.timerEnd, null, "stale expiry cannot affect a redraw");
  await intent("selectCard", "a", { timer_id: choice, index: 0 });
  assert.equal(state.phase, "chooseCard", "stale choice cannot select the replacement cards");
  await report("started", "b", 0);
  await intent("selectCard", "b", { index: 0 });
  await intent("startDialTimer", "a", { timerSeconds: 60, guessTimerSeconds: 7 });
  const dial = state.timerSync.id;
  assert.equal(state.timerEnd, null);
  await intent("startDialTimer", "a", { timerSeconds: 100 });
  assert.equal(state.timerSync.id, dial, "repeated viewing cannot replace a waiting dial clock");
  await intent("donePsychic", "a");
  assert.equal(state.timerSync.id, dial, "clue and discussion share one clock");
  await report("started", "a", 2500);
  assert(state.timerEnd > Date.now() + 57400 && state.timerEnd <= Date.now() + 57500);
  await intent("penaltyLock", "b", { timerSeconds: 7 });
  assert.equal(state.timerSync.ownerId, "b");
  assert.equal(state.timerSync.durationMs, 7000);
  assert.equal(state.timerEnd, null);
  await report("started", "b", 0);
  await report("expired", "b", 8500);
  assert.equal(state.phase, "reveal", "controller expiry advances at the end of its own grace");

  await intent("setup", "a", { cardMode: "single" });
  await intent("startDialTimer", "a", { timerSeconds: 1, guessTimerSeconds: 7 });
  await report("started", "a", 0);
  state.timerEnd = Date.now() - 20000;
  await sleep(200);
  assert.equal(state.phase, "psychic", "a live owner prevents the server fallback deadline from expiring play");
  await report("expired", "a", 2500);
  assert.equal(state.phase, "guess");
  assert.equal(state.timerEnd, null, "automatic transitions do not consume an unseen next stage");
  assert.equal(state.timerSync.durationMs, 7000);
  await report("started", "a", 0);
  assert(state.timerEnd > Date.now() + 6900);

  await intent("setup", "a", { cardMode: "choice" });
  state.timerSync.readyBy = Date.now() - 1;
  await sleep(200);
  assert.equal(state.timerSync.status, "running");
  assert.equal(state.timerSync.source, "server");
  assert(state.timerEnd > Date.now() + 9700);
  streams.forEach(stream => stream.destroy());
  state.timerEnd = Date.now() - 1501;
  await sleep(200);
  assert.equal(state.phase, "psychic", "server fallback remains active after all controllers disconnect");
  server.close();
  console.log("CONTROLLER TIMER SERVER TEST PASSED");
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
