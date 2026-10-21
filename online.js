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
  async function api(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (e) { /* respuesta vacía */ }
    if (!r.ok) throw new Error(j.error || 'No se pudo completar la acción.');
    return j;
  }

  function action(type, extra) {
    if (!session) return Promise.resolve();
    return api('/api/action', Object.assign({ room: session.room, pid: session.pid, type }, extra || {}))
      .catch((e) => { flash(e.message); });
  }

  let flashTimer = null;
  function flash(msg) {
    el.banner.hidden = false;
    el.banner.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.banner.hidden = true; }, 3500);
  }

  function connect() {
    if (source) source.close();
    if (!session) return;
    const src = new EventSource('/api/events?room=' + encodeURIComponent(session.room) + '&pid=' + encodeURIComponent(session.pid));
    source = src;
    source.onopen = () => { el.banner.hidden = true; };
    source.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      if (data.phase === 'closed') {
        source.close();
        session = null; view = null; saveSession();
        el.banner.hidden = true;
        showEntry(data.message || 'La partida terminó.');
        return;
      }
      view = data;
      viewAt = Date.now();
      el.banner.hidden = true;
      render();
    };
    source.onerror = async () => {
      if (unloading || src !== source) return;
      el.banner.hidden = false;
      el.banner.textContent = 'Reconectando…';
      if (src.readyState !== EventSource.CLOSED) return; // el navegador reintenta solo
      // El navegador se rindió: ¿la sala sigue existiendo?
      try {
        const r = await fetch('/api/check?room=' + encodeURIComponent(session.room) + '&pid=' + encodeURIComponent(session.pid));
        if (r.status === 404) {
          session = null; view = null; saveSession();
          el.banner.hidden = true;
          showEntry('La sala ya no está disponible. Crea una nueva o únete a otra.');
          return;
        }
      } catch (e) { /* sin red: se reintenta abajo */ }
      setTimeout(() => { if (session && src === source) connect(); }, 1500);
    };
  }

  // ---------- Entrada ----------
  function showEntry(msg) {
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
    session = null; view = null; saveSession();
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

    el.joinUrls.textContent = '';
    const base = v.joinUrls.length ? v.joinUrls : [location.origin];
    base.forEach((u) => el.joinUrls.appendChild(h('li', '', u.replace(/\/$/, '') + '/online.html')));

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
  function renderLanes() {
    el.lanes.textContent = '';
    view.players.forEach((p) => {
      const active = p.isTurn;
      const lane = h('div', 'lane' + (active ? ' active' : '') + (p.connected ? '' : ' off'));
      lane.appendChild(h('span', 'lane-name', p.name + (p.id === view.you.id ? ' (tú)' : '')));
      const track = h('div', 'track');
      const bar = h('div', 'bar');
      bar.style.width = (view.totalKm ? (p.km / view.totalKm) * 100 : 0) + '%';
      track.appendChild(bar);
      lane.appendChild(track);
      lane.appendChild(h('span', 'lane-km', p.km + ' km'));
      el.lanes.appendChild(lane);
    });
  }

  function nameOf(id) {
    const p = view.players.find((x) => x.id === id);
    return p ? p.name : '';
  }

  const RPS_EMOJI = { piedra: '✊', papel: '✋', tijera: '✌️' };
  const RPS_LABEL = { piedra: 'Piedra', papel: 'Papel', tijera: 'Tijera' };

  function renderRps() {
    const v = view;
    const r = v.rps;
    el.rpsBox.hidden = !r;
    if (!r) return;
    el.rpsBox.textContent = '';
    const iAm = r.ids.includes(v.you.id);
    el.rpsBox.appendChild(h('p', 'rps-title', 'Ronda ' + r.round + ': ' + r.ids.map(nameOf).join(' vs ')));

    if (r.showing && r.last) {
      const row = h('div', 'rps-result');
      r.ids.forEach((id) => {
        const box = h('div', 'rps-pick');
        box.appendChild(h('span', 'rps-emoji', RPS_EMOJI[r.last.choices[id]] || '?'));
        box.appendChild(h('span', 'rps-name', nameOf(id)));
        if (r.last.survivors.includes(id) && !r.last.draw && r.last.survivors.length < r.ids.length) box.classList.add('won');
        row.appendChild(box);
      });
      el.rpsBox.appendChild(row);
      let text;
      if (r.last.draw) text = '¡Empate! Vuelven a elegir.';
      else if (r.last.survivors.length === 1) text = '¡Gana ' + nameOf(r.last.survivors[0]) + '!';
      else text = 'Siguen ' + r.last.survivors.map(nameOf).join(' y ') + ': vuelven a elegir.';
      el.rpsBox.appendChild(h('p', 'rps-outcome', text));
      return;
    }

    if (r.last) {
      el.rpsBox.appendChild(h('p', 'hint', r.last.draw ? 'La ronda anterior fue empate.' : 'Siguen los que empataron.'));
    }
    if (iAm) {
      const btns = h('div', 'rps-buttons');
      ['piedra', 'papel', 'tijera'].forEach((c) => {
        const b = h('button', 'rps-btn' + (r.mine === c ? ' picked' : ''));
        b.type = 'button';
        b.disabled = !!r.mine;
        b.appendChild(h('span', 'rps-emoji', RPS_EMOJI[c]));
        b.appendChild(h('span', '', RPS_LABEL[c]));
        b.addEventListener('click', () => action('rps', { choice: c }));
        btns.appendChild(b);
      });
      el.rpsBox.appendChild(btns);
    }
    el.rpsBox.appendChild(h('p', 'hint', r.ids.map((id) => nameOf(id) + (r.picked[id] ? ' ✓' : ' …')).join('   ')));
    el.rpsBox.appendChild(h('p', 'hint', iAm
      ? (r.mine ? 'Esperando a los demás…' : 'Elige antes de que se acabe el tiempo.')
      : 'Los jugadores empatados están eligiendo…'));
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
    el.options.textContent = '';
    (waiting ? [] : v.question.options).forEach((text, i) => {
      const b = h('button', 'option');
      b.type = 'button';
      b.appendChild(h('span', 'letter', 'ABC'[i]));
      b.appendChild(h('span', 'text', text));
      b.disabled = !canAnswer;
      if (inQuestion && !canAnswer && !me.answered) b.classList.add('idle');
      if (inQuestion && v.you.choice === i) b.classList.add('picked');
      if (v.reveal) {
        b.disabled = true;
        if (i === v.reveal.correctIndex) b.classList.add('correct');
        else if (i === v.reveal.chosenIndex) b.classList.add('wrong');
      }
      b.addEventListener('click', () => action('answer', { index: i }));
      el.options.appendChild(b);
    });

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
