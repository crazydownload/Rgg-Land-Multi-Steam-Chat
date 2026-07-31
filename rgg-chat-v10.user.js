// ==UserScript==
// @name         RGG Land — плавающий Twitch-чат (v10 revive)
// @namespace    rgg.land.chat.sync
// @version      10.0
// @description  Скрытие вместо закрытия + кнопка-якорь возврата + Alt+C, память, тёмная тема, ресайз, авто
// @match        https://rgg.land/*
// @match        https://www.rgg.land/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const HOST = location.hostname;
  const SAVE_KEY = 'rgg_chat_win_v10';
  const MIN_W = 220, MIN_H = 200;
  const SIZES = { s: [240, 330], m: [300, 480], l: [400, 680] };
  let current = null, autoOn = true, lastDetected = null, stable = 0;
  let chipsKey = '', invertOn = true, hidden = false;
  const refs = {};
  let lastGeom = { x: 0, y: 0, w: 300, h: 480 };

  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700;800&family=Rubik:wght@400;500;600;700;800&display=swap';
  document.head.appendChild(font);

  /* ===== память ===== */
  function loadState() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch (e) { return {}; } }
  function captureGeom() {
    const p = refs.panel; if (!p) return;
    const x = parseFloat(p.style.left), y = parseFloat(p.style.top);
    const w = parseFloat(p.style.width), h = parseFloat(p.style.height);
    if (!isNaN(x)) lastGeom.x = x; if (!isNaN(y)) lastGeom.y = y;
    if (!isNaN(w)) lastGeom.w = w; if (!isNaN(h)) lastGeom.h = h;
  }
  function saveState() {
    captureGeom();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...lastGeom, inv: invertOn, hidden })); } catch (e) {}
  }
  let _svT = null;
  function saveSoon() { clearTimeout(_svT); _svT = setTimeout(saveState, 250); }

  function channelFromSrc(src) {
    if (!src) return null;
    try {
      const u = new URL(src, location.origin);
      const ch = u.searchParams.get('channel');
      if (ch) return ch.toLowerCase();
      const m = u.pathname.match(/\/embed\/([^/]+)\/chat/i);
      if (m) return m[1].toLowerCase();
      return null;
    } catch (e) { return null; }
  }
  function isPlayer(src) {
    const s = (src || '').toLowerCase();
    if (s.includes('/chat') || s.includes('chat?')) return false;
    return s.includes('player.') || s.includes('channel=') || s.includes('/video');
  }
  function players() {
    const out = [];
    document.querySelectorAll('iframe').forEach(f => {
      const src = f.src || f.getAttribute('src') || '';
      const ch = channelFromSrc(src);
      if (ch && isPlayer(src)) out.push({ ch, el: f });
    });
    return out;
  }
  function detectActive(list) {
    let best = null, bestScore = -Infinity;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    list.forEach(p => {
      const r = p.el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return;
      const vw = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const vh = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const area = vw * vh; if (area <= 0) return;
      const dx = (r.left + r.width / 2) - cx, dy = (r.top + r.height / 2) - cy;
      const score = area * 100000 - Math.hypot(dx, dy);
      if (score > bestScore) { bestScore = score; best = p; }
    });
    return best;
  }

  function markSize() {
    const w = parseFloat(refs.panel.style.width), h = parseFloat(refs.panel.style.height);
    refs.panel.querySelectorAll('.rgg-sz').forEach(b => {
      const [pw, ph] = SIZES[b.dataset.sz];
      b.classList.toggle('is-on', Math.abs(w - pw) < 3 && Math.abs(h - ph) < 3);
    });
  }

  /* ===== скрыть / показать (вместо закрытия) ===== */
  function setHidden(h) {
    hidden = h;
    refs.panel.style.display = h ? 'none' : 'flex';
    refs.dock.style.display = h ? 'flex' : 'none';
    if (h) { refs.dock.classList.remove('show'); requestAnimationFrame(() => refs.dock.classList.add('show')); }
    else { markSize(); }
    saveState();
  }

  /* ===== кнопка-якорь возврата ===== */
  function buildDock() {
    const css = `
      #rggdock{position:fixed;right:18px;bottom:18px;z-index:2147483001;display:none;align-items:center;
        height:52px;padding:0;border:none;cursor:pointer;border-radius:999px;
        background:radial-gradient(120% 120% at 30% 20%,#a970ff 0%,#7c3aed 45%,#5b21b6 100%);
        box-shadow:0 10px 30px -6px rgba(124,58,237,.7),0 0 0 1px rgba(255,255,255,.12) inset;
        color:#fff;font-family:'Rubik',system-ui,sans-serif;overflow:hidden;
        transform:scale(.4) translateY(20px);opacity:0;transition:transform .45s cubic-bezier(.2,1.3,.3,1),opacity .35s,box-shadow .2s}
      #rggdock.show{transform:scale(1) translateY(0);opacity:1}
      #rggdock:hover{box-shadow:0 14px 38px -6px rgba(124,58,237,.85),0 0 0 1px rgba(255,255,255,.2) inset}
      #rggdock:active{transform:scale(.93)}
      #rggdock::before{content:'';position:absolute;inset:-6px;border-radius:999px;pointer-events:none;
        border:2px solid rgba(169,112,255,.6);animation:rggDockPulse 2.2s ease-out infinite}
      @keyframes rggDockPulse{0%{transform:scale(.85);opacity:.7}100%{transform:scale(1.35);opacity:0}}
      .dock-ico{flex:0 0 auto;width:52px;height:52px;display:flex;align-items:center;justify-content:center;position:relative;
        filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))}
      .dock-dot{position:absolute;top:9px;right:9px;width:9px;height:9px;border-radius:50%;background:#22c55e;
        border:2px solid #5b21b6;animation:rggPulse2 1.6s infinite}
      @keyframes rggPulse2{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 6px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
      .dock-label{display:flex;flex-direction:column;align-items:flex-start;gap:1px;
        max-width:0;opacity:0;white-space:nowrap;overflow:hidden;padding-right:0;
        transition:max-width .35s ease,opacity .25s ease,padding-right .35s ease}
      #rggdock:hover .dock-label{max-width:200px;opacity:1;padding-right:16px}
      .dock-label b{font-size:13px;font-weight:700;letter-spacing:.01em}
      .dock-label small{font-size:10px;font-weight:500;color:#e9d5ff;letter-spacing:.04em;text-transform:lowercase}
      .dock-label kbd{font-family:'Chakra Petch',sans-serif;font-size:9px;font-weight:700;color:#ddd6fe;
        background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.18);border-radius:4px;padding:0 4px;margin-left:5px}
    `;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    const dock = document.createElement('button');
    dock.id = 'rggdock';
    dock.title = 'Открыть чат (Alt+C)';
    dock.innerHTML = `
      <span class="dock-ico">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>
        <span class="dock-dot"></span>
      </span>
      <span class="dock-label"><b>открыть чат<kbd>Alt+C</kbd></b><small class="dock-nick">—</small></span>
    `;
    document.body.appendChild(dock);
    refs.dock = dock;
    refs.dockNick = dock.querySelector('.dock-nick');
    dock.onclick = () => setHidden(false);
  }

  function buildPanel() {
    const css = `
      #rggchat{
        --bg:#0e0e10; --panel:#18181b; --elev:#1f1f23; --line:#2f2f35;
        --text:#efeff1; --muted:#adadb8; --purple:#a970ff; --purple-deep:#9147ff;
        --purple-hov:#bf94ff; --red:#eb0400;
        position:fixed; right:16px; top:80px; width:300px; height:480px;
        min-width:${MIN_W}px; min-height:${MIN_H}px;
        z-index:2147483000; display:flex; flex-direction:column; overflow:hidden;
        background:var(--panel); border:1px solid var(--line); border-radius:12px;
        color:var(--text); font-family:'Rubik',system-ui,sans-serif;
        box-shadow:0 18px 50px rgba(0,0,0,.65), 0 0 0 1px rgba(145,71,255,.16),
                   0 0 60px -10px rgba(145,71,255,.35);
        animation:rggIn .55s cubic-bezier(.2,.9,.3,1.2);
      }
      #rggchat::before{content:'';position:absolute;inset:-1px;border-radius:12px;pointer-events:none;
        background:linear-gradient(135deg,rgba(145,71,255,.5),transparent 35%,transparent 65%,rgba(145,71,255,.25));
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;mask-composite:exclude;padding:1px;opacity:.6;
        animation:rggBorder 6s linear infinite}
      @keyframes rggBorder{0%,100%{opacity:.35}50%{opacity:.75}}
      @keyframes rggIn{from{opacity:0;transform:translateY(26px) scale(.96)}to{opacity:1;transform:none}}
      #rggchat:hover{box-shadow:0 18px 50px rgba(0,0,0,.7), 0 0 0 1px rgba(145,71,255,.28),
                   0 0 80px -8px rgba(145,71,255,.5)}

      #rggchat.rgg-min{width:auto!important;height:auto!important;min-width:0;min-height:0}
      #rggchat.rgg-min .rgg-name,#rggchat.rgg-min .rgg-live,#rggchat.rgg-min .rgg-ver,
      #rggchat.rgg-min .rgg-row2,#rggchat.rgg-min .rgg-body,#rggchat.rgg-min .rg{display:none}

      .rgg-top{display:flex;align-items:center;gap:9px;padding:11px 12px;cursor:grab;user-select:none;
        touch-action:none;background:var(--elev);border-bottom:1px solid var(--line);position:relative;z-index:2}
      .rgg-top:active{cursor:grabbing}
      .rgg-top::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;
        background:linear-gradient(90deg,var(--purple-deep),var(--purple) 45%,transparent);opacity:.9}
      .rgg-logo{flex:0 0 auto;display:flex;filter:drop-shadow(0 0 6px rgba(145,71,255,.6))}
      .rgg-name{font-family:'Chakra Petch',sans-serif;font-weight:700;font-size:16px;
        text-transform:lowercase;letter-spacing:.02em;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .rgg-live{display:inline-flex;align-items:center;gap:5px;font-family:'Chakra Petch',sans-serif;
        font-size:9px;font-weight:700;letter-spacing:.16em;color:#ff5c5c;flex:0 0 auto}
      .rgg-live i{width:7px;height:7px;border-radius:50%;background:var(--red);animation:rggPulse 1.5s infinite}
      @keyframes rggPulse{0%{box-shadow:0 0 0 0 rgba(235,4,0,.55)}70%{box-shadow:0 0 0 7px rgba(235,4,0,0)}100%{box-shadow:0 0 0 0 rgba(235,4,0,0)}}
      .rgg-ver{font-family:'Chakra Petch',sans-serif;font-size:9px;font-weight:800;color:var(--purple-hov);
        border:1px solid var(--purple-deep);border-radius:5px;padding:1px 6px;letter-spacing:.1em;flex:0 0 auto;
        box-shadow:0 0 10px -2px rgba(145,71,255,.6)}
      .rgg-spacer{flex:1}
      .rgg-btn{background:var(--elev);border:1px solid var(--line);color:var(--muted);border-radius:6px;
        min-width:26px;height:24px;cursor:pointer;font-size:13px;font-family:'Rubik',sans-serif;
        display:inline-flex;align-items:center;justify-content:center;transition:.16s;padding:0 6px}
      .rgg-btn:hover{color:var(--text);border-color:var(--purple);background:#26262c;transform:translateY(-1px)}
      .rgg-btn:active{transform:translateY(0) scale(.94)}
      .rgg-auto{font-size:9px;font-weight:700;letter-spacing:.14em;padding:0 9px}
      .rgg-auto.is-on{background:var(--purple-deep);color:#fff;border-color:var(--purple);
        box-shadow:0 0 12px rgba(145,71,255,.55)}
      .rgg-auto.is-on:hover{background:var(--purple)}

      .rgg-row2{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--panel);
        border-bottom:1px solid var(--line);position:relative;z-index:2}
      .rgg-chips{flex:1;min-width:0;display:flex;gap:6px;overflow-x:auto;scrollbar-width:thin}
      .rgg-chip{flex:0 0 auto;background:var(--elev);border:1px solid var(--line);color:var(--muted);
        border-radius:6px;padding:4px 11px;font-size:12px;font-weight:600;cursor:pointer;position:relative;overflow:hidden;
        transition:.16s;text-transform:lowercase;font-family:'Rubik',sans-serif}
      .rgg-chip:hover{color:var(--purple-hov);border-color:var(--purple);transform:translateY(-1px)}
      .rgg-chip.on{background:var(--purple-deep);color:#fff;border-color:var(--purple-deep);
        box-shadow:0 2px 10px rgba(145,71,255,.45)}
      .rgg-chip.on::after{content:'';position:absolute;top:0;left:-60%;width:40%;height:100%;
        background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent);
        animation:rggShine 2.6s ease-in-out infinite}
      @keyframes rggShine{0%{left:-60%}55%,100%{left:130%}}
      .rgg-tools{flex:0 0 auto;display:flex;gap:5px}
      .rgg-sz{min-width:24px;height:22px;font-size:10px;font-weight:800;font-family:'Chakra Petch',sans-serif}
      .rgg-sz.is-on{color:var(--purple-hov);border-color:var(--purple);background:#26262c;
        box-shadow:0 0 8px -2px rgba(145,71,255,.5)}
      .rgg-inv.is-on{color:var(--purple-hov);border-color:var(--purple);background:#26262c}

      .rgg-body{flex:1;min-height:0;background:var(--bg);position:relative}
      .rgg-frame{width:100%;height:100%;border:0;display:block;background:var(--bg);color-scheme:dark;
        filter:invert(1) hue-rotate(180deg) contrast(.96)}
      #rggchat.no-invert .rgg-frame{filter:none}

      .rgg-loader{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:14px;background:var(--bg);transition:opacity .4s}
      .rgg-loader.hide{opacity:0;pointer-events:none}
      .rgg-spin{width:34px;height:34px;border-radius:50%;border:3px solid #2a2a30;border-top-color:var(--purple);
        animation:rggRot .8s linear infinite;box-shadow:0 0 16px -2px rgba(145,71,255,.6)}
      @keyframes rggRot{to{transform:rotate(360deg)}}
      .rgg-loader span{font-family:'Chakra Petch',sans-serif;font-size:11px;letter-spacing:.18em;
        color:var(--muted);text-transform:uppercase;animation:rggFlick 1.4s ease-in-out infinite}
      @keyframes rggFlick{0%,100%{opacity:.45}50%{opacity:1}}

      .rg{position:absolute;z-index:30;touch-action:none;transition:background .15s}
      .rg:hover{background:rgba(169,112,255,.22)}
      .rg-e{right:0;top:14px;bottom:14px;width:8px;cursor:ew-resize}
      .rg-w{left:0;top:14px;bottom:14px;width:8px;cursor:ew-resize}
      .rg-n{top:0;left:14px;right:14px;height:7px;cursor:ns-resize}
      .rg-s{bottom:0;left:14px;right:14px;height:8px;cursor:ns-resize}
      .rg-ne{top:0;right:0;width:15px;height:15px;cursor:nesw-resize}
      .rg-nw{top:0;left:0;width:15px;height:15px;cursor:nwse-resize}
      .rg-sw{bottom:0;left:0;width:15px;height:15px;cursor:nesw-resize}
      .rg-se{bottom:0;right:0;width:20px;height:20px;cursor:nwse-resize}
      .rg-se::after{content:'';position:absolute;right:5px;bottom:5px;width:8px;height:8px;
        border-right:2px solid var(--purple);border-bottom:2px solid var(--purple);opacity:.85}
      .rg-e::after{content:'';position:absolute;top:50%;right:3px;width:3px;height:3px;border-radius:50%;
        background:var(--muted);transform:translateY(-50%);box-shadow:0 -7px 0 var(--muted),0 7px 0 var(--muted);opacity:.5}
      .rg-s::after{content:'';position:absolute;left:50%;bottom:3px;width:3px;height:3px;border-radius:50%;
        background:var(--muted);transform:translateX(-50%);box-shadow:-7px 0 0 var(--muted),7px 0 0 var(--muted);opacity:.5}
      #rggchat.rgg-busy .rgg-frame{pointer-events:none}
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'rggchat';
    panel.innerHTML = `
      <div class="rgg-top">
        <span class="rgg-logo"><svg viewBox="0 0 24 24" width="17" height="17" fill="#a970ff"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg></span>
        <span class="rgg-name">…</span>
        <span class="rgg-live"><i></i>LIVE</span>
        <span class="rgg-ver">v10</span>
        <span class="rgg-spacer"></span>
        <button class="rgg-btn rgg-auto is-on" title="Авто-переключение">AUTO</button>
        <button class="rgg-btn rgg-minb" title="Свернуть в полоску">–</button>
        <button class="rgg-btn rgg-x" title="Скрыть чат (Alt+C)">×</button>
      </div>
      <div class="rgg-row2">
        <div class="rgg-chips"></div>
        <div class="rgg-tools">
          <button class="rgg-btn rgg-sz" data-sz="s" title="Маленький">S</button>
          <button class="rgg-btn rgg-sz" data-sz="m" title="Средний">M</button>
          <button class="rgg-btn rgg-sz" data-sz="l" title="Большой">L</button>
          <button class="rgg-btn rgg-inv is-on" title="Тёмная тема (инверсия)">◐</button>
          <button class="rgg-btn rgg-reload" title="Перезагрузить чат">↻</button>
        </div>
      </div>
      <div class="rgg-body">
        <iframe class="rgg-frame" allowfullscreen></iframe>
        <div class="rgg-loader"><div class="rgg-spin"></div><span>подключение к чату</span></div>
      </div>
      <div class="rg" data-dir="n"></div><div class="rg" data-dir="s"></div>
      <div class="rg" data-dir="e"></div><div class="rg" data-dir="w"></div>
      <div class="rg" data-dir="ne"></div><div class="rg" data-dir="nw"></div>
      <div class="rg" data-dir="se"></div><div class="rg" data-dir="sw"></div>
    `;
    document.body.appendChild(panel);

    refs.panel = panel;
    refs.top = panel.querySelector('.rgg-top');
    refs.name = panel.querySelector('.rgg-name');
    refs.chips = panel.querySelector('.rgg-chips');
    refs.frame = panel.querySelector('.rgg-frame');
    refs.loader = panel.querySelector('.rgg-loader');
    refs.autoBtn = panel.querySelector('.rgg-auto');
    refs.invBtn = panel.querySelector('.rgg-inv');

    refs.autoBtn.onclick = () => { autoOn = !autoOn; renderAuto(); };
    panel.querySelector('.rgg-minb').onclick = () => panel.classList.toggle('rgg-min');
    panel.querySelector('.rgg-x').onclick = () => setHidden(true);          // <-- больше не убивает
    panel.querySelector('.rgg-reload').onclick = () => { const ch = current; if (ch) { current = null; setChat(ch); } };
    refs.invBtn.onclick = () => {
      invertOn = !invertOn;
      panel.classList.toggle('no-invert', !invertOn);
      refs.invBtn.classList.toggle('is-on', invertOn);
      saveState();
    };
    panel.querySelectorAll('.rgg-sz').forEach(b => b.onclick = () => setSize(b.dataset.sz));

    refs.frame.addEventListener('load', () => refs.loader.classList.add('hide'));

    function setSize(key) {
      const [w0, h0] = SIZES[key];
      const w = Math.min(w0, innerWidth - 16), h = Math.min(h0, innerHeight - 16);
      panel.classList.remove('rgg-min');
      let l = parseFloat(panel.style.left), t = parseFloat(panel.style.top);
      if (isNaN(l)) l = 8; if (isNaN(t)) t = 8;
      l = Math.max(8, Math.min(l, innerWidth - w - 8));
      t = Math.max(8, Math.min(t, innerHeight - h - 8));
      panel.style.right = 'auto';
      panel.style.left = l + 'px'; panel.style.top = t + 'px';
      panel.style.width = w + 'px'; panel.style.height = h + 'px';
      markSize(); saveState();
    }

    function busy(on) { panel.classList.toggle('rgg-busy', on); }

    /* перетаскивание */
    refs.top.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault(); busy(true);
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        panel.style.right = 'auto';
        panel.style.left = Math.max(8, Math.min(ev.clientX - dx, innerWidth - panel.offsetWidth - 8)) + 'px';
        panel.style.top = Math.max(8, Math.min(ev.clientY - dy, innerHeight - 48)) + 'px';
        captureGeom();
      };
      const up = () => { busy(false); markSize(); saveState(); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });

    /* ресайз */
    panel.querySelectorAll('.rg').forEach(h => {
      h.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        if (panel.classList.contains('rgg-min')) return;
        busy(true);
        const dir = h.dataset.dir;
        const sx = e.clientX, sy = e.clientY;
        const r = panel.getBoundingClientRect();
        const st = { l: r.left, t: r.top, w: r.width, h: r.height };
        const move = ev => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          let l = st.l, t = st.t, w = st.w, hh = st.h;
          if (dir.includes('e')) w = st.w + dx;
          if (dir.includes('s')) hh = st.h + dy;
          if (dir.includes('w')) { w = st.w - dx; l = st.l + dx; }
          if (dir.includes('n')) { hh = st.h - dy; t = st.t + dy; }
          if (w < MIN_W) { if (dir.includes('w')) l = st.l + st.w - MIN_W; w = MIN_W; }
          if (hh < MIN_H) { if (dir.includes('n')) t = st.t + st.h - MIN_H; hh = MIN_H; }
          w = Math.min(w, innerWidth - 16); hh = Math.min(hh, innerHeight - 16);
          panel.style.right = 'auto';
          panel.style.left = l + 'px'; panel.style.top = t + 'px';
          panel.style.width = w + 'px'; panel.style.height = hh + 'px';
          captureGeom();
        };
        const up = () => { busy(false); markSize(); saveState(); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
        addEventListener('pointermove', move); addEventListener('pointerup', up);
      });
    });

    /* восстановление геометрии / инверсии / скрытости */
    const st = loadState();
    if (st && typeof st.w === 'number') {
      lastGeom = {
        x: Math.max(8, Math.min(st.x, innerWidth - Math.max(MIN_W, st.w) - 8)),
        y: Math.max(8, Math.min(st.y, innerHeight - Math.max(MIN_H, st.h) - 8)),
        w: Math.max(MIN_W, Math.min(st.w, innerWidth - 16)),
        h: Math.max(MIN_H, Math.min(st.h, innerHeight - 16))
      };
    } else {
      const r = panel.getBoundingClientRect();
      lastGeom = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    panel.style.right = 'auto';
    panel.style.left = lastGeom.x + 'px'; panel.style.top = lastGeom.y + 'px';
    panel.style.width = lastGeom.w + 'px'; panel.style.height = lastGeom.h + 'px';

    if (st && typeof st.inv === 'boolean') {
      invertOn = st.inv;
      panel.classList.toggle('no-invert', !invertOn);
      refs.invBtn.classList.toggle('is-on', invertOn);
    }
    markSize();

    if (st && st.hidden === true) setHidden(true);   // вспомнили, что был скрыт
  }

  function renderAuto() { refs.autoBtn.classList.toggle('is-on', autoOn); }

  function setChat(ch) {
    if (!ch) return;
    if (current === ch) return;
    current = ch;
    refs.loader.classList.remove('hide');
    clearTimeout(refs._lt); refs._lt = setTimeout(() => refs.loader.classList.add('hide'), 7000);
    refs.frame.src = 'https://www.twitch.tv/embed/' + ch + '/chat?parent=' + HOST + '&darkpopout&theme=dark';
    refs.name.textContent = ch;
    if (refs.dockNick) refs.dockNick.textContent = ch;
    refs.chips.querySelectorAll('.rgg-chip').forEach(c => c.classList.toggle('on', c.dataset.ch === ch));
  }

  function buildChips(list) {
    const seen = new Set(), chans = [];
    list.forEach(p => { if (!seen.has(p.ch)) { seen.add(p.ch); chans.push(p.ch); } });
    chans.sort();
    const key = chans.join(',');
    if (key === chipsKey) return;
    chipsKey = key;
    refs.chips.innerHTML = '';
    chans.forEach(ch => {
      const b = document.createElement('button');
      b.className = 'rgg-chip' + (ch === current ? ' on' : '');
      b.textContent = ch; b.dataset.ch = ch;
      b.onclick = () => { autoOn = false; renderAuto(); setChat(ch); };
      refs.chips.appendChild(b);
    });
  }

  function tick() {
    if (document.hidden) return;
    const list = players();
    buildChips(list);
    if (autoOn) {
      const act = detectActive(list);
      if (act) {
        if (act.ch === lastDetected) stable++;
        else { stable = 0; lastDetected = act.ch; }
        if (stable >= 2) setChat(act.ch);
      }
    }
  }

  /* ===== горячая клавиша Alt+C ===== */
  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
      e.preventDefault();
      setHidden(!hidden);
    }
  });

  buildDock();
  buildPanel();
  tick();
  setInterval(tick, 800);
})();
