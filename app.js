(function () {
  "use strict";

  var G = WL.createGame();
  var ONLINE = false;
  var ROLE = "local";
  var psychicViewing = false;
  var dragging = false;
  var lastDialSync = 0;
  var overDismissed = false;
  var displayScroll = new Map();
  var previousDisplay = null;
  var scoreAnimations = new Map();
  var teamEffectTimers = new Map();

  function wideMonitor() {
    return ROLE === "monitor" && window.matchMedia && window.matchMedia("(min-width: 1800px) and (max-height: 900px)").matches;
  }

  // Passive displays advance long records and rankings without requiring a mouse.
  function scrollDisplayPanels() {
    if (!wideMonitor() || G.rulesOpen || document.hidden) return;
    var now = Date.now();
    document.querySelectorAll("[data-auto-scroll]").forEach(function (list) {
      if (!list.clientHeight) return;
      var key = list.dataset.entries + ":" + list.clientHeight + ":" + G.phase;
      var progress = displayScroll.get(list);
      if (!progress || progress.key !== key) {
        list.scrollTop = 0;
        displayScroll.set(list, { key: key, holdUntil: now + 4000, last: now, position: 0 });
        return;
      }
      var elapsed = Math.min(250, now - progress.last);
      progress.last = now;
      var end = list.scrollHeight - list.clientHeight;
      if (end <= 0 || now < progress.holdUntil) return;
      if (progress.position >= end) {
        progress.position = 0;
        list.scrollTop = 0;
        progress.holdUntil = now + 4000;
      } else {
        progress.position = Math.min(end, progress.position + elapsed / 1000 * 24 * Math.min(innerWidth / 3904, innerHeight / 672));
        list.scrollTop = progress.position;
        if (progress.position >= end) progress.holdUntil = now + 4000;
      }
    });
  }

  var connState = "local";
  var sse = null;
  var pingFail = 0;
  var intentQueue = [];
  var retryTimer = null;
  var flushTimer = null;
  var heartbeatTimer = null;
  var retryDelay = 1000;
  var warnedTimerEnd = null;
  var audioContext = null;

  var $ = function (id) { return document.getElementById(id); };

  function configuredTimerSeconds(attr, fallback) {
    var value = Math.floor(Number(document.body.getAttribute(attr)));
    if (isNaN(value)) return fallback;
    return Math.max(0, Math.min(60 * 60, value));
  }

  function ensureAudio() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      if (!audioContext) audioContext = new AudioCtx();
      if (audioContext.state === "suspended") audioContext.resume().catch(function () {});
      return audioContext;
    } catch (e) {
      return null;
    }
  }

  function playTimerWarning() {
    var ctx = ensureAudio();
    if (!ctx) return;
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      var now = ctx.currentTime;
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } catch (e) {}
  }

  function renderTimer() {
    var el = $("timer-display");
    if (!el) return;
    var footer = $("display-footer");
    var host = wideMonitor() ? footer : document.querySelector(".header-actions");
    if (el.parentElement !== host) host.insertBefore(el, wideMonitor() ? null : $("btn-restart"));
    if (!G.timerEnd || !G.timerKind) {
      el.className = "timer-display hidden";
      el.textContent = "00:00";
      warnedTimerEnd = null;
      return;
    }
    var remaining = Math.max(0, Math.ceil((G.timerEnd - Date.now()) / 1000));
    var minutes = Math.floor(remaining / 60);
    var seconds = remaining % 60;
    el.textContent = String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    el.className = "timer-display" + (remaining === 0 ? " expired" : remaining <= 5 ? " warning" : "");
    if (remaining > 0 && remaining <= 5 && warnedTimerEnd !== G.timerEnd) {
      warnedTimerEnd = G.timerEnd;
      playTimerWarning();
    }
  }

  var NAMES_DEFAULT = {
    gameName: "Returned",
    gameTitle: "Returned",
    gameSubtitle: "逆转录者",
    psychic: "Psychic",
    clue: "线索",
    dial: "拨杆",
    target: "目标",
    wedge: "楔形",
    screen: "屏幕",
    roundUnit: "轮",
    leftRight: "左右",
    catchup: "追赶规则",
    suddenDeath: "加时赛",
    perfectHit: "完美命中",
    teamDefaultA: "射命丸文",
    teamDefaultB: "姬海棠果",
    restartBtn: "重新开始",
    playagainBtn: "再来一局",
    startBtn: "开始游戏",
    skipBtn: "跳过此题"
  };
  var NAMES = null;

  function T(k) {
    if (NAMES && typeof NAMES[k] === "string" && NAMES[k] !== "") return NAMES[k];
    return NAMES_DEFAULT[k] !== undefined ? NAMES_DEFAULT[k] : k;
  }

  function mergeNames(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    NAMES = {};
    Object.keys(NAMES_DEFAULT).forEach(function (k) {
      if (typeof obj[k] === "string" && obj[k] !== "") NAMES[k] = obj[k];
    });
    return true;
  }

  function namesMsg(text, ok) {
    var el = $("names-msg");
    el.textContent = text;
    el.className = "deck-msg" + (ok ? " ok" : " err");
  }

  function applyNames() {
    document.title = T("gameTitle") + " · " + T("gameSubtitle");
    $("title-main").textContent = T("gameTitle");
    $("sub-title").textContent = T("gameSubtitle");
    $("setup-title").textContent = T("gameName");
    $("btn-restart").textContent = T("restartBtn");
    $("btn-playagain").textContent = T("playagainBtn");
    $("btn-start").textContent = T("startBtn");
    $("input-nameA").value = T("teamDefaultA");
    $("input-nameB").value = T("teamDefaultB");
    $("names-info").textContent = NAMES ? "自定义文案" : "默认文案";
    render();
  }

  function loadNamesText(rawText) {
    var obj;
    try {
      obj = JSON.parse(rawText);
    } catch (e) {
      namesMsg("文案加载失败：" + e.message, false);
      return;
    }
    if (!mergeNames(obj)) {
      namesMsg("文案格式错误：应为键值对象，如 {\"gameName\": \"…\"}", false);
      return;
    }
    try { localStorage.setItem("wl_names", rawText); } catch (e) {}
    namesMsg("已加载文案，游戏名：" + T("gameName"), true);
    applyNames();
  }

  function resetNames() {
    try { localStorage.removeItem("wl_names"); } catch (e) {}
    NAMES = null;
    namesMsg("已恢复默认文案", true);
    applyNames();
    tryFetchNames();
  }

  function tryFetchNames() {
    if (typeof fetch !== "function") return;
    fetch("names.json").then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.text();
    }).then(function (t) {
      if (mergeNames(JSON.parse(t))) {
        namesMsg("已加载：" + T("gameName"), true);
        applyNames();
      }
    }).catch(function () {});
  }

  function initNames() {
    var saved = null;
    try { saved = localStorage.getItem("wl_names"); } catch (e) {}
    if (saved) {
      try {
        if (mergeNames(JSON.parse(saved))) {
          applyNames();
          return;
        }
      } catch (e) {
        try { localStorage.removeItem("wl_names"); } catch (e2) {}
      }
    }
    applyNames();
    tryFetchNames();
  }

  function canControl() {
    return (ROLE === "local" || ROLE === "controller") && (ROLE === "local" || connState === "ok");
  }

  function dispatch(intent) {
    if (ONLINE) {
      if (ROLE === "controller") postIntent(intent);
    } else {
      WL.applyIntent(G, intent);
      render();
    }
  }

  function setConn(state) {
    connState = state;
    var badge = $("conn-badge");
    var warn = $("conn-warn");
    badge.className = "";
    warn.classList.add("hidden");
    if (state === "local") {
      badge.innerHTML = "<span class='dot'></span>本地模式";
    } else if (state === "connecting") {
      badge.innerHTML = "<span class='dot'></span>连接中…";
      badge.className = "retry";
    } else if (state === "ok") {
      badge.innerHTML = "<span class='dot'></span>已连接";
      badge.className = "ok";
    } else if (state === "retry") {
      badge.innerHTML = "<span class='dot'></span>重连中…";
      badge.className = "retry";
      warn.textContent = "与服务器连接中断，正在自动重连…";
      warn.classList.remove("hidden");
    } else {
      badge.innerHTML = "<span class='dot'></span>连接断开";
      badge.className = "bad";
      warn.textContent = "与服务器连接已断开，操作暂时无法送达。请检查网络或服务器后等待自动重连。";
      warn.classList.remove("hidden");
    }
    render();
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(heartbeat, 8000);
  }

  function heartbeat() {
    if (!ONLINE) return;
    var done = false;
    var timer = setTimeout(function () {
      if (!done) {
        done = true;
        failPing();
      }
    }, 4000);
    fetch("api/ping").then(function (r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (r.ok) {
        pingFail = 0;
      } else {
        failPing();
      }
    }).catch(function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      failPing();
    });
  }

  function failPing() {
    pingFail++;
    if (pingFail >= 2) forceReconnect();
  }

  function connectSSE() {
    if (!ONLINE) return;
    if (sse) {
      try { sse.close(); } catch (e) {}
    }
    sse = new EventSource("/api/stream");
    sse.onopen = function () {
      retryDelay = 1000;
      pingFail = 0;
      setConn("ok");
      flushQueue();
    };
    sse.onmessage = function (ev) {
      try {
        var previousPhase = G.phase;
        G = JSON.parse(ev.data);
        if (G.phase !== "psychic" || previousPhase !== G.phase) psychicViewing = false;
        render();
      } catch (e) {}
    };
    sse.onerror = function () {
      try { sse.close(); } catch (e) {}
      sse = null;
      setConn("retry");
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connectSSE();
      retryDelay = Math.min(retryDelay * 2, 10000);
    }, retryDelay);
  }

  function forceReconnect() {
    if (sse) {
      try { sse.close(); } catch (e) {}
      sse = null;
    }
    setConn("retry");
    scheduleReconnect();
  }

  function queueIntent(intent) {
    intentQueue.push(intent);
    if (intentQueue.length > 20) intentQueue.shift();
    collapseDialQueue();
  }

  function collapseDialQueue() {
    for (var i = intentQueue.length - 2; i >= 0; i--) {
      if (intentQueue[i].type === "setDial" && intentQueue[i + 1].type === "setDial") {
        intentQueue.splice(i, 1);
      } else if (intentQueue[i].type === "setDial") {
        break;
      }
    }
  }

  function flushQueue() {
    if (connState !== "ok") return;
    collapseDialQueue();
    var pending = intentQueue.splice(0, intentQueue.length);
    pending.forEach(function (it) { sendIntent(it); });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushQueue();
    }, 2000);
  }

  function postIntent(intent) {
    if (!ONLINE || ROLE !== "controller") return;
    if (connState !== "ok") {
      queueIntent(intent);
      scheduleFlush();
      return;
    }
    sendIntent(intent);
  }

  function sendIntent(intent) {
    fetch("/api/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intent)
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "http " + r.status); });
    }).catch(function () {
      if (connState !== "ok") {
        queueIntent(intent);
        scheduleFlush();
      }
    });
  }

  function render() {
    var A = G.teams.A, B = G.teams.B;
    // Keep progress in the name column, leaving room for larger score digits.
    var trackCount = G.winScore > 0 ? Math.min(G.winScore, 40) : 31;
    var scoreDigits = Math.max(String(G.teams.A.score).length, String(G.teams.B.score).length);
    var trackColumns = Math.max(1, Math.floor((790 - scoreDigits * 140) / 44));
    document.body.style.setProperty("--team-card-height", 344 + (Math.ceil(trackCount / trackColumns) - 1) * 44);
    $("nameA").textContent = A.name;
    $("nameB").textContent = B.name;
    [A, B].forEach(function (team, index) {
      var panel = $(index === 0 ? "nameA" : "nameB").closest(".team");
      panel.style.setProperty("--name-length", Math.max(1, Array.from(team.name).length));
      panel.style.setProperty("--score-digits", String(team.score).length);
    });
    ["A", "B"].forEach(function (letter) {
      var animation = scoreAnimations.get(letter);
      if (!animation || animation.target !== G.teams[letter].score) {
        if (animation) cancelAnimationFrame(animation.frame);
        scoreAnimations.delete(letter);
        $("score" + letter).textContent = G.teams[letter].score;
      }
    });
    renderTrack("trackA", A.score, "a");
    renderTrack("trackB", B.score, "b");
    renderTeamFeedback();
    renderRuleSet();
    renderDeckInfo();
    renderTurn();
    renderCard();
    renderBands();
    renderTicks();
    renderControls();
    renderDial();
    renderGuessDirection();
    renderTargetVisibility();
    renderModals();
    renderTimer();
    renderAudience();
  }

  function monitorPhase() {
    if (G.phase === "over" && G.result && G.result.draw) return "和局复盘";
    return { setup: "待开局", chooseCard: "选题", psychic: "出题", dial: "讨论", guess: "猜左右",
      reveal: "揭晓", revealed: "结算", over: "复盘" }[G.phase] || "";
  }

  function renderRuleSet() {
    var balanced = G.ruleSet === "balanced";
    $("opt-rule-set").value = balanced ? "balanced" : "original";
    $("opt-rule-set").disabled = G.phase !== "setup";
    $("rule-summary").textContent = balanced
      ? "双方 0 分起步，严格轮流。至少 4 轮，双方行动后有人达到 8 分则结算；常规最多 6 轮。平分时各加赛一轮，仍平则和局。"
      : "先手 0 分，后手补 1 分。先到设定分即结算，常规最多 10 轮；4 分且仍落后可再行动，平分加时直到分出胜负。";
    $("select-first").querySelector('[value="A"]').textContent = balanced ? "左队先手（双方 0 分）" : "左队先手（左 0 分 / 右 1 分）";
    $("select-first").querySelector('[value="B"]').textContent = balanced ? "右队先手（双方 0 分）" : "右队先手（右 0 分 / 左 1 分）";
    $("opt-winscore").disabled = balanced;
    $("opt-bandwidth").disabled = balanced;
    $("winscore-label").textContent = balanced ? "结算门槛（平衡快局固定 8 分）" : "获胜分数（0 = 不设分数门槛，仍最多 10 轮）";
    $("rule-turns").textContent = balanced
      ? "平衡快局：双方 0 分起步，两队轮流出题。"
      : "原版：先手 0 分，后手 1 分。本队拿 4 分且仍然落后，立刻再行动一轮。";
    $("rule-ending").textContent = balanced
      ? "获胜：第 4 轮结束后，有队达到 8 分则比较总分；否则第 6 轮结算。领先者胜，平分加时。双方行动次数相等。"
      : "获胜：" + (G.winScore > 0 ? "先达到 " + G.winScore + " 分，或" : "") + "第 10 轮结束时分数较高者获胜；届时平分则进入加时赛。";
    $("rule-overtime").textContent = "平分加时赛：两队各出一次题，比较加时得分（含左右猜测的 1 分），谁高谁赢；" +
      (balanced ? "仍平则和局，整局最多 8 轮。" : "仍平则重复，直到分出胜负。") + "加时分不计入主记分板。";
    ["A", "B"].forEach(function (letter) {
      var el = $("overtime" + letter);
      el.classList.toggle("hidden", !G.sudden);
      el.textContent = G.sudden ? "加时 " + G.sdPts[letter] + " 分 · " + (G.sdTurns[letter] ? "已出题" : "待出题") : "";
    });
  }

  function actingTeam() {
    // Share the handoff between the turn instruction and the highlighted team card.
    if (G.phase === "guess") return WL.other(G.active);
    if (G.phase === "revealed") return G.catchup ? G.active : WL.other(G.active);
    return G.active;
  }

  function renderTeamFeedback() {
    var revealed = !!G.reveal && (G.phase === "revealed" || G.phase === "over");
    var actor = actingTeam();
    if (G.phase === "over") actor = G.result && G.result.winner;
    var newReveal = revealed && previousDisplay && previousDisplay.role === ROLE &&
      previousDisplay.round === G.round && previousDisplay.phase !== "setup" &&
      previousDisplay.phase !== "revealed" && previousDisplay.phase !== "over";
    ["A", "B"].forEach(function (letter) {
      var panel = $("name" + letter).closest(".team");
      var direction = $("direction" + letter);
      var hasGuess = G.guess && letter === WL.other(G.active) && ["reveal", "revealed", "over"].includes(G.phase);
      direction.textContent = hasGuess ? (G.guess === "L" ? "←" : "→") : "";
      direction.dataset.direction = hasGuess ? G.guess : "";
      direction.setAttribute("aria-label", hasGuess ? G.teams[letter].name + "选择" + (G.guess === "L" ? "左边" : "右边") : "");
      direction.setAttribute("aria-hidden", hasGuess && wideMonitor() ? "false" : "true");
      panel.classList.toggle("is-active", G.phase !== "setup" && actor === letter);
      panel.classList.toggle("is-winner", G.phase === "over" && actor === letter);
      panel.setAttribute("aria-label", G.teams[letter].name + "，" + G.teams[letter].score + " 分" +
        (G.phase === "over" && actor === letter ? "，获胜" : actor === letter && G.phase !== "setup" ? "，行动中" : ""));
      if (!revealed || !wideMonitor()) {
        var running = scoreAnimations.get(letter);
        if (running) {
          cancelAnimationFrame(running.frame);
          scoreAnimations.delete(letter);
          $("score" + letter).textContent = G.teams[letter].score;
        }
        clearTimeout(teamEffectTimers.get(letter));
        teamEffectTimers.delete(letter);
        panel.classList.remove("is-scoring", "perfect-hit");
        $("gain" + letter).textContent = "";
      }
      if (!newReveal || !wideMonitor()) return;
      var points = letter === G.active ? G.reveal.pts : G.reveal.oppPts;
      if (!points) return;
      $("gain" + letter).textContent = "+" + points;
      panel.classList.add("is-scoring");
      panel.classList.toggle("perfect-hit", letter === G.active && points === 4);
      clearTimeout(teamEffectTimers.get(letter));
      teamEffectTimers.set(letter, setTimeout(function () {
        panel.classList.remove("is-scoring", "perfect-hit");
        $("gain" + letter).textContent = "";
        teamEffectTimers.delete(letter);
      }, 3600));
      var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced || typeof requestAnimationFrame !== "function") return;
      var from = previousDisplay.scores[letter], to = G.teams[letter].score;
      // Overtime points do not change the main scoreboard.
      if (from === to) return;
      var animation = { target: to, frame: null, start: performance.now() };
      scoreAnimations.set(letter, animation);
      $("score" + letter).textContent = from;
      function step(now) {
        var progress = Math.min(1, (now - animation.start) / 650);
        $("score" + letter).textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - progress, 3)));
        if (progress < 1) animation.frame = requestAnimationFrame(step);
        else scoreAnimations.delete(letter);
      }
      animation.frame = requestAnimationFrame(step);
    });
    previousDisplay = { role: ROLE, round: G.round, phase: G.phase, scores: { A: G.teams.A.score, B: G.teams.B.score } };
  }

  function renderAudienceList(id, winners) {
    var list = $(id);
    var compact = wideMonitor() && id === "audience-winners";
    var signature = JSON.stringify([winners, compact]);
    if (list.dataset.entries === signature) return;
    list.dataset.entries = signature;
    list.textContent = "";
    winners.forEach(function (winner) {
      var row = document.createElement("li");
      var rank = document.createElement("span");
      rank.className = "audience-rank";
      rank.textContent = winner.rank;
      var avatar = document.createElement("span");
      avatar.className = "audience-avatar";
      avatar.textContent = Array.from(winner.nickname)[0] || "友";
      var img = document.createElement("img");
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.src = winner.avatarUrl;
      img.addEventListener("error", function () { img.remove(); });
      avatar.appendChild(img);
      var info = document.createElement("span");
      info.className = "audience-person";
      var name = document.createElement("strong");
      name.textContent = winner.nickname;
      name.title = winner.nickname;
      var guess = document.createElement("span");
      guess.textContent = (compact ? "" : "猜 ") + WL.formatPercent(winner.guessPct);
      info.appendChild(name);
      info.appendChild(guess);
      var error = document.createElement("span");
      error.className = "audience-error";
      error.textContent = winner.errorPct == null ? "" : winner.errorPct === 0 ? (compact ? "✓" : "精准命中") : "差 " + winner.errorPct + (compact ? "" : " 点");
      error.setAttribute("aria-label", winner.errorPct == null ? "等待揭晓" : winner.errorPct === 0 ? "精准命中" : "相差 " + winner.errorPct + " 个百分点");
      error.classList.toggle("exact", winner.errorPct === 0);
      row.appendChild(rank);
      row.appendChild(avatar);
      row.appendChild(info);
      row.appendChild(error);
      list.appendChild(row);
    });
  }

  function renderAudience() {
    var a = G.audience;
    var compact = wideMonitor();
    var enabled = ONLINE && ROLE !== "local" && a && a.enabled;
    $("audience-panel").classList.toggle("hidden", !enabled && !wideMonitor());
    document.body.classList.toggle("audience-mode", !!enabled);
    $("audience-final").classList.toggle("hidden", !enabled || !a.revealed);
    if (!enabled) {
      $("audience-connection").textContent = compact ? "" : "未启用";
      $("audience-connection").setAttribute("aria-label", "群互动未启用");
      $("audience-connection").title = "群互动未启用";
      $("audience-connection").classList.remove("connected");
      $("audience-prompt").textContent = compact ? "" : "群友竞猜尚未开启";
      $("audience-status").textContent = compact ? "未启用" : "开启群互动后，作答结果将在此展示。";
      renderAudienceList("audience-winners", []);
      return;
    }
    var connected = a.connected && connState === "ok";
    var revealed = a.revealed || G.phase === "over";
    var targetPct = a.revealed ? a.targetPct : (revealed && G.target ? WL.toSignedPercent(G.target.center) : null);
    var connectionLabel = a.demo ? "演示模式" : connected ? "QQ 已连接" : "QQ 未连接";
    $("audience-connection").textContent = compact ? "" : connectionLabel;
    $("audience-connection").setAttribute("aria-label", connectionLabel);
    $("audience-connection").title = connectionLabel;
    $("audience-connection").classList.toggle("connected", connected);
    $("audience-prompt").textContent = compact
      ? (revealed ? "目标 " + WL.formatPercent(targetPct) : "发送 g+50%")
      : revealed
      ? "目标 " + WL.formatPercent(targetPct) + " · 前 " + a.topN + " 名"
      : "群 " + a.groupId + " · 发送 g-50% / g0% / g+50%（−100～+100%） · " +
        (a.guessPolicy === "first" ? "首次作答有效" : "揭晓前可修改，以最后一次为准");
    var status = revealed
      ? (a.count ? "本轮 " + a.count + " 人作答 · 已截止" : "本轮暂无有效作答")
      : (a.accepting ? "正在收答 · " + a.count + " 人参与" : "等待出题完成后收答");
    if (compact) {
      var count = document.createElement("span");
      count.className = "audience-count";
      count.textContent = a.count + " 人";
      var badge = document.createElement("span");
      badge.className = "audience-state";
      badge.dataset.state = revealed ? "closed" : a.accepting ? "accepting" : "waiting";
      badge.textContent = revealed ? "已截止" : a.accepting ? "收答中" : "待开始";
      $("audience-status").replaceChildren(badge, count);
    } else {
      $("audience-status").textContent = status + (!connected && !revealed ? " · 群连接中断，暂无法收答" : "");
    }
    $("audience-final-status").textContent = "目标 " + WL.formatPercent(a.targetPct) + " · " + status;
    var winners = a.revealed || a.demo ? a.winners : [];
    renderAudienceList("audience-winners", winners);
    renderAudienceList("audience-final-winners", winners);
  }

  function renderTrack(id, score, cls) {
    var el = $(id);
    var signature = JSON.stringify([score, G.winScore]);
    if (el.dataset.entries === signature) return;
    var previousScore = Number(el.dataset.score || 0);
    el.dataset.entries = signature;
    el.dataset.score = score;
    el.innerHTML = "";
    el.className = "score-track " + cls;
    var limit = G.winScore > 0 ? Math.min(G.winScore, 40) : 30;
    for (var i = 0; i < limit; i++) {
      var d = document.createElement("i");
      if (i < score) d.className = "on";
      if (i >= previousScore && i < score) {
        d.classList.add("just-scored");
        d.style.setProperty("--gain-index", i - previousScore);
      }
      el.appendChild(d);
    }
    if (G.winScore === 0) {
      var inf = document.createElement("span");
      inf.textContent = "∞";
      el.appendChild(inf);
    }
  }

  function renderTurn() {
    var actor = actingTeam();
    var who = teamName(actor, G.teams[actor].name);
    var action = { chooseCard: "选题", psychic: "出题", dial: "讨论并拨杆", guess: "猜左右", reveal: "揭示目标", revealed: "出题" }[G.phase];
    $("banner").classList.add("hidden");
    if (G.phase === "over") {
      $("turn-indicator").textContent = G.result && G.result.draw ? "双方和局" : "对局结束";
    } else if (G.phase === "setup") {
      $("turn-indicator").textContent = "等待开局";
    } else {
      $("turn-indicator").innerHTML = (G.phase === "revealed" ? "下一轮 · " : "") + who + " · " + action;
    }
    if (G.catchup && G.phase === "revealed") {
      $("banner").textContent = T("catchup") + " · " + G.teams[G.active].name + " 继续出题，请更换 " + T("psychic") + "。";
      $("banner").classList.remove("hidden");
    }
  }

  function renderCard() {
    var c = G.card;
    var box = $("sides");
    box.innerHTML = "";
    box.classList.toggle("choosing", G.phase === "chooseCard");
    $("card-frame").classList.toggle("choosing", G.phase === "chooseCard");
    var label = "第 " + G.round + " " + T("roundUnit") + " · " + (G.sudden ? "加时 · " : "") + monitorPhase();
    if (G.ruleSet === "balanced") label += " · 平衡快局";
    if (G.phase === "chooseCard") {
      $("card-label").textContent = label;
      G.cardChoices.forEach(function (card, index) {
        var b = document.createElement("button");
        b.className = "side card-choice" + (G.cardChoices.length === 1 ? " only" : "");
        b.type = "button";
        var tag = document.createElement("span");
        tag.className = "side-tag";
        tag.textContent = "题目 " + (index + 1);
        b.appendChild(tag);
        WL.cardSides(card).forEach(function (pair) { b.appendChild(cardPair(pair)); });
        var action = document.createElement("span");
        action.className = "choice-action";
        action.textContent = canControl() ? "选择这道题 →" : "等待控制器选择";
        b.appendChild(action);
        if (canControl()) {
          b.onclick = function () {
            psychicViewing = false;
            dispatch({ type: "selectCard", index: index });
          };
        } else {
          b.classList.add("readonly");
          b.setAttribute("aria-disabled", "true");
        }
        box.appendChild(b);
      });
      return;
    }
    if (!c) {
      $("card-label").textContent = "等待开始游戏";
      return;
    }
    $("card-label").textContent = label;
    var opts = WL.cardSides(c);
    opts.forEach(function (pair, i) {
      var b = document.createElement("button");
      b.className = "side" + (i === G.side ? " selected" : "") + (opts.length === 1 ? " only" : "");
      b.innerHTML = "<span class='side-tag'>" + (opts.length === 1 ? "概念" : "面 " + (i === 0 ? "A" : "B")) + "</span>";
      b.appendChild(cardPair(pair));
      if (G.phase === "psychic") {
        if (canControl()) {
          b.onclick = function () { dispatch({ type: "selectSide", side: i }); };
        } else {
          b.classList.add("readonly");
        }
      } else {
        b.disabled = true;
      }
      box.appendChild(b);
    });
  }

  function cardPair(pair) {
    var con = document.createElement("span");
    con.className = "con";
    con.innerHTML = "<span class='l'></span><i>—</i><span class='r'></span>";
    con.querySelector(".l").textContent = pair[0];
    con.querySelector(".r").textContent = pair[1];
    return con;
  }

  function targetVisible() {
    return (G.phase === "psychic" && psychicViewing) || G.phase === "revealed" || G.phase === "over";
  }

  function renderTicks() {
    var box = $("ticks");
    var labelBox = $("tick-labels");
    box.innerHTML = "";
    labelBox.innerHTML = "";
    function addTick(position, major) {
      var tick = document.createElement("i");
      tick.className = "tick-mark" + (major ? " major" : "");
      tick.style.left = position + "%";
      box.appendChild(tick);
    }
    function addLabel(position) {
      var label = document.createElement("span");
      label.className = "tick-number" +
        (position === 0 ? " edge-left" : position === 100 ? " edge-right" : "");
      label.style.left = position + "%";
      label.textContent = WL.formatPercent(WL.toSignedPercent(position * WL.UNIT / 100));
      labelBox.appendChild(label);
    }
    for (var position = 5; position < 100; position += 5) addTick(position, position % 25 === 0);
    for (var labelPosition = 0; labelPosition <= 100; labelPosition += 25) addLabel(labelPosition);
  }

  function renderBands() {
    var box = $("bands");
    var t = G.target;
    if (!t) {
      box.innerHTML = "";
      return;
    }
    if (!targetVisible()) return;
    box.innerHTML = "";
    function add(cls, lo, hi, label) {
      var d = document.createElement("div");
      d.className = "band " + cls;
      d.style.left = (lo / WL.UNIT * 100) + "%";
      d.style.width = ((hi - lo) / WL.UNIT * 100) + "%";
      if (label) {
        var s = document.createElement("span");
        s.className = "band-label";
        s.textContent = label;
        s.setAttribute("aria-label", label + "分区间");
        d.appendChild(s);
      }
      box.appendChild(d);
    }
    add("b2", t.center - t.w2, t.center - t.w3, "2");
    add("b3", t.center - t.w3, t.center - t.w4, "3");
    add("b4", t.center - t.w4, t.center + t.w4, "4");
    add("b3", t.center + t.w4, t.center + t.w3, "3");
    add("b2", t.center + t.w3, t.center + t.w2, "2");
    $("center-mark").style.left = (t.center / WL.UNIT * 100) + "%";
  }

  function renderDial() {
    $("dial").style.left = (G.dial / WL.UNIT * 100) + "%";
    var lock = G.phase === "dial" && canControl();
    $("interact").classList.toggle("lock-touch", lock);
    $("interact").classList.toggle("disabled", !lock);
  }

  function renderGuessDirection() {
    var axis = $("axis"), region = $("guess-region"), frame = $("direction-frame");
    var selected = (G.guess === "L" || G.guess === "R") && ["reveal", "revealed", "over"].includes(G.phase);
    frame.hidden = !selected;
    region.hidden = !selected || G.phase !== "reveal";
    if (!selected) return;
    var position = Math.max(0, Math.min(100, G.dial / WL.UNIT * 100));
    var left = G.guess === "L";
    axis.style.setProperty("--guess-color", teamColor(WL.other(G.active)));
    axis.style.setProperty("--guess-clip-left", (left ? 0 : position) + "%");
    axis.style.setProperty("--guess-clip-right", (left ? 100 - position : 0) + "%");
    region.dataset.side = G.guess;
    region.style.left = (left ? 0 : position) + "%";
    region.style.width = (left ? position : 100 - position) + "%";
  }

  function setDialFromEvent(e) {
    var rect = $("axis").getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    WL.applyIntent(G, { type: "setDial", value: Math.round(pct * WL.UNIT) });
    renderDial();
  }

  function renderTargetVisibility() {
    var show = targetVisible();
    var s = $("screen"), m = $("center-mark");
    s.classList.toggle("open", show);
    m.classList.toggle("shown", show);
  }

  function renderControls() {
    var box = $("controls");
    var hint = $("hint");
    box.innerHTML = "";
    var t = G.teams[G.active], o = G.teams[WL.other(G.active)];
    var control = canControl();

    if (G.phase === "setup") {
      hint.innerHTML = ROLE === "monitor"
        ? "等待控制器开始游戏…"
        : "填写队伍信息并点击「" + T("startBtn") + "」。";
      if (control) box.appendChild(mk(T("startBtn"), "primary", startGame));
    } else if (G.phase === "chooseCard") {
      hint.innerHTML = teamName(G.active, t.name) + " · " + T("psychic") +
        (G.cardChoices.length > 1 ? "：选择本轮题目。" : "：确认本轮题目。");
    } else if (G.phase === "psychic") {
      hint.innerHTML = teamName(G.active, t.name) + " · " + T("psychic") + "：" + (psychicViewing
        ? "给出" + T("clue") + "后点击「出题完成」，随后保持沉默。"
        : (WL.cardSides(G.card).length > 1 ? "选好卡片面，再查看" : "查看") + T("target") + "。<span class='warn'>其他人请勿看屏幕。</span>");
      if (control) {
        if (psychicViewing) {
          box.appendChild(mk("出题完成，隐藏" + T("target"), "magenta", function () {
            psychicViewing = false;
            dispatch({ type: "donePsychic" });
          }));
        } else {
          box.appendChild(mk("查看" + T("target") + "（仅 " + T("psychic") + "）", "primary", function () {
            psychicViewing = true;
            ensureAudio();
            dispatch({
              type: "startDialTimer",
              timerSeconds: configuredTimerSeconds("data-dial-timer-seconds", 60)
            });
            render();
          }));
        }
        box.appendChild(mk(T("skipBtn"), "", function () {
          psychicViewing = false;
          dispatch({ type: "skipCard" });
        }));
      }
    } else if (G.phase === "dial") {
      hint.innerHTML = teamName(G.active, t.name) + "：讨论" + T("clue") + "，拖动金色" + T("dial") + "后锁定。<span class='warn'>" + T("psychic") + " 保持沉默。</span>";
      if (control) {
        var lock = mk("锁定" + T("dial") + "位置", "primary", function () {
          ensureAudio();
          dispatch({
            type: "lock",
            timerSeconds: configuredTimerSeconds("data-guess-timer-seconds", 15)
          });
        });
        lock.id = "btn-lock";
        box.appendChild(lock);
      }
    } else if (G.phase === "guess") {
      hint.innerHTML = teamName(WL.other(G.active), o.name) + "：" + T("target") + "中心在" + T("dial") + "<b>左边</b>还是<b>右边</b>？";
      if (control) {
        box.appendChild(mk(T("target") + "在" + T("dial") + "左边 ←", "primary", function () {
          dispatch({ type: "guess", guess: "L" });
        }));
        box.appendChild(mk(T("target") + "在" + T("dial") + "右边 →", "magenta", function () {
          dispatch({ type: "guess", guess: "R" });
        }));
      }
    } else if (G.phase === "reveal") {
      hint.innerHTML = teamName(G.active, t.name) + " · " + T("psychic") + "：揭示" + T("target") + "。";
      if (control) box.appendChild(mk("揭示" + T("target") + "！", "primary", function () {
        dispatch({ type: "reveal" });
      }));
    } else if (G.phase === "revealed") {
      hint.innerHTML = (G.sudden ? "<b>" + T("suddenDeath") + " · </b>" : "") + "下一轮：" +
        (G.catchup ? teamName(G.active, t.name) : teamName(WL.other(G.active), o.name)) +
        "，请换一位 " + T("psychic") + " 出题。";
      if (control) box.appendChild(mk("开始下一轮", "primary", function () {
        dispatch({ type: "nextRound" });
      }));
    } else {
      hint.innerHTML = "";
    }

    // The wide display communicates turns through its team cards and phase label.
    if (wideMonitor()) {
      hint.textContent = "第 " + G.round + " " + T("roundUnit") + " · " + (G.sudden ? "加时 · " : "") + monitorPhase();
    } else if (ROLE === "monitor") {
      if (G.phase === "chooseCard") {
        hint.innerHTML = teamName(G.active, t.name) + " 的 " + T("psychic") + " 正在选择本轮题目，等待控制器确认。";
      } else if (G.phase === "psychic") {
        hint.innerHTML = teamName(G.active, t.name) + " 的 " + T("psychic") + " 正在查看" + T("target") + "并出题，请听取" + T("clue") + "。";
      } else if (G.phase === "dial") {
        hint.innerHTML = teamName(G.active, t.name) + " 讨论" + T("clue") + "并拖动金色" + T("dial") + "，确认后锁定；" + T("psychic") + " 请保持沉默。";
      } else if (G.phase === "revealed") {
        hint.innerHTML = (G.sudden ? "<b>" + T("suddenDeath") + " · </b>" : "") + "下一轮由 " +
          (G.catchup ? teamName(G.active, t.name) : teamName(WL.other(G.active), o.name)) +
          " 行动，请换一位新 " + T("psychic") + " 出题。";
      } else if (G.phase === "over" && G.result) {
        hint.innerHTML = G.result.draw ? "双方和局 · 加时仍平，精彩同频！" :
          teamName(G.result.winner, G.teams[G.result.winner].name) + " 获胜！ · 对局复盘" + (G.result.sudden ? "（加时赛决出）" : "");
      }
    }

    if (hint.innerHTML || wideMonitor()) {
      hint.innerHTML = "<span class='phase-message'>" + hint.innerHTML + "</span>";
    }

    if (!wideMonitor() && G.guess && (G.phase === "reveal" || G.phase === "revealed" || G.phase === "over")) {
      var guessSide = G.guess === "L"
        ? T("target") + "在" + T("dial") + "左边 ←"
        : T("target") + "在" + T("dial") + "右边 →";
      var guessStatus = "等待揭示";
      var guessClass = "pending";
      if (G.reveal) {
        if (G.reveal.oppPts === 1) {
          guessStatus = "猜对了！";
          guessClass = "correct";
        } else if (G.reveal.pts === 4) {
          guessStatus = T("perfectHit") + "，本次左右选择不计分";
          guessClass = "neutral";
        } else {
          guessStatus = "猜错了";
          guessClass = "wrong";
        }
      }
      hint.insertAdjacentHTML("beforeend",
        "<span class='guess-choice " + guessClass + "'>" +
        teamName(WL.other(G.active), o.name) +
        "<span>的选择：</span><strong>" + guessSide + "</strong>" +
        "<span class='guess-result'>· " + guessStatus + "</span></span>");
      hint.querySelector(".guess-choice").setAttribute("aria-label", o.name + " 选择" + (G.guess === "L" ? "左边" : "右边") +
        (G.reveal ? G.reveal.pts === 4 ? "，本次不计分" : G.reveal.oppPts ? "，猜对" : "，猜错" : "，等待揭晓"));
    }

    var pop = $("score-pop");
    if (!wideMonitor() && G.reveal && (G.phase === "revealed" || G.phase === "over")) {
      var r = G.reveal;
      var txt = teamName(G.active, t.name) + " 获得 <span class='pts" + (r.pts === 4 ? " pts4" : "") + "'>+" + r.pts + "</span> 分";
      if (r.oppPts === 1) {
        txt += " · " + teamName(WL.other(G.active), o.name) + " 猜对" + T("leftRight") + "，<span class='pts'>+1</span> 分";
      } else if (r.pts === 4) {
        txt += " · " + T("perfectHit") + "！对方无法得分";
      } else {
        txt += " · " + teamName(WL.other(G.active), o.name) + " 猜错，不得分";
      }
      pop.innerHTML = txt;
    } else {
      pop.textContent = "";
    }

    var ul = $("log");
    var logSignature = JSON.stringify([G.log, G.teams.A.name, G.teams.B.name, NAMES, wideMonitor()]);
    if (ul.dataset.entries === logSignature) return;
    ul.dataset.entries = logSignature;
    ul.innerHTML = "";
    G.log.forEach(function (e) {
      var li = document.createElement("li");
      var items = [
        { label: T("dial"), val: e.dialPct, team: true },
        { label: T("target"), val: e.targetPct, team: false }
      ].sort(function (a, b) { return a.val - b.val; });
      var labels = items.map(function (it) {
        return it.team
          ? "<span style='color:" + teamColor(e.team) + "'>" + it.label + "</span>"
          : it.label;
      }).join("-");
      var vals = items.map(function (it) {
        return "<span class='log-value " + (it.team ? "log-dial" : "log-target") + "' style='color:" + (it.team ? teamColor(e.team) : "#000") + "' aria-label='" + (it.team ? "拨杆" : "目标") + "'>" + WL.formatPercent(WL.toSignedPercent(it.val * WL.UNIT / 100)) + "</span>";
      }).join(" / ");
      var leftPoints = e.team === "A" ? e.pts : e.oppPts;
      var rightPoints = e.team === "B" ? e.pts : e.oppPts;
      var points = "<span class='log-points' data-team='A' style='color:" + teamColor("A") + "' aria-label='左队得分'>+" + leftPoints + "</span> / " +
        "<span class='log-points' data-team='B' style='color:" + teamColor("B") + "' aria-label='右队得分'>+" + rightPoints + "</span>";
      li.innerHTML = "<span class='log-round'>第 " + e.round + " " + T("roundUnit") + " · " + teamName(e.team, G.teams[e.team].name) +
        "（" + labels + " " + vals + "）</span><span class='log-separator'> · </span>" +
        "<span class='log-card'>卡片：<b></b></span><span class='log-separator'> · </span>" +
        "<span class='log-score'>左队 / 右队 " + points + "</span>";
      li.querySelector(".log-card b").textContent = e.pair[0] + " — " + e.pair[1];
      if (wideMonitor()) {
        li.querySelector(".log-round").textContent = "第 " + e.round + " " + T("roundUnit");
        li.querySelector(".log-card").firstChild.textContent = "";
        var title = document.createElement("span");
        title.className = "log-title";
        title.appendChild(li.querySelector(".log-round"));
        title.appendChild(li.querySelector(".log-card"));
        li.prepend(title);
        li.querySelector(".log-score").innerHTML = teamName(e.team, G.teams[e.team].name) + " · " + vals + " · " + points;
      }
      ul.appendChild(li);
    });
  }

  function renderModals() {
    if (G.phase !== "over") overDismissed = false;
    var showSetup = G.phase === "setup" && (ROLE === "controller" || (ROLE === "local" && !ONLINE));
    $("setup-modal").classList.toggle("hidden", !showSetup);
    if (showSetup) {
      $("opt-ordered").checked = !!G.ordered;
      $("opt-card-mode").value = G.cardMode;
      $("opt-winscore").value = G.winScore;
      $("opt-bandwidth").value = G.bandWidth;
    }

    var showDeckServer = ONLINE && ROLE === "controller";
    $("deck-server").style.display = showDeckServer ? "" : "none";
    if (showDeckServer && $("deck-select").options.length <= 1) refreshDeckList();

    var showOver = G.phase === "over" && G.result && !overDismissed && ROLE !== "monitor";
    $("over-modal").classList.toggle("hidden", !showOver);
    if (showOver) {
      var w = G.teams[G.result.winner];
      $("winner-text").textContent = G.result.draw ? "双方和局 · 精彩同频！" : "🏆 " + w.name + " 获胜！";
      $("winner-text").className = "winner" + (G.result.draw ? "" : G.result.winner === "A" ? " a" : " b");
      $("final-score").textContent = G.teams.A.name + " " + G.teams.A.score + " 分　VS　" + G.teams.B.name + " " + G.teams.B.score + " 分" +
        (G.result.sudden ? "（加时 " + G.sdPts.A + " : " + G.sdPts.B + (G.result.draw ? "，仍平）" : "）") :
          G.result.maxRounds ? "（" + WL.rulesFor(G).maxRounds + " 轮结算）" : "");
    }

    var isMonitor = ROLE === "monitor";
    document.body.classList.toggle("monitor-mode", isMonitor);
    document.body.dataset.phase = G.phase;
    var rules = document.querySelector("details.rules");
    rules.open = !!G.rulesOpen;
    rules.querySelector("summary").tabIndex = isMonitor ? -1 : 0;
    $("btn-restart").style.display = isMonitor ? "none" : "";
    $("btn-playagain").style.display = isMonitor ? "none" : "";
  }

  function mk(text, cls, fn) {
    var b = document.createElement("button");
    b.className = "btn" + (cls ? " " + cls : "");
    b.textContent = text;
    b.onclick = fn;
    return b;
  }

  function teamColor(letter) {
    return "var(--c" + (letter === "B" ? "B" : "A") + ")";
  }

  function teamName(letter, name) {
    return "<b class='team-name' style='color:" + teamColor(letter) + "'>" + name + "</b>";
  }

  function startGame() {
    var nA = $("input-nameA").value.trim() || T("teamDefaultA");
    var nB = $("input-nameB").value.trim() || T("teamDefaultB");
    var first = $("select-first").value;
    if (first === "R") first = Math.random() < 0.5 ? "A" : "B";
    psychicViewing = false;
    dispatch({ type: "setup", teamA: nA, teamB: nB, first: first, cardMode: $("opt-card-mode").value, ruleSet: $("opt-rule-set").value });
  }

  function deckMsg(text, ok) {
    var el = $("deck-msg");
    el.textContent = text;
    el.className = "deck-msg" + (ok ? " ok" : " err");
  }

  function refreshDeckList() {
    if (!ONLINE) return;
    fetch("/api/decks").then(function (r) {
      return r.json();
    }).then(function (j) {
      var sel = $("deck-select");
      sel.innerHTML = "";
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "— 选择题库（" + (j.decks ? j.decks.length : 0) + " 个）—";
      sel.appendChild(ph);
      (j.decks || []).forEach(function (d) {
        var o = document.createElement("option");
        o.value = d.file;
        o.textContent = d.name + " · " + d.cards + " 张卡";
        if (d.error) {
          o.textContent = d.name + "（格式错误）";
          o.disabled = true;
        }
        sel.appendChild(o);
      });
      sel.value = "";
    }).catch(function () {});
  }

  function renderDeckInfo() {
    $("deck-info").textContent = G.deckName + " · " + G.cards.length + " 张卡";
    $("deck-badge").textContent = G.deckName;
  }

  function loadDeckText(rawText, sourceName) {
    var parsed;
    try {
      parsed = WL.parseDeck(rawText);
    } catch (e) {
      deckMsg("题库加载失败：" + e.message, false);
      return;
    }
    if (ONLINE && ROLE === "controller") {
      fetch("/api/deck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sourceName, text: rawText })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "服务器错误"); });
      }).then(function () {
        deckMsg("题库已加载", true);
      }).catch(function (e) {
        deckMsg("题库加载失败：" + e.message, false);
      });
    } else {
      dispatch({ type: "loadDeck", name: parsed.name || sourceName || WL.DECK_NAME_DEFAULT, cards: parsed.cards });
      try { localStorage.setItem("wl_deck", JSON.stringify({ t: rawText, n: G.deckName })); } catch (e) {}
      deckMsg("已加载题库：" + G.deckName + "（" + G.cards.length + " 张卡）", true);
    }
  }

  function resetDeck() {
    $("deck-select").value = "";
    if (ONLINE && ROLE === "controller") {
      dispatch({ type: "resetDeck" });
      deckMsg("已恢复默认题库", true);
      return;
    }
    try { localStorage.removeItem("wl_deck"); } catch (e) {}
    dispatch({ type: "resetDeck" });
    deckMsg("已恢复默认题库（" + G.cards.length + " 张卡）", true);
    tryFetch("cards.yaml");
  }

  function tryFetch(url) {
    if (typeof fetch !== "function") return;
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.text();
    }).then(function (t) {
      var parsed = WL.parseDeck(t);
      dispatch({ type: "loadDeck", name: parsed.name || url.replace(/\.(json|ya?ml)$/i, ""), cards: parsed.cards });
      deckMsg("已加载题库：" + G.deckName + "（" + G.cards.length + " 张卡）", true);
    }).catch(function () {
      if (url === "cards.yaml") tryFetch("cards.json");
    });
  }

  function initLocalDeck() {
    var saved = null;
    try { saved = localStorage.getItem("wl_deck"); } catch (e) {}
    if (saved) {
      try {
        var obj = JSON.parse(saved);
        if (obj && typeof obj.t === "string") {
          var parsed = WL.parseDeck(obj.t);
          G.cards = parsed.cards;
          G.deckName = parsed.name || obj.n || "自定义题库";
          G.deck = [];
          render();
          return;
        }
      } catch (e) {
        try { localStorage.removeItem("wl_deck"); } catch (e2) {}
      }
    }
    tryFetch("cards.yaml");
  }

  function checkOnline() {
    if (typeof fetch !== "function") {
      afterOnlineCheck({ ok: false });
      return;
    }
    var done = false;
    var finish = function (info) {
      if (done) return;
      done = true;
      afterOnlineCheck(info);
    };
    fetch("api/ping").then(function (r) {
      return r.json().then(function (j) {
        finish({ ok: r.ok, authRequired: !!j.authRequired, authed: !!j.authed });
      });
    }).catch(function () {
      finish({ ok: false });
    });
    setTimeout(function () { finish({ ok: false }); }, 2500);
  }

  function afterOnlineCheck(info) {
    if (!info.ok) {
      ONLINE = false;
      setConn("local");
      initLocalDeck();
      render();
      return;
    }
    ONLINE = true;
    if (info.authRequired && !info.authed) {
      setConn("connecting");
      $("auth-modal").classList.remove("hidden");
      render();
      return;
    }
    enterOnline();
  }

  function enterGuest() {
    ONLINE = false;
    $("auth-modal").classList.add("hidden");
    $("auth-password").value = "";
    $("auth-msg").textContent = "";
    setConn("local");
    initLocalDeck();
    render();
  }

  function enterOnline() {
    setConn("connecting");
    connectSSE();
    startHeartbeat();
    $("role-modal").classList.remove("hidden");
    render();
  }

  function submitAuth() {
    var pass = $("auth-password").value;
    var msg = $("auth-msg");
    fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pass })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || "认证失败");
      });
    }).then(function () {
      $("auth-modal").classList.add("hidden");
      $("auth-password").value = "";
      $("auth-msg").textContent = "";
      enterOnline();
    }).catch(function (e) {
      msg.textContent = e.message;
      msg.className = "deck-msg err";
      $("auth-password").value = "";
      $("auth-password").focus();
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (!ONLINE || document.hidden) return;
    heartbeat();
    if (!sse) scheduleReconnect();
  });

  var interact = $("interact");
  interact.addEventListener("pointerdown", function (e) {
    if (G.phase !== "dial" || !canControl()) return;
    dragging = true;
    if (interact.setPointerCapture) interact.setPointerCapture(e.pointerId);
    setDialFromEvent(e);
    if (ONLINE && ROLE === "controller") {
      lastDialSync = Date.now();
      postIntent({ type: "setDial", value: G.dial });
    }
  });
  interact.addEventListener("pointermove", function (e) {
    if (!dragging || G.phase !== "dial") return;
    setDialFromEvent(e);
    if (ONLINE && ROLE === "controller") {
      var now = Date.now();
      if (now - lastDialSync > 60) {
        lastDialSync = now;
        postIntent({ type: "setDial", value: G.dial });
      }
    }
  });
  interact.addEventListener("pointerup", function () {
    if (dragging) {
      dragging = false;
      if (ONLINE && ROLE === "controller") {
        postIntent({ type: "setDial", value: G.dial });
      }
    }
  });

  $("btn-start").onclick = startGame;
  $("opt-rule-set").addEventListener("change", function () {
    dispatch({ type: "setRuleSet", value: this.value });
  });
  $("opt-card-mode").addEventListener("change", function () {
    dispatch({ type: "setCardMode", value: this.value });
  });
  $("opt-ordered").addEventListener("change", function () {
    dispatch({ type: "setOrdered", value: this.checked });
  });
  $("opt-winscore").addEventListener("change", function () {
    var v = Math.floor(Number(this.value));
    if (isNaN(v) || v < 0) v = 0;
    this.value = v;
    dispatch({ type: "setWinScore", value: v });
  });
  $("opt-bandwidth").addEventListener("change", function () {
    var v = Math.floor(Number(this.value));
    if (isNaN(v) || v < 2) v = WL.BAND_WIDTH;
    this.value = v;
    dispatch({ type: "setBandWidth", value: v });
  });
  $("btn-playagain").onclick = function () { dispatch({ type: "newGame" }); };
  document.querySelector("details.rules > summary").addEventListener("click", function (event) {
    event.preventDefault();
    if (ROLE === "monitor") return;
    dispatch({ type: "setRulesOpen", value: !G.rulesOpen });
  });
  $("btn-over-close").onclick = function () {
    overDismissed = true;
    render();
  };
  $("btn-restart").onclick = function () { dispatch({ type: "newGame" }); };
  $("btn-load-deck").onclick = function () { $("file-deck").click(); };
  $("btn-reset-deck").onclick = resetDeck;
  $("btn-builtin-deck").onclick = function () {
    $("deck-select").value = "";
    loadDeckText(JSON.stringify({ name: "通用题库", cards: WL.BUILTIN_DECK }));
  };
  $("btn-load-names").onclick = function () { $("file-names").click(); };
  $("btn-reset-names").onclick = resetNames;
  $("file-names").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      loadNamesText(String(reader.result));
    };
    reader.readAsText(f);
    this.value = "";
  });
  $("btn-deck-refresh").onclick = refreshDeckList;
  $("deck-select").addEventListener("change", function () {
    var f = this.value;
    if (!f) return;
    var sel = this;
    sel.value = "";
    fetch("/api/deck/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: f })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "加载失败"); });
    }).then(function () {
      deckMsg("题库已加载", true);
    }).catch(function (e) {
      deckMsg("题库加载失败：" + e.message, false);
    });
  });
  $("btn-role-controller").onclick = function () {
    ensureAudio();
    ROLE = "controller";
    $("role-modal").classList.add("hidden");
    render();
  };
  $("btn-role-monitor").onclick = function () {
    ensureAudio();
    ROLE = "monitor";
    $("role-modal").classList.add("hidden");
    render();
  };
  $("btn-auth").onclick = submitAuth;
  $("btn-guest").onclick = enterGuest;
  $("auth-password").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitAuth();
  });
  $("file-deck").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      loadDeckText(String(reader.result), f.name.replace(/\.(json|ya?ml)$/i, ""));
    };
    reader.readAsText(f);
    this.value = "";
  });

  render();
  initNames();
  checkOnline();
  setInterval(renderTimer, 200);
  setInterval(scrollDisplayPanels, 100);
  window.addEventListener("resize", render);
})();
