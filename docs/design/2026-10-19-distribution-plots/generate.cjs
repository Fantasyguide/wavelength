"use strict";

// Generates an offline ECharts report using the production density parameters.
// No Python environment or package installation is required.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "../../..");
const W = require(path.join(ROOT, "game.js"));
const echartsDir = process.env.ECHARTS_DIR || path.dirname(require.resolve("echarts/package.json"));
const vendor = fs.readFileSync(path.join(echartsDir, "dist/echarts.min.js"), "utf8");
const font = fs.readFileSync(path.join(ROOT, "assets/fantasyguide/FZYaShiHei-Medium.woff2")).toString("base64");

function modelFactory(pr) {
  const threshold = 70;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function integral(a) {
    const J = t => t * t * t - t * t * t * t / 2;
    if (a <= pr.U) {
      const t = a / pr.U;
      return pr.U * (pr.M * t + (pr.V - pr.M) * J(t));
    }
    const t = (a - pr.U) / (.5 - pr.U);
    return pr.U * (pr.M + pr.V) / 2 + (.5 - pr.U) * (pr.V * t + (pr.E - pr.V) * J(t));
  }
  const halfMass = integral(.5);
  const cdf = u => .5 + (u < 0 ? -1 : 1) * integral(Math.abs(clamp(u, -.5, .5))) / (2 * halfMass);
  const positions = Array.from({ length: 1001 }, (_, c) => {
    const lo = Math.max(-.5, (c - .5 - 500) / 1000);
    const hi = Math.min(.5, (c + .5 - 500) / 1000);
    const x = Math.round((c / 5 - 100) * 10) / 10;
    const probability = cdf(hi) - cdf(lo);
    return { x, probability, density: probability / ((hi - lo) * 200) * 100, easy: Math.abs(x) > threshold };
  });
  const p0 = positions.reduce((s, p) => s + (p.easy ? p.probability : 0), 0);
  function target(history, strength = .6, lower = .1, upper = .9) {
    const easy = [...history].filter(c => c === "E").length;
    const debt = history.length * p0 - easy;
    return { easy, hard: history.length - easy, debt, q: clamp(p0 + strength * debt, lower, upper) };
  }
  function acceptance(q) {
    const scale = Math.max(q / p0, (1 - q) / (1 - p0));
    return { easy: q / p0 / scale, hard: (1 - q) / (1 - p0) / scale, meanDraws: scale, rate: 1 / scale };
  }
  function density(q = p0) {
    return positions.map(p => [p.x, p.density * (p.easy ? q / p0 : (1 - q) / (1 - p0))]);
  }
  function sequenceStats(n, strength, lower = .1, upper = .9) {
    let states = [{ history: "", probability: 1 }];
    let prediction = 0;
    for (let step = 0; step < n; step++) {
      prediction = 0;
      states = states.flatMap(s => {
        const q = target(s.history, strength, lower, upper).q;
        prediction += s.probability * Math.max(q, 1 - q);
        return [{ history: s.history + "E", probability: s.probability * q },
          { history: s.history + "H", probability: s.probability * (1 - q) }];
      });
    }
    const counts = Array(n + 1).fill(0);
    for (const s of states) counts[[...s.history].filter(c => c === "E").length] += s.probability;
    let gap2 = 0, equal = 0;
    for (let a = 0; a <= n; a++) for (let b = 0; b <= n; b++) {
      if (Math.abs(a - b) >= 2) gap2 += counts[a] * counts[b];
      if (a === b) equal += counts[a] * counts[b];
    }
    return { n, strength, lower, upper, counts, gap2, equal, prediction,
      meanEasy: counts.reduce((s, p, count) => s + p * count, 0) / n };
  }
  return { pr, p0, threshold, positions, target, acceptance, density, sequenceStats };
}

function chartFactory(modelFactory, baseParameters) {
  const model = modelFactory(baseParameters);
  const C = { ink: "#26374a", gray: "#7b8797", blue: "#3d78c5", teal: "#078f85", amber: "#d88929", purple: "#9b5eb4", red: "#cc5b62" };
  const palette = [C.ink, C.blue, C.teal, C.amber];
  const pct = (v, digits = 1) => (v * 100).toFixed(digits) + "%";
  const histories = ["", "H", "E", "HH", "HE", "EE", "HHH", "HHE", "HEE", "EEE"];
  const historyLabel = h => h ? [...h].map(c => c === "H" ? "难" : "易").join(" · ") : "尚未出题";
  const strengths = [0, .3, .6, .9];
  const caps = [[.05, .95], [.1, .9], [.2, .8]];
  const capNames = ["5%—95%", "10%—90%", "20%—80%"];
  function base(title, subtitle, height) {
    return { width: 1600, height, option: { animation: false, backgroundColor: "#ffffff",
      textStyle: { fontFamily: "PlotCN, sans-serif", fontSize: 18, color: C.ink },
      title: [{ text: title, subtext: subtitle, left: 34, top: 22,
        textStyle: { fontSize: 30, fontWeight: "normal", color: C.ink },
        subtextStyle: { fontSize: 18, lineHeight: 28, color: "#64748b" } }],
      tooltip: { trigger: "axis", confine: true },
      grid: [], xAxis: [], yAxis: [], series: [], legend: [],
      graphic: [{ type: "text", left: 36, bottom: 18, style: { text: "Wavelength · 参数分析 · 2026-10-19   |   精确积分与序列枚举；不代表对局胜率", font: "16px PlotCN", fill: "#7b8797" } }]
    } };
  }
  function panel(o, rect, title, xmin, xmax, ymin, ymax, xname, yname) {
    const i = o.grid.length;
    o.grid.push({ left: rect[0], top: rect[1], width: rect[2], height: rect[3] });
    o.title.push({ text: title, left: rect[0], top: rect[1] - 76,
      textStyle: { fontSize: 21, fontWeight: "normal", color: C.ink } });
    o.xAxis.push({ type: "value", gridIndex: i, min: xmin, max: xmax, name: xname,
      nameLocation: "middle", nameGap: 36, nameTextStyle: { fontSize: 17 },
      axisLine: { lineStyle: { color: "#a6b1bf" } }, axisTick: { show: false },
      axisLabel: { fontSize: 16 }, splitLine: { show: false } });
    o.yAxis.push({ type: "value", gridIndex: i, min: ymin, max: ymax, name: yname,
      nameLocation: "middle", nameRotate: 90, nameGap: 55, nameTextStyle: { fontSize: 16, align: "center" },
      axisLine: { show: false, onZero: false }, axisTick: { show: false },
      axisLabel: { fontSize: 16 }, splitLine: { lineStyle: { color: "#e9eef3" } } });
    return i;
  }
  function line(o, i, name, data, color, extra = {}) {
    o.series.push({ type: "line", name, xAxisIndex: i, yAxisIndex: i, data, showSymbol: false,
      lineStyle: { width: 3, color }, itemStyle: { color }, emphasis: { focus: "series" }, ...extra });
  }
  function legend(o, names, left, top) {
    o.legend.push({ data: names, left, top, itemWidth: 28, itemGap: 24, textStyle: { fontSize: 16 } });
  }
  function region(o, seriesIndex) {
    o.series[seriesIndex].markArea = { silent: true, label: { show: false }, data: [
      [{ xAxis: -100, itemStyle: { color: "rgba(216,137,41,0.10)" } }, { xAxis: -70 }],
      [{ xAxis: -70, itemStyle: { color: "rgba(61,120,197,0.055)" } }, { xAxis: 70 }],
      [{ xAxis: 70, itemStyle: { color: "rgba(216,137,41,0.10)" } }, { xAxis: 100 }]
    ] };
    o.series[seriesIndex].markLine = { silent: true, symbol: "none", label: { show: false },
      lineStyle: { color: C.amber, width: 1.5, type: "dashed" }, data: [{ xAxis: -70 }, { xAxis: 70 }] };
  }
  function note(o, text, left, top) {
    o.graphic.push({ type: "text", left, top, style: { text, font: "18px PlotCN", fill: C.ink, lineHeight: 28 } });
  }
  function original() {
    const chart = base("01  原始推荐分布：±70% 划分保留", "参数 M=0.9、E=1.5、V=0.5、U=0.16  ·  易区为 |目标中心| > 70%；边界计入难区", 1040), o = chart.option;
    const a = panel(o, [100, 212, 1405, 338], "目标位置的概率密度", -100, 100, 0, 1, "目标位置（%）", "概率密度（% / 刻度百分点）");
    line(o, a, "推荐分布", model.density(), C.ink); region(o, 0);
    legend(o, ["推荐分布"], 102, 166);
    note(o, "易区（左端） " + pct(model.p0 / 2, 2), 120, 235);
    note(o, "难区（中间） " + pct(1 - model.p0, 2), 650, 235);
    note(o, "易区（右端） " + pct(model.p0 / 2, 2), 1240, 235);
    const b = panel(o, [100, 721, 1405, 213], "阈值越靠外，被归为易题的目标就越少", 0, 100, 0, 100, "难易分界的绝对值（%）", "两端区域合计概率（%）");
    const tail = Array.from({ length: 501 }, (_, k) => {
      const threshold = k / 5;
      return [threshold, model.positions.reduce((s, p) => s + (Math.abs(p.x) > threshold + 1e-8 ? p.probability : 0), 0) * 100];
    });
    line(o, b, "两端概率", tail, C.teal, { markLine: { silent: true, symbol: "none", label: { show: false },
      data: [{ xAxis: 70 }, { yAxis: 50 }], lineStyle: { color: C.gray, type: "dashed" } } });
    note(o, "当前 70%：易 " + pct(model.p0, 2) + " / 难 " + pct(1 - model.p0, 2) + "；概率对半的边界约为 65.4%。", 790, 644);
    return chart;
  }
  function rawParameters() {
    const chart = base("02  原分布参数：每次只改变一项", "所有曲线均独立归一化；图例给出 ±70% 外的实际易区比例。黑色粗线为当前推荐参数。", 1160), o = chart.option;
    const defs = [
      ["M", "M：中心权重", [.6, .9, 1.2]], ["E", "E：端部权重", [1.1, 1.5, 1.9]],
      ["V", "V：谷底权重", [.3, .5, .7]], ["U", "U：谷底位置（刻度绝对值 = 200U）", [.12, .16, .20]]
    ];
    defs.forEach(([key, title, values], j) => {
      const left = j % 2 ? 900 : 100, top = j < 2 ? 230 : 770;
      const i = panel(o, [left, top, 610, 300], title, -100, 100, 0, 1.15, "目标位置（%）", "密度（% / 刻度百分点）");
      const names = [];
      values.forEach((value, k) => {
        const m = modelFactory({ ...baseParameters, [key]: value });
        const name = key + "=" + value.toFixed(2) + " · 易" + pct(m.p0);
        names.push(name);
        const current = Math.abs(value - baseParameters[key]) < 1e-8;
        line(o, i, name, m.density(), current ? C.ink : k === 0 ? C.blue : C.amber,
          { lineStyle: { width: current ? 4 : 2.5, color: current ? C.ink : k === 0 ? C.blue : C.amber } });
      });
      legend(o, names, left - 8, top - 42);
      region(o, o.series.length - 2);
    });
    return chart;
  }
  function compensation() {
    const chart = base("03  累计历史：补偿强度如何改变下一题", "p₀ = " + pct(model.p0, 2) + "；易题缺口 D = 已出题数 × p₀ − 实际易题数；q = clip(p₀ + λD, 10%, 90%)", 1160), o = chart.option;
    const a = panel(o, [110, 214, 1380, 280], "正缺口表示之前易题偏少；负缺口表示之前易题偏多", -2, 2, 0, 100, "累计易题缺口 D（题）", "下一题易区概率 q（%）");
    const names = [];
    strengths.forEach((s, k) => {
      const name = "λ=" + s.toFixed(1); names.push(name);
      line(o, a, name, Array.from({ length: 161 }, (_, j) => {
        const d = -2 + j / 40;
        return [d, Math.min(.9, Math.max(.1, model.p0 + s * d)) * 100];
      }), palette[k]);
    });
    legend(o, names, 110, 166);
    const i = panel(o, [220, 695, 1170, 360], "同一累计历史下的实际概率（顺序不影响累计缺口）", 0, 1, 0, 1, "补偿强度 λ", "本队已完成历史");
    o.xAxis[i] = { type: "category", gridIndex: i, data: strengths.map(s => "λ=" + s.toFixed(1)), position: "top", axisTick: { show: false }, axisLine: { show: false }, axisLabel: { fontSize: 18 } };
    o.yAxis[i] = { type: "category", gridIndex: i, data: histories.map(historyLabel), inverse: true, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { fontSize: 18, margin: 18 } };
    const data = histories.flatMap((h, y) => strengths.map((s, x) => [x, y, model.target(h, s).q * 100]));
    o.series.push({ type: "heatmap", xAxisIndex: i, yAxisIndex: i, data,
      label: { show: true, formatter: p => p.value[2].toFixed(1) + "%", fontSize: 19, color: "#172b3c" }, itemStyle: { borderColor: "white", borderWidth: 3 } });
    o.visualMap = { type: "continuous", min: 0, max: 100, seriesIndex: o.series.length - 1, right: 28, top: 695, itemHeight: 305,
      text: ["偏易", "偏难"], inRange: { color: ["#a8c7ed", "#f7f8f4", "#e7b56f"] }, calculable: false, textStyle: { fontSize: 16 } };
    return chart;
  }
  function rejection() {
    const chart = base("04  先按推荐分布抽，再按位置接受或拒绝", "接受概率 ≠ 最终易题概率。以下按原始易题占比 " + pct(model.p0, 2) + " 精确换算；拒绝后重抽，历史保持不变。", 1160), o = chart.option;
    const qs = [.2, model.p0, .8], colors = [C.blue, C.ink, C.amber];
    const labels = qs.map(q => "最终易 " + pct(q, q === model.p0 ? 2 : 0));
    const a = panel(o, [100, 230, 610, 300], "过滤后的最终目标分布", -100, 100, 0, 1.7, "目标位置（%）", "密度（% / 刻度百分点）");
    qs.forEach((q, k) => line(o, a, labels[k], model.density(q), colors[k]));
    region(o, 1); legend(o, labels, 90, 184);
    const b = panel(o, [900, 230, 610, 300], "实现目标比例所需的接受概率", 0, 100, 0, 105, "希望最终达到的易题概率 q（%）", "候选位置接受概率（%）");
    const scan = Array.from({ length: 181 }, (_, j) => .05 + j / 200);
    line(o, b, "易区候选", scan.map(q => [q * 100, model.acceptance(q).easy * 100]), C.amber);
    line(o, b, "难区候选", scan.map(q => [q * 100, model.acceptance(q).hard * 100]), C.blue);
    legend(o, ["易区候选", "难区候选"], 900, 184);
    const c = panel(o, [100, 770, 610, 300], "实际接受函数：同一区域使用相同接受率", -100, 100, 0, 110, "候选目标位置（%）", "接受概率（%）");
    o.title[o.title.length - 1].top = 652;
    qs.forEach((q, k) => {
      const accept = model.acceptance(q);
      const name = labels[k] + " 的接受率";
      line(o, c, name, model.positions.map(p => [p.x, (p.easy ? accept.easy : accept.hard) * 100]), colors[k]);
    });
    region(o, 5);
    note(o, "目标易80%：接受全部易区，接受" + pct(model.acceptance(.8).hard) + "的难区候选。", 102, 704);
    const d = panel(o, [900, 770, 610, 300], "每个最终目标平均需要多少个推荐候选", 0, 100, 0, 2.5, "最终易题概率 q（%）", "平均候选数（次）");
    o.title[o.title.length - 1].top = 652;
    line(o, d, "平均候选数", scan.map(q => [q * 100, model.acceptance(q).meanDraws]), C.teal);
    note(o, "q=p₀ 时全部接受；q=90% 时平均 " + model.acceptance(.9).meanDraws.toFixed(2) + " 次。", 900, 704);
    return chart;
  }
  function fairness() {
    const chart = base("05  补偿强度与上下限：均衡、可预测性和比例偏移", "固定每队出题次数，精确枚举全部难易序列。两队独立；不模拟得分、胜负或提前结束。", 1160), o = chart.option;
    legend(o, capNames.map(n => "上下限 " + n), 365, 117);
    const defs = [
      ["双方各2题：一队全易、另一队全难", 0, 15, (s, cap) => model.sequenceStats(2, s, ...cap).gap2 * 100, "发生概率（%）"],
      ["双方各3题：易题数相差至少2题", 0, 25, (s, cap) => model.sequenceStats(3, s, ...cap).gap2 * 100, "发生概率（%）"],
      ["仅看历史，预测第3题难易的最优正确率", 50, 95, (s, cap) => model.sequenceStats(3, s, ...cap).prediction * 100, "难易分类正确率（%）"],
      ["单队前三题的平均易题占比", 42, 50, (s, cap) => model.sequenceStats(3, s, ...cap).meanEasy * 100, "易题比例（%）"]
    ];
    defs.forEach(([title, ymin, ymax, metric, ylabel], j) => {
      const left = j % 2 ? 900 : 100, top = j < 2 ? 252 : 770;
      const i = panel(o, [left, top, 610, 300], title, 0, 1, ymin, ymax, "补偿强度 λ", ylabel);
      if (j >= 2) o.title[o.title.length - 1].top = 652;
      caps.forEach((cap, k) => line(o, i, "上下限 " + capNames[k],
        Array.from({ length: 51 }, (_, n) => [n / 50, metric(n / 50, cap)]), [C.blue, C.teal, C.amber][k]));
    });
    note(o, "注意：可预测的是难易档位，不是左右或具体位置。", 102, 704);
    note(o, "上下限可能使实际均值轻微偏离基准 " + pct(model.p0, 2) + "。", 900, 704);
    return chart;
  }
  function interactive(history, strength, lower, upper) {
    const state = model.target(history, strength, lower, upper), accepted = model.acceptance(state.q);
    const chart = base("当前历史下，最终目标会如何分布", historyLabel(history) + "；λ=" + strength.toFixed(2) + "；上下限 " + pct(lower, 0) + "—" + pct(upper, 0), 650), o = chart.option;
    const i = panel(o, [100, 218, 1405, 325], "累计缺口 " + state.debt.toFixed(3) + " 题 → 下一题易区 " + pct(state.q, 2), -100, 100, 0, 1.9, "目标位置（%）", "概率密度（% / 刻度百分点）");
    line(o, i, "原始推荐", model.density(), C.ink, { lineStyle: { width: 2.5, type: "dashed", color: C.ink } });
    line(o, i, "当前补偿", model.density(state.q), C.teal); region(o, 0);
    legend(o, ["原始推荐", "当前补偿"], 100, 174);
    return { ...chart, state, accepted };
  }
  return { model, pct, historyLabel, interactive, figures: {
    "01-original": original(), "02-raw-parameters": rawParameters(), "03-history-strength": compensation(),
    "04-rejection-sampling": rejection(), "05-fairness-tradeoffs": fairness()
  } };
}

const pr = { ...W.DIST_PRESETS.recommended };
const model = modelFactory(pr);
const close = (a, b, label) => assert(Math.abs(a - b) < 1e-10, label + ": " + a + " / " + b);
// Simpson integration is exact on each cubic piece of the production density.
function productionMass(lo, hi, parameters) {
  const cuts = [lo, ...[-parameters.U, 0, parameters.U].filter(x => x > lo && x < hi), hi];
  return cuts.slice(1).reduce((sum, b, i) => {
    const a = cuts[i], f = u => W.distDensity(parameters, u);
    return sum + (b - a) / 6 * (f(a) + 4 * f((a + b) / 2) + f(b));
  }, 0);
}
const totalMass = productionMass(-.5, .5, pr);
for (let c = 0; c <= 1000; c++) {
  const lo = Math.max(-.5, (c - .5 - 500) / 1000);
  const hi = Math.min(.5, (c + .5 - 500) / 1000);
  close(model.positions[c].probability, productionMass(lo, hi, pr) / totalMass, "production density bin " + c);
}
close(model.positions.reduce((s, p) => s + p.probability, 0), 1, "probability mass");
for (let c = 0; c <= 1000; c++) close(model.positions[c].probability, model.positions[1000 - c].probability, "symmetry");
for (const q of [.05, .1, .2, model.p0, .5, .8, .9, .95]) {
  const a = model.acceptance(q);
  close(model.p0 * a.easy / (model.p0 * a.easy + (1 - model.p0) * a.hard), q, "accepted mass");
  assert(a.easy <= 1 + 1e-12 && a.hard <= 1 + 1e-12);
}
close(model.target("HHE").q, model.target("EHH").q, "history order");
close(model.target("").q, model.p0, "empty history baseline");
const rows = [];
for (const strength of [0, .3, .6, .9]) for (const cap of [[.05, .95], [.1, .9], [.2, .8]]) for (const n of [2, 3, 4]) {
  const r = model.sequenceStats(n, strength, ...cap);
  close(r.counts.reduce((s, p) => s + p, 0), 1, "history probability mass");
  rows.push(r);
}
const analysis = { generatedFor: "2026-10-19", parameters: pr, threshold: 70,
  quantizationStep: .2, p0: model.p0, proposal: "D = n*p0 - easyCount; q = clip(p0 + strength*D, lower, upper)",
  note: "Proposed rejection filter; not implemented in the game. Exact fixed-length enumeration, not simulated games.",
  historyExamples: ["", "H", "E", "HH", "HE", "EE", "HHE", "HEE"].map(history => {
    const state = model.target(history); return { history, ...state, acceptance: model.acceptance(state.q) };
  }), comparisons: rows };
fs.writeFileSync(path.join(__dirname, "analysis.json"), JSON.stringify(analysis, null, 2) + "\n");
fs.writeFileSync(path.join(__dirname, "comparisons.csv"), "own_turns,strength,lower,upper,equal_easy_count,gap_at_least_two,mean_easy_share,predict_next_class\n" +
  rows.map(r => [r.n, r.strength, r.lower, r.upper, r.equal, r.gap2, r.meanEasy, r.prediction].join(",")).join("\n") + "\n");
for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(echartsDir, f), path.join(__dirname, "ECHARTS-" + f + ".txt"));
const fontCSS = "@font-face{font-family:PlotCN;src:url(data:font/woff2;base64," + font + ") format('woff2');font-weight:100 900;font-display:block;}";
const titles = { "01-original": "原始推荐分布", "02-raw-parameters": "M / E / V / U 参数", "03-history-strength": "累计历史与补偿强度", "04-rejection-sampling": "接受函数与最终分布", "05-fairness-tradeoffs": "均衡与可预测性" };
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>推荐分布与累计难度补偿</title>
<style>${fontCSS}*{box-sizing:border-box}body{margin:0;background:#eef2f6;color:#26374a;font-family:PlotCN,sans-serif}main{max-width:1680px;margin:0 auto;padding:32px}header{margin:6px 0 28px}h1{font-size:34px;font-weight:normal;margin:0 0 12px}p{line-height:1.7;margin:8px 0;color:#586a7e}a{color:#16766e}nav{display:flex;gap:18px;flex-wrap:wrap;margin-top:18px}section{background:white;border:1px solid #dce4ec;border-radius:12px;margin:24px 0;overflow:hidden}section>h2{font-weight:normal;font-size:24px;margin:24px 28px 10px}.controls{padding:24px 28px;display:flex;gap:28px;flex-wrap:wrap;background:#f9fbfd}.controls label{display:grid;gap:8px;min-width:200px}select,input{font:inherit}select{padding:9px;border:1px solid #becbda;border-radius:5px;background:white}.kpis{display:flex;gap:24px;flex-wrap:wrap;padding:18px 28px;background:#f1f8f6}.kpis>div{min-width:180px}.kpis small{display:block;color:#61758a;margin-bottom:5px}.kpis strong{font-size:25px;font-weight:normal}.figure-scroll{overflow-x:auto}.chart{width:1600px;max-width:none}.downloads{padding:10px 28px 20px;display:flex;gap:20px}.note{padding:0 28px 24px}.intro{max-width:1200px}footer{padding:20px 0 40px;color:#63748a}@media(max-width:800px){main{padding:16px}h1{font-size:27px}.controls{gap:16px}.chart{transform-origin:top left}.figure-scroll{overflow-x:auto}}</style>
<main><header><h1>保留 ±70% 划分：推荐分布与累计难度补偿</h1><p class="intro">原始易区占比 <b>${(model.p0 * 100).toFixed(2)}%</b>，难区占比 <b>${((1 - model.p0) * 100).toFixed(2)}%</b>。本页同时比较原始分布参数与历史补偿参数；λ=0 完全保留原分布。本页保留分析时的参数比较；游戏已接入历史补偿，默认强度为0.5、概率上下限为10%–90%。</p><nav>${Object.entries(titles).map(([id, title]) => `<a href="#${id}">${title}</a>`).join("")}<a href="README.md">公式与计算口径</a></nav></header>
<section><h2>交互试算：选择本队历史和补偿参数</h2><div class="controls"><label>本队已完成的难易历史<select id="history"><option value="">尚未出题</option><option value="H">难</option><option value="E">易</option><option value="HH">难 · 难</option><option value="HE">难 · 易</option><option value="EE">易 · 易</option><option value="HHH">难 · 难 · 难</option><option value="HHE" selected>难 · 难 · 易</option><option value="HEE">难 · 易 · 易</option><option value="EEE">易 · 易 · 易</option></select></label><label>补偿强度 λ：<output id="strength-value">0.60</output><input id="strength" type="range" min="0" max="1" step="0.05" value="0.6"></label><label>最终易题概率上下限<select id="caps"><option value="0.05,0.95">5% — 95%</option><option value="0.1,0.9" selected>10% — 90%</option><option value="0.2,0.8">20% — 80%</option></select></label></div><div class="kpis" id="kpis"></div><div class="figure-scroll"><div class="chart" id="interactive-chart"></div></div><p class="note">累计缺口 D = 已出题数 × 原始易题占比 − 实际易题数。这里的“预测正确率”只指难易档位，不指具体位置；所有统计均按固定出题次数计算。</p></section>
${Object.entries(titles).map(([id, title]) => `<section id="${id}"><div class="figure-scroll"><div class="chart" id="chart-${id}"></div></div><div class="downloads"><a href="${id}.png">PNG 图片</a><a href="${id}.svg">SVG 矢量图</a></div></section>`).join("")}
<footer>数据来自当前 game.js 的 recommended 参数；密度精确积分，目标取整到 0.2 个刻度百分点。保留边界 ±70% 为难区。<br>图表由 Apache ECharts 6.0.0 生成；本 HTML 内嵌字体与图表库，可离线打开。<a href="analysis.json">原始数据</a> · <a href="comparisons.csv">参数比较 CSV</a></footer></main>
<script>${vendor.replace(/<\/script/gi, "<\\/script")}</script>
<script>const modelFactory=${modelFactory.toString()};const chartFactory=${chartFactory.toString()};const baseParameters=${JSON.stringify(pr)};window.plotFontCSS=${JSON.stringify(fontCSS)};
(async function(){await document.fonts.load('18px PlotCN');await document.fonts.ready;const api=chartFactory(modelFactory,baseParameters);window.figureDefinitions=api.figures;window.plotCharts={};for(const [id,fig] of Object.entries(api.figures)){const el=document.getElementById('chart-'+id);el.style.height=fig.height+'px';const chart=echarts.init(el,null,{renderer:'svg',width:fig.width,height:fig.height});chart.setOption(fig.option);window.plotCharts[id]=chart;}const box=document.getElementById('interactive-chart');box.style.height='650px';const dynamic=echarts.init(box,null,{renderer:'svg',width:1600,height:650});function update(){const history=document.getElementById('history').value,strength=Number(document.getElementById('strength').value),caps=document.getElementById('caps').value.split(',').map(Number);document.getElementById('strength-value').textContent=strength.toFixed(2);const fig=api.interactive(history,strength,...caps);dynamic.setOption(fig.option,true);const entries=[['累计易题缺口',fig.state.debt.toFixed(3)+' 题'],['最终易区概率',api.pct(fig.state.q,2)],['易区候选接受率',api.pct(fig.accepted.easy,2)],['难区候选接受率',api.pct(fig.accepted.hard,2)],['平均推荐候选数',fig.accepted.meanDraws.toFixed(2)+' 次']];document.getElementById('kpis').innerHTML=entries.map(e=>'<div><small>'+e[0]+'</small><strong>'+e[1]+'</strong></div>').join('');window.currentCalculation={history,strength,caps,state:fig.state,accepted:fig.accepted};}for(const id of ['history','strength','caps'])document.getElementById(id).addEventListener('input',update);update();window.plotsReady=true;})();</script></html>`;
fs.writeFileSync(path.join(__dirname, "index.html"), html);
console.log(JSON.stringify({ p0: model.p0, historyExamples: analysis.historyExamples, output: __dirname }, null, 2));
