"use strict";
const fs = require('node:fs');
const path = require('node:path');
const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'session.json')));
const esc = x => String(x ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const pct = x => (x > 0 ? '+' : '') + x;
const pair = x => x.join(' ↔ ');
const out = ['# 五局逐轮完整记录', '', '坐标统一为左 −100、右 +100。每轮是一个队伍出题一次。所有选择与判断来自四名固定 astra/high 玩家，计分来自项目原游戏引擎。出题人的目标与解释仅在揭晓后进入本报告。', '', `状态：${s.stage === 'complete' ? '五局已完成' : '进行中'}。`, ''];
for (const m of s.matches) {
  for (let i = 0; i < m.rounds.length; i++) {
    const r = m.rounds[i];
    if (!r.sudden) continue;
    const before = i && m.rounds[i - 1].sudden ? m.rounds[i - 1].suddenPointsAfter : { A: 0, B: 0 };
    r.pairPointsAtReveal = { ...before };
    r.pairPointsAtReveal[r.team] += r.pts;
    r.pairPointsAtReveal[r.team === 'A' ? 'B' : 'A'] += r.oppPts;
  }
  const last = m.rounds.at(-1);
  out.push(`## 第 ${m.game} 局`, '', `先手 ${m.first}；${m.rounds.length} 轮；${m.result ? `胜方 ${m.result.winner}，比分 A ${m.score.A} : ${m.score.B} B${m.result.sudden ? `，最后一对加时 A ${last.pairPointsAtReveal.A} : ${last.pairPointsAtReveal.B} B 决胜` : ''}。` : '尚未结束。'}`, '', '| 轮 | 出题→猜题 | 题面 | 角色 | 目标 | 拨杆 | 误差 | 主动得分 | 对手左右/得分 | 比分A:B |', '|---:|---|---|---|---:|---:|---:|---:|---|---|');
  for (const r of m.rounds) out.push(`| ${r.round}${r.sudden ? '加时' : ''} | ${r.psychic}→${r.guesser} | ${esc(pair(r.pair))} | ${esc(r.clue.clue)} | ${pct(r.target)} | ${pct(r.dial.dial)} | ${r.error} | ${r.pts} | ${r.opponentSide === 'L' ? '左' : '右'} / ${r.oppPts} | ${r.scoreAfter.A}:${r.scoreAfter.B}${r.catchup ? '（追赶）' : ''} |`);
  out.push('');
  for (const r of m.rounds) {
    out.push(`### 第 ${r.round} 轮：${r.psychic} 出题`, '', `- 候选题：${r.candidates.map((c, i) => `${i + 1}. ${pair(c)}`).join('；')}。选第 ${r.selection.index + 1} 题：${r.selection.reason}`, `- 私密目标：${pct(r.target)}；分布 ${r.targetRaw.dist}。线索：**${r.clue.clue}**。出题难度 ${r.clue.difficulty}/5，信心 ${r.clue.confidence}。`, `- 出题者事后可公开的理由：${r.clue.reason}`, `- ${r.guesser} 猜 ${pct(r.dial.dial)}，信心 ${r.dial.confidence}：${r.dial.reason}`);
    for (const [p, d] of Object.entries(r.defense).sort()) out.push(`- ${p} 防守估计 ${pct(d.estimate)}，猜${d.side === 'L' ? '左' : '右'}，信心 ${d.confidence}：${d.reason}`);
    out.push(`- 合议：估计均值 ${pct(r.opponentEstimate)}，最终猜${r.opponentSide === 'L' ? '左' : '右'}。主动队 +${r.pts}，对手 +${r.oppPts}；比分 ${r.scoreBefore.A}:${r.scoreBefore.B} → ${r.scoreAfter.A}:${r.scoreAfter.B}。${r.catchup ? '触发追赶，下轮同队换人出题。' : ''}${r.sudden ? `本对加时累计 A ${r.pairPointsAtReveal.A} : ${r.pairPointsAtReveal.B} B（主比分不变）。` : ''}`, '');
  }
  if (Object.keys(m.feedback).length) {
    out.push('### 本局四人反馈', '', '评分1差至5好；为代理自评，不是真人问卷。', '', '| 玩家 | 有趣 | 公平 | 节奏 | 参与感 |', '|---|---:|---:|---:|---:|');
    for (const [p, f] of Object.entries(m.feedback).sort()) out.push(`| ${p} | ${f.fun} | ${f.fairness} | ${f.pace} | ${f.agency} |`);
    out.push('');
    for (const [p, f] of Object.entries(m.feedback).sort()) {
      out.push(`**${p}**`, '', `- 挫折：${Array.isArray(f.frustrations) ? f.frustrations.join('；') : f.frustrations}`, `- 学到：${f.learned}`, `- 建议：${f.proposal}`, '');
      if (f.overall) out.push('五局综合建议：', '', '```json', JSON.stringify(f.overall, null, 2), '```', '');
    }
  }
}
fs.writeFileSync(path.join(__dirname, 'round-log.md'), out.join('\n') + '\n');
console.log(`Rendered ${s.matches.length} games / ${s.matches.reduce((n,m) => n + m.rounds.length, 0)} rounds.`);
