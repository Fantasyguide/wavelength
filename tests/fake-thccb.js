// Protocol fixture only. Database serialization is tested in THCCB's own suite.
const http = require('node:http');
module.exports = function fakeThccb() {
  const fake = { calls: [], rounds: new Map(), tombstones: new Set(), reject: {}, gates: new Map(), current: null, legacy: false };
  fake.hold = (action, afterCommit = false) => {
    let release;
    const gate = { promise: new Promise(r => { release = r; }), afterCommit, release: () => { fake.gates.delete(action); release(); } };
    fake.gates.set(action, gate);
    return gate;
  };
  fake.server = http.createServer(async (req, res) => {
    const bits = req.url.split('/'), action = bits.at(-1);
    let body = ''; for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : undefined;
    const key = action === 'start' ? body.round_key : decodeURIComponent(bits.at(-2));
    fake.calls.push({ action, key, body, auth: req.headers.authorization });
    const gate = fake.gates.get(action);
    if (gate && !gate.afterCommit) await gate.promise;
    let status = fake.reject[action] || 200, result;
    const round = fake.rounds.get(key);
    if (fake.legacy && ['capabilities', 'state', 'abort'].includes(action)) status = 404;
    if (status !== 200) result = { detail: 'injected failure' };
    else if (action === 'capabilities') result = { durable_cancel: true, round_state: true };
    else if (action === 'current') result = fake.current;
    else if (action === 'state') result = { round_key: key, status: round ? round.status : fake.tombstones.has(key) ? 'cancelled' : 'missing', exists: !!round, summary: round || null };
    else if (action === 'start') {
      if (fake.tombstones.has(key)) { status = 409; result = {}; }
      else if (round) result = round;
      else if (Array.from(fake.rounds.values()).some(r => ['open', 'closed'].includes(r.status))) { status = 409; result = {}; }
      else {
        result = { ...body, status: 'open', target_position: null, participant_count: 0, total_refund: '0', total_payout: '0' };
        fake.rounds.set(key, result); fake.current = result;
      }
    } else if (action === 'abort') {
      fake.tombstones.add(key);
      if (round && round.status !== 'settled') round.status = 'cancelled';
      result = { round_key: key, status: round ? round.status : 'cancelled', exists: !!round, summary: round || null };
    } else if (!round) { status = 404; result = {}; }
    else if (action === 'cancel') { if (round.status === 'settled') status = 409; else round.status = 'cancelled'; result = round; }
    else if (action === 'close') { if (round.status === 'open') round.status = 'closed'; else if (round.status !== 'closed') status = 409; result = round; }
    else if (action === 'result') { if (round.status === 'closed') { round.status = 'settled'; round.target_position = body.target_position; } else if (round.status !== 'settled') status = 409; result = round; }
    else if (action === 'results') result = { round_key: key, target_position: round.target_position, top_five: [{ username: '<winner>', position: 510, distance: Math.abs(510 - round.target_position), payout: '300' }] };
    else { status = 404; result = {}; }
    if (gate && gate.afterCommit) await gate.promise;
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  return fake;
};
