// Core integration behavior uses real HTTP routes and a local THCCB source endpoint.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-thccb-'));
process.env.PORT = '0';
process.env.WL_CONFIG = path.join(dir, 'config.json');
process.env.WL_AUTH_SESSIONS = path.join(dir, 'sessions.json');
fs.writeFileSync(process.env.WL_CONFIG, JSON.stringify({ password: 'shared-password', retained: 'keep-me',
  qq: { enabled: true, groupId: 'legacy', url: 'ws://127.0.0.1:1/v1/events' } }));
const { server, state } = require('../server.js');
const calls = [];
let rejectAction = '';
let responseDelay = 15;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, message) {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await sleep(20);
  assert(predicate(), message);
}
const source = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  calls.push({ url: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : null });
  const rejected = req.url.endsWith('/' + rejectAction);
  // A brief response delay allows concurrent controller intents to overlap.
  await new Promise(resolve => setTimeout(resolve, responseDelay));
  res.writeHead(rejected ? 503 : 200);
  res.end(JSON.stringify({ ok: !rejected }));
});
let base, cookie = '';
async function request(url, body, useAuth = true) {
  const response = await fetch(base + url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(useAuth ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), response };
}
async function intent(type, extra = {}) { return request('/api/intent', { type, ...extra }); }
(async () => {
  await once(server, 'listening');
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  const origin = 'http://127.0.0.1:' + source.address().port;
  assert.equal((await request('/api/thccb', undefined, false)).status, 401);
  assert.equal((await request('/api/thccb', { enabled: true }, false)).status, 401);
  const login = await request('/api/auth', { password: 'shared-password' });
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/thccb')).json.config.enabled, false);
  assert.equal(state.audience, undefined, 'legacy QQ config no longer creates audience state');
  await intent('setup', { cardMode: 'single' });
  await intent('donePsychic');
  assert.equal(calls.length, 0, 'disabled mode does not contact THCCB');
  await intent('newGame');
  const secret = 'test-secret-that-is-at-least-32-characters';
  const settings = { enabled: true, base_url: origin, secret };
  for (const invalid of ['ftp://example.com', 'https://user@example.com', 'http://@example.com', origin + '?token=x', origin + '#x']) {
    assert.equal((await request('/api/thccb', { ...settings, base_url: invalid })).status, 400);
  }
  assert.equal((await request('/api/thccb', { ...settings, secret: 'short' })).status, 400);
  const saved = await request('/api/thccb', settings);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.config.secret_configured, true);
  assert.ok(!saved.text.includes(secret));
  const disk = JSON.parse(fs.readFileSync(process.env.WL_CONFIG));
  assert.equal(disk.password, 'shared-password');
  assert.equal(disk.retained, 'keep-me');
  await request('/api/thccb', { ...settings, secret: '' });
  assert.equal(JSON.parse(fs.readFileSync(process.env.WL_CONFIG)).thccb.secret, secret);
  for (const file of ['/config.json', '/auth-sessions.json', '/auth-ips.json', '/.git/config', '/server.js', '/package.json']) {
    assert.equal((await request(file)).status, 404, file + ' is not public');
  }
  assert.equal((await request('/assets/fantasyguide/Yin.svg')).status, 200);
  assert.equal((await request('/decks/' + encodeURIComponent('车万版.json'))).status, 404, 'decks stay behind the authenticated API');
  assert.equal((await intent('resetDeck')).status, 200, 'restoring tagged cards does not call array.slice on objects');
  assert(state.cards.some(card => card.concepts && [1, 2].includes(card.tag)));

  await intent('setup', { cardMode: 'single', teamA: '测试队' });
  const target = state.target.center;
  rejectAction = 'start';
  assert.equal((await intent('donePsychic')).status, 502);
  assert.equal(state.phase, 'psychic');
  const firstKey = calls[0].body.round_key;
  assert.equal((await intent('selectSide', { side: 1 })).status, 400, 'failed start freezes the selected question');
  assert.equal((await intent('skipCard')).status, 400);
  assert.equal((await intent('setup')).status, 400);
  assert.equal((await request('/api/deck', { text: '- [new, old]' })).status, 400);
  assert.equal((await request('/api/thccb', { ...settings, enabled: false, secret: '' })).status, 400);
  rejectAction = '';
  const starts = await Promise.all([intent('donePsychic'), intent('donePsychic')]);
  assert.ok(starts.every(r => r.status === 200));
  assert.equal(calls.length, 2, 'duplicate device intent only sends one successful start');
  assert.deepEqual(calls[0].body, calls[1].body, 'retry keeps identical round and stable labels');
  assert.equal(calls[1].auth, 'Bearer ' + secret);
  assert.deepEqual(Object.keys(calls[1].body).sort(), ['game_key', 'left_label', 'right_label', 'round_key', 'round_number', 'team_name']);
  assert.equal(calls[1].body.team_name, '测试队');
  assert.equal(state.phase, 'dial');
  rejectAction = 'close';
  assert.equal((await intent('lock')).status, 502);
  assert.equal(state.phase, 'dial');
  await intent('setDial', { value: 500 });
  assert.match(state.thccb.error, /通知失败/, 'unrelated dial updates keep the notification failure visible');
  rejectAction = '';
  await Promise.all([intent('lock'), intent('lock')]);
  assert.equal(calls.filter(c => c.url.endsWith('/close')).length, 2);
  await intent('guess', { guess: 'L' });
  rejectAction = 'result';
  assert.equal((await intent('reveal')).status, 502);
  assert.equal(state.phase, 'reveal');
  rejectAction = '';
  await Promise.all([intent('reveal'), intent('reveal')]);
  assert.equal(state.phase, 'revealed');
  assert.deepEqual(calls.at(-1).body, { target_position: target });
  assert.ok(decodeURIComponent(calls.at(-1).url).includes(firstKey));
  assert.ok(!JSON.stringify(state).includes(secret));

  await intent('nextRound');
  await intent('donePsychic');
  const secondKey = calls.at(-1).body.round_key;
  assert.notEqual(firstKey, secondKey);
  rejectAction = 'cancel';
  assert.equal((await intent('newGame')).status, 502);
  assert.equal(state.phase, 'dial');
  rejectAction = '';
  await intent('newGame');
  assert.equal(state.phase, 'setup');
  assert.ok(decodeURIComponent(calls.at(-1).url).includes(secondKey));
  assert.equal(calls.at(-1).body, null);
  await intent('setup', { cardMode: 'single' });
  await intent('donePsychic');
  assert.notEqual(calls.at(-1).body.game_key, calls[0].body.game_key);
  await intent('newGame');

  // Automatic locks must confirm closure even when every controller is disconnected.
  await intent('setup', { cardMode: 'single' });
  await intent('startDialTimer', { timerSeconds: 60, guessTimerSeconds: 7 });
  await intent('donePsychic');
  await intent('setDial', { value: 750 });
  rejectAction = 'close';
  state.timerEnd = Date.now() - 1501;
  await waitFor(() => state.thccb.timer_blocked, 'automatic close failure becomes retryable');
  assert.equal(state.phase, 'dial', 'failed close cannot move to the guessing phase');
  assert.equal(state.dial, 750);
  const blockedKey = state.thccb.round_key;
  const blockedCalls = calls.length;
  await sleep(250);
  assert.equal(calls.length, blockedCalls, 'background timer does not repeatedly retry a failed notification');
  assert.equal((await intent('setDial', { value: 123 })).status, 400, 'late dragging cannot change the pending automatic lock');
  assert.equal((await intent('retryThccb')).status, 502);
  assert.equal(state.thccb.round_key, blockedKey);
  rejectAction = '';
  assert.equal((await intent('retryThccb')).status, 200);
  assert.equal(state.phase, 'guess');
  assert.equal(state.dial, 750);
  assert.equal(state.thccb.status, 'closed');
  assert.equal(state.thccb.timer_blocked, false);
  assert(state.timerEnd > Date.now() + 6500, 'guessing gets its configured duration after successful closure');
  state.timerEnd = Date.now() - 1501;
  await waitFor(() => state.phase === 'reveal', 'guessing expires after closure without clients');
  assert.equal((await intent('reveal')).status, 200);
  assert.equal(state.thccb.status, 'result');
  await intent('newGame');

  // Expiring while the target is still being viewed opens and closes the same round.
  await intent('setup', { cardMode: 'single' });
  assert.equal((await request('/api/thccb', { ...settings, enabled: false })).status, 400, 'configuration changes wait for setup');
  await intent('startDialTimer', { timerSeconds: 60, guessTimerSeconds: 15 });
  const timeoutStart = calls.length;
  state.timerEnd = Date.now() - 1501;
  await waitFor(() => state.phase === 'guess', 'psychic timeout advances only after the bridge confirms');
  assert.equal(calls[timeoutStart].url, '/api/v1/wavelength/rounds/start');
  assert(calls[timeoutStart + 1].url.endsWith('/close'));
  assert.equal(calls.length, timeoutStart + 2);
  assert.equal((await intent('newGame')).status, 200);

  // Cancelling stays available while automatic closure is blocked.
  await intent('setup', { cardMode: 'single' });
  await intent('startDialTimer', { timerSeconds: 60 });
  await intent('donePsychic');
  rejectAction = 'close';
  state.timerEnd = Date.now() - 1501;
  await waitFor(() => state.thccb.timer_blocked, 'second automatic close is blocked');
  assert.equal((await intent('newGame')).status, 200, 'cancellation does not retry the failed close');
  assert.equal(state.phase, 'setup');
  assert.equal(state.thccb.timer_blocked, false);
  assert(calls.at(-1).url.endsWith('/cancel'));
  rejectAction = '';

  // Opening across the deadline must still close once, through the same serial queue.
  await intent('setup', { cardMode: 'single' });
  await intent('startDialTimer', { timerSeconds: 60 });
  responseDelay = 150;
  const pendingStart = calls.length;
  state.timerEnd = Date.now() - 1500 + 80;
  const opening = intent('donePsychic');
  await waitFor(() => calls.length > pendingStart, 'opening request is in flight');
  const changingDeck = request('/api/deck', { text: '- [new, old]' });
  assert.equal((await opening).status, 200);
  assert.equal((await changingDeck).status, 400, 'deck upload cannot race an in-flight opening');
  await waitFor(() => state.phase === 'guess', 'deadline crossed during opening still closes before advancing');
  assert.deepEqual(calls.slice(pendingStart).map(c => c.url.split('/').at(-1)), ['start', 'close']);
  assert.equal(state.thccb.status, 'closed');
  responseDelay = 15;
  await intent('newGame');

  fs.unlinkSync(process.env.WL_CONFIG);
  fs.mkdirSync(process.env.WL_CONFIG);
  const failedSave = await request('/api/thccb', { ...settings, enabled: false, secret: '' });
  assert.equal(failedSave.status, 400);
  assert.match(failedSave.json.error, /写入失败/);
  assert.equal((await request('/api/thccb')).json.config.enabled, true, 'failed disk write does not activate changes');
  console.log('THCCB SERVER TEST PASSED: auth, config, secret privacy, tagged decks, timeout closure, retry, cancellation, concurrent devices and uploads');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.closeAllConnections();
  source.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => source.close(resolve))]);
  fs.rmSync(dir, { recursive: true, force: true });
});
