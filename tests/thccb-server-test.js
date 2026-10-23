// Local recovery must never wait for a remote request, including a committed result.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fake = require('./fake-thccb')();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-thccb-'));
process.env.PORT = '0'; process.env.WL_CONFIG = path.join(dir, 'config.json');
process.env.WL_AUTH_SESSIONS = path.join(dir, 'sessions.json');
fs.writeFileSync(process.env.WL_CONFIG, JSON.stringify({ password: 'shared-password', retained: 'keep-me' }));
const { server, state } = require('../server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate, message) {
  const end = Date.now() + 6000;
  while (!predicate() && Date.now() < end) await sleep(15);
  assert(predicate(), message);
}
let base, cookie = '';
async function request(url, body, auth = true) {
  const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, response: r };
}
const intent = (type, extra = {}) => request('/api/intent', { type, ...extra });
const admin = (type, extra = {}) => intent(type, { control: { ...state.control }, operation_id: randomUUID(), ...extra });
const clean = () => waitFor(() => state.thccb.jobs.every(j => j.terminal), 'cleanup eventually finishes');
async function monitorSnapshot() {
  const r = await fetch(base + '/api/stream'); const reader = r.body.getReader(); let text = '';
  try { while (!text.includes('data: ')) text += new TextDecoder().decode((await reader.read()).value); return JSON.parse(text.split('data: ')[1].split('\n')[0]); }
  finally { await reader.cancel(); }
}
(async () => {
  await once(server, 'listening'); fake.server.listen(0, '127.0.0.1'); await once(fake.server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await request('/api/thccb', undefined, false)).status, 401);
  cookie = (await request('/api/auth', { password: 'shared-password' })).response.headers.get('set-cookie').split(';')[0];
  const secret = 'test-secret-at-least-32-characters';
  const settings = { enabled: true, base_url: 'http://127.0.0.1:' + fake.server.address().port, secret };
  for (const bad of ['ftp://example.com', 'https://user@example.com', 'http://@example.com', settings.base_url + '?token=x'])
    assert.equal((await request('/api/thccb', { ...settings, base_url: bad })).status, 400);
  assert.equal((await request('/api/thccb', { ...settings, secret: 'short' })).status, 400);
  const saved = await request('/api/thccb', settings); assert.equal(saved.status, 200); assert(!saved.text.includes(secret));
  assert.equal(JSON.parse(fs.readFileSync(process.env.WL_CONFIG)).retained, 'keep-me');
  for (const file of ['/config.json', '/auth-sessions.json', '/server.js', '/thccb-bridge.js', '/data/thccb-journal.json']) assert.equal((await request(file)).status, 404);
  await waitFor(() => state.thccb_connection.status === 'connected', 'health is read-only reachability');
  assert.equal(fake.calls.filter(c => c.action === 'start').length, 0);

  // Retries reconcile already committed state and freeze the chosen input.
  await intent('setup', { cardMode: 'single' });
  fake.reject.start = 503;
  assert.equal((await intent('donePsychic')).status, 502);
  assert.equal(state.phase, 'psychic'); assert(state.thccb.retryable);
  const firstKey = state.thccb.round_key;
  assert.equal((await intent('skipCard')).status, 400);
  delete fake.reject.start;
  const retries = await Promise.all([intent('retryThccb'), intent('retryThccb')]);
  assert(retries.every(r => r.status === 200)); assert.equal(state.phase, 'dial');
  assert.equal(fake.calls.filter(c => c.action === 'start' && c.key === firstKey).length, 2);
  fake.reject.close = 503;
  assert.equal((await intent('penaltyLock', { timerSeconds: 7 })).status, 502);
  const frozen = state.dial;
  assert.equal((await intent('setDial', { value: 123 })).status, 400); assert.equal(state.dial, frozen);
  delete fake.reject.close;
  await intent('retryThccb'); assert.equal(state.phase, 'guess');
  assert(state.timerEnd > Date.now() + 6500);
  const penalty = state.dial; await intent('penaltyLock'); assert.equal(state.dial, penalty);
  await intent('guess', { guess: 'L' }); await intent('reveal');
  await waitFor(() => state.thccb.results, 'leaderboard fetched');
  const monitor = await monitorSnapshot(); assert.equal(monitor.thccb.results.top_five[0].username, '<winner>');
  assert.equal(monitor.thccb.jobs, undefined); assert.equal(monitor.control, undefined);
  assert(!JSON.stringify(monitor).includes(secret));
  const scores = { A: state.teams.A.score, B: state.teams.B.score };
  assert(scores.A + scores.B >= 0);
  await admin('voidRound'); assert.equal(state.round, 1); assert.equal(state.log.length, 0);
  assert.equal(state.thccb.results, null); assert(state.thccb.jobs.some(j => j.status === 'rewards_retained'));
  await intent('newGame');

  // Every admin escape works while every critical remote transition is still held.
  for (const action of ['start', 'close', 'result']) for (const escape of ['setThccbEnabled', 'voidRound', 'resetGame']) {
    await clean();
    if (!state.thccb.enabled) await admin('setThccbEnabled', { value: true });
    await intent('setup', { cardMode: 'single' });
    if (action !== 'start') await intent('donePsychic');
    if (action === 'result') { await intent('lock'); await intent('guess', { guess: 'L' }); }
    const gate = fake.hold(action, action === 'result');
    const count = fake.calls.length;
    const outstanding = intent({ start: 'donePsychic', close: 'lock', result: 'reveal' }[action]);
    await waitFor(() => fake.calls.slice(count).some(c => c.action === action), 'remote transition has started');
    const oldAttempt = { ...state.control }, oldKey = state.thccb.round_key;
    const operation = { control: oldAttempt, operation_id: randomUUID(), value: false };
    const began = Date.now();
    const response = await admin(escape, operation);
    assert.equal(response.status, 200, response.text); assert(Date.now() - began < 400, 'local escape cannot wait for held remote');
    const phase = state.phase, attempt = state.control.attempt_key, target = state.target && state.target.center;
    assert.equal((await admin(escape, operation)).status, 200, 'same operation ID is idempotent');
    assert.equal(state.target && state.target.center, target);
    if (escape !== 'setThccbEnabled') assert.equal((await admin('voidRound', { control: oldAttempt })).status, 400, 'stale device cannot void new attempt');
    gate.release(); await outstanding; await clean();
    assert.equal(state.phase, phase, 'late response cannot advance replacement game'); assert.equal(state.control.attempt_key, attempt);
    assert.equal(state.thccb.results, null);
    if (action === 'start') assert(fake.tombstones.has(oldKey), 'cancel-before-create is durable');
    if (action === 'result') assert(state.thccb.jobs.some(j => j.round_key === oldKey && j.status === 'rewards_retained'));
    await intent('newGame');
  }

  // Re-enable during discussion never opens the current round. Pending refunds skip a new window.
  await clean(); await admin('setThccbEnabled', { value: true });
  await intent('setup', { cardMode: 'single' }); await intent('donePsychic');
  const abortGate = fake.hold('abort');
  await admin('setThccbEnabled', { value: false }); await admin('setThccbEnabled', { value: true });
  let starts = fake.calls.filter(c => c.action === 'start').length;
  await intent('lock'); await intent('guess', { guess: 'L' }); await intent('reveal'); await intent('nextRound');
  await intent('donePsychic'); assert.equal(state.phase, 'dial'); assert.equal(state.thccb.status, 'unlinked');
  assert.equal(fake.calls.filter(c => c.action === 'start').length, starts);
  abortGate.release(); await clean();
  assert.equal(state.thccb.status, 'unlinked', 'cleanup completion cannot open mid-discussion');
  await admin('voidRound'); await intent('donePsychic'); assert.equal(state.thccb.status, 'open');

  // Failed deadline closure can be released locally with a full guessing period.
  await intent('newGame'); await clean(); await intent('setup', { cardMode: 'single' });
  await intent('startDialTimer', { timerSeconds: 60, guessTimerSeconds: 7 }); await intent('donePsychic');
  fake.reject.close = 503; state.timerEnd = Date.now() - 1501;
  await waitFor(() => state.thccb.timer_blocked, 'automatic closure waits for retry');
  await admin('setThccbEnabled', { value: false }); assert.equal(state.phase, 'guess'); assert(state.timerEnd > Date.now() + 6500);
  delete fake.reject.close;
  await intent('newGame'); await clean(); await admin('setThccbEnabled', { value: true });
  await intent('setup', { cardMode: 'single' }); await intent('startDialTimer', { timerSeconds: 60 });
  starts = fake.calls.filter(c => c.action === 'start').length; state.timerEnd = Date.now() - 1501;
  await waitFor(() => state.phase === 'guess', 'psychic timeout works without an instantaneous betting round');
  assert.equal(fake.calls.filter(c => c.action === 'start').length, starts);
  await intent('newGame');

  // A foreign old round is inspectable and cancellable only by an explicit controller action.
  fake.current = { round_key: 'foreign', status: 'closed', left_label: 'left', right_label: 'right' }; fake.rounds.set('foreign', fake.current);
  await intent('retryThccb'); await waitFor(() => state.thccb.conflict, 'show foreign round conflict');
  assert.equal(fake.current.status, 'closed');
  assert.equal((await admin('cancelOldThccb', { round_key: 'foreign' })).status, 200); await clean();
  assert.equal(fake.current.status, 'cancelled');

  // Failed durable writes must not turn local recovery into another outage.
  await intent('setup', { cardMode: 'single' }); await intent('donePsychic');
  const store = path.join(dir, 'data', 'thccb-journal.json'); fs.renameSync(store, store + '.saved'); fs.mkdirSync(store);
  assert.equal((await admin('resetGame')).status, 200); assert.equal(state.phase, 'setup'); assert.match(state.thccb.error, /保存失败/);
  fs.rmdirSync(store); fs.renameSync(store + '.saved', store); await intent('retryThccb'); await clean();

  // Restart retains unknown active rounds and explicit cancellation without exposing secrets.
  const Bridge = require('../thccb-bridge'); const recoveryFile = path.join(dir, 'recovery.json');
  let manager = new Bridge({ file: recoveryFile, config: () => settings, changed() {} });
  const job = manager.create({ round_key: 'restart-job', game_key: 'restart', round_number: 1, left_label: 'L', right_label: 'R', team_name: 'T' });
  manager.stop(); manager = new Bridge({ file: recoveryFile, config: () => settings, changed() {} });
  assert.equal(manager.jobs[0].desired, 'orphan'); manager.cancelKnown(job.key);
  await waitFor(() => manager.jobs[0].terminal, 'recovered orphan can be cancelled in controller'); manager.stop();
  assert(!fs.readFileSync(recoveryFile, 'utf8').includes(secret));
  fs.writeFileSync(recoveryFile, JSON.stringify({ version: 1, jobs: [null] }));
  manager = new Bridge({ file: recoveryFile, config: () => settings, changed() {} });
  assert.match(manager.storageError, /无法读取/); assert.deepEqual(manager.diagnostics(), []);
  assert.throws(() => manager.retry(), /无法读取/); manager.stop();
  assert.deepEqual(JSON.parse(fs.readFileSync(recoveryFile)), { version: 1, jobs: [null] }, 'corrupt journal is preserved for repair');
  console.log('THCCB SERVER TEST PASSED: nonblocking admin, stale responses, retry reconciliation, timers, refund journal and privacy');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  for (const gate of fake.gates.values()) gate.release();
  server.closeAllConnections(); fake.server.closeAllConnections();
  await Promise.all([new Promise(r => server.close(r)), new Promise(r => fake.server.close(r))]);
  fs.rmSync(dir, { recursive: true, force: true });
});
