(() => {
  'use strict';
  const defaults = { a: '#B52C3A', b: '#8F3D7E' };
  const colors = { ...defaults };
  const $ = id => document.getElementById(id);
  const preview = $('preview');
  let gameDocument;
  const palettes = [
    { id: 'celadon', number: '01', name: '纸白青玉', tag: '首选推荐', colors: ['#C9DBCF', '#7BA58F', '#28594C'], ink: ['#233C31', '#18372D', '#FFFFFF'],
      cover: '#E5E1D8', coverInk: '#5C574D', coverBorder: '#B7B0A3', track: '#FAF8F2', outline: '#7D7567', dark: false,
      note: '暖纸色遮住目标，揭开后是由浅到深的青玉绿。空白底轨保留纸白，金色游标与红紫队色都能自然融入。', verdict: '整体最协调 · 适合现有白底、宋体与墨线边框', short: '暖纸遮挡，青玉揭晓。温润而清楚。' },
    { id: 'indigo', number: '02', name: '雾银靛青', tag: '已采用', colors: ['#CAD9E6', '#7F9DB9', '#365674'], ink: ['#263A4F', '#162F48', '#FFFFFF'],
      cover: '#DDE3E9', coverInk: '#45576A', coverBorder: '#A9B6C4', track: '#F5F7FA', outline: '#64778A', dark: false,
      note: '银灰遮挡与蓝白底轨衔接，得分区逐渐加深为靛青。冷色横条托住金色游标，画面更清爽。', verdict: '冷暖区分最清楚 · 金色游标在蓝灰背景上更突出', short: '雾银遮挡，靛青揭晓。清爽有层次。' },
    { id: 'champagne', number: '03', name: '烟墨鎏金', tag: '揭晓感强', colors: ['#E6D9BA', '#BDA06B', '#6D5228'], ink: ['#49391D', '#352A19', '#FFFFFF'],
      cover: '#363637', coverInk: '#F2EBE0', coverBorder: '#77716A', track: '#F6F1E6', outline: '#6E665A', dark: true,
      note: '中性的烟墨遮挡，揭开后转成暖白底轨与浅金、砂金、古金色带。隐藏与揭晓有明显明暗变化。', verdict: '揭晓前后反差最大 · 同色系游标依靠白色描边区分', short: '烟墨遮挡，鎏金揭晓。揭开时更鲜明。' },
    { id: 'graphite', number: '04', name: '暖灰岩墨', tag: '克制耐看', colors: ['#D8D3CC', '#A69D92', '#514B45'], ink: ['#38332F', '#2D2722', '#FFFFFF'],
      cover: '#D5D0C9', coverInk: '#554D45', coverBorder: '#AAA198', track: '#FAF8F5', outline: '#7A7167', dark: false,
      note: '暖灰遮挡接上石白底轨，再以浅砂、灰褐和岩墨区分分值。整条横条保持低彩度，让红紫队伍更突出。', verdict: '最安静的一套 · 把鲜艳留给两队和方向提示', short: '暖灰遮挡，岩墨揭晓。红紫始终醒目。' }
  ];
  const original = { id: 'original', name: '原版配色', colors: ['#E7A0BB', '#EDB86C', '#F0D377'], ink: ['#222222', '#222222', '#222222'],
    cover: '#263F4A', coverInk: '#FFFFFF', coverBorder: '#78929A', track: '#FFFFFF', outline: '#222222', dark: true,
    note: '原版是深蓝绿斜纹遮挡，揭晓后切换成粉、橙、黄三色；这里同时保留两个状态，方便对照。', verdict: '原版对照 · 保留遮挡斜纹、双线边框和数字底色' };
  let selected = palettes.find(p => p.id === (location.hash.startsWith('#direction-') ? new URLSearchParams(location.search).get('palette') : location.hash.slice(1))) || palettes[1];
  let comparing = false;
  let colorRevealed = false;
  const motions = [
    { id: 'pulse', number: '01', name: '半区呼吸', tag: '首选推荐', short: '选中一侧柔和明灭，最接近你说的闪烁。',
      description: '从游标到所选方向的端点，整段横条用队色缓慢明灭。约 1.8 秒一个呼吸，选择范围最直观。', verdict: '推荐搭配纸白青玉 · 大屏最容易看清选了哪一侧。' },
    { id: 'flow', number: '02', name: '流向光带', tag: '方向鲜明', short: '一道柔光从游标向所选端点流动。',
      description: '柔光从金色游标出发，反复流向左端或右端。光的运动方向就是队伍的选择。', verdict: '方向感最强 · 适合想让横条更有动势的场景。' },
    { id: 'outline', number: '03', name: '轮廓呼吸', tag: '克制清楚', short: '只让所选半区的轮廓呼吸，内部保持干净。',
      description: '只让所选区间的细边框缓慢明灭，内部保留轻微底色。保留原页面的墨线感。', verdict: '最克制 · 与白底墨线风格接近，远看稍弱。' },
    { id: 'arrows', number: '04', name: '箭头引导', tag: '已采用', short: '箭头朝所选方向流动，同侧外框随队色加粗。',
      description: '箭头从游标朝所选端点移动；该侧的上、下和端点边框全部变为队色并加粗。揭晓后停止箭头，保留边框。', verdict: '已搭配雾银靛青应用到正式界面。' }
  ];
  let study = location.hash.startsWith('#direction-') ? 'direction' : 'colors';
  let motion = motions.find(item => '#direction-' + item.id === location.hash) || motions[3];
  const direction = { side: 'R', team: 'b', position: 24, revealed: false, paused: false };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frameBaseHTML = '', frameLogHTML = '', framePreviousLogHTML = '', frameStudy = '';

  function paintPalette(element, palette) {
    palette.colors.forEach((color, index) => {
      element.style.setProperty('--band' + (index + 2), color);
      element.style.setProperty('--band' + (index + 2) + '-ink', palette.ink[index]);
    });
    element.style.setProperty('--band-label-bg', palette.id === 'original' ? 'rgba(255, 255, 255, .6)' : 'transparent');
    const originalPalette = palette.id === 'original';
    const variables = {
      '--screen-color': palette.cover, '--screen-ink': palette.coverInk, '--screen-border': palette.coverBorder,
      '--screen-texture': originalPalette ? 'repeating-linear-gradient(45deg, rgba(255,255,255,.035) 0 12px, transparent 12px 24px)' : 'none',
      '--screen-border-width': originalPalette ? '3px' : '1px', '--screen-border-style': originalPalette ? 'double' : 'solid',
      '--screen-tick': originalPalette ? 'rgba(35,35,35,.22)' : palette.coverInk + '33',
      '--screen-major-tick': originalPalette ? 'rgba(35,35,35,.65)' : palette.coverInk + '80',
      '--spectrum-track': palette.track, '--spectrum-outline': palette.outline,
      '--spectrum-tick': originalPalette ? 'rgba(35,35,35,.22)' : palette.outline + '33',
      '--spectrum-major-tick': originalPalette ? 'rgba(35,35,35,.65)' : palette.outline + '99',
      '--choice-wash-weight': palette.dark ? '45%' : '100%',
      '--choice-stroke-weight': palette.dark ? '55%' : '100%',
      '--choice-accent-weight': palette.dark ? '40%' : '100%',
      '--choice-pulse-low': palette.dark ? '.24' : '.10', '--choice-pulse-high': palette.dark ? '.72' : '.32',
      '--choice-flow-opacity': palette.dark ? '.65' : '.38', '--choice-arrow-opacity': palette.dark ? '.75' : '.85'
    };
    Object.entries(variables).forEach(([name, value]) => element.style.setProperty(name, value));
  }

  function renderPalette() {
    const palette = comparing ? original : selected;
    paintPalette($('detail-spectrum'), palette);
    paintPalette($('cover-spectrum'), palette);
    if (gameDocument) paintPalette(gameDocument.documentElement, palette);
    $('current-name').textContent = (palette.number ? palette.number + ' ' : '') + palette.name;
    $('detail-title').textContent = palette.name;
    $('palette-note').textContent = palette.note;
    $('palette-verdict').textContent = palette.verdict;
    $('compare').textContent = comparing ? '返回' + selected.name + '方案' : '对照原版配色';
    $('compare').setAttribute('aria-pressed', String(comparing));
    const swatches = [['遮挡', palette.cover], ['底轨', palette.track], ...palette.colors.map((color, index) => [(index + 2) + ' 分', color])];
    $('palette-values').replaceChildren(...swatches.map(([name, color]) => {
      const item = document.createElement('div');
      item.className = 'palette-value';
      const swatch = document.createElement('i');
      swatch.style.backgroundColor = color;
      const label = document.createElement('span');
      label.textContent = name;
      const hex = document.createElement('code');
      hex.textContent = color;
      item.append(swatch, label, hex);
      return item;
    }));
    document.querySelectorAll('[data-palette]').forEach(button => {
      button.setAttribute('aria-pressed', String(!comparing && button.dataset.palette === selected.id));
    });
    $('status').textContent = '当前方案：' + palette.name + ' · 左红 ' + colors.a + ' · 右紫 ' + colors.b;
    $('motion-palette').value = selected.id;
    document.querySelectorAll('[data-color-phase]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.colorPhase === 'revealed') === colorRevealed)));
    renderMotion();
  }

  palettes.forEach(palette => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-card';
    button.dataset.palette = palette.id;
    button.setAttribute('aria-pressed', 'false');
    paintPalette(button, palette);
    button.innerHTML = '<span class="palette-card-heading"><span class="palette-number">' + palette.number + '</span><span class="palette-tag">' + palette.tag + '</span><span class="selected-mark" aria-hidden="true">✓</span></span>' +
      '<span class="palette-title">' + palette.name + '</span><span class="palette-state-label">遮挡时</span><span class="mini-cover" aria-hidden="true"><span>目标隐藏</span><i></i></span><span class="palette-state-label">揭晓后</span><span class="mini-spectrum" aria-hidden="true"><span class="zone zone-2">2</span><span class="zone zone-3">3</span><span class="zone zone-4">4</span><span class="zone zone-3">3</span><span class="zone zone-2">2</span></span>' +
      '<span class="palette-short">' + palette.short + '</span>';
    button.addEventListener('click', () => {
      selected = palette;
      comparing = false;
      setHash(palette.id);
      renderPalette();
    });
    $('palettes').append(button);
    const option = document.createElement('option');
    option.value = palette.id;
    option.textContent = palette.name;
    $('motion-palette').append(option);
  });
  document.querySelectorAll('[data-color-phase]').forEach(button => button.addEventListener('click', () => {
    colorRevealed = button.dataset.colorPhase === 'revealed';
    renderPalette();
  }));
  $('compare').addEventListener('click', () => { comparing = !comparing; renderPalette(); });
  document.querySelectorAll('.zone').forEach(zone => {
    const number = document.createElement('span');
    number.className = 'zone-number';
    number.textContent = zone.textContent;
    zone.replaceChildren(number);
  });
  $('grayscale').addEventListener('change', event => {
    document.body.classList.toggle('grayscale', event.target.checked);
  });
  window.addEventListener('hashchange', () => {
    study = location.hash.startsWith('#direction-') ? 'direction' : 'colors';
    if (study === 'direction') {
      motion = motions.find(item => '#direction-' + item.id === location.hash) || motions[3];
      selected = palettes.find(p => p.id === new URLSearchParams(location.search).get('palette')) || selected;
    }
    else selected = palettes.find(p => p.id === location.hash.slice(1)) || palettes[1];
    comparing = false;
    renderStudy();
  });

  function setHash(hash) {
    try {
      const url = new URL(location.href);
      url.hash = hash;
      if (hash.startsWith('direction-')) url.searchParams.set('palette', selected.id);
      else url.searchParams.delete('palette');
      history.replaceState(null, '', url);
    } catch (_) { /* File previews may restrict history. */ }
  }

  function makeEffect(ownerDocument = document) {
    const effect = ownerDocument.createElement('div');
    effect.className = 'direction-effect';
    effect.setAttribute('aria-hidden', 'true');
    for (const part of ['wash', 'flow', 'outline', 'chevron']) {
      const layer = ownerDocument.createElement('i');
      layer.className = 'direction-' + part;
      effect.append(layer);
    }
    return effect;
  }

  function makeFrame(ownerDocument = document) {
    const frame = ownerDocument.createElement('div');
    frame.className = 'direction-frame';
    frame.setAttribute('aria-hidden', 'true');
    return frame;
  }

  function setFrame(host, side, position) {
    host.style.setProperty('--guess-clip-left', (side === 'L' ? 0 : position) + '%');
    host.style.setProperty('--guess-clip-right', (side === 'L' ? 100 - position : 0) + '%');
    host.querySelector('.direction-frame').hidden = !side;
  }

  motions.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-card motion-card';
    button.dataset.motion = item.id;
    button.innerHTML = '<span class="palette-card-heading"><span class="palette-number">' + item.number + '</span><span class="palette-tag">' + item.tag + '</span><span class="selected-mark" aria-hidden="true">✓</span></span>' +
      '<span class="palette-title">' + item.name + '</span><span class="motion-mini direction-host" data-effect="' + item.id + '" aria-hidden="true"><i class="motion-mini-dial"></i></span><span class="palette-short">' + item.short + '</span>';
    const effect = makeEffect();
    effect.style.left = '45%';
    effect.style.width = '55%';
    button.querySelector('.motion-mini').append(effect, makeFrame());
    button.addEventListener('click', () => {
      motion = item;
      direction.revealed = false;
      setHash('direction-' + item.id);
      renderMotion();
    });
    $('motions').append(button);
  });
  $('motion-spectrum').querySelector('.motion-axis').append(makeEffect(), makeFrame());

  function renderStudy() {
    document.body.dataset.study = study;
    document.querySelectorAll('[data-lab]').forEach(section => { section.hidden = section.dataset.lab !== study; });
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === study)));
    $('page-title').innerHTML = study === 'direction' ? '往哪边，让横条说<span>。</span>' : '遮住与揭开，都成一套<span>。</span>';
    document.querySelector('.intro .description').textContent = study === 'direction'
      ? '红紫代表队伍，金色标记猜测。让左右选择，从游标向一侧延伸。'
      : '红紫队色保留。遮挡条、空白底轨、得分色带与方向提示，一起重新配色。';
    $('preview').title = study === 'direction' ? '左右选择动效的活动屏预览，交互示例' : '遮挡与得分整体配色的活动屏预览，可切换揭晓状态';
    renderPalette();
    fitPreview();
  }

  function applyDirection(host) {
    const position = (direction.position + 100) / 2;
    const effect = host.querySelector('.direction-effect');
    host.dataset.effect = motion.id;
    host.dataset.revealed = String(direction.revealed);
    host.style.setProperty('--guess-color', colors[direction.team]);
    effect.hidden = !direction.side;
    effect.dataset.side = direction.side || '';
    effect.style.left = (direction.side === 'L' ? 0 : position) + '%';
    effect.style.width = (direction.side === 'L' ? position : 100 - position) + '%';
    setFrame(host, direction.side, position);
  }

  function signed(value) { return (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value) + '%'; }

  function renderMotion() {
    document.body.dataset.paused = String(direction.paused);
    document.body.dataset.motionStill = String(reducedMotion.matches);
    document.documentElement.style.setProperty('--direction-team', colors[direction.team]);
    const name = direction.team === 'a' ? '射命丸文' : '姬海棠果';
    const sideLabel = direction.side === 'L' ? '偏左 ←' : '偏右 →';
    const choice = direction.side ? name + '选择' + sideLabel : name + '尚未选择左右';
    const position = (direction.position + 100) / 2;
    const stage = $('motion-spectrum');
    paintPalette(stage, selected);
    applyDirection(stage);
    stage.style.setProperty('--dial-position', position + '%');
    stage.setAttribute('aria-label', choice + '，游标 ' + signed(direction.position) + (direction.revealed ? '，目标 +30%' : '，目标尚未揭晓'));
    $('motion-name').textContent = motion.name;
    $('motion-description').textContent = motion.description;
    $('motion-verdict').textContent = motion.verdict;
    $('motion-position-value').textContent = signed(direction.position);
    $('motion-choice').textContent = choice;
    $('motion-choice').style.color = colors[direction.team];
    $('motion-phase').textContent = direction.revealed ? '已揭晓 · 目标 +30%' : '等待揭晓 · 目标隐藏';
    $('motion-reveal').textContent = direction.revealed ? '返回等待揭晓' : '揭晓目标';
    $('motion-reveal').disabled = !direction.side;
    $('motion-pause').textContent = direction.paused ? '继续动画' : '暂停动画';
    $('motion-pause').setAttribute('aria-pressed', String(direction.paused));
    $('motion-pause').disabled = reducedMotion.matches;
    $('motion-accessibility').textContent = reducedMotion.matches ? '已跟随系统减少动态效果，当前显示静态提示。' : '揭晓后停止循环，留下方向轮廓。';
    let result = '点击「揭晓目标」，观察色带出现后提示如何收住。';
    if (!direction.side) result = '未作选择时，横条不显示方向提示。';
    else if (direction.revealed) {
      if (Math.abs(position - 65) <= 1.6) result = '游标命中 4 分区，本轮左右选择不计分。';
      else result = '目标在游标' + (position < 65 ? '右侧' : '左侧') + ' · ' + name + (direction.side === (position < 65 ? 'R' : 'L') ? '猜对方向。' : '猜错方向。');
    } else if ((direction.side === 'R' && position === 100) || (direction.side === 'L' && position === 0)) result = '游标已在所选方向的端点，这一侧没有可高亮的区间。';
    $('motion-result').textContent = result;
    document.querySelectorAll('[data-motion]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.motion === motion.id)));
    document.querySelectorAll('button[data-direction]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.direction === (direction.side || 'none'))));
    document.querySelectorAll('.motion-mini').forEach(mini => {
      paintPalette(mini, selected);
      mini.style.setProperty('--guess-color', colors[direction.team]);
      mini.querySelector('.direction-effect').dataset.side = direction.side || 'R';
      mini.querySelector('.direction-effect').style.left = direction.side === 'L' ? '0%' : '45%';
      mini.querySelector('.direction-effect').style.width = direction.side === 'L' ? '45%' : '55%';
      setFrame(mini, direction.side || 'R', 45);
    });
    if (gameDocument && frameBaseHTML) {
      if (frameStudy !== study) {
        gameDocument.body.innerHTML = frameBaseHTML;
        frameStudy = study;
      }
      gameDocument.body.dataset.paused = String(direction.paused);
      gameDocument.body.dataset.motionStill = String(reducedMotion.matches);
      if (study === 'direction') {
        const axis = gameDocument.querySelector('.axis');
        axis.classList.add('direction-host', 'native-direction');
        if (!axis.querySelector('.direction-effect')) axis.append(makeEffect(gameDocument), makeFrame(gameDocument));
        applyDirection(axis);
        gameDocument.querySelector('.dial').style.left = position + '%';
        gameDocument.body.dataset.phase = direction.revealed ? 'revealed' : direction.side ? 'reveal' : 'guess';
        gameDocument.querySelector('.phase-message').textContent = choice;
        gameDocument.querySelector('.display-footer').textContent = direction.revealed ? '目标 +30% · ' + (Math.abs(position - 65) <= 1.6 ? '4 分命中' : '游标 ' + signed(direction.position)) : '游标 ' + signed(direction.position) + ' · 等待揭晓';
        for (const team of ['a', 'b']) {
          const panel = gameDocument.querySelector('.team.' + team);
          const arrow = panel.querySelector('.team-direction');
          panel.classList.toggle('is-active', team === direction.team);
          arrow.textContent = team === direction.team && direction.side ? (direction.side === 'L' ? '←' : '→') : '';
          arrow.dataset.direction = team === direction.team ? direction.side || '' : '';
          arrow.setAttribute('aria-label', team === direction.team ? choice : '');
        }
      } else {
        gameDocument.body.dataset.phase = colorRevealed ? 'revealed' : 'reveal';
        gameDocument.querySelector('.phase-message').textContent = colorRevealed ? '第 3 轮 · 揭晓结算' : '第 3 轮 · 目标已隐藏';
        gameDocument.querySelector('.display-footer').textContent = colorRevealed ? '游标 +24% · 目标 +30%' : '游标 +24% · 等待揭晓';
        gameDocument.querySelectorAll('.team-direction').forEach(arrow => { arrow.textContent = ''; arrow.dataset.direction = ''; arrow.removeAttribute('aria-label'); });
      }
      const revealed = study === 'direction' ? direction.revealed : colorRevealed;
      gameDocument.querySelector('.screen').classList.toggle('open', revealed);
      gameDocument.querySelector('.bands').style.visibility = revealed ? 'visible' : 'hidden';
      gameDocument.querySelector('.center-mark').classList.toggle('shown', revealed);
      // Neither state preview shows current-round results before the reveal.
      gameDocument.querySelector('.log ul').innerHTML = revealed ? frameLogHTML : framePreviousLogHTML;
    }
    if (study === 'direction') {
      $('current-name').textContent = motion.name + ' / ' + selected.name;
      $('status').textContent = motion.name + ' · ' + choice + ' · 交互示例';
    }
  }

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    study = button.dataset.view;
    comparing = false;
    setHash(study === 'direction' ? 'direction-' + motion.id : selected.id);
    renderStudy();
  }));
  document.querySelectorAll('button[data-direction]').forEach(button => button.addEventListener('click', () => {
    direction.side = button.dataset.direction === 'none' ? null : button.dataset.direction;
    direction.revealed = false;
    renderMotion();
  }));
  $('motion-team').addEventListener('change', event => { direction.team = event.target.value; renderMotion(); });
  $('motion-palette').addEventListener('change', event => { selected = palettes.find(item => item.id === event.target.value); setHash('direction-' + motion.id); renderPalette(); });
  $('motion-position').addEventListener('input', event => { direction.position = Number(event.target.value); renderMotion(); });
  $('motion-reset-position').addEventListener('click', () => { direction.position = 24; $('motion-position').value = '24'; renderMotion(); });
  $('motion-reveal').addEventListener('click', () => { direction.revealed = !direction.revealed; renderMotion(); });
  $('motion-pause').addEventListener('click', () => { direction.paused = !direction.paused; renderMotion(); });
  reducedMotion.addEventListener('change', renderMotion);

  function applyColor(team, value, syncHex = true) {
    colors[team] = value.toUpperCase();
    document.documentElement.style.setProperty('--' + team, colors[team]);
    gameDocument?.documentElement.style.setProperty('--c' + team.toUpperCase(), colors[team]);
    $('color-' + team).value = colors[team];
    if (syncHex) $('hex-' + team).value = colors[team];
    $('hex-' + team).removeAttribute('aria-invalid');
    $('error-' + team).textContent = '';
    document.querySelectorAll('[data-team="' + team + '"] [data-color]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.color === colors[team]));
    });
    renderPalette();
  }

  function fitPreview() {
    const scale = $('zoom').value === 'fit' ? Math.min(1, $('viewport').clientWidth / 3904) : 1;
    preview.style.transform = `scale(${scale})`;
    $('canvas-holder').style.width = 3904 * scale + 'px';
    $('canvas-holder').style.height = 672 * scale + 'px';
    $('scale-label').textContent = Math.round(scale * 100) + '%';
  }

  preview.addEventListener('load', () => {
    gameDocument = preview.contentDocument;
    const ticks = gameDocument.getElementById('ticks');
    for (let i = 1; i < 20; i++) {
      const tick = gameDocument.createElement('i');
      tick.className = 'tick-mark' + (i % 5 === 0 ? ' major' : '');
      tick.style.left = i * 5 + '%';
      ticks.append(tick);
    }
    frameBaseHTML = gameDocument.body.innerHTML;
    const previousLog = gameDocument.querySelector('.log ul').cloneNode(true);
    frameLogHTML = previousLog.innerHTML;
    previousLog.firstElementChild?.remove();
    framePreviousLogHTML = previousLog.innerHTML;
    gameDocument.head.append($('direction-styles').cloneNode(true));
    for (const team of ['a', 'b']) applyColor(team, colors[team]);
    fitPreview();
  });
  preview.srcdoc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>' +
    '<body class="monitor-mode" data-phase="revealed">' +
    $('game-template').innerHTML + '</body></html>';

  for (const team of ['a', 'b']) {
    $('color-' + team).addEventListener('input', event => applyColor(team, event.target.value));
    const hex = $('hex-' + team);
    function readHex(commit = false) {
      let value = hex.value.trim();
      if (!value.startsWith('#')) value = '#' + value;
      if (commit && /^#[0-9a-f]{3}$/i.test(value)) value = '#' + [...value.slice(1)].map(char => char + char).join('');
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        applyColor(team, value, commit);
      } else if (commit) {
        hex.setAttribute('aria-invalid', 'true');
        $('error-' + team).textContent = '请输入 3 位或 6 位十六进制色值，例如 ' + defaults[team] + '。';
      } else {
        hex.removeAttribute('aria-invalid');
        $('error-' + team).textContent = '';
      }
    }
    hex.addEventListener('input', () => readHex());
    hex.addEventListener('change', () => readHex(true));
    hex.addEventListener('keydown', event => {
      if (event.key === 'Enter') readHex(true);
      if (event.key === 'Escape') applyColor(team, colors[team]);
    });
    document.querySelectorAll('[data-team="' + team + '"] [data-color]').forEach(button => {
      button.addEventListener('click', () => applyColor(team, button.dataset.color));
    });
    applyColor(team, colors[team]);
  }

  $('reset').addEventListener('click', () => {
    for (const team of ['a', 'b']) applyColor(team, defaults[team]);
    $('status').textContent = '已恢复：左侧 ' + defaults.a + ' · 右侧 ' + defaults.b;
  });
  $('zoom').addEventListener('change', fitPreview);
  new ResizeObserver(fitPreview).observe($('viewport'));
  renderStudy();
})();
