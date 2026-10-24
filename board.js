// marathon/board.js
// Tablero general: pantalla de solo lectura para proyectar el progreso.
// Solo funciona en la computadora que corre server.js; no es un jugador.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const el = {
    banner: $('#banner'),
    wait: $('#wait'), lobby: $('#lobby'), game: $('#game'), results: $('#results'),
    waitMsg: $('#waitMsg'), roomList: $('#roomList'), waitUrl: $('#waitUrl'),
    lobbyUrl: $('#lobbyUrl'), altUrls: $('#altUrls'), lobbyCode: $('#lobbyCode'), lobbyCfg: $('#lobbyCfg'), lobbyPlayers: $('#lobbyPlayers'),
    hdrInfo: $('#hdrInfo'), hdrDeck: $('#hdrDeck'), hdrTimer: $('#hdrTimer'), board: $('#board'), stage: $('#stage'),
    winnerTitle: $('#winnerTitle'), podium: $('#podium'), restList: $('#restList')
  };
  const EMOJI = { piedra: '✊', papel: '✋', tijera: '✌️' };

  let view = null;
  let viewAt = 0;
  let source = null;
  let wantedRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  let joinUrls = [];

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function show(name) {
    ['wait', 'lobby', 'game', 'results'].forEach((k) => { el[k].hidden = k !== name; });
  }

  function joinUrl() {
    const base = joinUrls.length ? joinUrls[0] : location.origin;
    return base.replace(/\/$/, '') + '/online.html';
  }

  // ---------- Buscar sala ----------
  function showWait(msg) {
    view = null;
    show('wait');
    el.waitMsg.textContent = msg || 'Esperando una sala… Crea una desde online.html y aparecerá aquí sola.';
    el.waitUrl.textContent = joinUrl();
  }

  async function poll() {
    if (source) return;
    try {
      const r = await fetch('/api/rooms');
      if (!r.ok) throw new Error('no');
      const j = await r.json();
      joinUrls = j.joinUrls || [];
      el.banner.hidden = true;
      el.waitUrl.textContent = joinUrl();
      const open = j.rooms;
      if (wantedRoom && open.some((x) => x.code === wantedRoom)) { connect(wantedRoom); return; }
      if (!wantedRoom && open.length === 1) { connect(open[0].code); return; }
      el.roomList.textContent = '';
      if (open.length > 1) {
        el.waitMsg.textContent = 'Hay varias salas abiertas. Elige cuál mostrar:';
        open.forEach((rm) => {
          const b = h('button', '', 'Sala ' + rm.code + ' · ' + rm.players + ' jugadores · ' + rm.host);
          b.addEventListener('click', () => connect(rm.code));
          el.roomList.appendChild(b);
        });
      }
    } catch (e) {
      el.banner.hidden = false;
      el.banner.textContent = 'No se pudo conectar con el servidor. ¿Está abierto iniciar.bat? (este tablero solo funciona en la computadora del servidor)';
    }
  }

  function connect(code) {
    if (source) source.close();
    wantedRoom = code;
    const src = new EventSource('/api/watch?room=' + encodeURIComponent(code));
    source = src;
    src.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      el.banner.hidden = true;
      if (data.phase === 'closed') {
        src.close(); source = null; wantedRoom = '';
        showWait(data.message || 'La sala terminó. Esperando una nueva…');
        return;
      }
      view = data;
      viewAt = Date.now();
      joinUrls = data.joinUrls || joinUrls;
      render();
    };
    src.addEventListener('ping', () => { if (src === source) el.banner.hidden = true; });
    src.onerror = () => {
      if (src !== source) return;
      if (src.readyState === EventSource.CLOSED) {
        source = null; wantedRoom = '';
        showWait('La sala ya no existe. Esperando una nueva…');
      } else {
        el.banner.hidden = false;
        el.banner.textContent = 'Reconectando…';
      }
    };
  }

  // ---------- Pantallas ----------
  function render() {
    if (!view) return;
    const ph = view.phase;
    if (ph === 'lobby') { show('lobby'); renderLobby(); }
    else if (ph === 'results') { show('results'); renderResults(); }
    else { show('game'); renderGame(); }
    tick();
  }

  function renderLobby() {
    const v = view;
    el.lobbyUrl.textContent = joinUrl();
    // Si el servidor ve otras redes (VPN, adaptadores virtuales), se muestran pequeñas por si la principal no sirve.
    const alts = joinUrls.slice(1, 3).map((u) => u.replace(/\/$/, '') + '/online.html');
    el.altUrls.textContent = alts.length ? 'Si no abre, prueba: ' + alts.join('  ·  ') : '';
    el.lobbyCode.textContent = v.room;
    el.lobbyCfg.textContent = (v.config.play === 'race' ? 'Carrera de velocidad' : 'Por turnos') +
      ' · ' + v.config.deckSize + ' cartas · ' + v.players.length + ' de 25 jugadores';
    el.lobbyPlayers.textContent = '';
    v.players.forEach((p) => {
      el.lobbyPlayers.appendChild(h('span', 'chip-p' + (p.isHost ? ' host' : '') + (p.connected ? '' : ' off'), (p.isHost ? '👑 ' : '') + p.name));
    });
  }

  function sortedPlayers() {
    return view.players.slice().sort((a, b) => b.km - a.km || b.cards - a.cards || a.name.localeCompare(b.name));
  }

  function renderBoard() {
    const v = view;
    const list = sortedPlayers();
    const n = list.length;
    const cols = n <= 9 ? 1 : (n <= 18 ? 2 : 3);
    const rows = Math.ceil(n / cols);
    el.board.style.setProperty('--cols', cols);
    el.board.style.setProperty('--rows', rows);
    // tamaño de letra según las filas disponibles
    el.board.style.setProperty('--fs', Math.max(0.85, Math.min(cols === 1 ? 1.9 : 1.5, 11 / rows)) + 'rem');

    const winner = v.reveal ? v.reveal.winnerId : null;
    const race = v.config.play === 'race';
    el.board.textContent = '';
    list.forEach((p, i) => {
      const cls = 'row' + (p.isTurn ? ' turn' : '') + (p.locked ? ' out' : '') + (p.connected ? '' : ' off') + (winner === p.id ? ' win' : '');
      const row = h('div', cls);
      row.appendChild(h('span', 'rank', String(i + 1)));
      const mid = h('div', 'mid');
      const nm = h('span', 'name', p.name);
      if (race && v.phase === 'question' && v.unlocked && p.answered) nm.appendChild(h('span', 'mark', '✓'));
      if (p.locked && v.phase === 'question') nm.appendChild(h('span', 'mark', '✕'));
      mid.appendChild(nm);
      const track = h('div', 'track');
      const fill = h('div', 'fill');
      fill.style.width = (v.totalKm ? (p.km / v.totalKm) * 100 : 0) + '%';
      track.appendChild(fill);
      mid.appendChild(track);
      row.appendChild(mid);
      row.appendChild(h('span', 'km', p.km + ' km'));
      el.board.appendChild(row);
    });
  }

  function nameOf(id) {
    const p = view.players.find((x) => x.id === id);
    return p ? p.name : '';
  }

  function renderStage() {
    const v = view;
    const st = el.stage;
    st.textContent = '';

    if (v.phase === 'rps' && v.rps) {
      const r = v.rps;
      st.appendChild(h('p', 'qnum', 'Pregunta ' + v.asked + ' · Desempate'));
      st.appendChild(h('p', 'qtext', '¡Empate! Piedra, papel o tijera'));
      const duel = h('div', 'duel');
      r.ids.forEach((id) => {
        const box = h('div', 'p');
        if (r.showing && r.last) {
          box.appendChild(h('span', 'e', EMOJI[r.last.choices[id]] || '?'));
          if (r.last.survivors.includes(id) && !r.last.draw && r.last.survivors.length < r.ids.length) box.classList.add('won');
        } else {
          box.appendChild(h('span', 'e', r.picked[id] ? '✅' : '🤔'));
        }
        box.appendChild(h('span', 'n', nameOf(id)));
        duel.appendChild(box);
      });
      st.appendChild(duel);
      let line = 'Ronda ' + r.round + (r.showing ? '' : ': eligiendo en sus celulares…');
      if (r.showing && r.last) {
        if (r.last.draw) line = '¡Empate! Vuelven a elegir.';
        else if (r.last.survivors.length === 1) line = '¡Gana ' + nameOf(r.last.survivors[0]) + '!';
        else line = 'Siguen ' + r.last.survivors.map(nameOf).join(' y ') + '.';
      }
      st.appendChild(h('p', 'result-msg', line));
      return;
    }

    if (v.phase === 'question' && !v.question) { // conteo previo: la pregunta aún no se muestra
      const box = h('div', 'big-count');
      box.appendChild(h('p', '', 'Pregunta ' + v.asked + ' en'));
      const n = h('p', 'n', '');
      n.id = 'bigNum';
      box.appendChild(n);
      if (v.config.play === 'turns') box.appendChild(h('p', '', 'Turno de ' + nameOf(v.turnId)));
      st.appendChild(box);
      return;
    }

    st.appendChild(h('p', 'qnum', 'Pregunta ' + v.asked));
    st.appendChild(h('p', 'qtext', v.question.text));
    const opts = h('div', 'opts');
    v.question.options.forEach((text, i) => {
      const o = h('div', 'opt');
      o.appendChild(h('span', 'l', 'ABC'[i]));
      o.appendChild(h('span', '', text));
      if (v.reveal) {
        if (i === v.reveal.correctIndex) o.classList.add('correct');
        else if (i === v.reveal.chosenIndex) o.classList.add('wrong');
        else o.classList.add('dim');
      }
      opts.appendChild(o);
    });
    st.appendChild(opts);

    if (v.reveal) {
      st.appendChild(h('p', 'result-msg', v.reveal.message));
      if (v.reveal.card) {
        const c = h('div', 'km-card k' + v.reveal.card);
        c.appendChild(h('strong', '', String(v.reveal.card)));
        c.appendChild(h('span', '', v.reveal.card === 1 ? 'kilómetro' : 'kilómetros'));
        st.appendChild(c);
      }
    } else if (v.config.play === 'turns') {
      st.appendChild(h('p', 'status-line', 'Turno de ' + nameOf(v.turnId)));
    } else {
      const done = v.players.filter((p) => p.answered || p.locked).length;
      st.appendChild(h('p', 'status-line', 'Han respondido ' + done + ' de ' + v.players.length));
      if (v.notice) st.appendChild(h('p', 'status-line', v.notice));
    }
  }

  function renderGame() {
    const v = view;
    el.hdrInfo.textContent = 'Sala ' + v.room + ' · ' + (v.config.play === 'race' ? 'Carrera' : 'Por turnos');
    el.hdrDeck.textContent = 'Mazo: ' + v.deck.left + ' cartas · 1 km: ' + v.deck.c1 + ' · 2 km: ' + v.deck.c2 + ' · 3 km: ' + v.deck.c3;
    renderBoard();
    renderStage();
  }

  function renderResults() {
    const v = view;
    const sorted = sortedPlayers();
    const best = sorted[0] ? sorted[0].km : 0;
    const winners = sorted.filter((p) => p.km === best);
    el.winnerTitle.textContent = winners.length === 1
      ? '🏆 ¡Gana ' + winners[0].name + ' con ' + best + ' km!'
      : '🤝 Empate: ' + winners.map((p) => p.name).join(', ') + ' con ' + best + ' km';
    el.podium.textContent = '';
    const medals = ['🥇', '🥈', '🥉'];
    // orden visual del podio: 2º, 1º, 3º
    [1, 0, 2].forEach((i) => {
      const p = sorted[i];
      if (!p) return;
      const s = h('div', 'step p' + (i + 1));
      s.appendChild(h('div', 'pos', medals[i]));
      s.appendChild(h('div', 'who', p.name));
      s.appendChild(h('div', 'pts', p.km + ' km'));
      el.podium.appendChild(s);
    });
    el.restList.textContent = '';
    sorted.slice(3).forEach((p, i) => {
      el.restList.appendChild(h('span', 'r', (i + 4) + '. ' + p.name + ' — ' + p.km + ' km'));
    });
  }

  // ---------- Temporizador ----------
  function tick() {
    if (!view || view.remainingMs === null || view.phase === 'lobby' || view.phase === 'results') {
      el.hdrTimer.textContent = '';
      return;
    }
    const s = Math.max(0, Math.ceil((view.remainingMs - (Date.now() - viewAt)) / 1000));
    const k = view.deadlineKind;
    const big = document.getElementById('bigNum');
    if (big) big.textContent = s;
    if (k === 'tie' || k === 'rpsShow') el.hdrTimer.textContent = '';
    else if (k === 'next') el.hdrTimer.textContent = 'Siguiente en ' + s + ' s';
    else if (k === 'lock') el.hdrTimer.textContent = 'Pregunta en ' + s + ' s';
    else el.hdrTimer.textContent = '⏱ ' + s + ' s';
  }
  setInterval(tick, 250);

  // ---------- Inicio ----------
  showWait('');
  poll();
  setInterval(poll, 2000);
})();
