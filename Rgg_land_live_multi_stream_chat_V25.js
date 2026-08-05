// ==UserScript==
// @name         RGG Land — чат + листочек + стена кнопкой (v25)
// @namespace    rgg.land.chat.sync
// @version      25.0
// @description  v25: встроенный чат по листочку, стена окном, бейдж игры 16px (DecAPI+GQL), WALL прячет 1-й экран, листочек = тумблер, длинный ник переносится на 2 строки
// @match        https://rgg.land/live
// @match        https://www.rgg.land/live
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      decapi.me
// @connect      twitch.tv
// @connect      gql.twitch.tv
// ==/UserScript==

(function () {
  'use strict';

  const HOST = location.hostname;
  const SAVE_KEY = 'rgg_chat_win_v11';
  const ACTIVE_KEY = 'rgg_active_v11';
  const HEART_KEY = 'rgg_hb_v12';
  const WALL_GEOM_KEY = 'rgg_wall_geom_v18';
  const INSTANCE_KEY = '__rggChat_v25';
  const TWITCH_WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4uo6tgcw2s9w';
  const MODE = /chatwall/i.test(location.hash + location.search) ? 'wall' : 'dock';
  const MIN_W = 220, MIN_H = 200;
  const SIZES = { s: [240, 330], m: [300, 480], l: [400, 680] };

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
    try { const l = document.getElementById('rgglifeline'); if (l) l.remove(); } catch (e) {}
    try { document.querySelectorAll('style[data-rgg], link[data-rgg]').forEach(n => n.remove()); } catch (e) {}
  }
  try { if (window[INSTANCE_KEY] && typeof window[INSTANCE_KEY].cleanup === 'function') window[INSTANCE_KEY].cleanup(); } catch (e) {}

  let current = null, invertOn = true, hidden = false;
  let chipsKey = '', wallChips = new Set();
  let autoOn = true, wallAuto = true;
  let lastBroadcast = null, lastHb = 0;
  let embeddedActive = false, booted = false, attempts = 0;
  let gameCache = {};
  let refs = {};
  let closedByUser = false, nativeHiddenRef = null, wallOpen = false, leafBtn = null;
  let lastGeom = { x: 0, y: 0, w: 300, h: 480 };

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

  function detectBrowser() {
    const ua = navigator.userAgent;
    if (/Firefox\//i.test(ua)) return 'firefox';
    if (/Edg\//i.test(ua)) return 'edge';
    if (/OPR\/|Opera/i.test(ua)) return 'opera';
    if (/Brave/i.test(ua) || (navigator.brave && navigator.brave.isBrave)) return 'brave';
    if (/YaBrowser/i.test(ua)) return 'yandex';
    if (/Vivaldi/i.test(ua)) return 'vivaldi';
    if (/Chrome\//i.test(ua)) return 'chrome';
    return 'other';
  }

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
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...lastGeom, inv: invertOn, hidden })); } catch (e) {}
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

  function applyReturnVisibility() {
    if (!refs.lifeline) return;
    const want = MODE === 'dock' && !embeddedActive && hidden;
    refs.lifeline.style.display = want ? 'flex' : 'none';
  }

  /* ================= игра (ТОЛЬКО здесь 16px) ================= */
  function setGameText(txt, full) {
    if (!refs.game) return;
    const txtEl = refs.game.querySelector('.game-txt');
    if (!txtEl || txtEl.textContent === txt) return;
    txtEl.textContent = txt;
    refs.game.title = full || txt;
    refs.game.classList.remove('bump'); void refs.game.offsetWidth; refs.game.classList.add('bump');
  }
  function applyGame(game, via) {
    if (game === 'OFFLINE') setGameText('OFFLINE', 'Стример не в сети' + (via ? ' · ' + via : ''));
    else if (game) setGameText(game, game + (via ? ' · ' + via : ''));
    else setGameText('—', 'Игра недоступна (оба источника не ответили)');
  }
  function gmGet(url, onOk, onFail) {
    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: url, anonymous: true,
          onload: (res) => { if (res.status >= 200 && res.status < 400) onOk(res.responseText); else onFail(); },
          onerror: () => onFail()
        });
        return;
      } catch (e) {}
    }
    if (typeof fetch === 'function') {
      fetch(url).then(r => (r.ok ? r.text() : Promise.reject())).then(onOk).catch(onFail);
    } else onFail();
  }
  function gmPost(url, headers, data, onOk, onFail) {
    if (typeof GM_xmlhttpRequest !== 'function') { onFail(); return; }
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: url, headers: headers, data: data, anonymous: true,
        onload: (res) => { try { onOk(JSON.parse(res.responseText)); } catch (e) { onFail(); } },
        onerror: () => onFail()
      });
    } catch (e) { onFail(); }
  }
  function fetchGame(login) {
    if (!login) return;
    const c = gameCache[login];
    if (c && Date.now() - c.ts < 90 * 1000) { if (current === login) applyGame(c.game, c.via); return; }
    const done = (game, via) => { gameCache[login] = { game: game, ts: Date.now(), via: via }; if (current === login) applyGame(game, via); };
    gmGet('https://decapi.me/twitch/game/' + encodeURIComponent(login), (text) => {
      const t = (text || '').trim();
      if (!t) return fetchGameFallback(login, done);
      if (/offline/i.test(t)) return done('OFFLINE', 'decapi');
      if (/error|not found|unknown|unexpected/i.test(t)) return fetchGameFallback(login, done);
      done(t, 'decapi');
    }, () => fetchGameFallback(login, done));
  }
  function fetchGameFallback(login, done) {
    const q = 'query($l:String!){user(login:$l){stream{game{displayName name}}}}';
    const parse = (j) => {
      const s = j && j.data && j.data.user && j.data.user.stream;
      if (!s) return 'OFFLINE';
      return (s.game && (s.game.displayName || s.game.name)) || null;
    };
    gmPost('https://gql.twitch.tv/gql',
      { 'Client-ID': TWITCH_WEB_CLIENT_ID, 'Content-Type': 'application/json' },
      JSON.stringify({ query: q, variables: { l: login } }),
      (j) => { const g = parse(j); if (g === null) done(null, null); else done(g, 'gql'); },
      () => done(null, null)
    );
  }

  /* ================= стена / первый экран ================= */
  function updateWallTitle() {
    if (!refs.wallBtn) return;
    const br = detectBrowser();
    let t = 'Открыть чат-стену отдельным окном (удобно на 2-й монитор)';
    if (br === 'firefox') t += ' · Firefox: если откроется вкладкой — разреши всплывающие окна для сайта в настройках';
    refs.wallBtn.title = t;
  }
  function flashWallBtn() {
    if (!refs.wallBtn) return;
    refs.wallBtn.classList.add('blocked');
    refs.wallBtn.title = '⚠ Разреши всплывающие окна для rgg.land — иначе стену не открыть';
    regTimeout(() => { if (refs.wallBtn) { refs.wallBtn.classList.remove('blocked'); updateWallTitle(); } }, 2600);
  }
  function openWallWindow() {
    const url = location.origin + location.pathname + '#chatwall';
    let geom = null;
    try { geom = JSON.parse(localStorage.getItem(WALL_GEOM_KEY)); } catch (e) {}
    let left, top, width, height;
    if (geom && typeof geom.x === 'number' && geom.w > 50) {
      left = geom.x; top = geom.y; width = geom.w; height = geom.h;
    } else {
      left = (screen.availLeft || 0) + (screen.availWidth || innerWidth);
      top = screen.availTop || 0;
      width = screen.availWidth || innerWidth;
      height = screen.availHeight || innerHeight;
    }
    width = Math.max(320, Math.min(width, 3840));
    height = Math.max(240, Math.min(height, 2160));
    const features = 'popup=yes,left=' + left + ',top=' + top + ',width=' + width + ',height=' + height +
      ',toolbar=no,menubar=no,location=no,status=no,resizable=yes,scrollbars=no';
    let w = null;
    try { w = window.open(url, 'rgg_chat_wall', features); } catch (e) { w = null; }
    if (!w) { flashWallBtn(); return; }
    wallOpen = true;
    hideFirstMonitorChat();
    try { w.blur(); window.focus(); } catch (e) {}
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

  function hideFirstMonitorChat() {
    const col = findNativeChatPanel();
    if (col) { nativeHiddenRef = col.el; col.el.style.display = 'none'; }
    closedByUser = true;
    if (embeddedActive) exitEmbedded();
    else { hidden = true; if (refs.panel) refs.panel.style.display = 'none'; applyReturnVisibility(); }
    saveState();
  }

  function findLeafButton() {
    if (leafBtn && leafBtn.isConnected) return leafBtn;
    leafBtn = null;
    const all = document.querySelectorAll('button, [role="button"], a');
    for (const el of all) {
      const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '')).toLowerCase();
      if (/\bchat\b|чат/.test(t) && el.offsetParent !== null) { leafBtn = el; break; }
    }
    return leafBtn;
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
    void p.offsetHeight;
    embeddedActive = true;
    closedByUser = false; nativeHiddenRef = null;
    if (wallOpen) { try { window.close(); } catch (e) {} wallOpen = false; }
    applyReturnVisibility();
    setChat(ch);
  }

  function exitEmbedded() {
    if (!embeddedActive) return;
    applyNativeOpacity(refs.nativeEl, false);
    refs.nativeEl = null;
    if (refs.panel) refs.panel.classList.remove('rgg-embedded');
    embeddedActive = false;
    hidden = true;
    if (refs.panel) refs.panel.style.display = 'none';
    applyReturnVisibility();
    saveState();
  }

  function updateLink() {
    if (!refs.link) return;
    const alive = (Date.now() - lastHb) < 3500;
    refs.link.classList.toggle('ok', alive);
    refs.link.classList.toggle('bad', !alive);
    refs.link.textContent = alive ? ('LINK · ' + (current || '—')) : 'NO LINK';
    refs.link.title = alive ? 'Связь со стрим-окном есть' : 'Нет связи: откройте rgg.land/live в ТОМ ЖЕ Chrome и профиле, где этот ярлык';
  }

  function buildLifeline() {
    const css = `
      #rgglifeline{position:fixed;right:14px;bottom:14px;z-index:2147483001;display:none;align-items:center;justify-content:center;
        width:30px;height:30px;border-radius:9px;cursor:pointer;
        border:1px solid rgba(145,71,255,.22);background:rgba(24,24,27,.5);
        -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);color:#adadb8;
        opacity:.15;transform:scale(.9);
        transition:opacity .28s ease,transform .3s cubic-bezier(.2,1.3,.3,1),box-shadow .28s ease,border-color .28s ease,color .28s ease,background .28s ease}
      #rgglifeline:hover{opacity:1;transform:scale(1.1);color:#fff;border-color:#a970ff;
        background:rgba(145,71,255,.24);box-shadow:0 0 20px -2px rgba(145,71,255,.75),0 0 0 1px rgba(169,112,255,.3) inset}
      #rgglifeline:active{transform:scale(.96)}
      #rgglifeline svg{display:block;transition:filter .28s ease,transform .28s ease}
      #rgglifeline:hover svg{filter:drop-shadow(0 0 6px rgba(169,112,255,.85));transform:translateY(-1px)}
    `;
    const st = document.createElement('style'); st.setAttribute('data-rgg', '1'); st.textContent = css; document.head.appendChild(st);
    const el = document.createElement('button');
    el.id = 'rgglifeline';
    el.title = 'Открыть чат отдельным окном (Alt+C) · или жми кнопку чата в плеере, чтобы встроить';
    el.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    document.body.appendChild(el);
    refs.lifeline = el;
    el.onclick = () => openWallWindow();
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
      #rggchat.rgg-wall .rgg-sz,#rggchat.rgg-wall .rgg-wall-open,#rggchat.rgg-wall .rgg-game{display:none}
      #rggchat.rgg-wall .rgg-top{cursor:default}
      #rggchat.rgg-wall .rgg-name{font-size:20px}

      #rggchat.rgg-embedded{position:fixed!important;right:0!important;top:0!important;left:auto!important;
        height:100vh!important;border-radius:0!important;
        border:none!important;border-left:1px solid var(--line)!important;
        box-shadow:-14px 0 44px rgba(0,0,0,.55)!important;animation:none!important;margin:0!important}
      #rggchat.rgg-embedded::before{display:none}
      #rggchat.rgg-embedded .rg,#rggchat.rgg-embedded .rgg-minb{display:none}
      #rggchat.rgg-embedded .rgg-top{cursor:default}
      #rggchat.rgg-embedded .rgg-sz{display:none}
      #rggchat:not(.rgg-embedded) .rgg-wall-open{display:none}

      #rggchat:not(.rgg-wall) .rgg-chips{display:none}
      #rggchat:not(.rgg-wall) .rgg-tools{margin-left:auto}

      /* бейдж игры — ЕДИНСТВЕННОЕ место с 16px */
      .rgg-game{display:flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto;
        font-family:'Chakra Petch',sans-serif;font-size:16px;font-weight:600;color:var(--muted);
        padding:3px 9px;border:1px solid var(--line);border-radius:6px;background:var(--elev);
        transition:border-color .2s,color .2s}
      .rgg-game:hover{border-color:var(--purple);color:var(--text)}
      .rgg-game .game-ico{flex:0 0 auto;color:var(--purple-hov)}
      .rgg-game .game-txt{white-space:normal;line-height:1.25}
      .rgg-game.bump{animation:rggGameIn .45s ease}
      @keyframes rggGameIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

      /* шапка — компактная; ник переносится на 2 строки, если длинный (как бейдж игры) */
      .rgg-top{display:flex;align-items:center;gap:9px;padding:11px 12px;cursor:grab;user-select:none;
        touch-action:none;background:var(--elev);border-bottom:1px solid var(--line);position:relative;z-index:2}
      .rgg-top:active{cursor:grabbing}
      .rgg-top::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;
        background:linear-gradient(90deg,var(--purple-deep),var(--purple) 45%,transparent);opacity:.9}
      .rgg-logo{flex:0 0 auto;display:flex;filter:drop-shadow(0 0 6px rgba(145,71,255,.6))}
      .rgg-name{font-family:'Chakra Petch',sans-serif;font-weight:700;font-size:16px;text-transform:lowercase;
        letter-spacing:.02em;color:var(--text);
        white-space:normal;line-height:1.2;word-break:break-word;overflow-wrap:anywhere}
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

      .rgg-wall-open{min-width:24px;height:22px;padding:0 5px}
      .rgg-wall-open .wall-ico{display:block;transition:.2s}
      .rgg-wall-open:hover{color:var(--purple-hov);border-color:var(--purple);background:#26262c}
      .rgg-wall-open:hover .wall-ico{filter:drop-shadow(0 0 5px rgba(169,112,255,.6))}
      .rgg-wall-open.blocked{border-color:var(--red)!important;color:#fecaca!important;animation:rggLinkBad 1s ease-in-out infinite}

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
        <span class="rgg-ver">v25${MODE === 'wall' ? '·wall' : ''}</span>
        <span class="rgg-link bad">NO LINK</span>
        <span class="rgg-spacer"></span>
        <button class="rgg-btn rgg-auto is-on" title="${MODE === 'wall' ? 'Синхронизация со стрим-окном' : 'Авто-переключение'}">AUTO</button>
      </div>
      <div class="rgg-row2">
        <span class="rgg-game" title="Текущая игра стримера (с Twitch)">
          <svg class="game-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 11h4M8 9v4"/><circle cx="15" cy="10" r=".6" fill="currentColor"/><circle cx="17.5" cy="12.5" r=".6" fill="currentColor"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.012.107-.02.161C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.682-7.25-.008-.053-.014-.108-.02-.161A4 4 0 0 0 17.32 5z"/></svg>
          <span class="game-txt">…</span>
        </span>
        <div class="rgg-chips"></div>
        <div class="rgg-tools">
          <button class="rgg-btn rgg-wall-open" title="Открыть чат-стену отдельным окном">
            <svg class="wall-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="9" height="13" rx="1.6"/><rect x="13" y="4" width="9" height="9" rx="1.6"/></svg>
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
    refs.wallBtn = panel.querySelector('.rgg-wall-open');
    refs.game = panel.querySelector('.rgg-game');

    if (refs.autoBtn) refs.autoBtn.onclick = () => {
      if (MODE === 'wall') {
        wallAuto = !wallAuto; renderAuto();
        if (wallAuto) { const c = localStorage.getItem(ACTIVE_KEY); if (c) setChat(c); }
      } else { autoOn = !autoOn; renderAuto(); }
    };
    if (MODE === 'dock') {
      if (refs.wallBtn) { updateWallTitle(); refs.wallBtn.onclick = openWallWindow; }
    }
    const rel = panel.querySelector('.rgg-reload'); if (rel) rel.onclick = () => { const ch = current; if (ch) { current = null; setChat(ch); } };
    if (refs.invBtn) refs.invBtn.onclick = () => {
      invertOn = !invertOn;
      panel.classList.toggle('no-invert', !invertOn);
      refs.invBtn.classList.toggle('is-on', invertOn);
      saveState();
    };
    refs.frame.addEventListener('load', () => refs.loader.classList.add('hide'));

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
    markSize();

    if (MODE === 'dock') {
      hidden = true;
      if (refs.panel) refs.panel.style.display = 'none';
      applyReturnVisibility();
    }
    if (MODE === 'wall') {
      refs.panel.style.display = 'flex';
      const c0 = localStorage.getItem(ACTIVE_KEY); if (c0) setChat(c0);
      lastHb = parseInt(localStorage.getItem(HEART_KEY) || '0', 10) || 0;
      updateLink();
      const saveWallGeom = () => {
        try { localStorage.setItem(WALL_GEOM_KEY, JSON.stringify({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })); } catch (e) {}
      };
      saveWallGeom();
      regInterval(saveWallGeom, 1500);
      addEventListener('resize', saveWallGeom);
      addEventListener('beforeunload', saveWallGeom);
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
    if (MODE === 'wall') { wallChips.add(ch); updateLink(); }
    if (MODE === 'dock') { try { localStorage.setItem(ACTIVE_KEY, ch); } catch (e) {} }
    fetchGame(ch);
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

  function tickBody() {
    if (MODE === 'wall') { refreshChips(); return; }
    const col = findNativeChatPanel();
    if (col) {
      const ch = autoOn ? ((detectActive(players()) || {}).ch || current) : current;
      if (!embeddedActive) enterEmbedded(col.width, col.el, ch || lastBroadcast || 'nuke73');
      else { refs.nativeEl = col.el; applyNativeOpacity(col.el, true); if (ch) setChat(ch); }
    } else if (embeddedActive) {
      exitEmbedded();
    }
    const list = players();
    refreshChips();
    const act = detectActive(list);
    if (act && act.ch !== lastBroadcast) { lastBroadcast = act.ch; try { localStorage.setItem(ACTIVE_KEY, act.ch); } catch (e) {} }
    try { localStorage.setItem(HEART_KEY, String(Date.now())); } catch (e) {}
  }

  function tickGuarded() {
    try { if (!refs.panel || !refs.chips || document.hidden) return; tickBody(); }
    catch (e) { console.error('[RGG-chat] tick error', e); }
  }
  function updateLinkGuarded() { try { if (refs.link) updateLink(); } catch (e) {} }

  function buildDom() {
    try {
      const oldP = document.getElementById('rggchat'); if (oldP) oldP.remove();
      const oldD = document.getElementById('rggdock'); if (oldD) oldD.remove();
      const oldL = document.getElementById('rgglifeline'); if (oldL) oldL.remove();
      document.querySelectorAll('style[data-rgg]:not(#rggwallhide)').forEach(n => n.remove());
      refs = {};
      embeddedActive = false;
      if (MODE === 'dock') buildLifeline();
      buildPanel();
      renderAuto();
      booted = true; attempts = 0;
      console.log('[RGG-chat] v25 dom built · mode=' + MODE + ' · browser=' + detectBrowser());
    } catch (e) {
      console.error('[RGG-chat] buildDom error', e);
    }
  }

  function watchdog() {
    if (!document.body) return;
    const p = document.getElementById('rggchat');
    const pOk = !!(p && document.body.contains(p));
    if (MODE === 'dock') {
      const l = document.getElementById('rgglifeline');
      const lOk = !!(l && document.body.contains(l));
      if (pOk && lOk) { attempts = 0; return; }
    } else if (pOk) { attempts = 0; return; }
    if (attempts++ > 30) { if (attempts === 31) console.error('[RGG-chat] too many rebuilds — backing off'); return; }
    console.warn('[RGG-chat] watchdog: panel/lifeline missing in DOM — rebuilding');
    buildDom();
  }

  function keyHandler(e) {
    if (MODE !== 'dock') return;
    if (e.altKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) { e.preventDefault(); openWallWindow(); }
  }
  function storageHandler(e) {
    if (e.key === ACTIVE_KEY && wallAuto && e.newValue) setChat(e.newValue);
    if (e.key === HEART_KEY && e.newValue) { lastHb = parseInt(e.newValue, 10) || Date.now(); updateLink(); }
  }

  document.addEventListener('pointerdown', (e) => {
    const leaf = findLeafButton();
    if (leaf && (e.target === leaf || leaf.contains(e.target))) {
      if (closedByUser) {
        if (nativeHiddenRef && nativeHiddenRef.isConnected) nativeHiddenRef.style.display = '';
        closedByUser = false;
      } else if (embeddedActive) {
        e.preventDefault(); e.stopImmediatePropagation();
        hideFirstMonitorChat();
      }
      return;
    }
    if (closedByUser && nativeHiddenRef && nativeHiddenRef.isConnected && nativeHiddenRef.style.display === 'none') nativeHiddenRef.style.display = '';
  }, true);
  document.addEventListener('keydown', keyHandler);

  window[INSTANCE_KEY] = { cleanup: cleanupInstance };
  regInterval(tickGuarded, 350);
  regInterval(() => { if (current) fetchGame(current); }, 60 * 1000);
  if (MODE === 'wall') {
    regInterval(updateLinkGuarded, 1000);
    window.addEventListener('storage', storageHandler);
  }
  regInterval(watchdog, 2000);

  if (document.body) buildDom();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildDom, { once: true });
  else buildDom();

  console.log('[RGG-chat] v25 started · mode=' + MODE + ' · browser=' + detectBrowser());
})();
