// ==UserScript==
// @name         RGG Land — чат + листочек + 2-й монитор (v17 watchdog)
// @namespace    rgg.land.chat.sync
// @version      17.0
// @description  v17: сторож пересоздаёт чат, если сайт вынес его из DOM (фикс пропажи после Ctrl+F5) + самоочистка + try/catch
// @match        https://rgg.land/*
// @match        https://www.rgg.land/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const HOST = location.hostname;
  const SAVE_KEY = 'rgg_chat_win_v11';
  const ACTIVE_KEY = 'rgg_active_v11';
  const HEART_KEY = 'rgg_hb_v12';
  const INSTANCE_KEY = '__rggChat_v17';
  const MODE = /chatwall/i.test(location.hash + location.search) ? 'wall' : 'dock';
  const MIN_W = 220, MIN_H = 200;
  const SIZES = { s: [240, 330], m: [300, 480], l: [400, 680] };

  /* ===== самоочистка предыдущего инстанса (двойной инжект на тёплой перезагрузке) ===== */
  const timers = [];
  function regInterval(fn, ms) { const id = setInterval(fn, ms); timers.push(id); return id; }
  function regTimeout(fn, ms) { const id = setTimeout(fn, ms); timers.push(id); return id; }
  function cleanupInstance() {
    timers.forEach(id => { clearInterval(id); clearTimeout(id); });
    timers.length = 0;
    try { document.removeEventListener('keydown', keyHandler); } catch (e) {}
    try { window.removeEventListener('storage', storageHandler); } catch (e) {}
    try { const p = document.getElementById('rggchat'); if (p) p.remove(); } catch (e) {}
    try { const d = document.getElementById('rggdock'); if (d) d.remove(); } catch (e) {}
    try { document.querySelectorAll('style[data-rgg], link[data-rgg]').forEach(n => n.remove()); } catch (e) {}
  }
  try { if (window[INSTANCE_KEY] && typeof window[INSTANCE_KEY].cleanup === 'function') window[INSTANCE_KEY].cleanup(); } catch (e) {}

  let current = null, invertOn = true, hidden = false, dockOn = true, siteMode = false;
  let chipsKey = '', wallChips = new Set();
  let autoOn = true, wallAuto = true, lastDetected = null, stable = 0;
  let lastBroadcast = null, lastHb = 0;
  let embeddedActive = false, booted = false, attempts = 0;
  let refs = {};
  let lastGeom = { x: 0, y: 0, w: 300, h: 480 };

  /* ===== ранний wall-hide (безопасен, с защитой) ===== */
  if (MODE === 'wall') {
    try {
      const early = document.createElement('style');
      early.id = 'rggwallhide'; early.setAttribute('data-rgg', '1');
      early.textContent =
        'html.rgg-wall-mode,html.rgg-wall-mode body{background:#0e0e10!important;margin:0!important;' +
        'overflow:hidden!important;height:100%!important}' +
        'html.rgg-wall-mode body>*:not(#rggchat){display:none!important}';
      (document.head || document.documentElement).appendChild(early);
      document.documentElement.classList.add('rgg-wall-mode');
    } catch (e) {}
  }

  try {
    const font = document.createElement('link');
    font.rel = 'stylesheet'; font.setAttribute('data-rgg', '1');
    font.href = 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700;800&family=Rubik:wght@400;500;600;700;800&display=swap';
    (document.head || document.documentElement).appendChild(font);
  } catch (e) {}

  function loadState() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch (e) { return {}; } }
  function captureGeom() {
    const p = refs.panel; if (!p) return;
    const x = parseFloat(p.style.left), y = parseFloat(p.style.top);
    const w = parseFloat(p.style.width), h = parseFloat(p.style.height);
    if (!isNaN(x)) lastGeom.x = x; if (!isNaN(y)) lastGeom.y = y;
    if (!isNaN(w)) lastGeom.w = w; if (!isNaN(h)) lastGeom.h = h;
  }
  function restoreGeom() {
    const p = refs.panel, g = lastGeom; if (!p) return;
    p.style.right = 'auto';
    p.style.left = g.x + 'px'; p.style.top = g.y + 'px';
    p.style.width = g.w + 'px'; p.style.height = g.h + 'px';
  }
  function saveState() {
    if (MODE === 'dock' && !embeddedActive) captureGeom();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...lastGeom, inv: invertOn, hidden, dock: dockOn, site: siteMode })); } catch (e) {}
  }
  let _svT = null; function saveSoon() { clearTimeout(_svT); _svT = regTimeout(saveState, 250); }

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
  function isChatSrc(src) {
    const s = (src || '').toLowerCase();
    return s.includes('twitch.tv/embed/') && s.includes('/chat');
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
    if (MODE === 'wall' || embeddedActive || !refs.panel) return;
    const w = parseFloat(refs.panel.style.width), h = parseFloat(refs.panel.style.height);
    refs.panel.querySelectorAll('.rgg-sz').forEach(b => {
      const [pw, ph] = SIZES[b.dataset.sz];
      b.classList.toggle('is-on', Math.abs(w - pw) < 3 && Math.abs(h - ph) < 3);
    });
  }

  function applyDockVisibility() {
    if (!refs.dock) return;
    const show = MODE === 'dock' && !embeddedActive && hidden && dockOn;
    if (show) {
      if (refs.dock.style.display !== 'flex') {
        refs.dock.style.display = 'flex';
        refs.dock.classList.remove('show');
        requestAnimationFrame(() => refs.dock.classList.add('show'));
      }
    } else {
      refs.dock.style.display = 'none';
      refs.dock.classList.remove('show');
    }
  }

  function setHidden(h) {
    hidden = h;
    if (embeddedActive) { applyDockVisibility(); saveState(); return; }
    if (refs.panel) refs.panel.style.display = h ? 'none' : 'flex';
    applyDockVisibility();
    if (!h) markSize();
    saveState();
  }

  function updateDockTitle() {
    if (refs.xBtn) refs.xBtn.title = dockOn
      ? 'Скрыть чат · вернуть якорем или Alt+C'
      : 'Скрыть чат · вернуть только Alt+C (якорь выключен)';
    if (refs.dockToggle) refs.dockToggle.title = dockOn
      ? 'Якорь возврата: ВКЛ (клик — убрать)'
      : 'Якорь возврата: ВЫКЛ · вернуть чат Alt+C (клик — вернуть якорь)';
  }
  function toggleDock() {
    dockOn = !dockOn;
    if (refs.dockToggle) {
      refs.dockToggle.classList.toggle('is-on', dockOn);
      refs.dockToggle.classList.toggle('is-off', !dockOn);
      refs.dockToggle.classList.remove('flash'); void refs.dockToggle.offsetWidth; refs.dockToggle.classList.add('flash');
    }
    updateDockTitle(); applyDockVisibility(); saveState();
  }

  function updateSiteTitle() {
    if (!refs.siteToggle) return;
    refs.siteToggle.title = siteMode
      ? 'Режим «листочек сайта»: ВКЛ — по кнопке чата на сайте наш чат встаёт в правую колонку (Alt+D)'
      : 'Режим «листочек сайта»: ВЫКЛ — чат только плавающий (Alt+D)';
  }

  function applyNativeOpacity(el, on) {
    if (!el) return;
    if (on) {
      if (el.dataset.rggOp === undefined) el.dataset.rggOp = el.style.opacity || '';
      if (el.dataset.rggPe === undefined) el.dataset.rggPe = el.style.pointerEvents || '';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    } else {
      el.style.opacity = el.dataset.rggOp || '';
      el.style.pointerEvents = el.dataset.rggPe || '';
      delete el.dataset.rggOp; delete el.dataset.rggPe;
    }
  }

  function findNativeChatPanel() {
    const ifs = document.querySelectorAll('iframe');
    for (const f of ifs) {
      if (refs.panel && refs.panel.contains(f)) continue;
      if (!isChatSrc(f.src || f.getAttribute('src') || '')) continue;
      const r = f.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      let cont = f.parentElement, best = f;
      for (let i = 0; i < 4 && cont; i++) {
        const cr = cont.getBoundingClientRect();
        if (cr.height > r.height + 20 && Math.abs(cr.width - r.width) < 50) { best = cont; break; }
        cont = cont.parentElement;
      }
      const br = best.getBoundingClientRect();
      return { el: best, width: br.width > 200 ? br.width : r.width };
    }
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, header = null;
    while ((n = walk.nextNode())) {
      const v = (n.textContent || '').trim();
      if (v === 'Чат трансляции') { header = n.parentElement; break; }
    }
    if (header && !(refs.panel && refs.panel.contains(header))) {
      let el = header;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        const r = el.getBoundingClientRect();
        if (r.right > innerWidth - 60 && r.height > innerHeight * 0.5 && r.width >= 240 && r.width <= 560) {
          return { el, width: r.width };
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  function enterEmbedded(width, nativeEl, ch) {
    refs.nativeEl = nativeEl;
    applyNativeOpacity(nativeEl, true);
    const w = Math.max(300, Math.min(460, width || 360));
    const p = refs.panel; if (!p) return;
    p.classList.remove('rgg-min');
    p.classList.add('rgg-embedded');
    p.style.left = ''; p.style.top = ''; p.style.right = ''; p.style.height = '';
    p.style.width = w + 'px';
    p.style.display = 'flex';
    embeddedActive = true;
    applyDockVisibility();
    setChat(ch);
  }
  function exitEmbedded() {
    if (!embeddedActive) return;
    applyNativeOpacity(refs.nativeEl, false);
    refs.nativeEl = null;
    if (refs.panel) refs.panel.classList.remove('rgg-embedded');
    embeddedActive = false;
    restoreGeom();
    if (refs.panel) refs.panel.style.display = hidden ? 'none' : 'flex';
    applyDockVisibility();
    if (!hidden) markSize();
  }

  function applySiteMode(on) {
    siteMode = on;
    if (refs.siteToggle) {
      refs.siteToggle.classList.toggle('is-on', on);
      refs.siteToggle.classList.toggle('is-off', !on);
      refs.siteToggle.classList.remove('flash'); void refs.siteToggle.offsetWidth; refs.siteToggle.classList.add('flash');
    }
    updateSiteTitle();
    if (!on && embeddedActive) exitEmbedded();
    saveState();
  }

  function updateLink() {
    if (!refs.link) return;
    const alive = (Date.now() - lastHb) < 3500;
    refs.link.classList.toggle('ok', alive);
    refs.link.classList.toggle('bad', !alive);
    refs.link.textContent = alive ? ('LINK · ' + (current || '—')) : 'NO LINK';
    refs.link.title = alive
      ? 'Связь со стрим-окном есть'
      : 'Нет связи: откройте rgg.land/live в ТОМ ЖЕ Chrome и профиле, где этот ярлык';
  }

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
      .dock-label b{font-size:13px;font-weight:700}
      .dock-label small{font-size:10px;font-weight:500;color:#e9d5ff;text-transform:lowercase}
      .dock-label kbd{font-family:'Chakra Petch',sans-serif;font-size:9px;font-weight:700;color:#ddd6fe;
        background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.18);border-radius:4px;padding:0 4px;margin-left:5px}
    `;
    const st = document.createElement('style'); st.setAttribute('data-rgg', '1'); st.textContent = css; document.head.appendChild(st);
    const dock = document.createElement('button');
    dock.id = 'rggdock'; dock.title = 'Открыть чат (Alt+C)';
    dock.innerHTML = `
      <span class="dock-ico">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>
        <span class="dock-dot"></span>
      </span>
      <span class="dock-label"><b>открыть чат<kbd>Alt+C</kbd></b><small class="dock-nick">—</small></span>`;
    document.body.appendChild(dock);
    refs.dock = dock; refs.dockNick = dock.querySelector('.dock-nick');
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
        box-shadow:0 18px 50px rgba(0,0,0,.65), 0 0 0 1px rgba(145,71,255,.16), 0 0 60px -10px rgba(145,71,255,.35);
        animation:rggIn .55s cubic-bezier(.2,.9,.3,1.2);
      }
      #rggchat::before{content:'';position:absolute;inset:-1px;border-radius:12px;pointer-events:none;
        background:linear-gradient(135deg,rgba(145,71,255,.5),transparent 35%,transparent 65%,rgba(145,71,255,.25));
        -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
        -webkit-mask-composite:xor;mask-composite:exclude;padding:1px;opacity:.6;animation:rggBorder 6s linear infinite}
      @keyframes rggBorder{0%,100%{opacity:.35}50%{opacity:.75}}
      @keyframes rggIn{from{opacity:0;transform:translateY(26px) scale(.96)}to{opacity:1;transform:none}}
      #rggchat:hover{box-shadow:0 18px 50px rgba(0,0,0,.7), 0 0 0 1px rgba(145,71,255,.28), 0 0 80px -8px rgba(145,71,255,.5)}
      #rggchat.rgg-min{width:auto!important;height:auto!important;min-width:0;min-height:0}
      #rggchat.rgg-min .rgg-name,#rggchat.rgg-min .rgg-live,#rggchat.rgg-min .rgg-ver,
      #rggchat.rgg-min .rgg-row2,#rggchat.rgg-min .rgg-body,#rggchat.rgg-min .rg{display:none}

      #rggchat.rgg-wall{position:fixed;inset:0!important;width:auto!important;height:auto!important;
        min-width:0;min-height:0;border:none;border-radius:0;box-shadow:none;animation:none}
      #rggchat.rgg-wall::before{display:none}
      #rggchat.rgg-wall .rg,#rggchat.rgg-wall .rgg-minb,#rggchat.rgg-wall .rgg-x,
      #rggchat.rgg-wall .rgg-sz,#rggchat.rgg-wall .rgg-dock-toggle,#rggchat.rgg-wall .rgg-site-toggle{display:none}
      #rggchat.rgg-wall .rgg-top{cursor:default}
      #rggchat.rgg-wall .rgg-name{font-size:20px}

      #rggchat.rgg-embedded{position:fixed!important;right:0!important;top:0!important;left:auto!important;
        height:100vh!important;border-radius:0!important;
        border:none!important;border-left:1px solid var(--line)!important;
        box-shadow:-14px 0 44px rgba(0,0,0,.55)!important;animation:none!important;margin:0!important}
      #rggchat.rgg-embedded::before{display:none}
      #rggchat.rgg-embedded .rg,#rggchat.rgg-embedded .rgg-minb,#rggchat.rgg-embedded .rgg-x{display:none}
      #rggchat.rgg-embedded .rgg-top{cursor:default}

      .rgg-top{display:flex;align-items:center;gap:9px;padding:11px 12px;cursor:grab;user-select:none;
        touch-action:none;background:var(--elev);border-bottom:1px solid var(--line);position:relative;z-index:2}
      .rgg-top:active{cursor:grabbing}
      .rgg-top::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;
        background:linear-gradient(90deg,var(--purple-deep),var(--purple) 45%,transparent);opacity:.9}
      .rgg-logo{flex:0 0 auto;display:flex;filter:drop-shadow(0 0 6px rgba(145,71,255,.6))}
      .rgg-name{font-family:'Chakra Petch',sans-serif;font-weight:700;font-size:16px;text-transform:lowercase;
        letter-spacing:.02em;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .rgg-live{display:inline-flex;align-items:center;gap:5px;font-family:'Chakra Petch',sans-serif;
        font-size:9px;font-weight:700;letter-spacing:.16em;color:#ff5c5c;flex:0 0 auto}
      .rgg-live i{width:7px;height:7px;border-radius:50%;background:var(--red);animation:rggPulse 1.5s infinite}
      @keyframes rggPulse{0%{box-shadow:0 0 0 0 rgba(235,4,0,.55)}70%{box-shadow:0 0 0 7px rgba(235,4,0,0)}100%{box-shadow:0 0 0 0 rgba(235,4,0,0)}}
      .rgg-ver{font-family:'Chakra Petch',sans-serif;font-size:9px;font-weight:800;color:var(--purple-hov);
        border:1px solid var(--purple-deep);border-radius:5px;padding:1px 6px;letter-spacing:.1em;flex:0 0 auto;
        box-shadow:0 0 10px -2px rgba(145,71,255,.6)}
      .rgg-link{font-family:'Chakra Petch',sans-serif;font-size:9px;font-weight:800;letter-spacing:.1em;
        border-radius:5px;padding:2px 7px;flex:0 0 auto;border:1px solid transparent;transition:.2s;white-space:nowrap}
      .rgg-link.ok{color:#bbf7d0;background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.5);box-shadow:0 0 10px -2px rgba(34,197,94,.6)}
      .rgg-link.bad{color:#fecaca;background:rgba(235,4,0,.14);border-color:rgba(235,4,0,.5);animation:rggLinkBad 1.1s ease-in-out infinite}
      @keyframes rggLinkBad{0%,100%{opacity:.5}50%{opacity:1}}
      #rggchat:not(.rgg-wall) .rgg-link{display:none}
      .rgg-spacer{flex:1}
      .rgg-btn{background:var(--elev);border:1px solid var(--line);color:var(--muted);border-radius:6px;
        min-width:26px;height:24px;cursor:pointer;font-size:13px;font-family:'Rubik',sans-serif;
        display:inline-flex;align-items:center;justify-content:center;transition:.16s;padding:0 6px}
      .rgg-btn:hover{color:var(--text);border-color:var(--purple);background:#26262c;transform:translateY(-1px)}
      .rgg-btn:active{transform:translateY(0) scale(.94)}
      .rgg-auto{font-size:9px;font-weight:700;letter-spacing:.14em;padding:0 9px}
      .rgg-auto.is-on{background:var(--purple-deep);color:#fff;border-color:var(--purple);box-shadow:0 0 12px rgba(145,71,255,.55)}
      .rgg-auto.is-on:hover{background:var(--purple)}

      .rgg-dock-toggle,.rgg-site-toggle{position:relative;overflow:hidden}
      .rgg-dock-toggle .pin-ico,.rgg-site-toggle .site-ico{display:block;transition:.2s}
      .rgg-dock-toggle.is-on{border-color:var(--purple);background:#26262c}
      .rgg-dock-toggle.is-on .pin-ico{fill:var(--purple-hov);filter:drop-shadow(0 0 5px rgba(169,112,255,.6))}
      .rgg-dock-toggle.is-off .pin-ico{fill:var(--muted);opacity:.45}
      .rgg-site-toggle.is-on{border-color:var(--purple);background:#26262c}
      .rgg-site-toggle.is-on .site-ico{color:var(--purple-hov);filter:drop-shadow(0 0 5px rgba(169,112,255,.6))}
      .rgg-site-toggle.is-off .site-ico{color:var(--muted);opacity:.5}
      .rgg-slash{position:absolute;left:4px;right:4px;top:50%;height:2px;border-radius:2px;background:var(--red);
        transform:rotate(-45deg) scaleX(0);transform-origin:center;transition:transform .25s cubic-bezier(.2,.9,.3,1);opacity:.9;pointer-events:none}
      .rgg-dock-toggle.is-off .rgg-slash{transform:rotate(-45deg) scaleX(1)}
      .rgg-dock-toggle.flash,.rgg-site-toggle.flash{animation:rggPinFlash .45s}
      @keyframes rggPinFlash{0%{box-shadow:0 0 0 0 rgba(169,112,255,.6)}100%{box-shadow:0 0 0 9px rgba(169,112,255,0)}}

      .rgg-row2{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--panel);
        border-bottom:1px solid var(--line);position:relative;z-index:2}
      .rgg-chips{flex:1;min-width:0;display:flex;gap:6px;overflow-x:auto;scrollbar-width:thin}
      .rgg-chip{flex:0 0 auto;background:var(--elev);border:1px solid var(--line);color:var(--muted);
        border-radius:6px;padding:4px 11px;font-size:12px;font-weight:600;cursor:pointer;position:relative;overflow:hidden;
        transition:.16s;text-transform:lowercase;font-family:'Rubik',sans-serif}
      .rgg-chip:hover{color:var(--purple-hov);border-color:var(--purple);transform:translateY(-1px)}
      .rgg-chip.on{background:var(--purple-deep);color:#fff;border-color:var(--purple-deep);box-shadow:0 2px 10px rgba(145,71,255,.45)}
      .rgg-chip.on::after{content:'';position:absolute;top:0;left:-60%;width:40%;height:100%;
        background:linear-gradient(100deg,transparent,rgba(255,255,255,.45),transparent);animation:rggShine 2.6s ease-in-out infinite}
      @keyframes rggShine{0%{left:-60%}55%,100%{left:130%}}
      .rgg-tools{flex:0 0 auto;display:flex;gap:5px}
      .rgg-sz{min-width:24px;height:22px;font-size:10px;font-weight:800;font-family:'Chakra Petch',sans-serif}
      .rgg-sz.is-on{color:var(--purple-hov);border-color:var(--purple);background:#26262c;box-shadow:0 0 8px -2px rgba(145,71,255,.5)}
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
    const style = document.createElement('style'); style.setAttribute('data-rgg', '1'); style.textContent = css; document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'rggchat';
    if (MODE === 'wall') panel.classList.add('rgg-wall');
    panel.innerHTML = `
      <div class="rgg-top">
        <span class="rgg-logo"><svg viewBox="0 0 24 24" width="17" height="17" fill="#a970ff"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg></span>
        <span class="rgg-name">…</span>
        <span class="rgg-live"><i></i>LIVE</span>
        <span class="rgg-ver">v17${MODE === 'wall' ? '·wall' : ''}</span>
        <span class="rgg-link bad">NO LINK</span>
        <span class="rgg-spacer"></span>
        <button class="rgg-btn rgg-auto is-on" title="${MODE === 'wall' ? 'Синхронизация со стрим-окном' : 'Авто-переключение'}">AUTO</button>
        <button class="rgg-btn rgg-minb" title="Свернуть в полоску">–</button>
        <button class="rgg-btn rgg-x" title="Скрыть чат (Alt+C)">×</button>
      </div>
      <div class="rgg-row2">
        <div class="rgg-chips"></div>
        <div class="rgg-tools">
          <button class="rgg-btn rgg-sz" data-sz="s" title="Маленький">S</button>
          <button class="rgg-btn rgg-sz" data-sz="m" title="Средний">M</button>
          <button class="rgg-btn rgg-sz" data-sz="l" title="Большой">L</button>
          <button class="rgg-btn rgg-dock-toggle is-on" title="Якорь возврата">
            <svg class="pin-ico" viewBox="0 0 24 24" width="13" height="13"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
            <span class="rgg-slash"></span>
          </button>
          <button class="rgg-btn rgg-site-toggle is-off" title="Режим «листочек сайта»">
            <svg class="site-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 12h5"/></svg>
          </button>
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
    refs.link = panel.querySelector('.rgg-link');
    refs.xBtn = panel.querySelector('.rgg-x');
    refs.dockToggle = panel.querySelector('.rgg-dock-toggle');
    refs.siteToggle = panel.querySelector('.rgg-site-toggle');

    if (refs.autoBtn) refs.autoBtn.onclick = () => {
      if (MODE === 'wall') {
        wallAuto = !wallAuto; renderAuto();
        if (wallAuto) { const c = localStorage.getItem(ACTIVE_KEY); if (c) setChat(c); }
      } else { autoOn = !autoOn; renderAuto(); }
    };
    if (MODE === 'dock') {
      const minb = panel.querySelector('.rgg-minb'); if (minb) minb.onclick = () => panel.classList.toggle('rgg-min');
      if (refs.xBtn) refs.xBtn.onclick = () => setHidden(true);
      if (refs.dockToggle) refs.dockToggle.onclick = toggleDock;
      if (refs.siteToggle) refs.siteToggle.onclick = () => applySiteMode(!siteMode);
    }
    const rel = panel.querySelector('.rgg-reload'); if (rel) rel.onclick = () => { const ch = current; if (ch) { current = null; setChat(ch); } };
    if (refs.invBtn) refs.invBtn.onclick = () => {
      invertOn = !invertOn;
      panel.classList.toggle('no-invert', !invertOn);
      refs.invBtn.classList.toggle('is-on', invertOn);
      saveState();
    };
    panel.querySelectorAll('.rgg-sz').forEach(b => b.onclick = () => setSize(b.dataset.sz));
    refs.frame.addEventListener('load', () => refs.loader.classList.add('hide'));

    function setSize(key) {
      if (MODE === 'wall' || embeddedActive) return;
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

    if (MODE === 'dock') {
      refs.top.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        if (embeddedActive) return;
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
      panel.querySelectorAll('.rg').forEach(h => {
        h.addEventListener('pointerdown', e => {
          e.preventDefault(); e.stopPropagation();
          if (panel.classList.contains('rgg-min') || embeddedActive) return;
          busy(true);
          const dir = h.dataset.dir, sx = e.clientX, sy = e.clientY;
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
    }

    /* восстановление настроек */
    const st = loadState();
    if (MODE === 'dock') {
      if (st && typeof st.w === 'number') {
        lastGeom = {
          x: Math.max(8, Math.min(st.x, innerWidth - Math.max(MIN_W, st.w) - 8)),
          y: Math.max(8, Math.min(st.y, innerHeight - Math.max(MIN_H, st.h) - 8)),
          w: Math.max(MIN_W, Math.min(st.w, innerWidth - 16)),
          h: Math.max(MIN_H, Math.min(st.h, innerHeight - 16))
        };
      } else { const r = panel.getBoundingClientRect(); lastGeom = { x: r.left, y: r.top, w: r.width, h: r.height }; }
      restoreGeom();
    }
    if (st && typeof st.inv === 'boolean') {
      invertOn = st.inv;
      panel.classList.toggle('no-invert', !invertOn);
      if (refs.invBtn) refs.invBtn.classList.toggle('is-on', invertOn);
    }
    if (st && typeof st.dock === 'boolean') dockOn = st.dock;
    if (refs.dockToggle) {
      refs.dockToggle.classList.toggle('is-on', dockOn);
      refs.dockToggle.classList.toggle('is-off', !dockOn);
    }
    updateDockTitle();
    if (st && typeof st.site === 'boolean') siteMode = st.site;
    if (refs.siteToggle) {
      refs.siteToggle.classList.toggle('is-on', siteMode);
      refs.siteToggle.classList.toggle('is-off', !siteMode);
    }
    updateSiteTitle();
    markSize();

    if (MODE === 'dock') {
      if (st && st.hidden === true) setHidden(true);
    }
    if (MODE === 'wall') {
      refs.panel.style.display = 'flex';
      const c0 = localStorage.getItem(ACTIVE_KEY); if (c0) setChat(c0);
      lastHb = parseInt(localStorage.getItem(HEART_KEY) || '0', 10) || 0;
      updateLink();
    }
  }

  function renderAuto() { if (refs.autoBtn) refs.autoBtn.classList.toggle('is-on', MODE === 'wall' ? wallAuto : autoOn); }

  function setChat(ch) {
    if (!ch || current === ch) return;
    current = ch;
    if (refs.loader) refs.loader.classList.remove('hide');
    clearTimeout(refs._lt); refs._lt = regTimeout(() => refs.loader && refs.loader.classList.add('hide'), 7000);
    if (refs.frame) refs.frame.src = 'https://www.twitch.tv/embed/' + ch + '/chat?parent=' + HOST + '&darkpopout&theme=dark';
    if (refs.name) refs.name.textContent = ch;
    if (refs.dockNick) refs.dockNick.textContent = ch;
    if (MODE === 'wall') { wallChips.add(ch); updateLink(); }
    if (MODE === 'dock') { try { localStorage.setItem(ACTIVE_KEY, ch); } catch (e) {} }
    refreshChips();
  }

  function refreshChips() {
    if (!refs.chips) return;
    const set = new Set();
    players().forEach(p => set.add(p.ch));
    if (MODE === 'wall') wallChips.forEach(c => set.add(c));
    if (current) set.add(current);
    const chans = [...set].sort();
    const key = chans.join(',');
    if (key === chipsKey) {
      refs.chips.querySelectorAll('.rgg-chip').forEach(c => c.classList.toggle('on', c.dataset.ch === current));
      return;
    }
    chipsKey = key;
    refs.chips.innerHTML = '';
    chans.forEach(ch => {
      const b = document.createElement('button');
      b.className = 'rgg-chip' + (ch === current ? ' on' : '');
      b.textContent = ch; b.dataset.ch = ch;
      b.onclick = () => {
        if (MODE === 'wall') wallAuto = false; else autoOn = false;
        renderAuto(); setChat(ch);
      };
      refs.chips.appendChild(b);
    });
  }

  /* ===== тело тика (обёрнуто в tickGuarded) ===== */
  function tickBody() {
    if (MODE === 'wall') { refreshChips(); return; }

    if (siteMode) {
      const col = findNativeChatPanel();
      if (col) {
        const ch = autoOn ? ((detectActive(players()) || {}).ch || current) : current;
        if (!embeddedActive) enterEmbedded(col.width, col.el, ch || lastBroadcast || 'nuke73');
        else { refs.nativeEl = col.el; applyNativeOpacity(col.el, true); if (ch) setChat(ch); }
      } else if (embeddedActive) {
        exitEmbedded();
      }
    } else if (embeddedActive) {
      exitEmbedded();
    }

    const list = players();
    refreshChips();
    const act = detectActive(list);
    if (act && act.ch !== lastBroadcast) { lastBroadcast = act.ch; try { localStorage.setItem(ACTIVE_KEY, act.ch); } catch (e) {} }
    try { localStorage.setItem(HEART_KEY, String(Date.now())); } catch (e) {}
    if (!embeddedActive && autoOn && act) {
      if (act.ch === lastDetected) stable++; else { stable = 0; lastDetected = act.ch; }
      if (stable >= 2) setChat(act.ch);
    }
  }

  function tickGuarded() {
    try { if (!refs.panel || !refs.chips || document.hidden) return; tickBody(); }
    catch (e) { console.error('[RGG-chat] tick error', e); }
  }
  function updateLinkGuarded() { try { if (refs.link) updateLink(); } catch (e) {} }

  /* ===== единая сборка DOM (идемпотентна: чистит свои висящие узлы и строит заново) ===== */
  function buildDom() {
    try {
      const oldP = document.getElementById('rggchat'); if (oldP) oldP.remove();
      const oldD = document.getElementById('rggdock'); if (oldD) oldD.remove();
      document.querySelectorAll('style[data-rgg]:not(#rggwallhide)').forEach(n => n.remove());
      refs = {};
      embeddedActive = false;
      if (MODE === 'dock') buildDock();
      buildPanel();
      renderAuto();
      booted = true; attempts = 0;
      console.log('[RGG-chat] v17 dom built · mode=' + MODE);
    } catch (e) {
      console.error('[RGG-chat] buildDom error', e);
    }
  }

  /* ===== сторож: если сайт вынес чат/якорь из DOM — пересобрать ===== */
  function watchdog() {
    if (!document.body) return;
    const p = document.getElementById('rggchat');
    const pOk = !!(p && document.body.contains(p));
    if (MODE === 'dock') {
      const d = document.getElementById('rggdock');
      const dOk = !!(d && document.body.contains(d));
      if (pOk && dOk) { attempts = 0; return; }
    } else if (pOk) { attempts = 0; return; }
    if (attempts++ > 30) { if (attempts === 31) console.error('[RGG-chat] too many rebuilds — backing off'); return; }
    console.warn('[RGG-chat] watchdog: panel/dock missing in DOM — rebuilding');
    buildDom();
  }

  /* ===== обработчики, снимаемые при cleanup ===== */
  function keyHandler(e) {
    if (MODE !== 'dock') return;
    if (e.altKey && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) { e.preventDefault(); applySiteMode(!siteMode); return; }
    if (e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC') && !embeddedActive) { e.preventDefault(); setHidden(!hidden); }
  }
  function storageHandler(e) {
    if (e.key === ACTIVE_KEY && wallAuto && e.newValue) setChat(e.newValue);
    if (e.key === HEART_KEY && e.newValue) { lastHb = parseInt(e.newValue, 10) || Date.now(); updateLink(); }
  }

  /* ===== запуск: интервалы и слушатели вешаются один раз, не зависят от body ===== */
  window[INSTANCE_KEY] = { cleanup: cleanupInstance };
  regInterval(tickGuarded, 350);
  if (MODE === 'wall') {
    regInterval(updateLinkGuarded, 1000);
    window.addEventListener('storage', storageHandler);
  }
  regInterval(watchdog, 2000);
  document.addEventListener('keydown', keyHandler);

  if (document.body) buildDom();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildDom, { once: true });
  else buildDom();

  console.log('[RGG-chat] v17 started · mode=' + MODE);
})();