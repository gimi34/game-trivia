// marathon/app.js
(() => {
  'use strict';

  // ---------- Reglas ----------
  // Proporción de cartas en el mazo: 1 km común, 2 km media, 3 km escasa.
  const WEIGHTS = { 1: 0.6, 2: 0.3, 3: 0.1 };
  const MIN_PLAYERS = 2, MAX_PLAYERS = 6;
  const MIN_CARDS = 10, MAX_CARDS = 60;
  const CARDS_PER_PLAYER = 6; // modo automático

  const $ = (s) => document.querySelector(s);
  const el = {
    setup: $('#setup'), game: $('#game'), results: $('#results'),
    playersCount: $('#playersCount'), playersMinus: $('#playersMinus'), playersPlus: $('#playersPlus'),
    names: $('#names'), manualBox: $('#manualBox'), deckRange: $('#deckRange'), deckRangeOut: $('#deckRangeOut'),
    deckTotal: $('#deckTotal'), deckChips: $('#deckChips'), startBtn: $('#startBtn'),
    lanes: $('#lanes'), turnLabel: $('#turnLabel'), deckLeft: $('#deckLeft'),
    questionCard: $('#questionCard'), qNum: $('#qNum'), qText: $('#qText'), options: $('#options'),
    feedback: $('#feedback'), feedbackText: $('#feedbackText'), kmCard: $('#kmCard'),
    nextBtn: $('#nextBtn'), quitBtn: $('#quitBtn'),
    buzzers: $('#buzzers'), passBtn: $('#passBtn'),
    presenterBox: $('#presenterBox'), presenterName: $('#presenterName'), hostBanner: $('#hostBanner'),
    winnerTitle: $('#winnerTitle'), ranking: $('#ranking'), againBtn: $('#againBtn'), configBtn: $('#configBtn')
  };

  const config = { players: 2, names: ['Jugador 1', 'Jugador 2'], mode: 'auto', manual: 24, host: 'presenter', presenterName: '', play: 'turns' };
  let state = null;

  // ---------- Utilidades ----------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Reparte n cartas según WEIGHTS (método del mayor resto).
  function composition(n) {
    const keys = [1, 2, 3];
    const raw = keys.map((k) => n * WEIGHTS[k]);
    const counts = raw.map(Math.floor);
    let left = n - counts.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
    for (let i = 0; left > 0; i++, left--) counts[order[i][1]]++;
    return { 1: counts[0], 2: counts[1], 3: counts[2] };
  }

  function buildDeck(n) {
    const c = composition(n);
    const deck = [];
    [1, 2, 3].forEach((k) => { for (let i = 0; i < c[k]; i++) deck.push(k); });
    return shuffle(deck);
  }

  function deckSize() {
    if (config.mode === 'manual') return config.manual;
    return Math.min(MAX_CARDS, Math.max(12, config.players * CARDS_PER_PLAYER));
  }

  function el$(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function show(which) {
    ['setup', 'game', 'results'].forEach((k) => { el[k].hidden = k !== which; });
    window.scrollTo(0, 0);
  }

  // ---------- Configuración ----------
  function readNames() {
    const inputs = el.names.querySelectorAll('input');
    inputs.forEach((inp, i) => { config.names[i] = inp.value; });
  }

  function renderNames() {
    el.names.textContent = '';
    for (let i = 0; i < config.players; i++) {
      const inp = el$('input');
      inp.type = 'text';
      inp.maxLength = 16;
      inp.value = config.names[i] || '';
      inp.placeholder = 'Jugador ' + (i + 1);
      inp.setAttribute('aria-label', 'Nombre del participante ' + (i + 1));
      el.names.appendChild(inp);
    }
  }

  function renderDeckPreview() {
    const n = deckSize();
    const c = composition(n);
    el.deckTotal.textContent = n;
    el.deckChips.textContent = '';
    [1, 2, 3].forEach((k) => {
      const chip = el$('span', 'chip km' + k, c[k] + ' × ' + k + ' km');
      el.deckChips.appendChild(chip);
    });
  }

  function renderSetup() {
    el.playersCount.textContent = config.players;
    el.playersMinus.disabled = config.players <= MIN_PLAYERS;
    el.playersPlus.disabled = config.players >= MAX_PLAYERS;
    el.manualBox.hidden = config.mode !== 'manual';
    el.presenterBox.hidden = config.host !== 'presenter';
    el.presenterName.value = config.presenterName;
    document.querySelectorAll('input[name=host]').forEach((r) => { r.checked = r.value === config.host; });
    document.querySelectorAll('input[name=play]').forEach((r) => { r.checked = r.value === config.play; });
    el.deckRange.value = config.manual;
    el.deckRangeOut.textContent = config.manual;
    document.querySelectorAll('input[name=deckMode]').forEach((r) => { r.checked = r.value === config.mode; });
    renderNames();
    renderDeckPreview();
  }

  function changePlayers(delta) {
    readNames();
    config.players = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, config.players + delta));
    renderSetup();
  }

  el.playersMinus.addEventListener('click', () => changePlayers(-1));
  el.playersPlus.addEventListener('click', () => changePlayers(1));
  document.querySelectorAll('input[name=deckMode]').forEach((r) => {
    r.addEventListener('change', () => {
      config.mode = r.value;
      el.manualBox.hidden = config.mode !== 'manual';
      renderDeckPreview();
    });
  });
  document.querySelectorAll('input[name=host]').forEach((r) => {
    r.addEventListener('change', () => {
      config.host = r.value;
      el.presenterBox.hidden = config.host !== 'presenter';
    });
  });
  document.querySelectorAll('input[name=play]').forEach((r) => {
    r.addEventListener('change', () => { config.play = r.value; });
  });
  el.presenterName.addEventListener('input', () => { config.presenterName = el.presenterName.value; });
  el.deckRange.addEventListener('input', () => {
    config.manual = Number(el.deckRange.value);
    el.deckRangeOut.textContent = config.manual;
    renderDeckPreview();
  });

  // ---------- Partida ----------
  function startGame() {
    readNames();
    const names = [];
    for (let i = 0; i < config.players; i++) {
      const raw = (config.names[i] || '').trim();
      names.push(raw || 'Jugador ' + (i + 1));
    }
    const size = deckSize();
    state = {
      host: config.host,
      presenter: (config.presenterName || '').trim() || 'Presentador',
      players: names.map((name) => ({ name, km: 0, cards: 0, hits: 0 })),
      deck: buildDeck(size),
      totalKm: 0,
      turn: 0,
      round: 1,
      asked: 0,
      current: null,
      answered: false,
      lastCorrect: false,
      play: config.play,
      buzzed: null,
      locked: [],
      done: false
    };
    state.totalKm = state.deck.reduce((a, b) => a + b, 0);
    show('game');
    nextQuestion();
  }

  // Cola aleatoria sin repeticiones: cada pregunta sale una vez hasta agotar el banco.
  // Lo ya preguntado se recuerda en este navegador para no repetir tampoco entre partidas.
  const SEEN_KEY = 'marathon.seen';
  let questionQueue = [];
  let lastQuestion = -1;

  function qid(text) {
    let h = 5381;
    const t = text.trim().toLowerCase();
    for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function loadSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY)) || []); } catch (e) { return new Set(); }
  }
  function saveSeen(set) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(set))); } catch (e) { /* sin almacenamiento */ }
  }
  function nextQuestionIndex() {
    const all = window.QUESTIONS.map((_, i) => i);
    const seen = loadSeen();
    if (!questionQueue.length) {
      let pool = all.filter((i) => !seen.has(qid(window.QUESTIONS[i].q)));
      if (!pool.length) { seen.clear(); pool = all; }
      questionQueue = shuffle(pool);
      const top = questionQueue.length - 1;
      if (top > 0 && questionQueue[top] === lastQuestion) {
        [questionQueue[0], questionQueue[top]] = [questionQueue[top], questionQueue[0]];
      }
    }
    const i = questionQueue.pop();
    lastQuestion = i;
    seen.add(qid(window.QUESTIONS[i].q));
    saveSeen(seen);
    return i;
  }

  function nextQuestion() {
    const data = window.QUESTIONS[nextQuestionIndex()];
    const options = shuffle([
      { text: data.a, correct: true },
      { text: data.w[0], correct: false },
      { text: data.w[1], correct: false }
    ]);
    state.current = { q: data.q, options };
    state.answered = false;
    state.buzzed = null;
    state.locked = [];
    state.done = false;
    state.asked++;
    renderGame();
    el.questionCard.focus({ preventScroll: true });
  }

  function remainingDeck() {
    const c = { 1: 0, 2: 0, 3: 0 };
    state.deck.forEach((k) => { c[k]++; });
    return c;
  }

  function renderLanes() {
    el.lanes.textContent = '';
    state.players.forEach((p, i) => {
      const act = state.play === 'race' ? state.buzzed : state.turn;
      const lane = el$('div', 'lane' + (i === act ? ' active' : ''));
      lane.appendChild(el$('span', 'lane-name', p.name));
      const track = el$('div', 'track');
      const bar = el$('div', 'bar');
      bar.style.width = (state.totalKm ? (p.km / state.totalKm) * 100 : 0) + '%';
      track.appendChild(bar);
      lane.appendChild(track);
      lane.appendChild(el$('span', 'lane-km', p.km + ' km'));
      el.lanes.appendChild(lane);
    });
  }

  function renderGame() {
    const p = state.players[state.turn];
    const left = remainingDeck();
    renderLanes();
    el.turnLabel.textContent = (state.host === 'presenter' ? 'Responde ' : 'Turno de ') + p.name;
    if (state.host === 'presenter') {
      el.hostBanner.hidden = false;
      el.hostBanner.textContent = '🎤 ' + state.presenter + ': lee la pregunta y las tres opciones en voz alta. ' +
        'Cuando ' + p.name + ' responda, toca esa opción.';
    } else {
      el.hostBanner.hidden = true;
    }
    el.deckLeft.textContent = 'Mazo: ' + state.deck.length + ' cartas (1 km: ' + left[1] +
      ' · 2 km: ' + left[2] + ' · 3 km: ' + left[3] + ')';
    el.qNum.textContent = 'Pregunta ' + state.asked;
    el.qText.textContent = state.current.q;

    el.options.textContent = '';
    state.current.options.forEach((opt, i) => {
      const b = el$('button', 'option');
      b.type = 'button';
      b.dataset.index = i;
      b.appendChild(el$('span', 'letter', 'ABC'[i]));
      b.appendChild(el$('span', 'text', opt.text));
      b.addEventListener('click', () => (state.play === 'race' ? raceAnswer(i) : answer(i)));
      el.options.appendChild(b);
    });

    el.feedback.hidden = true;
    el.kmCard.hidden = true;
    el.kmCard.className = 'km-card';
    el.nextBtn.hidden = true;
    if (state.play === 'race') {
      refreshRace();
    } else {
      el.buzzers.hidden = true;
      el.passBtn.hidden = true;
    }
  }

  // ---------- Modo carrera ----------
  function refreshRace() {
    const p = state.buzzed !== null ? state.players[state.buzzed] : null;
    const presenter = state.host === 'presenter';

    if (state.done) el.turnLabel.textContent = 'Pregunta resuelta';
    else if (p) el.turnLabel.textContent = 'Responde ' + p.name;
    else el.turnLabel.textContent = '¡Carrera! ¿Quién contesta primero?';

    if (state.done) {
      el.hostBanner.hidden = true;
    } else {
      el.hostBanner.hidden = false;
      if (presenter) {
        el.hostBanner.textContent = p
          ? '🎤 ' + state.presenter + ': toca la opción que diga ' + p.name + '.'
          : '🎤 ' + state.presenter + ': lee la pregunta y las tres opciones. Toca el nombre de quien conteste primero (o su número en el teclado).';
      } else {
        el.hostBanner.textContent = p
          ? p.name + ', elige tu respuesta.'
          : 'Toca tu nombre lo más rápido que puedas y luego elige tu respuesta.';
      }
    }

    el.buzzers.hidden = state.done;
    el.buzzers.textContent = '';
    state.players.forEach((pl, i) => {
      const locked = state.locked.includes(i);
      const b = el$('button', 'buzzer' + (locked ? ' locked' : '') + (state.buzzed === i ? ' active' : ''));
      b.type = 'button';
      b.textContent = (i + 1) + '. ' + pl.name + (locked ? ' ✕' : '');
      b.disabled = locked || state.buzzed !== null;
      b.addEventListener('click', () => buzz(i));
      el.buzzers.appendChild(b);
    });

    el.options.querySelectorAll('.option').forEach((b) => {
      const idle = !state.done && state.buzzed === null;
      b.disabled = state.done || idle;
      b.classList.toggle('idle', idle);
    });
    el.passBtn.hidden = state.done || state.buzzed !== null;
    renderLanes();
  }

  function buzz(i) {
    if (state.done || state.buzzed !== null || state.locked.includes(i)) return;
    state.buzzed = i;
    refreshRace();
  }

  function raceAnswer(i) {
    if (state.done || state.buzzed === null) return;
    const p = state.players[state.buzzed];
    if (state.current.options[i].correct) {
      finishRace(state.buzzed);
      return;
    }
    state.locked.push(state.buzzed);
    state.buzzed = null;
    if (state.locked.length === state.players.length) {
      finishRace(null, 'Nadie acertó.');
    } else {
      el.feedback.hidden = false;
      el.kmCard.hidden = true;
      el.feedbackText.textContent = p.name + ' falló y queda fuera de esta pregunta. ¡Otro puede contestar!';
      refreshRace();
    }
  }

  function finishRace(winnerIdx, msg) {
    state.done = true;
    state.answered = true;
    el.options.querySelectorAll('.option').forEach((b, idx) => {
      if (state.current.options[idx].correct) b.classList.add('correct');
    });
    el.feedback.hidden = false;
    let last = false;
    if (winnerIdx !== null) {
      const p = state.players[winnerIdx];
      const card = state.deck.pop();
      p.km += card;
      p.cards++;
      p.hits++;
      last = state.deck.length === 0;
      el.feedbackText.textContent = '¡Correcto, ' + p.name + '! Ganas una carta de ' + card + ' km.';
      el.kmCard.hidden = false;
      el.kmCard.className = 'km-card km' + card + ' reveal';
      el.kmCard.textContent = '';
      el.kmCard.appendChild(el$('strong', '', String(card)));
      el.kmCard.appendChild(el$('span', '', card === 1 ? 'kilómetro' : 'kilómetros'));
    } else {
      el.kmCard.hidden = true;
      el.feedbackText.textContent = (msg || 'Nadie contestó.') + ' La respuesta era: ' +
        state.current.options.find((o) => o.correct).text + '. Sin carta esta vez.';
    }
    refreshRace();
    renderLanesAndDeck();
    el.nextBtn.textContent = last ? 'Ver resultados' : 'Siguiente pregunta';
    el.nextBtn.hidden = false;
    el.nextBtn.focus();
  }

  el.passBtn.addEventListener('click', () => {
    if (state && state.play === 'race' && !state.done && state.buzzed === null) finishRace(null, 'Nadie contestó.');
  });

  function answer(i) {
    if (!state.answered) {
      state.answered = true;
      const p = state.players[state.turn];
      const opts = state.current.options;
      const chosen = opts[i];
      const buttons = el.options.querySelectorAll('.option');
      buttons.forEach((b, idx) => {
        b.disabled = true;
        if (opts[idx].correct) b.classList.add('correct');
        else if (idx === i) b.classList.add('wrong');
      });

      el.feedback.hidden = false;
      let last = false;
      if (chosen.correct) {
        const card = state.deck.pop();
        p.km += card;
        p.cards++;
        p.hits++;
        state.lastCorrect = true;
        last = state.deck.length === 0;
        el.feedbackText.textContent = '¡Correcto, ' + p.name + '! Ganas una carta de ' + card + ' km.';
        el.kmCard.hidden = false;
        el.kmCard.className = 'km-card km' + card + ' reveal';
        el.kmCard.textContent = '';
        el.kmCard.appendChild(el$('strong', '', String(card)));
        el.kmCard.appendChild(el$('span', '', card === 1 ? 'kilómetro' : 'kilómetros'));
      } else {
        state.lastCorrect = false;
        el.feedbackText.textContent = 'Incorrecto. La respuesta era: ' +
          opts.find((o) => o.correct).text + '. Sin carta esta vez.';
      }
      renderLanesAndDeck();
      el.nextBtn.textContent = last ? 'Ver resultados' : 'Siguiente turno';
      el.nextBtn.hidden = false;
      el.nextBtn.focus();
    }
  }

  function renderLanesAndDeck() {
    const left = remainingDeck();
    renderLanes();
    el.deckLeft.textContent = 'Mazo: ' + state.deck.length + ' cartas (1 km: ' + left[1] +
      ' · 2 km: ' + left[2] + ' · 3 km: ' + left[3] + ')';
  }

  function next() {
    if (!state.deck.length) { showResults(); return; }
    if (state.play === 'race') { nextQuestion(); return; }
    state.turn = (state.turn + 1) % state.players.length;
    if (state.turn === 0) state.round++;
    nextQuestion();
  }

  function showResults() {
    const sorted = state.players.slice().sort((a, b) => b.km - a.km || b.cards - a.cards);
    const best = sorted[0].km;
    const winners = sorted.filter((p) => p.km === best);
    el.winnerTitle.textContent = winners.length === 1
      ? '🏆 ¡Gana ' + winners[0].name + ' con ' + best + ' km!'
      : '🤝 Empate entre ' + winners.map((p) => p.name).join(' y ') + ' con ' + best + ' km';
    el.ranking.textContent = '';
    sorted.forEach((p) => {
      const li = el$('li', p.km === best ? 'top' : '');
      li.appendChild(el$('span', 'r-name', p.name));
      li.appendChild(el$('span', 'r-km', p.km + ' km'));
      li.appendChild(el$('span', 'r-detail', p.hits + (p.hits === 1 ? ' acierto' : ' aciertos')));
      el.ranking.appendChild(li);
    });
    show('results');
  }

  // ---------- Eventos ----------
  el.startBtn.addEventListener('click', startGame);
  el.nextBtn.addEventListener('click', next);
  el.quitBtn.addEventListener('click', () => { renderSetup(); show('setup'); });
  el.againBtn.addEventListener('click', startGame);
  el.configBtn.addEventListener('click', () => { renderSetup(); show('setup'); });

  document.addEventListener('keydown', (e) => {
    if (el.game.hidden || !state || state.answered) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (state.play === 'race') {
      if (state.buzzed === null) {
        const n = Number(k);
        if (n >= 1 && n <= state.players.length) buzz(n - 1);
      } else {
        const j = ['1', '2', '3'].indexOf(k) >= 0 ? Number(k) - 1 : ['a', 'b', 'c'].indexOf(k);
        if (j >= 0) raceAnswer(j);
      }
      return;
    }
    const i = ['1', '2', '3'].indexOf(k) >= 0 ? Number(k) - 1 : ['a', 'b', 'c'].indexOf(k);
    if (i >= 0) answer(i);
  });

  renderSetup();
  show('setup');

  // Expuesto solo para pruebas desde la consola.
  window.__marathon = { composition, buildDeck };
})();
