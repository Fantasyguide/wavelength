(function (global) {
  "use strict";

  var samplingConfig = typeof module !== "undefined" && module.exports
    ? require("./target-sampling-config.js") : global.WLTargetSamplingConfig;
  if (!samplingConfig || typeof samplingConfig.enabled !== "boolean" ||
      !Number.isFinite(samplingConfig.easyThreshold) || samplingConfig.easyThreshold < 0 || samplingConfig.easyThreshold >= 100 ||
      !Number.isFinite(samplingConfig.strength) || samplingConfig.strength < 0 ||
      !Number.isFinite(samplingConfig.minEasyProbability) || !Number.isFinite(samplingConfig.maxEasyProbability) ||
      samplingConfig.minEasyProbability < 0 || samplingConfig.maxEasyProbability > 1 ||
      samplingConfig.minEasyProbability > samplingConfig.maxEasyProbability) {
    throw new Error("Invalid target-sampling-config.js settings");
  }
  samplingConfig = Object.freeze(Object.assign({}, samplingConfig));
  // Runtime-only history: neither settings nor sampling history enter shared game snapshots.
  var targetHistories = new WeakMap();

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
  var BAND_WIDTH = 40;
  var WIN_SCORE = 10;
  var MAX_ROUNDS = 10;
  var CHOICE_TIMER_SECONDS = 10;
  var TIMER_GRACE_MS = 1500;
  var RULE_SETS = {
    original: { label: "原版", winScore: 10, bandWidth: 40, maxRounds: 10, minRounds: 1,
      secondBonus: 1, catchup: true, pairedEnd: false, tiedOvertimeDraw: false },
    balanced: { label: "平衡快局", winScore: 8, bandWidth: 48, maxRounds: 6, minRounds: 4,
      secondBonus: 0, catchup: false, pairedEnd: true, tiedOvertimeDraw: true }
  };
  function rulesFor(s) {
    return s && s.ruleSet === "balanced" ? RULE_SETS.balanced : RULE_SETS.original;
  }

  function resetStartingScores(s) {
    s.teams.A.score = s.first === "B" ? rulesFor(s).secondBonus : 0;
    s.teams.B.score = s.first === "B" ? 0 : rulesFor(s).secondBonus;
  }

  function selectRuleSet(s, value) {
    if (value !== "original" && value !== "balanced") return;
    if (s.ruleSet !== value) {
      s.ruleSet = value;
      s.winScore = rulesFor(s).winScore;
      s.bandWidth = rulesFor(s).bandWidth;
    }
  }
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
    if (!Array.isArray(c)) c = c.concepts;
    if (Array.isArray(c[0])) return c;
    if (c.length === 4) return [[c[0], c[1]], [c[2], c[3]]];
    return [c];
  }

  function cardTag(c) { return c.tag === 1 ? 1 : 2; }
  function cardKey(c) { return JSON.stringify(cardSides(c)); }

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

  function targetDistForRound(round, ruleSet) {
    if (ruleSet === "balanced") return DIST_DEFAULT;
    if (round === 1) return "mild";
    if (round === 2) return "strong";
    return DIST_DEFAULT;
  }

  // Integral of the symmetric proposal density from 0 to a (0 <= a <= 0.5).
  function targetDensityArea(pr, a) {
    var width = a <= pr.U ? pr.U : 0.5 - pr.U;
    var t = a <= pr.U ? a / width : (a - pr.U) / width;
    var blend = t * t * t - t * t * t * t / 2;
    return a <= pr.U ? pr.M * a + (pr.V - pr.M) * width * blend
      : pr.U * (pr.M + pr.V) / 2 + pr.V * (a - pr.U) + (pr.E - pr.V) * width * blend;
  }

  function targetBaseProbability() {
    var pr = DIST_PRESETS.recommended;
    // Classify the rounded 0..1000 center, including the half-step rounding boundary.
    var edge = (Math.floor(500 + samplingConfig.easyThreshold * 5) + 0.5 - 500) / 1000;
    return 1 - targetDensityArea(pr, edge) / targetDensityArea(pr, 0.5);
  }
  var baseEasyProbability = targetBaseProbability();

  function targetCenter(s, dist) {
    var history, own, q, easyRate, hardRate;
    if (samplingConfig.enabled && s && s.ruleSet === "balanced" && s.round > 0 &&
        (s.active === "A" || s.active === "B")) {
      history = targetHistories.get(s);
      if (!history) {
        history = { A: { n: 0, e: 0 }, B: { n: 0, e: 0 }, last: null };
        targetHistories.set(s, history);
      }
      own = history[s.active];
      // A classic-mode skip replaces this turn's target instead of adding another turn.
      if (history.last && history.last.round === s.round && history.last.team === s.active) {
        own.n--;
        own.e -= history.last.easy ? 1 : 0;
      }
      q = Math.max(samplingConfig.minEasyProbability, Math.min(samplingConfig.maxEasyProbability,
        baseEasyProbability + samplingConfig.strength * (own.n * baseEasyProbability - own.e)));
      easyRate = q / baseEasyProbability;
      hardRate = (1 - q) / (1 - baseEasyProbability);
      var scale = Math.max(easyRate, hardRate);
      easyRate /= scale;
      hardRate /= scale;
    }
    for (;;) {
      var c = Math.max(0, Math.min(1000, Math.round(500 + 1000 * sampleTargetX(dist))));
      if (!own) return c;
      var easy = Math.abs(c - 500) / 5 > samplingConfig.easyThreshold;
      if (Math.random() < (easy ? easyRate : hardRate)) {
        own.n++;
        own.e += easy ? 1 : 0;
        history.last = { round: s.round, team: s.active, easy: easy };
        return c;
      }
    }
  }

  function newTarget(s) {
    var bw = s && s.bandWidth > 0 ? s.bandWidth : BAND_WIDTH;
    var dist = s && s.round > 0 ? targetDistForRound(s.round, s.ruleSet) : (s && s.dist ? s.dist : DIST_DEFAULT);
    var c = targetCenter(s, dist);
    // Half of the 4-point band, then one full 3-point and 2-point band.
    var w4 = bw * 0.4;
    var w3 = w4 + bw;
    return { center: c, w4: w4, w3: w3, w2: w3 + bw * 1.1, dist: dist };
  }

  function drawFromDeck(s, exclude, preferredTag, previousChoices) {
    var excluded = exclude ? cardKey(exclude) : null;
    var pool = s.cards.filter(function (c) { return cardKey(c) !== excluded; });
    // Prefer fresh topics on a redraw; tiny decks may have to reuse an old topic.
    if (previousChoices && previousChoices.length) {
      var oldKeys = previousChoices.map(cardKey);
      var fresh = pool.filter(function (c) { return oldKeys.indexOf(cardKey(c)) === -1; });
      if (fresh.length) pool = fresh;
    }
    var tagged = pool.filter(function (c) { return cardTag(c) === preferredTag; });
    if (tagged.length) pool = tagged;
    if (!pool.length) return null;
    var keys = pool.map(cardKey);
    for (var i = s.deck.length - 1; i >= 0; i--) {
      if (keys.indexOf(cardKey(s.deck[i])) !== -1 && (!tagged.length || cardTag(s.deck[i]) === preferredTag)) {
        return s.deck.splice(i, 1)[0];
      }
    }
    // Refill only the exhausted pool so both tags retain their draw probabilities.
    var refill = s.ordered ? pool.slice() : shuffle(pool.slice());
    s.deck = s.deck.concat(refill);
    return s.deck.pop();
  }

  function createGame() {
    return {
      phase: "setup",
      rulesOpen: false,
      ruleSet: "balanced",
      active: "A",
      first: "A",
      teams: { A: { name: "射命丸文", score: 0 }, B: { name: "姬海棠果", score: 0 } },
      round: 0,
      dial: UNIT / 2,
      target: null,
      card: null,
      cardChoices: [],
      cardMode: "choice",
      redrawUsed: { A: false, B: false },
      side: 0,
      guess: null,
      cards: BUILTIN_DECK.slice(),
      deckName: DECK_NAME_DEFAULT,
      deck: [],
      ordered: false,
      winScore: RULE_SETS.balanced.winScore,
      bandWidth: RULE_SETS.balanced.bandWidth,
      sudden: false,
      sdPts: { A: 0, B: 0 },
      sdTurns: { A: false, B: false },
      catchup: false,
      result: null,
      reveal: null,
      timerKind: null,
      timerEnd: null,
      guessTimerSeconds: 15,
      log: []
    };
  }

  function startRound(s) {
    s.round++;
    drawRoundCards(s);
  }

  function drawRoundCards(s, previousChoices) {
    s.cardChoices = [];
    if (s.cardMode === "choice") {
      s.phase = "chooseCard";
      s.card = null;
      s.target = null;
      var mixed = s.cards.some(function (c) { return cardTag(c) === 1; }) &&
        s.cards.some(function (c) { return cardTag(c) === 2; });
      var leftTag = mixed && Math.random() < 0.7 ? 1 : 2;
      var firstCard = drawFromDeck(s, null, leftTag, previousChoices);
      s.cardChoices.push(firstCard);
      var rightTag = mixed && Math.random() < 0.7 ? 2 : 1;
      var secondCard = drawFromDeck(s, firstCard, rightTag, previousChoices);
      if (secondCard) s.cardChoices.push(secondCard);
    } else {
      s.phase = "psychic";
      s.card = drawFromDeck(s);
      s.target = newTarget(s);
    }
    s.side = 0;
    s.dial = UNIT / 2;
    s.guess = null;
    s.reveal = null;
    s.timerKind = null;
    s.timerEnd = null;
    s.guessTimerSeconds = 15;
    if (s.phase === "chooseCard") startTimer(s, "chooseCard", CHOICE_TIMER_SECONDS);
  }

  function selectCard(s, index) {
    s.card = s.cardChoices[index];
    s.cardChoices = [];
    s.side = 0;
    s.target = newTarget(s);
    s.phase = "psychic";
    s.timerKind = null;
    s.timerEnd = null;
  }

  function randomCardIndex(choices) {
    if (choices.length < 2) return 0;
    var leftTag = cardTag(choices[0]), rightTag = cardTag(choices[1]);
    var leftChance = leftTag === rightTag ? 0.5 : leftTag === 1 ? 0.7 : 0.3;
    return Math.random() < leftChance ? 0 : 1;
  }

  function doSetup(s, intent) {
    s.rulesOpen = false;
    selectRuleSet(s, intent.ruleSet);
    if (s.ruleSet === "balanced") {
      s.bandWidth = rulesFor(s).bandWidth;
    }
    if (intent.winScore !== undefined) s.winScore = normalizeWinScore(intent.winScore);
    targetHistories.delete(s);
    if (intent.cardMode === "choice" || intent.cardMode === "single") s.cardMode = intent.cardMode;
    s.teams.A = { name: intent.teamA || "射命丸文", score: 0 };
    s.teams.B = { name: intent.teamB || "姬海棠果", score: 0 };
    s.first = intent.first === "B" ? "B" : "A";
    resetStartingScores(s);
    s.active = s.first;
    s.redrawUsed = { A: false, B: false };
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
    targetHistories.delete(s);
    s.rulesOpen = false;
    s.redrawUsed = { A: false, B: false };
    resetStartingScores(s);
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
    var rules = rulesFor(s);
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
        if (s.sdPts.A === s.sdPts.B) {
          if (rules.tiedOvertimeDraw) {
            s.result = { winner: null, sudden: true, draw: true };
            s.phase = "over";
            return;
          }
          s.sdPts.A = 0;
          s.sdPts.B = 0;
          s.sdTurns.A = false;
          s.sdTurns.B = false;
        } else {
          s.result = { winner: s.sdPts.A > s.sdPts.B ? "A" : "B", sudden: true };
          s.phase = "over";
          return;
        }
      }
      s.phase = "revealed";
      return;
    }

    t.score += pts;
    o.score += oppPts;
    s.catchup = rules.catchup && pts === 4 && t.score < o.score;

    var limit = s.winScore > 0 ? s.winScore : Infinity;
    var aWon = s.teams.A.score >= limit;
    var bWon = s.teams.B.score >= limit;
    var maxRoundsReached = s.round >= rules.maxRounds;
    var canFinish = s.round >= rules.minRounds && (!rules.pairedEnd || s.round % 2 === 0);
    if (canFinish && (aWon || bWon || maxRoundsReached)) {
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
    if (s.ruleSet === "balanced") {
      // Once the threshold is reached, the next paired boundary ends regulation.
      // Otherwise keep every remaining opportunity through the six-turn cap.
      var lastRound = aWon || bWon ? Math.max(rules.minRounds, s.round + s.round % 2) : rules.maxRounds;
      var leader = s.teams.A.score > s.teams.B.score ? "A" : "B";
      var trailing = other(leader);
      var maxCatchup = 0;
      var next = other(s.active);
      for (var r = s.round + 1; r <= lastRound; r++) {
        maxCatchup += next === trailing ? 4 : 1;
        next = other(next);
      }
      // Equality preserves a possible tie and the chance to win in overtime.
      if (s.teams[leader].score - s.teams[trailing].score > maxCatchup) {
        s.result = { winner: leader, early: true };
        s.phase = "over";
        return;
      }
    }
    s.phase = "revealed";
  }

  function clampDial(v) {
    return Math.max(0, Math.min(UNIT, Math.round(v)));
  }

  function normalizeWinScore(value) {
    var score = Math.floor(Number(value));
    return Number.isFinite(score) && score >= 0 ? Math.min(999, score) : 0;
  }

  function timerSeconds(value, fallback) {
    var seconds = Math.floor(Number(value));
    if (isNaN(seconds)) seconds = fallback;
    return Math.max(0, Math.min(60 * 60, seconds));
  }

  function startTimer(s, kind, value, fallback, now) {
    var seconds = timerSeconds(value, fallback);
    s.timerKind = seconds > 0 ? kind : null;
    s.timerEnd = seconds > 0 ? (now === undefined ? Date.now() : now) + seconds * 1000 : null;
  }

  function advanceTimers(s, now) {
    if (now === undefined) now = Date.now();
    var changed = false;
    while (s.timerEnd !== null && s.timerEnd + TIMER_GRACE_MS <= now) {
      // Keep the visible countdown separate from the last accepted input time.
      var deadline = s.timerEnd + TIMER_GRACE_MS;
      if (s.timerKind === "chooseCard" && s.phase === "chooseCard") {
        selectCard(s, randomCardIndex(s.cardChoices));
      } else if (s.timerKind === "dial" && (s.phase === "psychic" || s.phase === "dial")) {
        // The displayed zero is the center (500 internally). Preserve any other
        // current position; only a centered dial gets a uniform random choice.
        if (s.dial === UNIT / 2) s.dial = Math.floor(Math.random() * (UNIT + 1));
        s.phase = "guess";
        startTimer(s, "guess", s.guessTimerSeconds, 15, deadline);
      } else if (s.timerKind === "guess" && s.phase === "guess") {
        s.guess = Math.random() < 0.5 ? "L" : "R";
        s.phase = "reveal";
        s.timerKind = null;
        s.timerEnd = null;
      } else {
        s.timerKind = null;
        s.timerEnd = null;
      }
      changed = true;
    }
    return changed;
  }

  function applyIntent(s, intent, options) {
    if (!intent || typeof intent.type !== "string") return s;
    // Late input cannot override an automatic action or act on its new phase.
    // The online server coordinates timers with asynchronous THCCB confirmations.
    if (!(options && options.deferTimers) && advanceTimers(s) && ["selectCard", "selectSide", "donePsychic", "startDialTimer",
      "setDial", "lock", "penaltyLock", "guess", "reveal", "skipCard", "redrawCards"].indexOf(intent.type) !== -1) return s;
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
          selectCard(s, intent.index);
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
        if (s.phase === "psychic" && !s.timerEnd) {
          s.guessTimerSeconds = timerSeconds(intent.guessTimerSeconds, 15);
          startTimer(s, "dial", intent.timerSeconds, 60);
        }
        break;
      case "setDial":
        if (s.phase === "dial" && Number.isFinite(Number(intent.value))) {
          s.dial = clampDial(intent.value);
        }
        break;
      case "lock":
      case "penaltyLock":
        if (s.phase === "dial") {
          if (intent.type === "penaltyLock") s.dial = Math.floor(Math.random() * (UNIT + 1));
          s.phase = "guess";
          startTimer(s, "guess", intent.timerSeconds, s.guessTimerSeconds);
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
          if (!rulesFor(s).catchup || !s.catchup) s.active = other(s.active);
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
        if (s.phase === "psychic" && s.cardMode === "single") {
          drawRoundCards(s);
        }
        break;
      case "redrawCards":
        if (s.phase === "chooseCard" && s.cardMode === "choice" && !s.redrawUsed[s.active]) {
          s.redrawUsed[s.active] = true;
          drawRoundCards(s, s.cardChoices);
        }
        break;
      case "setCardMode":
        if (s.phase === "setup" && (intent.value === "choice" || intent.value === "single")) {
          s.cardMode = intent.value;
        }
        break;
      case "setRuleSet":
        if (s.phase === "setup") {
          selectRuleSet(s, intent.value);
          resetStartingScores(s);
        }
        break;
      case "setOrdered":
        s.ordered = !!intent.value;
        break;
      case "setWinScore":
        s.winScore = normalizeWinScore(intent.value);
        break;
      case "setBandWidth":
        if (s.ruleSet === "balanced") break;
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
      var m = lines[i].match(/^\s*-\s*(concepts:\s*)?\[(.*?)\]\s*(?:#.*)?$/);
      if (!m) {
        var tag = lines[i].match(/^\s+tag\s*:\s*([12])\s*(?:#.*)?$/);
        if (tag && out.length && !Array.isArray(out[out.length - 1]) && out[out.length - 1].tag === undefined) {
          out[out.length - 1].tag = Number(tag[1]);
          continue;
        }
        var nm = lines[i].match(/^\s*name\s*:\s*(.*?)\s*$/);
        if (nm) {
          name = nm[1].replace(/^["']|["']$/g, "").trim();
          continue;
        }
        var s = lines[i].replace(/#.*$/, "").trim();
        if (!s || s === "cards:" || s === "cards") continue;
        throw new Error("第 " + (i + 1) + " 行格式错误，应为：- [左, 右]");
      }
      var items = m[2].split(",").map(function (x) {
        return x.trim().replace(/^["']|["']$/g, "").trim();
      });
      if (items.length !== 2 && items.length !== 4) throw new Error("第 " + (i + 1) + " 行应有 2 或 4 个概念");
      out.push(m[1] ? { concepts: items } : items);
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
      var concepts = Array.isArray(c) ? c : c && c.concepts;
      var ok = Array.isArray(concepts) && (concepts.length === 2 || concepts.length === 4) &&
        concepts.every(function (x) { return typeof x === "string" && x.trim() !== ""; });
      if (!ok) throw new Error("第 " + (i + 1) + " 张卡格式错误：应为 [左, 右] 或 [左1, 右1, 左2, 右2]");
      if (!Array.isArray(c) && c.tag !== undefined && c.tag !== 1 && c.tag !== 2) {
        throw new Error("第 " + (i + 1) + " 张卡的 tag 应为 1 或 2");
      }
      out.push(Array.isArray(c) ? concepts : { concepts: concepts, tag: cardTag(c) });
    }
    return { cards: out, name: name };
  }

  var WL = {
    BUILTIN_DECK: BUILTIN_DECK,
    UNIT: UNIT,
    BAND_WIDTH: BAND_WIDTH,
    WIN_SCORE: WIN_SCORE,
    MAX_ROUNDS: MAX_ROUNDS,
    TIMER_GRACE_MS: TIMER_GRACE_MS,
    RULE_SETS: RULE_SETS,
    rulesFor: rulesFor,
    DECK_NAME_DEFAULT: DECK_NAME_DEFAULT,
    DIST_PRESETS: DIST_PRESETS,
    DIST_DEFAULT: DIST_DEFAULT,
    distDensity: distDensity,
    sampleTargetX: sampleTargetX,
    targetDistForRound: targetDistForRound,
    newTarget: newTarget,
    createGame: createGame,
    applyIntent: applyIntent,
    advanceTimers: advanceTimers,
    parseDeck: parseDeck,
    parseYamlCards: parseYamlCards,
    cardSides: cardSides,
    cardTag: cardTag,
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
