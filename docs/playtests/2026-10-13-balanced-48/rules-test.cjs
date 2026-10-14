'use strict';
const assert = require('node:assert/strict');
const W = require('./engine-snapshot.cjs');
const apply = (g,type,extra={}) => W.applyIntent(g,{type,...extra});
function game(first='A') { const g=W.createGame(); apply(g,'setup',{first}); return g; }
function turn(g,points,opp=0) {
  apply(g,'selectCard',{index:0});
  assert.equal(g.target.dist,'recommended');
  g.target.center=500;
  apply(g,'donePsychic');
  apply(g,'setDial',{value:500+({4:0,3:30,2:100,0:150}[points])});
  apply(g,'lock'); apply(g,'guess',{guess:opp?'L':'R'}); apply(g,'reveal');
  assert.equal(g.reveal.pts,points);
  assert.equal(g.reveal.oppPts,opp);
  assert.equal(g.catchup,false);
  return g;
}
for (const first of ['A','B']) {
  let g=game(first); assert.deepEqual([g.teams.A.score,g.teams.B.score],[0,0]);
  for(let i=1;i<=4;i++) { turn(g,i%2?4:0); assert.equal(g.phase,i===4?'over':'revealed'); if(i<4)apply(g,'nextRound'); }
  assert.equal(g.round,4); assert.equal(g.result.winner,first);
  g=game(first);
  for(let i=1;i<=8;i++) { turn(g,0); assert.equal(g.phase,i===8?'over':'revealed'); if(i<8)apply(g,'nextRound'); }
  assert.equal(g.result.draw,true); assert.equal(g.result.winner,null); assert.equal(g.round,8);
  g=game(first);
  for(let i=1;i<=6;i++) { turn(g,i<=4?4:(i===5?3:2)); if(i<6)apply(g,'nextRound'); }
  assert.equal(g.round,6); assert.equal(g.result.winner,first); assert.equal(g.result.sudden,true);
}
// Quantized scoring boundaries: 3.8/4.0, 13.4/13.6, 24.0/24.2.
for(const [offset,points] of [[19,4],[20,3],[67,3],[68,2],[120,2],[121,0]]) {
  const g=game(); apply(g,'selectCard',{index:0}); g.target.center=500;
  apply(g,'donePsychic'); apply(g,'setDial',{value:500+offset}); apply(g,'lock');
  apply(g,'guess',{guess:'R'}); apply(g,'reveal'); assert.equal(g.reveal.pts,points);
}
console.log('Passed: symmetric starts, paired end, minimum 4, regular cap 6, bounded overtime/draw, no catchup, recommended targets, width-48 boundaries.');
