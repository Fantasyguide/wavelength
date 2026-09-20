(function () {
  "use strict";

  var G = WL.createGame();
  var ONLINE = false;
  var ROLE = "local";
  var psychicViewing = false;
  var dragging = false;
  var lastDialSync = 0;
  var overDismissed = false;

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
    gameName: "Wavelength",
    gameTitle: "WAVELENGTH",
    gameSubtitle: "心灵波长",
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
    teamDefaultA: "左脑",
    teamDefaultB: "右脑",
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
    $("setup-title").textContent = "🎧 " + T("gameName");
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
        namesMsg("已加载服务器文案，游戏名：" + T("gameName"), true);
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
    $("nameA").textContent = A.name;
    $("nameB").textContent = B.name;
    $("scoreA").textContent = A.score;
    $("scoreB").textContent = B.score;
    renderTrack("trackA", A.score, "a");
    renderTrack("trackB", B.score, "b");
    renderDeckInfo();
    renderTurn();
    renderCard();
    renderBands();
    renderTicks();
    renderControls();
    renderDial();
    renderTargetVisibility();
    renderModals();
    renderTimer();
  }

  function renderTrack(id, score, cls) {
    var el = $(id);
    el.innerHTML = "";
    el.className = "score-track " + cls;
    var limit = G.winScore > 0 ? Math.min(G.winScore, 40) : 30;
    for (var i = 0; i < limit; i++) {
      var d = document.createElement("i");
      if (i < score) d.className = "on";
      el.appendChild(d);
    }
    if (G.winScore === 0) {
      var inf = document.createElement("span");
      inf.textContent = "∞";
      el.appendChild(inf);
    }
  }

  function renderTurn() {
    var t = G.teams[G.active];
    var who = "<b class='" + (G.active === "A" ? "a" : "b") + "'>" + t.name + "</b>";
    if (G.catchup) {
      $("turn-indicator").innerHTML = "🔥 " + T("catchup") + "触发：" + who + " 本轮 4 分且仍落后，继续行动！";
      $("banner").textContent = T("catchup") + "：4 分 + 落后 = " + G.teams[G.active].name + " 立刻再行动一轮（换一位新 " + T("psychic") + "）";
      $("banner").classList.remove("hidden");
    } else {
      $("turn-indicator").innerHTML = "轮到 " + who + " 行动";
      $("banner").classList.add("hidden");
    }
  }

  function renderCard() {
    var c = G.card;
    var box = $("sides");
    box.innerHTML = "";
    box.classList.toggle("choosing", G.phase === "chooseCard");
    $("card-frame").classList.toggle("choosing", G.phase === "chooseCard");
    var label = "第 " + G.round + " " + T("roundUnit") + " · " + G.teams[G.active].name + " 的 " + T("psychic");
    if (G.phase === "chooseCard") {
      $("card-label").textContent = label + " 选题";
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
    $("card-label").textContent = label + " 读卡";
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
      label.textContent = position + "%";
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
        d.appendChild(s);
      }
      box.appendChild(d);
    }
    add("b2", t.center - t.w2, t.center - t.w3, "2分");
    add("b3", t.center - t.w3, t.center - t.w4, "3分");
    add("b4", t.center - t.w4, t.center + t.w4, "4分");
    add("b3", t.center + t.w4, t.center + t.w3, "3分");
    add("b2", t.center + t.w3, t.center + t.w2, "2分");
    $("center-mark").style.left = (t.center / WL.UNIT * 100) + "%";
  }

  function renderDial() {
    $("dial").style.left = (G.dial / WL.UNIT * 100) + "%";
    var lock = G.phase === "dial" && canControl();
    $("interact").classList.toggle("lock-touch", lock);
    $("interact").classList.toggle("disabled", !lock);
  }

  function setDialFromEvent(e) {
    var rect = $("axis").getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    G.dial = WL.clampDial(Math.round(pct * WL.UNIT));
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
      hint.innerHTML = teamName(G.active, t.name) + " 的 " + T("psychic") +
        (G.cardChoices.length > 1 ? "：从上方两道题中选择本轮题目，选定后继续出题。" : "：题库只有一道不同的题，点击上方题目后继续出题。") +
        (ROLE === "monitor" ? " 等待控制器选择…" : "");
    } else if (G.phase === "psychic") {
      hint.innerHTML = teamName(G.active, t.name) + " 的 " + T("psychic") + " 步骤：选好卡片面 → 点击「查看" + T("target") + "」（<span class='warn'>请确保其他人没有偷看屏幕！</span>）→ 口述" + T("clue") + " → 关闭" + T("screen") + "，之后不能再说话。";
      if (control) {
        if (psychicViewing) {
          box.appendChild(mk("我记住了，关闭" + T("screen"), "magenta", function () {
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
      hint.innerHTML = teamName(G.active, t.name) + " 全队讨论" + T("clue") + "，拖动金色" + T("dial") + "到猜测位置（<span class='warn'>" + T("psychic") + " 请保持沉默）</span>，然后锁定。";
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
      hint.innerHTML = teamName(WL.other(G.active), o.name) + " 猜：" + T("target") + "的 <b>中心" + T("wedge") + "</b>（4 分处）在" + T("dial") + "的<b>左边</b>还是<b>右边</b>？";
      if (control) {
        box.appendChild(mk(T("target") + "在" + T("dial") + "左边 ←", "primary", function () {
          dispatch({ type: "guess", guess: "L" });
        }));
        box.appendChild(mk(T("target") + "在" + T("dial") + "右边 →", "magenta", function () {
          dispatch({ type: "guess", guess: "R" });
        }));
      }
    } else if (G.phase === "reveal") {
      hint.innerHTML = teamName(G.active, t.name) + " 的 " + T("psychic") + " 揭示" + T("target") + "！";
      if (control) box.appendChild(mk("揭示" + T("target") + "！", "primary", function () {
        dispatch({ type: "reveal" });
      }));
    } else if (G.phase === "revealed") {
      hint.innerHTML = G.sudden
        ? "<b>" + T("suddenDeath") + "！</b>平分后继续，直到分出胜负。下一轮由 " + (G.catchup ? teamName(G.active, t.name) : teamName(WL.other(G.active), G.teams[WL.other(G.active)].name)) + " 行动（换一位新 " + T("psychic") + "）。"
        : "下一轮由 " + (G.catchup ? teamName(G.active, t.name) : teamName(WL.other(G.active), o.name)) + " 行动，别忘了换一位新 " + T("psychic") + " 出题。";
      if (control) box.appendChild(mk("开始下一轮", "primary", function () {
        dispatch({ type: "nextRound" });
      }));
    } else {
      hint.innerHTML = "";
    }

    if (hint.innerHTML) {
      hint.innerHTML = "<span class='phase-message'>" + hint.innerHTML + "</span>";
    }

    if (G.guess && (G.phase === "reveal" || G.phase === "revealed" || G.phase === "over")) {
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
    }

    var pop = $("score-pop");
    if (G.reveal && (G.phase === "revealed" || G.phase === "over")) {
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
    ul.innerHTML = "";
    G.log.forEach(function (e) {
      var li = document.createElement("li");
      var items = [
        { label: T("target"), val: e.targetPct, team: false },
        { label: T("dial"), val: e.dialPct, team: true }
      ].sort(function (a, b) { return a.val - b.val; });
      var labels = items.map(function (it) {
        return it.team
          ? "<span style='color:" + teamColor(e.team) + "'>" + it.label + "</span>"
          : it.label;
      }).join("-");
      var vals = items.map(function (it) {
        return it.team
          ? "<span style='color:" + teamColor(e.team) + "'>" + it.val + "%</span>"
          : it.val + "%";
      }).join("-");
      var opp = WL.other(e.team);
      li.innerHTML = "第 " + e.round + " " + T("roundUnit") + " · " + teamName(e.team, G.teams[e.team].name) +
        "（" + labels + " " + vals + "）· 卡片：<b>" +
        e.pair[0] + " — " + e.pair[1] + "</b> · 本队 <span style='color:" + teamColor(e.team) + "'>+" + e.pts + "</span> / 对方 <span style='color:" + teamColor(opp) + "'>+" + e.oppPts + "</span>";
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

    var showOver = G.phase === "over" && G.result && !overDismissed;
    $("over-modal").classList.toggle("hidden", !showOver);
    if (showOver) {
      var w = G.teams[G.result.winner];
      $("winner-text").textContent = "🏆 " + w.name + " 获胜！";
      $("winner-text").className = "winner " + (G.result.winner === "A" ? "a" : "b");
      $("final-score").textContent = "蓝队（" + G.teams.A.name + "）" + G.teams.A.score + " 分　VS　粉队（" + G.teams.B.name + "）" + G.teams.B.score + " 分" + (G.result.sudden ? "（加时赛决出）" : G.result.maxRounds ? "（10 局结算）" : "");
    }

    var isMonitor = ROLE === "monitor";
    document.body.classList.toggle("monitor-mode", isMonitor);
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
    return "<b style='color:" + teamColor(letter) + "'>" + name + "</b>";
  }

  function startGame() {
    var nA = $("input-nameA").value.trim() || "左脑";
    var nB = $("input-nameB").value.trim() || "右脑";
    var first = $("select-first").value;
    if (first === "R") first = Math.random() < 0.5 ? "A" : "B";
    psychicViewing = false;
    dispatch({ type: "setup", teamA: nA, teamB: nB, first: first, cardMode: $("opt-card-mode").value });
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
        deckMsg("已发送题库到服务器，所有设备将同步更新…", true);
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
      deckMsg("已加载服务器题库，所有设备已同步", true);
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
})();
