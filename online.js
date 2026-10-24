// marathon/online.js
// Cliente del modo en red. Toda la lógica vive en server.js; aquí solo se muestra el estado.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const SKEY = 'marathon.session';
  const el = {
    banner: $('#connBanner'), entry: $('#entry'), lobby: $('#lobby'), game: $('#game'), results: $('#results'),
    entryMsg: $('#entryMsg'), fileWarn: $('#fileWarn'), nameInput: $('#nameInput'), codeInput: $('#codeInput'),
    createBtn: $('#createBtn'), joinBtn: $('#joinBtn'),
    lobbyCode: $('#lobbyCode'), joinUrls: $('#joinUrls'), lobbyPlayers: $('#lobbyPlayers'),
    cfgManual: $('#cfgManual'), cfgRange: $('#cfgRange'), cfgRangeOut: $('#cfgRangeOut'),
    lobbyDeckTotal: $('#lobbyDeckTotal'), lobbyChips: $('#lobbyChips'), lobbyWait: $('#lobbyWait'), startBtn: $('#startBtn'),
    lanes: $('#lanes'), turnLabel: $('#turnLabel'), timer: $('#timer'), deckLeft: $('#deckLeft'),
    qNum: $('#qNum'), countdown: $('#countdown'), countNum: $('#countNum'), qText: $('#qText'), notice: $('#notice'), rpsBox: $('#rpsBox'), options: $('#options'),
    feedback: $('#feedback'), feedbackText: $('#feedbackText'), kmCard: $('#kmCard'), nextBtn: $('#nextBtn'),
    winnerTitle: $('#winnerTitle'), ranking: $('#ranking'), resultsWait: $('#resultsWait'), againBtn: $('#againBtn')
  };

  let session = null;
  let view = null;
  let viewAt = 0;
  let source = null;
  let unloading = false;
  window.addEventListener('pagehide', () => { unloading = true; });

  try { session = JSON.parse(sessionStorage.getItem(SKEY)); } catch (e) { session = null; }
  function saveSession() {
    try {
      if (session) sessionStorage.setItem(SKEY, JSON.stringify(session));
      else sessionStorage.removeItem(SKEY);
    } catch (e) { /* sin almacenamiento: no pasa nada */ }
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------- Red ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function request(url, opts, timeoutMs) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 8000) : null;
    try {
      return await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}, ctl ? { signal: ctl.signal } : {}));
    } finally { if (t) clearTimeout(t); }
  }

  async function api(url, body) {
    const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 10000);
    let j = {};
    try { j = await r.json(); } catch (e) { /* respuesta vacía */ }
    if (!r.ok) { const err = new Error(j.error || 'No se pudo completar la acción.'); err.status = r.status; throw err; }
    return j;
  }

  // Las acciones se reintentan si la red falla: el servidor las trata como idempotentes
  // (repetir un toque ya registrado no tiene efecto), así que ningún toque se pierde ni se duplica.
  async function sendAction(type, extra) {
    if (!session) return;
    const body = Object.assign({ room: session.room, pid: session.pid, type }, extra || {});
    const delays = [0, 400, 900, 1800, 3000, 4500];
    let lastErr = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      if (!session) return;
      try { await api('/api/action', body); return; } catch (e) {
        lastErr = e;
        if (e.status === 404) { dropSession('La sala ya no está disponible. Crea una nueva o únete a otra.'); return; }
        // el servidor sí respondió con un rechazo: si ya reintentamos, casi seguro es un duplicado inofensivo
        if (e.status) { if (i > 0) { resync(); return; } throw e; }
      }
    }
    throw lastErr || new Error('Sin conexión.');
  }

  function action(type, extra) {
    return sendAction(type, extra).catch((e) => { flash(e.message === 'Failed to fetch' || e.name === 'AbortError' ? 'Sin conexión: no se pudo enviar. Intenta de nuevo.' : e.message); throw e; }).catch(() => {});
  }

  // Un solo aviso superior con prioridades: avisos puntuales > conexión > anfitrión sin señal.
  let flashMsg = '';
  let flashTimer = null;
  let connMsg = '';
  function updateBanner() {
    let msg = flashMsg || connMsg;
    if (!msg && view && view.phase !== 'lobby' && view.phase !== 'results' && view.hostConnected === false && !view.you.isHost) {
      msg = 'El anfitrión perdió la señal. Esperando a que vuelva…';
    }
    el.banner.hidden = !msg;
    el.banner.textContent = msg;
  }
  function flash(msg) {
    flashMsg = msg;
    updateBanner();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashMsg = ''; updateBanner(); }, 3500);
  }
  function setConn(msg) { connMsg = msg || ''; updateBanner(); }

  function dropSession(msg) {
    if (source) source.close();
    session = null; view = null; saveSession();
    setConn('');
    showEntry(msg || 'La partida terminó.');
  }

  // Último mensaje recibido del servidor (datos o latido): si pasa mucho tiempo, la conexión está muerta.
  let lastEventAt = Date.now();
  let resyncing = false;

  function applyView(data) {
    if (data.phase === 'closed') { dropSession(data.message); return; }
    if (view && data.room === view.room && data.seq < view.seq && data.phase === view.phase) return; // llegó tarde y desordenado
    view = data;
    viewAt = Date.now();
    lastEventAt = Date.now();
    setConn('');
    render();
  }

  // Pide el estado completo por una petición normal (sirve cuando el canal en vivo va lento o se perdió).
  async function resync() {
    if (!session || resyncing) return;
    resyncing = true;
    try {
      const r = await request('/api/state?room=' + encodeURIComponent(session.room) + '&pid=' + encodeURIComponent(session.pid), {}, 8000);
      if (r.status === 404) { dropSession('La sala ya no está disponible. Crea una nueva o únete a otra.'); return; }
      if (r.ok) applyView(await r.json());
    } catch (e) { /* sin red: el vigilante lo volverá a intentar */ }
    finally { resyncing = false; }
  }

  function connect() {
    if (source) source.close();
    if (!session) return;
    const src = new EventSource('/api/events?room=' + encodeURIComponent(session.room) + '&pid=' + encodeURIComponent(session.pid));
    source = src;
    lastEventAt = Date.now();
    src.onopen = () => { lastEventAt = Date.now(); setConn(''); };
    src.onmessage = (e) => {
      if (src !== source) return;
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      applyView(data);
    };
    src.addEventListener('ping', (e) => {
      if (src !== source) return;
      lastEventAt = Date.now();
      setConn('');
      // si el servidor ya va en otra versión que la nuestra, se perdió algo: pedirlo completo
      if (view && Number(e.data) > view.seq) resync();
    });
    src.onerror = async () => {
      if (unloading || src !== source) return;
      setConn('Conexión lenta, reconectando…');
      if (src.readyState !== EventSource.CLOSED) return; // el navegador reintenta solo
      try {
        const r = await request('/api/check?room=' + encodeURIComponent(session.room) + '&pid=' + encodeURIComponent(session.pid), {}, 6000);
        if (r.status === 404) { dropSession('La sala ya no está disponible. Crea una nueva o únete a otra.'); return; }
      } catch (e) { /* sin red: se reintenta abajo */ }
      setTimeout(() => { if (session && src === source) connect(); }, 1500);
    };
  }

  // Vigilante: sin noticias del servidor por 14 s (el latido llega cada 5) → reabrir el canal y pedir el estado.
  setInterval(() => {
    if (!session || unloading) return;
    const quiet = Date.now() - lastEventAt;
    if (quiet > 14000) { setConn('Conexión lenta, reconectando…'); connect(); resync(); }
    else if (quiet > 7000) { resync(); }
  }, 2000);

  function wake() {
    if (!session) return;
    resync();
    if (!source || source.readyState !== EventSource.OPEN) connect();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', (e) => { unloading = false; if (e.persisted) wake(); });
  window.addEventListener('offline', () => { if (session) setConn('Sin internet en este dispositivo…'); });

  // ---------- Entrada ----------
  function showEntry(msg) {
    document.querySelector('#boardLinkEntry').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    ['lobby', 'game', 'results'].forEach((k) => { el[k].hidden = true; });
    el.entry.hidden = false;
    el.entryMsg.hidden = !msg;
    el.entryMsg.textContent = msg || '';
    el.fileWarn.hidden = location.protocol !== 'file:';
  }

  async function enter(kind) {
    const name = el.nameInput.value.trim();
    try {
      const body = kind === 'create'
        ? { name }
        : { name, room: el.codeInput.value.trim().toUpperCase() };
      const r = await api(kind === 'create' ? '/api/create' : '/api/join', body);
      session = { room: r.room, pid: r.pid };
      saveSession();
      try { localStorage.setItem('marathon.name', name); } catch (e) { /* opcional */ }
      connect();
    } catch (e) {
      showEntry(location.protocol === 'file:' ? '' : (e.message === 'Failed to fetch' ? 'No se pudo conectar con el servidor.' : e.message));
    }
  }

  el.createBtn.addEventListener('click', () => enter('create'));
  el.joinBtn.addEventListener('click', () => enter('join'));
  el.codeInput.addEventListener('input', () => { el.codeInput.value = el.codeInput.value.toUpperCase(); });
  el.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter('join'); });

  document.querySelectorAll('.leaveBtn').forEach((b) => b.addEventListener('click', () => {
    const s = session;
    session = null; view = null; saveSession(); setConn('');
    if (source) source.close();
    if (s) api('/api/action', { room: s.room, pid: s.pid, type: 'leave' }).catch(() => {});
    showEntry('');
  }));

  // ---------- Sala de espera ----------
  function chips(container, comp) {
    container.textContent = '';
    [1, 2, 3].forEach((k) => container.appendChild(h('span', 'chip km' + k, comp[k] + ' × ' + k + ' km')));
  }

  function renderLobby() {
    const v = view;
    const host = v.you.isHost;
    el.lobbyCode.textContent = v.room;
    document.querySelector('#playerCount').textContent = '(' + v.players.length + ' de 25)';
    const onServer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const bl = document.querySelector('#boardLink');
    bl.hidden = !(onServer && v.you.isHost);
    bl.href = 'board.html?room=' + encodeURIComponent(v.room);

    el.joinUrls.textContent = '';
    const base = v.joinUrls && v.joinUrls.length ? v.joinUrls : [location.origin];
    base.slice(0, 2).forEach((u) => el.joinUrls.appendChild(h('li', '', u.replace(/\/$/, '') + '/online.html')));

    el.lobbyPlayers.textContent = '';
    v.players.forEach((p) => {
      const li = h('li', p.connected ? '' : 'off');
      li.appendChild(h('span', 'pname', p.name + (p.id === v.you.id ? ' (tú)' : '')));
      if (p.isHost) li.appendChild(h('span', 'badge', 'anfitrión'));
      if (!p.connected) li.appendChild(h('span', 'badge off', 'sin conexión'));
      el.lobbyPlayers.appendChild(li);
    });

    document.querySelectorAll('input[name=cfgPlay]').forEach((r) => { r.checked = r.value === v.config.play; r.disabled = !host; });
    document.querySelectorAll('input[name=cfgMode]').forEach((r) => { r.checked = r.value === v.config.deckMode; r.disabled = !host; });
    el.cfgManual.hidden = v.config.deckMode !== 'manual';
    el.cfgRange.disabled = !host;
    if (document.activeElement !== el.cfgRange) {
      el.cfgRange.value = v.config.manual;
      el.cfgRangeOut.textContent = v.config.manual;
    }
    el.lobbyDeckTotal.textContent = v.config.deckSize;
    chips(el.lobbyChips, v.config.comp);

    el.startBtn.hidden = !host;
    el.startBtn.disabled = v.players.filter((p) => p.connected).length < 2;
    el.startBtn.textContent = el.startBtn.disabled ? 'Faltan participantes (mínimo 2)' : 'Comenzar partida';
    el.lobbyWait.hidden = host;
  }

  function sendConfig() {
    const play = document.querySelector('input[name=cfgPlay]:checked');
    const mode = document.querySelector('input[name=cfgMode]:checked');
    action('config', {
      play: play ? play.value : 'turns',
      deckMode: mode ? mode.value : 'auto',
      manual: Number(el.cfgRange.value)
    });
  }
  document.querySelectorAll('input[name=cfgPlay], input[name=cfgMode]').forEach((r) => r.addEventListener('change', sendConfig));
  el.cfgRange.addEventListener('input', () => { el.cfgRangeOut.textContent = el.cfgRange.value; });
  el.cfgRange.addEventListener('change', sendConfig);
  el.startBtn.addEventListener('click', () => action('start'));

  // ---------- Juego ----------
  // Con muchos jugadores el marcador del celular se resume: los 5 primeros y tu posición.
  const COMPACT_OVER = 8;
  function renderLanes() {
    el.lanes.textContent = '';
    const all = view.players;
    let rows = all.map((p) => ({ p, rank: 0 }));
    const compact = all.length > COMPACT_OVER;
    if (compact) {
      const sorted = all.slice().sort((a, b) => b.km - a.km || b.cards - a.cards || a.name.localeCompare(b.name));
      const rank = new Map(sorted.map((p, i) => [p.id, i + 1]));
      const shown = sorted.slice(0, 5);
      const mine = all.find((p) => p.id === view.you.id);
      if (mine && !shown.includes(mine)) shown.push(mine);
      rows = shown.map((p) => ({ p, rank: rank.get(p.id) }));
    }
    rows.forEach(({ p, rank }) => {
      const active = p.isTurn;
      const lane = h('div', 'lane' + (active ? ' active' : '') + (p.connected ? '' : ' off'));
      lane.appendChild(h('span', 'lane-name', (compact ? rank + '. ' : '') + p.name + (p.id === view.you.id ? ' (tú)' : '')));
      const track = h('div', 'track');
      const bar = h('div', 'bar');
      bar.style.width = (view.totalKm ? (p.km / view.totalKm) * 100 : 0) + '%';
      track.appendChild(bar);
      lane.appendChild(track);
      lane.appendChild(h('span', 'lane-km', p.km + ' km'));
      el.lanes.appendChild(lane);
    });
    if (compact && all.length > rows.length) {
      el.lanes.appendChild(h('p', 'hint', 'y ' + (all.length - rows.length) + ' jugadores más'));
    }
  }

  function nameOf(id) {
    const p = view.players.find((x) => x.id === id);
    return p ? p.name : '';
  }

  const RPS_EMOJI = { piedra: '✊', papel: '✋', tijera: '✌️' };
  const RPS_LABEL = { piedra: 'Piedra', papel: 'Papel', tijera: 'Tijera' };

  // La caja de piedra/papel/tijera se construye una sola vez; después solo se actualizan textos y estados,
  // así los botones no se reemplazan mientras alguien los está tocando.
  const rpsUi = (() => {
    const title = h('p', 'rps-title');
    const result = h('div', 'rps-result');
    const outcome = h('p', 'rps-outcome');
    const prev = h('p', 'hint');
    const btns = h('div', 'rps-buttons');
    const buttons = {};
    ['piedra', 'papel', 'tijera'].forEach((c) => {
      const b = h('button', 'rps-btn');
      b.type = 'button';
      b.appendChild(h('span', 'rps-emoji', RPS_EMOJI[c]));
      b.appendChild(h('span', '', RPS_LABEL[c]));
      b.addEventListener('click', () => pickRps(c));
      btns.appendChild(b);
      buttons[c] = b;
    });
    const who = h('p', 'hint');
    const msg = h('p', 'hint');
    [title, result, outcome, prev, btns, who, msg].forEach((n) => el.rpsBox.appendChild(n));
    return { title, result, outcome, prev, btns, buttons, who, msg };
  })();
  let pendingRps = null; // { round, choice }

  function pickRps(c) {
    const r = view && view.rps;
    if (!r || r.mine || r.showing || !r.ids.includes(view.you.id)) return;
    pendingRps = { key: r.round + ':' + r.ids.join(','), choice: c };
    renderRps();
    const mark = pendingRps;
    sendAction('rps', { choice: c }).catch((e) => {
      flash(e.status ? e.message : 'Sin conexión: tu elección no llegó. Intenta de nuevo.');
      if (pendingRps === mark) { pendingRps = null; if (view) renderRps(); }
    });
    // si el envío falla del todo, se libera para poder volver a elegir
    setTimeout(() => { if (pendingRps && pendingRps.choice === c && view && view.rps && !view.rps.mine) { pendingRps = null; renderRps(); } }, 30000);
  }

  function renderRps() {
    const v = view;
    const r = v.rps;
    el.rpsBox.hidden = !r;
    if (!r) { pendingRps = null; return; }
    const key = r.round + ':' + r.ids.join(',');
    if (pendingRps && pendingRps.key !== key) pendingRps = null;
    const mine = r.mine || (pendingRps ? pendingRps.choice : null);
    const iAm = r.ids.includes(v.you.id);
    const u = rpsUi;
    u.title.textContent = 'Ronda ' + r.round + ': ' + r.ids.map(nameOf).join(' vs ');

    const showRes = !!(r.showing && r.last);
    u.result.hidden = u.outcome.hidden = !showRes;
    u.btns.hidden = u.who.hidden = u.msg.hidden = showRes;
    u.prev.hidden = showRes || !r.last;
    if (showRes) {
      u.result.textContent = '';
      r.ids.forEach((id) => {
        const box = h('div', 'rps-pick');
        box.appendChild(h('span', 'rps-emoji', RPS_EMOJI[r.last.choices[id]] || '?'));
        box.appendChild(h('span', 'rps-name', nameOf(id)));
        if (r.last.survivors.includes(id) && !r.last.draw && r.last.survivors.length < r.ids.length) box.classList.add('won');
        u.result.appendChild(box);
      });
      let text;
      if (r.last.draw) text = '¡Empate! Vuelven a elegir.';
      else if (r.last.survivors.length === 1) text = '¡Gana ' + nameOf(r.last.survivors[0]) + '!';
      else text = 'Siguen ' + r.last.survivors.map(nameOf).join(' y ') + ': vuelven a elegir.';
      u.outcome.textContent = text;
      return;
    }
    if (r.last) u.prev.textContent = r.last.draw ? 'La ronda anterior fue empate.' : 'Siguen los que empataron.';
    u.btns.hidden = !iAm;
    Object.keys(u.buttons).forEach((c) => {
      const b = u.buttons[c];
      b.disabled = !!mine;
      b.classList.toggle('picked', mine === c);
    });
    u.who.textContent = r.ids.map((id) => nameOf(id) + (r.picked[id] || (id === v.you.id && mine) ? ' ✓' : ' …')).join('   ');
    u.msg.textContent = iAm
      ? (mine ? (r.mine ? 'Esperando a los demás…' : 'Enviando…') : 'Elige antes de que se acabe el tiempo.')
      : 'Los jugadores empatados están eligiendo…';
  }

  let pendingAnswer = null; // { asked, index }
  let optionsKey = '';

  function chooseAnswer(i) {
    const v = view;
    if (!v || v.phase !== 'question' || !v.unlocked || pendingAnswer) return;
    const me = v.players.find((p) => p.id === v.you.id);
    const race = v.config.play === 'race';
    if (race ? (me.locked || me.answered) : v.turnId !== v.you.id) return;
    pendingAnswer = { asked: v.asked, index: i };
    renderGame();   // respuesta visible al instante, sin esperar a la red
    const mark = pendingAnswer;
    sendAction('answer', { index: i }).catch((e) => {
      flash(e.status ? e.message : 'Sin conexión: tu respuesta no llegó. Intenta de nuevo.');
      if (pendingAnswer === mark) { pendingAnswer = null; if (view) render(); }
    });
    // si no se confirma (cortes largos), se libera para que pueda tocar de nuevo
    setTimeout(() => {
      if (pendingAnswer === mark) { pendingAnswer = null; if (view) render(); resync(); }
    }, 30000);
  }

  function renderGame() {
    const v = view;
    const me = v.players.find((p) => p.id === v.you.id);
    const race = v.config.play === 'race';
    const inQuestion = v.phase === 'question';
    const inRps = v.phase === 'rps';
    const myTurn = !race && v.turnId === v.you.id;
    const canAnswer = inQuestion && v.unlocked && (race ? (!me.locked && !me.answered) : myTurn);

    renderLanes();
    el.deckLeft.textContent = 'Mazo: ' + v.deck.left + ' cartas (1 km: ' + v.deck.c1 + ' · 2 km: ' + v.deck.c2 + ' · 3 km: ' + v.deck.c3 + ')';
    el.qNum.textContent = 'Pregunta ' + v.asked;
    // Durante el conteo previo la pregunta aún no se muestra.
    const waiting = !v.question;
    el.countdown.hidden = !waiting;
    el.qText.hidden = waiting;
    el.qText.textContent = waiting ? '' : v.question.text;

    // Mensaje de estado
    let label;
    if (v.phase === 'reveal') label = 'Pregunta resuelta';
    else if (inRps) label = '¡Empate! Piedra, papel o tijera';
    else if (!v.unlocked) label = race ? '¡Prepárate!' : (myTurn ? 'Es tu turno: prepárate…' : 'Turno de ' + nameOf(v.turnId));
    else if (!race) label = myTurn ? '¡Es tu turno! Elige tu respuesta' : 'Turno de ' + nameOf(v.turnId);
    else if (me.locked) label = 'Fallaste esta pregunta: espera al resto';
    else if (me.answered) label = 'Respuesta enviada…';
    else label = '¡Rápido! Toca la respuesta correcta';
    el.turnLabel.textContent = label;

    el.notice.hidden = !v.notice;
    el.notice.textContent = v.notice || '';
    renderRps();

    el.options.hidden = inRps || waiting;
    // pendiente de envío (toque ya hecho, aún sin confirmación del servidor)
    if (pendingAnswer && (pendingAnswer.asked !== v.asked || !inQuestion || v.you.choice !== null)) pendingAnswer = null;
    const sending = pendingAnswer ? pendingAnswer.index : null;
    const optKey = waiting ? '' : v.asked + '|' + v.question.options.join('\u0001');
    if (optKey !== optionsKey) {
      // Los botones solo se reconstruyen cuando cambia la pregunta; no en cada actualización.
      optionsKey = optKey;
      el.options.textContent = '';
      (waiting ? [] : v.question.options).forEach((text, i) => {
        const b = h('button', 'option');
        b.type = 'button';
        b.appendChild(h('span', 'letter', 'ABC'[i]));
        b.appendChild(h('span', 'text', text));
        b.addEventListener('click', () => chooseAnswer(i));
        el.options.appendChild(b);
      });
    }
    Array.prototype.forEach.call(el.options.children, (b, i) => {
      const chosen = (inQuestion && v.you.choice === i) || sending === i;
      b.disabled = !canAnswer || sending !== null;
      b.className = 'option'
        + (inQuestion && !canAnswer && !me.answered && sending === null ? ' idle' : '')
        + (chosen ? ' picked' : '');
      if (v.reveal) {
        b.disabled = true;
        if (i === v.reveal.correctIndex) b.classList.add('correct');
        else if (i === v.reveal.chosenIndex) b.classList.add('wrong');
      }
    });
    if (sending !== null && v.phase === 'question') el.turnLabel.textContent = 'Enviando respuesta…';

    // Resultado de la pregunta
    el.feedback.hidden = !v.reveal;
    if (v.reveal) {
      el.feedbackText.textContent = v.reveal.message;
      if (v.reveal.card) {
        el.kmCard.hidden = false;
        el.kmCard.className = 'km-card km' + v.reveal.card;
        el.kmCard.textContent = '';
        el.kmCard.appendChild(h('strong', '', String(v.reveal.card)));
        el.kmCard.appendChild(h('span', '', v.reveal.card === 1 ? 'kilómetro' : 'kilómetros'));
      } else {
        el.kmCard.hidden = true;
      }
      el.nextBtn.hidden = !v.you.isHost;
      el.nextBtn.textContent = v.reveal.last ? 'Ver resultados' : 'Siguiente ahora';
    }
  }

  // Las cartas solo se animan cuando aparecen por primera vez.
  let lastRevealKey = '';
  function animateCard() {
    const key = view.reveal ? view.asked + ':' + view.reveal.card : '';
    if (key && key !== lastRevealKey && view.reveal.card) el.kmCard.classList.add('reveal');
    lastRevealKey = key;
  }

  // ---------- Resultados ----------
  function renderResults() {
    const v = view;
    const sorted = v.players.slice().sort((a, b) => b.km - a.km || b.cards - a.cards);
    const best = sorted[0].km;
    const winners = sorted.filter((p) => p.km === best);
    el.winnerTitle.textContent = winners.length === 1
      ? '🏆 ¡Gana ' + winners[0].name + ' con ' + best + ' km!'
      : '🤝 Empate entre ' + winners.map((p) => p.name).join(' y ') + ' con ' + best + ' km';
    el.ranking.textContent = '';
    sorted.forEach((p) => {
      const li = h('li', p.km === best ? 'top' : '');
      li.appendChild(h('span', 'r-name', p.name + (p.id === v.you.id ? ' (tú)' : '')));
      li.appendChild(h('span', 'r-km', p.km + ' km'));
      li.appendChild(h('span', 'r-detail', p.hits + (p.hits === 1 ? ' acierto' : ' aciertos')));
      el.ranking.appendChild(li);
    });
    el.againBtn.hidden = !v.you.isHost;
    el.resultsWait.hidden = v.you.isHost;
  }

  el.nextBtn.addEventListener('click', () => action('next'));
  el.againBtn.addEventListener('click', () => action('restart'));

  // ---------- Render general ----------
  function render() {
    if (!view) return;
    el.entry.hidden = true;
    const phase = view.phase;
    el.lobby.hidden = phase !== 'lobby';
    el.game.hidden = !(phase === 'question' || phase === 'reveal' || phase === 'rps');
    el.results.hidden = phase !== 'results';
    if (phase === 'lobby') renderLobby();
    else if (phase === 'question' || phase === 'reveal' || phase === 'rps') { renderGame(); animateCard(); }
    else if (phase === 'results') renderResults();
    tick();
  }

  function tick() {
    if (!view || view.remainingMs === null || view.phase === 'lobby' || view.phase === 'results') {
      el.timer.textContent = '';
      return;
    }
    const s = Math.max(0, Math.ceil((view.remainingMs - (Date.now() - viewAt)) / 1000));
    el.countNum.textContent = s;
    const k = view.deadlineKind;
    if (k === 'tie' || k === 'rpsShow') el.timer.textContent = '';
    else if (k === 'next') el.timer.textContent = 'Siguiente en ' + s + ' s';
    else if (k === 'lock') el.timer.textContent = 'Pregunta en ' + s + ' s';
    else el.timer.textContent = '⏱ ' + s + ' s';
  }
  setInterval(tick, 250);

  // ---------- Inicio ----------
  try { el.nameInput.value = localStorage.getItem('marathon.name') || ''; } catch (e) { /* opcional */ }
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) el.codeInput.value = roomParam.toUpperCase().slice(0, 4);

  if (session) connect();
  else showEntry('');
})();
