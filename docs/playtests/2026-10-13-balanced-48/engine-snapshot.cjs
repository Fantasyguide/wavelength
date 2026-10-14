(function (global) {
  "use strict";

  var BUILTIN_DECK = [
    ["热的", "冷的"], ["吸引人的", "不吸引人的"],
    ["被低估的", "被高估的"], ["怀旧的", "前卫的"],
    ["和平的", "好战的"], ["安静的", "热闹的"],
    ["安全的", "危险的"], ["放松的", "紧绷的"],
    ["脏的", "干净的"], ["低俗的", "纯洁的"],
    ["杰作", "失败之作"], ["艺术", "垃圾"],
    ["神经质的", "放松的"], ["焦虑", "佛系"],
    ["可怕的人", "善良的人"], ["反派", "英雄"],
    ["糟糕的约会", "完美的约会"], ["尴尬", "浪漫"],
    ["80年代", "90年代"], ["复古", "未来"],
    ["便宜的", "昂贵的"], ["地摊货", "奢侈品"],
    ["健康", "垃圾食品"], ["自律", "放纵"],
    ["无聊的", "有趣的"], ["工作", "假期"],
    ["聪明", "愚蠢"], ["深思熟虑", "冲动"],
    ["快", "慢"], ["急性子", "慢性子"],
    ["轻松", "困难"], ["新手", "大师"],
    ["小众", "大众"], ["地下", "主流"],
    ["经典", "现代"], ["古老", "新鲜"],
    ["神秘", "直接"], ["隐晦", "直白"],
    ["可爱", "可怕"], ["萌", "恐怖"],
    ["正式", "休闲"], ["西装革履", "睡衣派对"],
    ["理性", "感性"], ["冷静", "上头"],
    ["有品位的", "没品位的"], ["精致", "土味"],
    ["老", "新"], ["过时", "潮流"],
    ["甜的", "酸的"], ["糖果", "柠檬"],
    ["沉默的", "吵闹的"], ["安静", "喧哗"],
    ["合法的", "违法的"], ["良民", "罪犯"],
    ["自然的", "人造的"], ["原生态", "工业品"],
    ["简单", "复杂"], ["极简", "繁琐"],
    ["乐观", "悲观"], ["乐天派", "丧"],
    ["有礼貌的", "粗鲁的"], ["绅士", "熊孩子"],
    ["勇敢", "胆小"], ["壮胆", "怂"],
    ["幸运", "倒霉"], ["欧皇", "非酋"],
    ["真实的", "虚构的"], ["纪录片", "科幻片"],
    ["合理的", "离谱的"], ["靠谱", "离谱"],
    ["受欢迎的", "不受欢迎的"], ["顶流", "糊咖"],
    ["美味", "难吃"], ["米其林", "食堂"],
    ["舒适的", "难受的"], ["沙发", "早八课"],
    ["正常的", "怪异的"], ["普通人", "怪人"],
    ["严肃", "搞笑"], ["新闻联播", "综艺"],
    ["慷慨", "吝啬"], ["散财童子", "铁公鸡"],
    ["温柔", "强硬"], ["绵羊", "铁腕"],
    ["精明", "老实"], ["精算师", "老实人"],
    ["富人", "穷人"], ["暴富", "月光"],
    ["大城市", "小城镇"], ["北上广", "老家"],
    ["电影明星", "普通人"], ["顶流", "路人甲"],
    ["小孩", "老人"], ["童年", "退休"],
    ["内向", "外向"], ["社恐", "社牛"],
    ["过去", "未来"], ["考古", "预言"]
  ];

  var UNIT = 1000;
  // Experimental balanced quick-match rules; production game.js is unchanged.
  var BAND_WIDTH = 48;
  var WIN_SCORE = 8;
  var MAX_ROUNDS = 6;
  var DIST_PRESETS = {
    uniform: { M: 1, E: 1, V: 1, U: 0.16, label: "均匀" },
    mild: { M: 0.9, E: 1.2, V: 0.65, U: 0.16, label: "适中" },
    recommended: { M: 0.9, E: 1.5, V: 0.5, U: 0.16, label: "推荐" },
    strong: { M: 0.9, E: 1.8, V: 0.35, U: 0.16, label: "明显" }
  };
  var DIST_DEFAULT = "recommended";

  function distDensity(pr, u) {
    var a = Math.abs(u);
    var t = a <= pr.U ? a / pr.U : (a - pr.U) / (0.5 - pr.U);
    var s = t * t * (3 - 2 * t);
    return a <= pr.U ? pr.M + (pr.V - pr.M) * s : pr.V + (pr.E - pr.V) * s;
  }
  var DECK_NAME_DEFAULT = "内置题库";

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function cardSides(c) {
    if (Array.isArray(c[0])) return c;
    if (c.length === 4) return [[c[0], c[1]], [c[2], c[3]]];
    return [c];
  }

  function other(t) { return t === "A" ? "B" : "A"; }

  // Keep game positions in 0..1000; the public scale is -100%..+100%.
  function toSignedPercent(position) { return Math.round((position / UNIT * 200 - 100) * 10) / 10; }
  function fromSignedPercent(percent) { return Math.round((percent + 100) / 200 * UNIT * 10) / 10; }
  function formatPercent(percent) { return (percent > 0 ? "+" : "") + percent + "%"; }

  function sampleTargetX(dist) {
    var pr = DIST_PRESETS[dist] || DIST_PRESETS[DIST_DEFAULT];
    var pmax = pr.E;
    for (;;) {
      var u = Math.random() - 0.5;
      var y = Math.random() * pmax;
      if (y <= distDensity(pr, u)) return u;
    }
  }

  function targetDistForRound(round) {
    return DIST_DEFAULT;
  }

  function newTarget(s) {
    var bw = s && s.bandWidth > 0 ? s.bandWidth : BAND_WIDTH;
    var dist = s && s.round > 0 ? targetDistForRound(s.round) : (s && s.dist ? s.dist : DIST_DEFAULT);
    var u = sampleTargetX(dist);
    var c = Math.round(500 + 1000 * u);
    c = Math.max(0, Math.min(1000, c));
    // Half of the 4-point band, then one full 3-point and 2-point band.
    var w4 = bw * 0.4;
    var w3 = w4 + bw;
    return { center: c, w4: w4, w3: w3, w2: w3 + bw * 1.1, dist: dist };
  }

  function drawFromDeck(s, exclude) {
    var excluded = exclude ? JSON.stringify(exclude) : null;
    // Refill at most once; a one-topic deck still offers a playable choice.
    for (var pass = 0; pass < 2; pass++) {
      for (var i = s.deck.length - 1; i >= 0; i--) {
        if (JSON.stringify(s.deck[i]) !== excluded) return s.deck.splice(i, 1)[0];
      }
      if (pass === 0) s.deck = s.ordered ? s.cards.slice() : shuffle(s.cards.slice());
    }
    return null;
  }

  function createGame() {
    return {
      phase: "setup",
      rulesOpen: false,
      active: "A",
      first: "A",
      teams: { A: { name: "左脑", score: 0 }, B: { name: "右脑", score: 0 } },
      round: 0,
      dial: UNIT / 2,
      target: null,
      card: null,
      cardChoices: [],
      cardMode: "choice",
      side: 0,
      guess: null,
      cards: BUILTIN_DECK.slice(),
      deckName: DECK_NAME_DEFAULT,
      deck: [],
      ordered: false,
      winScore: WIN_SCORE,
      bandWidth: BAND_WIDTH,
      sudden: false,
      sdPts: { A: 0, B: 0 },
      sdTurns: { A: false, B: false },
      catchup: false,
      result: null,
      reveal: null,
      timerKind: null,
      timerEnd: null,
      log: []
    };
  }

  function startRound(s) {
    s.round++;
    drawRoundCards(s);
  }

  function drawRoundCards(s) {
    s.cardChoices = [];
    var firstCard = drawFromDeck(s);
    if (s.cardMode === "choice") {
      s.phase = "chooseCard";
      s.card = null;
      s.target = null;
      s.cardChoices.push(firstCard);
      var secondCard = drawFromDeck(s, firstCard);
      if (secondCard) s.cardChoices.push(secondCard);
    } else {
      s.phase = "psychic";
      s.card = firstCard;
      s.target = newTarget(s);
    }
    s.side = 0;
    s.dial = UNIT / 2;
    s.guess = null;
    s.reveal = null;
    s.timerKind = null;
    s.timerEnd = null;
  }

  function doSetup(s, intent) {
    s.rulesOpen = false;
    if (intent.cardMode === "choice" || intent.cardMode === "single") s.cardMode = intent.cardMode;
    s.teams.A = { name: intent.teamA || "左脑", score: 0 };
    s.teams.B = { name: intent.teamB || "右脑", score: 0 };
    s.first = intent.first === "B" ? "B" : "A";
    s.active = s.first;
    s.round = 0;
    s.sudden = false;
    s.sdPts = { A: 0, B: 0 };
    s.sdTurns = { A: false, B: false };
    s.catchup = false;
    s.result = null;
    s.reveal = null;
    s.timerKind = null;
    s.timerEnd = null;
    s.log = [];
    startRound(s);
  }

  function doNewGame(s) {
    s.rulesOpen = false;
    s.teams.A = { name: s.teams.A.name, score: 0 };
    s.teams.B = { name: s.teams.B.name, score: 0 };
    s.round = 0;
    s.sudden = false;
    s.sdPts = { A: 0, B: 0 };
    s.sdTurns = { A: false, B: false };
    s.catchup = false;
    s.result = null;
    s.reveal = null;
    s.timerKind = null;
    s.timerEnd = null;
    s.log = [];
    s.phase = "setup";
    s.card = null;
    s.cardChoices = [];
    s.target = null;
    s.side = 0;
  }

  function doReveal(s) {
    var t = s.teams[s.active], o = s.teams[other(s.active)];
    var d = s.dial, c = s.target.center;
    var diff = Math.abs(d - c);
    var pts = 0;
    if (diff <= s.target.w4) pts = 4;
    else if (diff <= s.target.w3) pts = 3;
    else if (diff <= s.target.w2) pts = 2;

    var oppPts = 0;
    var oppCorrect = null;
    if (pts < 4 && d !== c) {
      oppCorrect = d < c ? "R" : "L";
      if (s.guess === oppCorrect) oppPts = 1;
    }

    var pair = cardSides(s.card)[s.side];
    s.reveal = { pts: pts, oppPts: oppPts, oppCorrect: oppCorrect, guess: s.guess, pair: pair };
    s.catchup = false;
    s.log.unshift({
      round: s.round, team: s.active,
      targetPct: Math.round(c / UNIT * 100),
      dialPct: Math.round(s.dial / UNIT * 100),
      pair: pair, pts: pts, oppPts: oppPts,
      sudden: s.sudden
    });

    if (s.sudden) {
      s.sdPts[s.active] += pts;
      s.sdPts[other(s.active)] += oppPts;
      s.sdTurns[s.active] = true;
      if (s.sdTurns.A && s.sdTurns.B) {
        var tied = s.sdPts.A === s.sdPts.B;
        s.result = { winner: tied ? null : s.sdPts.A > s.sdPts.B ? "A" : "B", sudden: true, draw: tied };
        s.phase = "over";
        return;
      }
      s.phase = "revealed";
      return;
    }

    t.score += pts;
    o.score += oppPts;
    s.catchup = false;

    var limit = s.winScore > 0 ? s.winScore : Infinity;
    var aWon = s.teams.A.score >= limit;
    var bWon = s.teams.B.score >= limit;
    var maxRoundsReached = s.round >= MAX_ROUNDS;
    if (s.round >= 4 && s.round % 2 === 0 && (aWon || bWon || maxRoundsReached)) {
      if (s.teams.A.score === s.teams.B.score) {
        s.sudden = true;
        s.sdPts.A = 0;
        s.sdPts.B = 0;
        s.sdTurns.A = false;
        s.sdTurns.B = false;
        s.phase = "revealed";
      } else {
        s.result = {
          winner: s.teams.A.score > s.teams.B.score ? "A" : "B",
          maxRounds: maxRoundsReached && !aWon && !bWon
        };
        s.phase = "over";
      }
      return;
    }
    s.phase = "revealed";
  }

  function clampDial(v) {
    return Math.max(0, Math.min(UNIT, Math.round(v)));
  }

  function startTimer(s, kind, value, fallback) {
    var seconds = Math.floor(Number(value));
    if (isNaN(seconds)) seconds = fallback;
    seconds = Math.max(0, Math.min(60 * 60, seconds));
    s.timerKind = seconds > 0 ? kind : null;
    s.timerEnd = seconds > 0 ? Date.now() + seconds * 1000 : null;
  }

  function applyIntent(s, intent) {
    if (!intent || typeof intent.type !== "string") return s;
    switch (intent.type) {
      case "setRulesOpen":
        if (typeof intent.value === "boolean") s.rulesOpen = intent.value;
        break;
      case "setup":
        doSetup(s, intent);
        break;
      case "newGame":
        doNewGame(s);
        break;
      case "selectCard":
        if (s.phase === "chooseCard" && Number.isInteger(intent.index) &&
            intent.index >= 0 && intent.index < s.cardChoices.length) {
          s.card = s.cardChoices[intent.index];
          s.cardChoices = [];
          s.side = 0;
          s.target = newTarget(s);
          s.phase = "psychic";
        }
        break;
      case "selectSide":
        if (s.phase === "psychic" && Number.isInteger(intent.side) &&
            intent.side >= 0 && intent.side < cardSides(s.card).length) s.side = intent.side;
        break;
      case "donePsychic":
        if (s.phase === "psychic") s.phase = "dial";
        break;
      case "startDialTimer":
        if (s.phase === "psychic") startTimer(s, "dial", intent.timerSeconds, 60);
        break;
      case "setDial":
        if (s.phase === "dial") s.dial = clampDial(intent.value);
        break;
      case "lock":
        if (s.phase === "dial") {
          s.phase = "guess";
          startTimer(s, "guess", intent.timerSeconds, 15);
        }
        break;
      case "guess":
        if (s.phase === "guess" && (intent.guess === "L" || intent.guess === "R")) {
          s.guess = intent.guess;
          s.phase = "reveal";
          s.timerKind = null;
          s.timerEnd = null;
        }
        break;
      case "reveal":
        if (s.phase === "reveal") doReveal(s);
        break;
      case "nextRound":
        if (s.phase === "revealed") {
          if (!s.catchup) s.active = other(s.active);
          startRound(s);
        }
        break;
      case "loadDeck":
        if (Array.isArray(intent.cards) && intent.cards.length > 0) {
          s.cards = intent.cards;
          s.deckName = intent.name || DECK_NAME_DEFAULT;
          s.deck = [];
        }
        break;
      case "resetDeck":
        s.cards = BUILTIN_DECK.slice();
        s.deckName = DECK_NAME_DEFAULT;
        s.deck = [];
        break;
      case "skipCard":
        if (s.phase === "psychic") {
          drawRoundCards(s);
        }
        break;
      case "setCardMode":
        if (s.phase === "setup" && (intent.value === "choice" || intent.value === "single")) {
          s.cardMode = intent.value;
        }
        break;
      case "setOrdered":
        s.ordered = !!intent.value;
        break;
      case "setWinScore":
        var ws = Math.floor(Number(intent.value));
        if (isNaN(ws) || ws < 0) ws = 0;
        s.winScore = ws;
        break;
      case "setBandWidth":
        var bw = Math.floor(Number(intent.value));
        if (isNaN(bw) || bw < 2) bw = BAND_WIDTH;
        s.bandWidth = bw;
        break;
    }
    return s;
  }

  function parseYamlCards(text) {
    var out = [];
    var name = "";
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*-\s*\[(.*?)\]\s*(?:#.*)?$/);
      if (!m) {
        var nm = lines[i].match(/^\s*name\s*:\s*(.*?)\s*$/);
        if (nm) {
          name = nm[1].replace(/^["']|["']$/g, "").trim();
          continue;
        }
        var s = lines[i].replace(/#.*$/, "").trim();
        if (!s || s === "cards:" || s === "cards") continue;
        throw new Error("第 " + (i + 1) + " 行格式错误，应为：- [左, 右]");
      }
      var items = m[1].split(",").map(function (x) {
        return x.trim().replace(/^["']|["']$/g, "").trim();
      });
      if (items.length === 2) out.push(items);
      else if (items.length === 4) out.push([items[0], items[1], items[2], items[3]]);
      else throw new Error("第 " + (i + 1) + " 行应有 2 或 4 个概念");
    }
    return { cards: out, name: name };
  }

  function parseDeck(text) {
    var t = text.trim();
    var obj;
    if (t.charAt(0) === "[" || t.charAt(0) === "{") {
      obj = JSON.parse(t);
    } else {
      obj = parseYamlCards(t);
    }
    var cards, name = "";
    if (Array.isArray(obj)) {
      cards = obj;
    } else if (obj && Array.isArray(obj.cards)) {
      cards = obj.cards;
      name = obj.name || "";
    } else {
      throw new Error("未找到卡片列表：需要卡片数组或 {cards: [...]}");
    }
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var ok = Array.isArray(c) && (c.length === 2 || c.length === 4) &&
        c.every(function (x) { return typeof x === "string" && x.trim() !== ""; });
      if (!ok) throw new Error("第 " + (i + 1) + " 张卡格式错误：应为 [左, 右] 或 [左1, 右1, 左2, 右2]");
      out.push(c);
    }
    return { cards: out, name: name };
  }

  var WL = {
    BUILTIN_DECK: BUILTIN_DECK,
    UNIT: UNIT,
    BAND_WIDTH: BAND_WIDTH,
    WIN_SCORE: WIN_SCORE,
    MAX_ROUNDS: MAX_ROUNDS,
    DECK_NAME_DEFAULT: DECK_NAME_DEFAULT,
    DIST_PRESETS: DIST_PRESETS,
    DIST_DEFAULT: DIST_DEFAULT,
    distDensity: distDensity,
    sampleTargetX: sampleTargetX,
    targetDistForRound: targetDistForRound,
    newTarget: newTarget,
    createGame: createGame,
    applyIntent: applyIntent,
    parseDeck: parseDeck,
    parseYamlCards: parseYamlCards,
    cardSides: cardSides,
    shuffle: shuffle,
    clampDial: clampDial,
    toSignedPercent: toSignedPercent,
    fromSignedPercent: fromSignedPercent,
    formatPercent: formatPercent,
    other: other
  };

  if (typeof module !== "undefined" && module.exports) module.exports = WL;
  if (typeof window !== "undefined") window.WL = WL;
})(typeof window !== "undefined" ? window : globalThis);
