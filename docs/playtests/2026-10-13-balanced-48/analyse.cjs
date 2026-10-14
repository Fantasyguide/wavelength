"use strict";
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const WL = require('./engine-snapshot.cjs');
const session = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json')));
const rounds = session.matches.flatMap(m => m.rounds);
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const at = q * (sorted.length - 1), lower = Math.floor(at), upper = Math.ceil(at);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower);
};
const rounded = x => x === null ? null : Math.round(x * 1000) / 1000;
const apply = (g, type, more = {}) => WL.applyIntent(g, { type, ...more });
const metrics = rs => ({ n: rs.length, meanError: rounded(mean(rs.map(r => r.error))), medianError: rounded(quantile(rs.map(r => r.error), 0.5)), meanPoints: rounded(mean(rs.map(r => r.pts))), zeroRate: rounded(mean(rs.map(r => +(r.pts === 0)))), perfectRate: rounded(mean(rs.map(r => +(r.pts === 4)))), defensePointsPerTurn: rounded(mean(rs.map(r => r.oppPts))) });
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Deterministically replay every observed round through the original engine.
function validate() {
  const engine = fs.readFileSync(path.join(__dirname, 'engine-snapshot.cjs'));
  assert.equal(crypto.createHash('sha256').update(engine).digest('hex'), session.engineSha256, 'Engine changed since experiment began');
  let count = 0;
  const ownTurns = { ...session.initialOwnTurns };
  for (const match of session.matches) {
    const g = WL.createGame();
    apply(g, 'loadDeck', session.deck);
    const original = Math.random;
    Math.random = rng(match.seed);
    try {
      apply(g, 'setup', { first: match.first });
      for (const r of match.rounds) {
        assert.equal(g.round, r.round);
        assert.equal(g.active, r.team);
        assert.equal(r.psychic, r.team + (ownTurns[r.team]++ % 2 + 1));
        assert.deepEqual(Object.keys(r.defense).sort(), [WL.other(r.team) + '1', WL.other(r.team) + '2']);
        assert.notEqual(r.guesser, r.psychic);
        assert.equal(r.guesser[0], r.team);
        assert.deepEqual(g.cardChoices, r.candidates);
        apply(g, 'selectCard', { index: r.selection.index });
        assert.deepEqual(g.target, r.targetRaw);
        assert.deepEqual(WL.cardSides(g.card)[0], r.pair);
        apply(g, 'donePsychic');
        apply(g, 'setDial', { value: WL.fromSignedPercent(r.dial.dial) });
        apply(g, 'lock', { timerSeconds: 0 });
        apply(g, 'guess', { guess: r.opponentSide });
        apply(g, 'reveal');
        assert.equal(g.reveal.pts, r.pts);
        assert.equal(g.reveal.oppPts, r.oppPts);
        assert.equal(g.teams.A.score, r.scoreAfter.A);
        assert.equal(g.teams.B.score, r.scoreAfter.B);
        assert.equal(g.catchup, r.catchup);
        assert.equal(r.catchup, false);
        assert.equal(r.targetRaw.dist, "recommended");
        assert.equal(r.targetRaw.w4, 48 * 0.4);
        assert.equal(r.team, r.round % 2 ? match.first : WL.other(match.first));
        assert.deepEqual(g.result, r.resultAfter);
        assert.deepEqual(g.sdPts, r.suddenPointsAfter);
        count++;
        if (g.phase !== 'over') apply(g, 'nextRound');
      }
      if (match.result) {
        assert.equal(g.phase, 'over');
        assert(match.rounds.length >= 4 && match.rounds.length <= 8);
        assert.equal(match.rounds.length % 2, 0);
        assert.equal(new Set(match.rounds.map(r => r.psychic)).size, 4);
        assert(match.rounds.filter(r => r.sudden).length <= 2);
      }
    } finally { Math.random = original; }
  }
  if (session.stage === 'complete') {
    assert.equal(session.matches.length, 5);
    for (const m of session.matches) assert.deepEqual(Object.keys(m.feedback).sort(), ['A1', 'A2', 'B1', 'B2']);
    assert.equal(session.actions.length, count * 5 + 20);
  }
  return count;
}

function widthScore(r,width) {
  const d=Math.abs(r.targetRaw.center-WL.fromSignedPercent(r.dial.dial));
  const w4=width*.4,w3=w4+width,w2=w3+width*1.1;
  const pts=d<=w4?4:d<=w3?3:d<=w2?2:0;
  const oppPts=pts<4 && r.target!==r.dial.dial && (r.target<r.dial.dial?'L':'R')===r.opponentSide?1:0;
  return {pts,oppPts};
}
const scoreKeys=['fun','fairness','pace','agency'];
function summarize(s) {
  const rs=s.matches.flatMap(m=>m.rounds),fs=s.matches.flatMap(m=>Object.values(m.feedback));
  return {
    games:s.matches.length,rounds:rs.length,meanTurns:rounded(mean(s.matches.map(m=>m.rounds.length))),
    medianTurns:quantile(s.matches.map(m=>m.rounds.length),.5),maxTurns:Math.max(...s.matches.map(m=>m.rounds.length)),
    completedGames:s.matches.filter(m=>m.result).length,
    wins:{A:s.matches.filter(m=>m.result?.winner==='A').length,B:s.matches.filter(m=>m.result?.winner==='B').length,draws:s.matches.filter(m=>m.result?.draw).length},
    unequalOpportunityGames:s.matches.filter(m=>m.rounds.filter(r=>r.team==='A').length!==m.rounds.filter(r=>r.team==='B').length).length,
    overtimeTurns:rs.filter(r=>r.sudden).length,...metrics(rs),
    feedback:Object.fromEntries(scoreKeys.map(k=>[k,rounded(mean(fs.map(f=>f[k])))])),
    feedbackByOutcome:Object.fromEntries(['won','lost','draw'].map(outcome=>{
      const entries=s.matches.flatMap(m=>Object.entries(m.feedback).filter(([p])=>(m.result?.draw?'draw':m.result?.winner===p[0]?'won':'lost')===outcome).map(([,f])=>f));
      return [outcome,{n:entries.length,...Object.fromEntries(scoreKeys.map(k=>[k,rounded(mean(entries.map(f=>f[k])))]))}];
    })),
    players:Object.fromEntries(['A1','A2','B1','B2'].map(p=>[p,{psychicTurns:rs.filter(r=>r.psychic===p).length,...Object.fromEntries(scoreKeys.map(k=>[k,rounded(mean(s.matches.filter(m=>m.feedback[p]).map(m=>m.feedback[p][k])))]))}])),
    teams:Object.fromEntries(['A','B'].map(t=>[t,metrics(rs.filter(r=>r.team===t))])),
    targetRegions:{center:metrics(rs.filter(r=>Math.abs(r.target)<=20)),middle:metrics(rs.filter(r=>Math.abs(r.target)>20&&Math.abs(r.target)<70)),ends:metrics(rs.filter(r=>Math.abs(r.target)>=70))},
    matches:s.matches.map(m=>({game:m.game,first:m.first,turns:m.rounds.length,score:m.score,result:m.result,ownTurns:{A:m.rounds.filter(r=>r.team==='A').length,B:m.rounds.filter(r=>r.team==='B').length},overtimePoints:m.result?.sudden?m.rounds.at(-1).suddenPointsAfter:null,...metrics(m.rounds),feedback:Object.fromEntries(scoreKeys.map(k=>[k,rounded(mean(Object.values(m.feedback).map(f=>f[k])))]))}))
  };
}
const replayedRounds=validate();
const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'../2026-10-13-astra-high/session.json')));
assert.equal(session.deckSha256,baseline.deckSha256);
const report={generatedAt:new Date().toISOString(),complete:session.stage==='complete',replayedRounds,
  baseline:summarize(baseline),candidate:summarize(session),
  widthCounterfactual:{note:'Identical candidate observations rescored; no new guesses or games, and no inference of alternate winners.',
    widths:[40,44,48,50].map(width=>({width,meanPoints:rounded(mean(rounds.map(r=>widthScore(r,width).pts))),zeroTurns:rounds.filter(r=>widthScore(r,width).pts===0).length,perfectTurns:rounds.filter(r=>widthScore(r,width).pts===4).length})),
    changedRounds:rounds.filter(r=>widthScore(r,40).pts!==r.pts).map(r=>({game:r.game,round:r.round,clue:r.clue.clue,error:r.error,at40:widthScore(r,40),at48:{pts:r.pts,oppPts:r.oppPts}}))},
  boundaryCases:session.matches.flatMap(m=>m.rounds.filter(r=>!r.sudden && r.round%2 && Math.max(r.scoreAfter.A,r.scoreAfter.B)>=8).map(r=>({game:m.game,round:r.round,score:r.scoreAfter,ultimately:m.result,finalScore:m.score}))),
  catchupOpportunities:rounds.filter(r=>!r.sudden&&r.pts===4&&r.scoreAfter[r.team]<r.scoreAfter[WL.other(r.team)]).map(r=>({game:r.game,round:r.round,team:r.team,score:r.scoreAfter})),
  zeroRounds:rounds.filter(r=>r.pts===0).map(r=>({game:r.game,round:r.round,pair:r.pair,clue:r.clue.clue,target:r.target,dial:r.dial.dial,error:r.error,clueReason:r.clue.reason,dialReason:r.dial.reason})),
  repeatedReferences:rounds.flatMap(r=>{
    const prior=baseline.matches.flatMap(m=>m.rounds).filter(b=>JSON.stringify(b.pair)===JSON.stringify(r.pair)&&b.clue.clue===r.clue.clue);
    return prior.length?[{game:r.game,round:r.round,pair:r.pair,clue:r.clue.clue,target:r.target,dial:r.dial.dial,error:r.error,prior:prior.map(b=>({game:b.game,round:b.round,target:b.target,dial:b.dial.dial,error:b.error}))}]:[];
  }),
  feedback:session.matches.map(m=>({game:m.game,players:m.feedback})),
  limitations:['Five games per condition; same players continue learning; new topics/targets; order not randomized; multiple parameters change together.','Model self-reports are not human experience ratings. No browser/time-to-play study.','Information isolation relies on task discipline and redacted interfaces, not OS boundaries.']};
report.change={meanTurns:rounded(report.candidate.meanTurns-report.baseline.meanTurns),relativeTurns:rounded(report.candidate.meanTurns/report.baseline.meanTurns-1),feedback:Object.fromEntries(scoreKeys.map(k=>[k,rounded(report.candidate.feedback[k]-report.baseline.feedback[k])]))};
fs.writeFileSync(path.join(__dirname,'analysis.json'),JSON.stringify(report,null,2)+'\n');
const csv=[['game','round','team','psychic','guesser','left','right','clue','target_signed','dial_signed','absolute_error','points','opponent_side','opponent_points','score_A','score_B','overtime','overtime_A','overtime_B']];
for(const r of rounds)csv.push([r.game,r.round,r.team,r.psychic,r.guesser,...r.pair,r.clue.clue,r.target,r.dial.dial,r.error,r.pts,r.opponentSide,r.oppPts,r.scoreAfter.A,r.scoreAfter.B,r.sudden,r.suddenPointsAfter.A,r.suddenPointsAfter.B]);
fs.writeFileSync(path.join(__dirname,'rounds.csv'),'\uFEFF'+csv.map(row=>row.map(x=>'"'+String(x).replaceAll('"','""')+'"').join(',')).join('\n')+'\n');
console.log(JSON.stringify({complete:report.complete,replayedRounds,baseline:report.baseline,candidate:report.candidate,change:report.change,widthCounterfactual:report.widthCounterfactual,boundaryCases:report.boundaryCases},null,2));
