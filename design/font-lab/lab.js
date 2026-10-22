(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const payload = JSON.parse($('lab-payload').textContent);
  const clone = value => JSON.parse(JSON.stringify(value));
  const quoted = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, ' ') + '"';
  const NUMERIC_RANGE = 'U+0025,U+002B-003A,U+003D,U+00B1-00B3,U+00B9,U+00BC-00BE,U+2070-209F,U+2150-218F,U+2212,U+FF05,U+FF0B-FF1A,U+FF1D';
  const groups = [
    {id:'names', label:'两队队名', selectors:'.team .tname,.team-name', sizeSelectors:'.team .tname', font:'Wavelength PingXian', size:116, weight:500, line:1, stroke:.008, sample:'幻想乡 · 外来人 01', note:'默认平显雅宋，原字体为常规体，队名用 0.008em 微量描边增重。字号是上限，长队名会缩小。记录里的队名只同步字形。'},
    {id:'concepts', label:'大题目 / 概念', selectors:'.side .con', sizeSelectors:'.side .con', font:'Wavelength YaShi', size:100, weight:400, line:1.1, sample:'讨好型人格 — 反驳型人格', note:'默认雅士黑。二选一题卡按 72 / 100 的比例使用较小字号；中间横线始终居中。'},
    {id:'headings', label:'栏目标题', selectors:'.log h3,.audience-heading h3', font:'Wavelength Song', size:40, weight:400, line:1.2, sample:'轮次记录 · 群友竞猜', note:'修改左右两侧的栏目标题。'},
    {id:'phase', label:'阶段 / 提示', selectors:'.phase-message', font:'FZYaSongS-B-GB', size:56, weight:400, line:1.1, sample:'第 3 轮 · 结算', note:'默认使用 FZCYSJW（FZYaSongS-B-GB）的原始字形。阶段文字位于长条上方。'},
    {id:'history', label:'记录正文', selectors:'.log li,.log-card b', sizeSelectors:'.log li', font:'Wavelength Source Han Serif', size:48, weight:500, line:1.25, sample:'永远的幻想乡 — 短暂的异变', note:'题目与第几轮在同一行。记录中的数字使用独立数字字体；可在预览中滚动长记录。'},
    {id:'audience', label:'群友昵称', selectors:'.audience-person strong,.audience-avatar', sizeSelectors:'.audience-person strong', font:'Wavelength WenKai', size:36, weight:700, line:1.1, synthesize:true, sample:'博丽灵梦 · 雾雨魔理沙', note:'修改群友榜昵称与头像里的文字。'},
    {id:'audienceMeta', label:'群友状态 / 目标', selectors:'.audience-prompt,.audience-status', sizeSelectors:'.audience-prompt', font:'Wavelength Source Han Serif', size:32, weight:500, line:1.2, sample:'目标 -50% · 已截止 · 5 人', note:'修改群友栏的目标、状态和参与人数；状态字号按 30 / 32 的比例显示。'},
    {id:'scores', label:'大比分', selectors:'.team .tscore', font:'Wavelength Score', size:208, weight:700, line:1, numeric:true, sample:'0 1 4 8 10 99', note:'默认思源宋体 Bold 数字，在队框内上下居中。可单独换用其他清晰数字字体。'},
    {id:'numbers', label:'其他数字', selectors:'.tick-number,.band-label,.audience-rank,.audience-person > span,.audience-error,.log-score,.team-gain', sizeSelectors:'.tick-number', font:'Wavelength Numeric', size:30, weight:700, line:1.1, numeric:true, sample:'−100%　0%　+100%　+4　１２３', note:'修改刻度、得分、榜单数值，也保护题目和名字里夹着的数字。字号以刻度为基准。'},
    {id:'timer', label:'计时器', selectors:'.timer-display', font:'Wavelength Numeric', size:64, weight:700, line:1, numeric:true, sample:'00:15　01:00', note:'倒计时位于最下方；试验台在各阶段都显示，方便选字体。'},
    {id:'brand', label:'页首英文标题', selectors:'#title-main', font:'Wavelength Source Han Serif', size:44, weight:400, line:1, spacing:3, sample:'Returned', note:'修改页首英文标题；中文小标题保留原作言宋。'}
  ];
  const paletteLabels = {a:'左队 / 左端',b:'右队 / 右端',ink:'正文',dim:'辅助文字',background:'背景',cursor:'拨杆',arrow:'方向箭头',band2:'2 分色带',band3:'3 分色带',band4:'4 分色带'};
  const texts = {teamA:'幻想乡',teamB:'外来人',left:'讨好型人格',right:'反驳型人格',left2:'岁月静好',right2:'负重前行',nicknames:'博丽灵梦\n雾雨魔理沙\n十六夜咲夜\n东风谷早苗\n魂魄妖梦',mixed:'第 3 轮 · 温度 100°C · １２３４ · −50%'};
  const defaults = {format:'wavelength-font-lab',version:1,baseline:'straight-arrows-16',canvas:{width:3904,height:672},stage:'revealed',palette:{a:'#079c94',b:'#de5458',ink:'#222222',dim:'#676767',background:'#ffffff',cursor:'#94651a',arrow:'#d3d3d3',band2:'#e7a0bb',band3:'#edb86c',band4:'#f0d377'},text:clone(texts),groups:Object.fromEntries(groups.map(g=>[g.id,{font:g.font,size:g.size,weight:g.weight,line:g.line,spacing:g.spacing||0,stroke:g.stroke||0,color:null,synthesize:!!g.synthesize,italic:false}]))};
  const STORAGE = 'wavelength-font-lab-straight-arrows-16';
  let settings = clone(defaults), selected = 'names', uploaded = [], reference = null, showingA = false;
  let frameDocument = null, scale = 1, checkTimer, savedTimer, renderEpoch = 0, probeEpoch = 0;
  let fontMetadata = new Map();
  const fontLabels = new Map([['Wavelength PingXian','内置 · 方正平显雅宋'],['Wavelength YaShi','内置 · 方正雅士黑'],['FZYaSongS-B-GB','内置 · 方正粗雅宋 FZCYSJW'],['Wavelength Song','内置 · 造字工房言宋'],['Wavelength Source Han Serif','内置 · 思源宋体'],['Wavelength Score','内置 · 思源宋体 Bold 数字'],['Wavelength WenKai','内置 · 霞鹜文楷'],['Wavelength Numeric','内置 · 清晰数字'],['Wavelength Sans','内置 · DejaVu Sans'],['Wavelength Old Mincho','内置 · 方正 FW 筑紫 A 老明朝 D']]);
  const suggestions = ['SimSun','NSimSun','FangSong','STSong','STZhongsong','STFangsong','STKaiti','STXingkai','Microsoft YaHei','DengXian','宋体','仿宋','华文中宋','华文宋体','方正小标宋简体','方正书宋简体','方正姚体','思源宋体 CN','Source Han Serif SC','Noto Serif CJK SC','Arial','Georgia','Times New Roman','Consolas','Bahnschrift','DIN Alternate','Segoe UI'];
  const catalogue = new Map([...fontLabels].map(([family,label])=>[family,{family,label,source:'bundled'}]));
  suggestions.forEach(family=>catalogue.set(family,{family,label:'常见 · '+family,source:'suggested'}));

  function normalize(input) {
    if (!input || input.format !== defaults.format || input.version !== 1) throw new Error('这不是本试验台的方案文件。');
    const result = clone(defaults);
    const bounded = (value,min,max,fallback) => Number.isFinite(Number(value)) ? Math.max(min,Math.min(max,Number(value))) : fallback;
    const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
    if (['revealed','chooseCard','dial','over'].includes(input.stage)) result.stage=input.stage;
    for (const key of Object.keys(result.palette)) result.palette[key]=color(input.palette?.[key])||result.palette[key];
    for (const key of Object.keys(result.text)) if (typeof input.text?.[key] === 'string') result.text[key]=input.text[key].slice(0,2000);
    for (const group of groups) {
      const from=input.groups?.[group.id], to=result.groups[group.id];
      if (!from || typeof from !== 'object') continue;
      if (typeof from.font === 'string' && from.font.trim()) to.font=from.font.trim().slice(0,240);
      if (!input.baseline) to.font=({'FZPingXianYaSong-R-GBK':'Wavelength PingXian','FZYaShiHeiS':'Wavelength YaShi','Source Han Serif SC':group.id==='scores'?'Wavelength Score':'Wavelength Source Han Serif'})[to.font]||to.font;
      if (group.numeric && blockedNumeric(to.font)) to.font=group.font;
      to.size=bounded(from.size,8,320,to.size);to.weight=bounded(from.weight,100,900,to.weight);
      to.stroke=bounded(from.stroke,0,.08,to.stroke);
      to.line=bounded(from.line,.8,2.5,to.line);to.spacing=bounded(from.spacing,-4,30,to.spacing);
      to.color=color(from.color);to.synthesize=!!from.synthesize;to.italic=!!from.italic;
    }
    return result;
  }
  function blockedNumeric(font) { return /Wavelength Song|YanSong|燕宋|言宋|AaGothic|康熙/i.test(font+' '+(fontLabels.get(font)||'')); }
  function validAssets(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(a=>a && typeof a.family==='string' && /^Lab File [a-zA-Z0-9_-]+$/.test(a.family) && typeof a.uri==='string' && /^data:font\/(?:ttf|otf|woff|woff2);base64,[a-zA-Z0-9+/=]+$/.test(a.uri)).map(a=>({family:a.family,label:String(a.label||a.family).slice(0,240),uri:a.uri,weight:400}));
  }
  try {
    const baked = JSON.parse($('lab-saved').textContent);
    if (baked) { settings=normalize(baked.settings);uploaded=validAssets(baked.fonts); }
    else {
      const stored=JSON.parse(localStorage.getItem(STORAGE)||'null');
      if (stored) settings=normalize(stored);
    }
  } catch (_) { /* A standalone file still works when storage is unavailable. */ }
  for (const asset of uploaded) addAssetToCatalogue(asset);
  function addAssetToCatalogue(asset) {
    fontLabels.set(asset.family,'文件 · '+asset.label);
    catalogue.set(asset.family,{family:asset.family,label:'文件 · '+asset.label,source:'file'});
  }
  function assetCss(assets) {
    return assets.map(a=>'@font-face{font-family:'+quoted(a.family)+';src:url('+quoted(a.uri)+');font-weight:'+(a.weight||400)+';font-style:normal;font-display:swap;'+(a.unicodeRange?'unicode-range:'+a.unicodeRange+';':'')+'}').join('\n');
  }
  function localSources(family,weight) {
    const faces=fontMetadata.get(family)||[];
    const desired=faces.find(f=>weight>=600?/bold|semibold|demi/i.test(f.style):/regular|normal|roman|book/i.test(f.style));
    const names=desired?[desired.postscriptName,desired.fullName]:weight>=600?[family+' Bold',family+'-Bold',family]:[family];
    return [...new Set(names.filter(Boolean))].map(n=>'local('+quoted(n)+')').join(',');
  }
  function numeralCss(state) {
    const font=state.groups.numbers.font;
    if (font==='Wavelength Numeric') return '';
    const assets=[...payload.fonts,...uploaded].filter(a=>a.family===font);
    if (assets.length) return assetCss(assets.map(a=>({...a,family:'Lab Inline Digits',unicodeRange:NUMERIC_RANGE})));
    return [400,700].map(weight=>'@font-face{font-family:"Lab Inline Digits";src:'+localSources(font,weight)+';font-weight:'+weight+';unicode-range:'+NUMERIC_RANGE+';}').join('\n');
  }
  function stack(state,group) {
    const font=state.groups[group.id].font;
    const lead=group.numeric?'':(state.groups.numbers.font==='Wavelength Numeric'?'"Wavelength Numeric",':'"Lab Inline Digits","Wavelength Numeric",');
    return lead+quoted(font)+',"Wavelength Numeric","Wavelength Source Han Serif","Microsoft YaHei",serif';
  }
  function stateCss(state,forExport=false) {
    const p=state.palette, lines=[numeralCss(state),':root{--cA:'+p.a+';--cB:'+p.b+';--cyan:'+p.a+';--magenta:'+p.b+';--ink:'+p.ink+';--txt:'+p.ink+';--dim:'+p.dim+';--bg:'+p.background+';--panel2:'+p.background+';--gold:'+p.cursor+'}'];
    lines.push('body.monitor-mode{--panel:'+p.background+'99;--team-backdrop:'+p.arrow+'}');
    for (const group of groups) {
      const g=state.groups[group.id];
      const synth=[g.synthesize?'weight':'',g.italic?'style':''].filter(Boolean).join(' ')||'none';
      const selectors=group.selectors.split(',').map(s=>'body.monitor-mode '+s).join(',');
      lines.push(selectors+'{font-family:'+stack(state,group)+'!important;font-weight:'+g.weight+'!important;font-style:'+(g.italic?'italic':'normal')+'!important;font-synthesis:'+synth+'!important;letter-spacing:calc('+g.spacing+' * var(--display-unit))!important;line-height:'+g.line+'!important;'+(g.color?'color:'+g.color+'!important;':'')+'}');
      const sized=(group.sizeSelectors||group.selectors).split(',').map(s=>'body.monitor-mode '+s).join(',');
      let size='calc('+g.size+' * var(--display-unit))';
      if (group.id==='names') size='min('+size+',calc((100cqw - (var(--score-digits,1) * 140 + 12) * var(--display-unit)) / var(--name-length,3)))';
      lines.push(sized+'{font-size:'+size+'!important}');
      lines.push(sized+'{-webkit-text-stroke:'+g.stroke+'em currentColor!important;paint-order:stroke fill}');
      if(g.color){
        const children={concepts:'.side .con .l,.side .con .r,.side .con i',numbers:'.log-value,.log-points',audienceMeta:'.audience-state,.audience-count'}[group.id];
        if(children)lines.push(children.split(',').map(s=>'body.monitor-mode '+s).join(',')+'{color:'+g.color+'!important}');
      }
      if (group.id==='concepts') lines.push('body.monitor-mode .card-choice .con{font-size:calc('+g.size*.72+' * var(--display-unit))!important}');
      if (group.id==='audience') lines.push('body.monitor-mode .audience-avatar{font-size:calc('+g.size*32/36+' * var(--display-unit))!important}');
      if (group.id==='audienceMeta') lines.push('body.monitor-mode .audience-status{font-size:calc('+g.size*30/32+' * var(--display-unit))!important}');
      if (group.id==='numbers') lines.push('body.monitor-mode .band-label,body.monitor-mode .audience-person > span,body.monitor-mode .audience-error{font-size:calc('+g.size*32/30+' * var(--display-unit))!important}body.monitor-mode .audience-rank{font-size:calc('+g.size*36/30+' * var(--display-unit))!important}body.monitor-mode .log-score,body.monitor-mode .team-gain{font-size:calc('+g.size*40/30+' * var(--display-unit))!important}');
    }
    lines.push('body.monitor-mode .b2{background:'+p.band2+'!important}body.monitor-mode .b3{background:'+p.band3+'!important}body.monitor-mode .b4{background:'+p.band4+'!important}');
    if (!forExport) lines.push('body{overflow:hidden}*{animation:none!important;transition:none!important}body.monitor-mode .lab-selected{outline:2px dashed #00877f;outline-offset:4px}body.monitor-mode .side,body.monitor-mode [data-lab-group]{cursor:pointer!important}body.monitor-mode .log ul,body.monitor-mode .audience-winners{scrollbar-width:thin}');
    return lines.join('\n');
  }
  function make(tag,className,text,doc=frameDocument) { const e=doc.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e; }
  function byId(id) { return frameDocument.getElementById(id); }
  function teamName(letter,text) { const b=make('b','team-name',text);b.style.color='var(--c'+letter+')';return b; }
  function renderFixture(state) {
    const d=frameDocument,t=state.text,phase=state.stage;
    d.body.className='monitor-mode audience-mode';d.body.dataset.phase=phase;
    for (const letter of ['A','B']) {
      byId('name'+letter).textContent=t['team'+letter];byId('score'+letter).textContent=letter==='A'?'4':'1';
      const panel=byId('name'+letter).closest('.team');
      panel.style.setProperty('--name-length',Math.max(1,Array.from(t['team'+letter]).length));panel.style.setProperty('--score-digits',1);
      panel.classList.toggle('is-active',(phase==='revealed'?letter==='B':letter==='A'));panel.classList.toggle('is-winner',phase==='over'&&letter==='A');
      const direction=byId('direction'+letter),hasGuess=letter==='B'&&['revealed','over'].includes(phase);
      direction.textContent=hasGuess?'→':'';direction.dataset.direction=hasGuess?'R':'';
      byId('gain'+letter).textContent='';
      byId('track'+letter).replaceChildren(...Array.from({length:10},(_,i)=>make('i',i<(letter==='A'?4:1)?'on':'')));
    }
    byId('deck-badge').textContent='字形试验';byId('conn-badge').textContent='离线预览';byId('btn-restart').style.display='none';
    byId('timer-display').classList.remove('hidden');byId('timer-display').textContent='00:15';
    byId('display-footer').append(byId('timer-display'));
    byId('card-label').textContent='第 3 轮 · '+({revealed:'结算',chooseCard:'选题',dial:'讨论',over:'复盘'}[phase]);
    const choosing=phase==='chooseCard';byId('sides').classList.toggle('choosing',choosing);byId('card-frame').classList.toggle('choosing',choosing);
    function pair(left,right) { const con=make('span','con');con.append(make('span','l',left),make('i','', '—'),make('span','r',right));return con; }
    const cards=choosing?[[t.left,t.right],[t.left2,t.right2]]:[[t.left,t.right]];
    byId('sides').replaceChildren(...cards.map((words,i)=>{const card=make('button','side '+(choosing?'card-choice':'selected only'));card.type='button';card.append(make('span','side-tag',choosing?'题目 '+(i+1):'概念'),pair(...words));if(choosing)card.append(pair(i===0?'喜欢独处':'永远的幻想乡',i===0?'喜欢热闹':'短暂的异变'));return card;}));
    const message=make('span','phase-message',byId('card-label').textContent);
    byId('hint').replaceChildren(message);
    byId('score-pop').textContent='';byId('controls').textContent='';
    byId('bands').replaceChildren(...[['b2',15,4.4,2],['b3',19.4,4,3],['b4',23.4,3.2,4],['b3',26.6,4,3],['b2',30.6,4.4,2]].map(([cls,left,width,points])=>{const b=make('div','band '+cls);b.style.left=left+'%';b.style.width=width+'%';b.append(make('span','band-label',points));return b;}));
    byId('dial').style.left='25%';byId('center-mark').style.left='25%';byId('center-mark').classList.toggle('shown',phase==='revealed'||phase==='over');
    byId('screen').classList.toggle('open',phase==='revealed'||phase==='over');
    byId('ticks').replaceChildren(...Array.from({length:19},(_,i)=>{const tick=make('i','tick-mark'+((i+1)%5===0?' major':''));tick.style.left=(i+1)*5+'%';return tick;}));
    byId('tick-labels').replaceChildren(...['-100%','-50%','0%','+50%','+100%'].map((value,i)=>{const e=make('span','tick-number'+(i===0?' edge-left':i===4?' edge-right':''),value);e.style.left=i*25+'%';return e;}));
    const revealed=['revealed','over'].includes(phase);
    byId('audience-panel').classList.remove('hidden');byId('audience-connection').textContent='';byId('audience-connection').classList.add('connected');
    byId('audience-prompt').textContent=revealed?'目标 -50%':'发送 g+50%';
    const names=t.nicknames.split('\n').filter(Boolean).slice(0,20);
    const badge=make('span','audience-state',revealed?'已截止':phase==='dial'?'收答中':'待开始');badge.dataset.state=revealed?'closed':phase==='dial'?'accepting':'waiting';
    byId('audience-status').replaceChildren(badge,make('span','audience-count',names.length+' 人'));
    const people=names.map((name,i)=>({name,index:i,guess:[-50,0,50,-25,75][i%5]}));
    if(revealed)people.sort((a,b)=>Math.abs(a.guess+50)-Math.abs(b.guess+50));
    byId('audience-winners').replaceChildren(...people.map((person,i)=>{
      const li=make('li'),info=make('span','audience-person'),avatar=make('span','audience-avatar'),img=make('img');
      img.src=payload.avatars[person.index%payload.avatars.length];img.alt='';avatar.append(img);
      info.append(make('strong','',person.name),make('span','',(person.guess>0?'+':'')+person.guess+'%'));
      const error=Math.abs(person.guess+50);
      li.append(make('span','audience-rank',i+1),avatar,info,make('span','audience-error'+(revealed&&error===0?' exact':''),revealed?(error===0?'✓':'差 '+error):''));return li;
    }));
    byId('log').replaceChildren(...[[t.left,t.right],[t.left2,t.right2],['温度 0°C','温度 100°C']].map((words,i)=>{
      const li=make('li'),title=make('span','log-title'),card=make('span','log-card'),score=make('span','log-score'),letter=i===1?'B':'A';
      card.append(make('b','',words.join(' — ')));title.append(make('span','log-round','第 '+(3-i)+' 轮'),card);
      const dial=make('span','log-value log-dial','-50%'),target=make('span','log-value log-target','-50%');dial.style.color='var(--c'+letter+')';target.style.color='#000';
      const a=make('span','log-points','+'+(letter==='A'?4:0)),b=make('span','log-points','+'+(letter==='B'?4:0));a.dataset.team='A';b.dataset.team='B';a.style.color='var(--cA)';b.style.color='var(--cB)';
      const positions=make('span','log-positions'),gains=make('span','log-gains'),guess=make('span','log-guess');
      guess.dataset.side=i===1?'L':'R';guess.innerHTML='<svg viewBox="0 0 48 32" aria-hidden="true" focusable="false"><path d="M3 16H42M30 4L42 16L30 28"/></svg>';
      guess.style.color='var(--c'+(letter==='A'?'B':'A')+')';guess.setAttribute('role','img');guess.setAttribute('aria-label','另一队猜测'+(i===1?'左侧':'右侧'));
      positions.append(dial,d.createTextNode(' / '),target);gains.append(a,d.createTextNode(' / '),b);
      score.append(teamName(letter,t['team'+letter]),positions,guess,gains);li.append(title,score);return li;
    }));
    const rules=d.querySelector('details.rules');if(rules)rules.open=false;
    for(const g of groups) d.querySelectorAll(g.selectors).forEach(e=>{e.dataset.labGroup=g.id;});
    d.querySelectorAll('.lab-selected').forEach(e=>e.classList.remove('lab-selected'));
    if($('highlight').checked)d.querySelectorAll('[data-lab-group="'+selected+'"]').forEach(e=>e.classList.add('lab-selected'));
  }
  function refreshFontSheets(state) {
    const css=assetCss([...payload.fonts,...uploaded])+numeralCss(state);
    if($('loaded-fonts').textContent!==css)$('loaded-fonts').textContent=css;
    if(frameDocument&&byId('frame-fonts').textContent!==css)byId('frame-fonts').textContent=css;
  }
  function render() {
    if(!frameDocument)return;
    const state=showingA?reference:settings;
    refreshFontSheets(state);byId('lab-overrides').textContent=stateCss(state);renderFixture(state);
    const g=groups.find(x=>x.id===selected),v=settings.groups[selected],sample=$('sample');
    sample.textContent=selected==='names'?settings.text.teamA+' · '+settings.text.teamB:selected==='concepts'?settings.text.left+' — '+settings.text.right:selected==='audience'?settings.text.nicknames.split('\n').slice(0,2).join(' · '):g.numeric?g.sample:g.sample+'　'+settings.text.mixed;
    sample.style.cssText='font-family:'+stack(settings,g)+';font-size:'+v.size+'px;font-weight:'+v.weight+';font-style:'+(v.italic?'italic':'normal')+';font-synthesis:'+(v.synthesize?'weight style':v.italic?'style':'none')+';letter-spacing:'+v.spacing+'px;line-height:'+v.line+';-webkit-text-stroke:'+v.stroke+'em currentColor;paint-order:stroke fill;color:'+(v.color||(['names','concepts','scores'].includes(selected)?settings.palette.a:settings.palette.ink));
    $('sample-box').style.background=settings.palette.background;
    $('sample-metrics').textContent=v.size+' px / '+v.weight+' / 行高 '+v.line;
    $('compare-a').classList.toggle('active-comparison',showingA);$('compare-a').textContent=showingA?'正在看 A · 返回当前':'对比 A';
    clearTimeout(checkTimer);const epoch=++renderEpoch;
    frameDocument.fonts.ready.then(()=>{if(epoch===renderEpoch)checkTimer=setTimeout(checkLayout,80);});
  }
  function checkLayout() {
    if(!frameDocument)return;
    const problems=new Set();
    const scopes={names:'.team',concepts:'.side',headings:'.log,.audience-panel',phase:'#hint,.card-frame',history:'#log',audience:'.audience-person,.audience-avatar',audienceMeta:'.audience-panel',scores:'.team',numbers:'.spectrum-wrap,#log,#audience-winners,.team',timer:'#display-footer',brand:'header'};
    for(const group of groups)frameDocument.querySelectorAll(group.sizeSelectors||group.selectors).forEach(el=>{
      if(!el.getClientRects().length||!el.textContent.trim())return;
      const range=frameDocument.createRange();range.selectNodeContents(el);const r=range.getBoundingClientRect();
      const scope=el.closest(scopes[group.id]);if(!scope)return;const bounds=scope.getBoundingClientRect();
      const scrollable=!!el.closest('#log,#audience-winners');
      const top=scope.tagName==='HEADER'?0:scope.id==='display-footer'?byId('tick-labels').getBoundingClientRect().bottom:Math.max(0,bounds.top);
      const bottom=scope.tagName==='HEADER'?byId('card-frame').getBoundingClientRect().top:Math.min(672,bounds.bottom);
      if(r.left<bounds.left-3||r.right>bounds.right+3||(!scrollable&&(r.top<top-4||r.bottom>bottom+4)))problems.add(group.label);
    });
    for(const card of frameDocument.querySelectorAll('.side'))if(card.scrollHeight>card.clientHeight+2||card.scrollWidth>card.clientWidth+2)problems.add('题卡');
    for(const panel of frameDocument.querySelectorAll('.team')){const a=panel.querySelector('.tname').getBoundingClientRect(),b=panel.querySelector('.tscore').getBoundingClientRect();if((panel.classList.contains('b')?b.right>a.left:a.right>b.left)||b.right>panel.getBoundingClientRect().right)problems.add('队名 / 比分');}
    $('layout-status').classList.toggle('warning',problems.size>0);
    $('layout-status').textContent=problems.size?'留意文字空间：'+[...problems].join('、')+'。可减小字号、字距或行高。':(showingA?'当前显示参考方案 A。':'布局保持 3904 × 672；可点击预览里的文字切换区域。');
  }
  function fit() {
    const view=$('viewport'), mode=$('zoom').value;
    scale=mode==='fit'?view.clientWidth/3904:Number(mode);
    if(document.fullscreenElement===view)scale=Math.min(view.clientWidth/3904,view.clientHeight/672);
    $('preview').style.transform='scale('+scale+')';$('canvas-holder').style.width=3904*scale+'px';$('canvas-holder').style.height=672*scale+'px';
    $('scale-info').textContent=Math.round(scale*100)+'% · 3904 × 672';
  }
  function saveSoon() {
    clearTimeout(savedTimer);savedTimer=setTimeout(()=>{try{localStorage.setItem(STORAGE,JSON.stringify(settings));$('save-status').textContent='参数已记在此浏览器。载入的字体文件请随“保存当前 HTML”一起保存。';}catch(_){$('save-status').textContent='本浏览器无法自动记忆；请用“保存当前 HTML”或“导出方案”。';}},250);
  }
  function changed() { showingA=false;render();saveSoon(); }
  function controls() {
    const group=groups.find(g=>g.id===selected),v=settings.groups[selected];
    $('selected-name').textContent=group.label;$('font-name').value=fontLabels.get(v.font)||v.font;
    $('font-size').value=v.size;$('font-size-range').value=v.size;$('font-weight').value=v.weight;$('line-height').value=v.line;$('letter-spacing').value=v.spacing;$('font-stroke').value=v.stroke;
    $('group-color').value=v.color||settings.palette.ink;$('follow-color').checked=!v.color;$('group-color').disabled=!v.color;$('synthesize').checked=v.synthesize;$('italic').checked=v.italic;$('group-note').textContent=group.note;
    $('stage').value=settings.stage;
    document.querySelectorAll('[data-group]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.group===selected)));
    document.querySelectorAll('[data-text]').forEach(input=>input.value=settings.text[input.dataset.text]);
    document.querySelectorAll('[data-palette]').forEach(input=>input.value=settings.palette[input.dataset.palette]);
    refreshCatalogue();
  }
  function selectGroup(id) {
    if(!groups.some(g=>g.id===id))return;
    selected=id;controls();render();
    $('font-status').textContent='当前字体：'+(fontLabels.get(settings.groups[id].font)||settings.groups[id].font)+'。可输入本机字体名或载入字体文件。';
  }
  function refreshCatalogue() {
    const query=$('font-search').value.toLowerCase();
    const entries=[...catalogue.values()].filter(f=>(f.label+' '+f.family).toLowerCase().includes(query)).sort((a,b)=>{const priority={bundled:0,file:1,installed:2,suggested:3};return priority[a.source]-priority[b.source]||a.family.localeCompare(b.family,'zh-CN');});
    $('font-list').replaceChildren(...entries.map(font=>{const option=document.createElement('option');option.value=font.family;option.textContent=font.label;return option;}));
    $('font-list').value=settings.groups[selected].font;$('font-count').textContent=entries.length+' 项';
    $('font-options').replaceChildren(...[...catalogue.values()].map(font=>{const option=document.createElement('option');option.value=fontLabels.get(font.family)||font.family;option.label=font.label;return option;}));
  }
  async function applyFont(family) {
    family=family.trim().slice(0,240);if(!family)return;
    family=[...fontLabels].find(([,label])=>label===family)?.[0]||family;
    const group=groups.find(g=>g.id===selected);
    if(group.numeric&&blockedNumeric(family)){$('font-status').textContent='数字区域请选清晰的数字字体；言宋、AaGothic 和康熙体留给中文。';controls();return;}
    settings.groups[selected].font=family;controls();changed();
    const epoch=++probeEpoch;
    if(catalogue.get(family)?.source==='bundled'||catalogue.get(family)?.source==='file'){$('font-status').textContent='已应用：'+fontLabels.get(family);return;}
    try{
      const probe=new FontFace('Lab Availability '+epoch,localSources(family,400));await probe.load();
      if(epoch===probeEpoch)$('font-status').textContent='已找到本机字体：'+family;
    }catch(_){if(epoch===probeEpoch)$('font-status').textContent='未能确认“'+family+'”已安装；浏览器可能正在用后备字体。可载入字体文件以确认。';}
  }
  async function scanFonts() {
    if(!window.queryLocalFonts){$('font-status').textContent='当前浏览器不能列出字体。下载后用 Chrome／Edge 打开试试；也可直接输入名称或载入字体文件。';return;}
    try{
      const fonts=await window.queryLocalFonts();fontMetadata=new Map();
      for(const f of fonts){if(!fontMetadata.has(f.family))fontMetadata.set(f.family,[]);fontMetadata.get(f.family).push({style:f.style,postscriptName:f.postscriptName,fullName:f.fullName});catalogue.set(f.family,{family:f.family,label:'本机 · '+f.family,source:'installed'});}
      refreshCatalogue();render();$('font-status').textContent='已读取 '+fontMetadata.size+' 个本机字体家族。用筛选框和“上一个／下一个”逐个试。';
    }catch(error){$('font-status').textContent=(error.name==='NotAllowedError'?'没有取得读取字体列表的许可。':'浏览器未能读取字体列表。')+'仍可输入字体名或载入字体文件。';}
  }
  function readDataURL(file) { return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);}); }
  async function loadFontFiles(files) {
    for(const file of files){
      const ext=file.name.split('.').pop().toLowerCase();if(!['ttf','otf','woff','woff2'].includes(ext)){$('font-status').textContent='请选择 TTF、OTF、WOFF 或 WOFF2 字体。';continue;}
      try{
        const raw=await readDataURL(file),uri='data:font/'+ext+';base64,'+String(raw).split(',')[1];
        const family='Lab File '+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
        const face=new FontFace(family,'url('+quoted(uri)+')');await face.load();
        const asset={family,label:file.name,uri,weight:400};uploaded.push(asset);addAssetToCatalogue(asset);await applyFont(family);
      }catch(_){$('font-status').textContent='无法打开 '+file.name+'；请换一个有效的字体文件。';}
    }
    $('font-files').value='';
  }
  function download(name,content,type) { const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000); }
  function saveHtml() {
    const copy=document.documentElement.cloneNode(true);
    copy.querySelector('#preview').removeAttribute('srcdoc');copy.querySelector('#loaded-fonts')?.remove();
    copy.querySelector('#lab-saved').textContent=JSON.stringify({settings,fonts:uploaded}).replace(/</g,'\\u003c');
    // Rebuild ephemeral controls and font sheets on open, without duplicating embedded assets.
    for(const id of ['font-options','font-list','group-tabs','palette','sample'])copy.querySelector('#'+id).replaceChildren();
    download('Wavelength-字体试验台.html','<!doctype html>\n'+copy.outerHTML,'text/html;charset=utf-8');
    $('save-status').textContent='已保存 HTML，包含当前方案和你载入的字体文件。';
  }
  function exportJSON() {
    const result=clone(settings);result.fontFiles=uploaded.map(a=>({family:a.family,filename:a.label}));
    download('Wavelength-字体方案.json',JSON.stringify(result,null,2),'application/json');$('save-status').textContent='已导出方案。JSON 记录字体名称与参数；字体文件随“保存当前 HTML”保存。';
  }
  async function importJSON(file) {
    try{const raw=JSON.parse(await file.text());settings=normalize(raw);reference=null;showingA=false;$('compare-a').disabled=true;controls();changed();const missing=Object.values(settings.groups).filter(g=>g.font.startsWith('Lab File ')&&!uploaded.some(a=>a.family===g.font));$('save-status').textContent=missing.length?'方案已导入；其中的字体文件需重新载入，或直接打开保存的 HTML。':'方案已导入。';}
    catch(error){$('save-status').textContent='导入失败：'+error.message;}
    $('json-file').value='';
  }
  groups.forEach(group=>{const button=document.createElement('button');button.textContent=group.label;button.dataset.group=group.id;button.onclick=()=>selectGroup(group.id);$('group-tabs').append(button);});
  for(const [key,label] of Object.entries(paletteLabels)){const field=document.createElement('label'),input=document.createElement('input');input.type='color';input.dataset.palette=key;input.value=settings.palette[key];input.oninput=()=>{settings.palette[key]=input.value;changed();};field.append(input,document.createTextNode(label));$('palette').append(field);}
  const fontSheet=document.createElement('style');fontSheet.id='loaded-fonts';document.head.append(fontSheet);
  $('preview').onload=()=>{
    frameDocument=$('preview').contentDocument;
    frameDocument.addEventListener('click',event=>{const target=event.target.closest('[data-lab-group]');if(target){event.preventDefault();selectGroup(target.dataset.labGroup);}});
    render();fit();
  };
  $('preview').srcdoc='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>'+payload.css+'</style><style id="frame-fonts"></style><style id="lab-overrides"></style></head><body class="monitor-mode" data-phase="revealed">'+payload.markup+'</body></html>';
  $('scan-fonts').onclick=scanFonts;$('load-font').onclick=()=>$('font-files').click();$('font-files').onchange=event=>loadFontFiles([...event.target.files]);
  $('font-name').onchange=()=>applyFont($('font-name').value);$('font-name').onkeydown=event=>{if(event.key==='Enter')applyFont($('font-name').value);};
  $('font-list').onchange=()=>applyFont($('font-list').value);$('font-search').oninput=refreshCatalogue;
  for(const [id,step] of [['previous-font',-1],['next-font',1]])$(id).onclick=()=>{const list=$('font-list');if(!list.options.length)return;const index=list.selectedIndex<0?(step>0?-1:0):list.selectedIndex;list.selectedIndex=(index+step+list.options.length)%list.options.length;applyFont(list.value);};
  const numericControls={'font-size':'size','font-size-range':'size','font-weight':'weight','line-height':'line','letter-spacing':'spacing','font-stroke':'stroke'};
  for(const [id,key] of Object.entries(numericControls))$(id).oninput=()=>{const input=$(id);if(input.value===''||!input.validity.valid)return;settings.groups[selected][key]=Number(input.value);if(key==='size'){$('font-size').value=input.value;$('font-size-range').value=input.value;}changed();};
  for(const id of ['synthesize','italic'])$(id).onchange=()=>{settings.groups[selected][id]= $(id).checked;changed();};
  $('follow-color').onchange=()=>{settings.groups[selected].color=$('follow-color').checked?null:$('group-color').value;$('group-color').disabled=$('follow-color').checked;changed();};
  $('group-color').oninput=()=>{settings.groups[selected].color=$('group-color').value;changed();};
  $('stage').onchange=()=>{settings.stage=$('stage').value;changed();};$('zoom').onchange=fit;$('highlight').onchange=render;
  $('remember-a').onclick=()=>{reference=clone(settings);showingA=false;$('compare-a').disabled=false;$('save-status').textContent='已把当前方案记为 A，可以继续修改再切换对比。';render();};
  $('compare-a').onclick=()=>{if(reference){showingA=!showingA;render();}};
  $('fullscreen').onclick=async()=>{try{await $('viewport').requestFullscreen();}catch(_){$('layout-status').textContent='此浏览器未允许全屏，请用浏览器全屏键或 100% 原尺寸预览。';}};
  document.addEventListener('fullscreenchange',fit);new ResizeObserver(fit).observe($('viewport'));
  $('reset-group').onclick=()=>{settings.groups[selected]=clone(defaults.groups[selected]);controls();changed();};$('reset-colors').onclick=()=>{settings.palette=clone(defaults.palette);controls();changed();};
  $('reset-all').onclick=()=>{settings=clone(defaults);reference=null;showingA=false;$('compare-a').disabled=true;selectGroup(selected);changed();};
  document.querySelectorAll('[data-text]').forEach(input=>input.oninput=()=>{settings.text[input.dataset.text]=input.value.slice(0,2000);changed();});
  $('normal-text').onclick=()=>{settings.text=clone(texts);controls();changed();};
  $('long-text').onclick=()=>{settings.text={...settings.text,teamA:'超长名称幻想乡队',teamB:'超长名称外来人队',left:'无论何时都会选择留在幻想乡的妖怪',right:'认为外面的世界总有更多可能性的人类',left2:'ReturnedSuperLongCardNameWithoutSpaces',right2:'AnotherLongConceptToTestWrapping',nicknames:'一位名字特别长但仍然热爱幻想乡的群友\n博丽灵梦１２３\n雾雨魔理沙'};controls();changed();};
  $('save-html').onclick=saveHtml;$('export-json').onclick=exportJSON;$('import-json').onclick=()=>$('json-file').click();$('json-file').onchange=e=>{if(e.target.files[0])importJSON(e.target.files[0]);};
  $('export-css').onclick=()=>download('Wavelength-字体方案.css','/* 追加在 Returned app.css 之后。系统字体需在运行游戏的电脑上安装。 */\n'+assetCss(uploaded)+'\n'+stateCss(settings,true),'text/css;charset=utf-8');
  controls();
  if(Object.values(settings.groups).some(g=>g.font.startsWith('Lab File ')&&!uploaded.some(a=>a.family===g.font)))$('font-status').textContent='已恢复参数；上次载入的字体文件请重新选择，或打开“保存当前 HTML”得到的文件。';
})();
