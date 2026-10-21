// marathon/server.js
// Servidor local para jugar en red (cada participante con su celular).
// Sin dependencias: solo necesita Node.js.  Uso:  node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');

let PORT = Number(process.env.PORT) || 3000;
const WANTED_PORT = PORT;
const ROOT = __dirname;

// Tiempos (milisegundos). Se pueden sobreescribir con variables de entorno.
const LOCK_MS = Number(process.env.LOCK_MS) || 5000;            // respuestas bloqueadas al aparecer cada pregunta
const ANSWER_MS = Number(process.env.ANSWER_MS) || 20000;       // modo turnos: tiempo para responder (tras el bloqueo)
const QUESTION_MS = Number(process.env.QUESTION_MS) || 20000;   // modo carrera: tiempo para contestar (tras el bloqueo)
const TIE_MS = Number(process.env.TIE_MS) || 800;               // modo carrera: respuestas correctas dentro de este margen cuentan como empate
const RPS_MS = Number(process.env.RPS_MS) || 8000;              // tiempo para elegir piedra, papel o tijera
const RPS_SHOW_MS = Number(process.env.RPS_SHOW_MS) || 2500;    // tiempo que se muestran las elecciones de cada ronda
const REVEAL_MS = Number(process.env.REVEAL_MS) || 5000;        // pausa antes de la siguiente pregunta
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 15000;  // margen para que el anfitrión recargue la página sin cerrar la sala
const RPS_BEATS = { piedra: 'tijera', tijera: 'papel', papel: 'piedra' };

const WEIGHTS = { 1: 0.6, 2: 0.3, 3: 0.1 };
const MIN_PLAYERS = 2, MAX_PLAYERS = 25, MIN_CARDS = 10, MAX_CARDS = 200, CARDS_PER_PLAYER = 6;

// ---------- Preguntas (mismo archivo que usa el juego local) ----------
function loadQuestions() {
  const code = fs.readFileSync(path.join(ROOT, 'questions.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  const list = sandbox.window.QUESTIONS;
  if (!Array.isArray(list) || !list.length) throw new Error('questions.js no tiene preguntas');
  list.forEach((d, i) => {
    if (!d || typeof d.q !== 'string' || typeof d.a !== 'string' || !Array.isArray(d.w) || d.w.length !== 2) {
      throw new Error('Pregunta #' + (i + 1) + ' mal formada en questions.js');
    }
  });
  return list;
}
const QUESTIONS = loadQuestions();

// ---------- Cola de preguntas: aleatoria y sin repetir ----------
// Cada pregunta sale una sola vez hasta agotar todo el banco; entonces se vuelve a barajar.
// Lo ya preguntado se guarda en vistas.json para no repetir tampoco entre partidas ni reinicios del servidor.
const SEEN_FILE = path.join(ROOT, 'vistas.json');
const IDS = QUESTIONS.map((d) => crypto.createHash('sha1').update(d.q.trim().toLowerCase()).digest('hex').slice(0, 10));
const seen = new Set();
try {
  JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')).forEach((id) => seen.add(id));
} catch (e) { /* primera vez o archivo ilegible: se empieza de cero */ }
let questionQueue = [];
let lastQuestion = -1;
let saveTimer = null;

function saveSeen() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(SEEN_FILE, JSON.stringify(Array.from(seen)), () => { /* si no se puede guardar, no pasa nada */ });
  }, 1000);
}

function nextQuestionIndex() {
  if (!questionQueue.length) {
    let pool = QUESTIONS.map((_, i) => i).filter((i) => !seen.has(IDS[i]));
    if (!pool.length) { seen.clear(); pool = QUESTIONS.map((_, i) => i); }
    questionQueue = shuffle(pool);
    // al reiniciar el ciclo, la última pregunta no debe salir otra vez de inmediato
    const top = questionQueue.length - 1;
    if (top > 0 && questionQueue[top] === lastQuestion) {
      [questionQueue[0], questionQueue[top]] = [questionQueue[top], questionQueue[0]];
    }
  }
  const i = questionQueue.pop();
  lastQuestion = i;
  seen.add(IDS[i]);
  saveSeen();
  return i;
}

// ---------- Utilidades de juego ----------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

function sizeFor(room) {
  const active = room.players.filter((p) => !p.left).length;
  if (room.config.deckMode === 'manual') return room.config.manual;
  return Math.min(MAX_CARDS, Math.max(12, active * CARDS_PER_PLAYER));
}

// ---------- Salas ----------
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (let tries = 0; tries < 100; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function cleanName(raw, room) {
  let n = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!n) n = 'Jugador ' + (room.players.length + 1);
  const base = n;
  let k = 2;
  while (room.players.some((p) => p.name.toLowerCase() === n.toLowerCase())) n = base.slice(0, 13) + ' ' + k++;
  return n;
}

function addPlayer(room, name) {
  const p = { id: crypto.randomBytes(12).toString('hex'), name: cleanName(name, room), km: 0, cards: 0, hits: 0, left: false };
  room.players.push(p);
  return p;
}

function isConn(room, p) {
  const set = room.conns.get(p.id);
  return !p.left && !!set && set.size > 0;
}

// Si el anfitrión sale, la partida termina para todos (el anfitrión no se traspasa).
function closeRoom(room, message) {
  clearTimer(room);
  room.phase = 'closed';
  const data = 'data: ' + JSON.stringify({ phase: 'closed', message }) + '\n\n';
  room.conns.forEach((set) => set.forEach((res) => {
    try { res.write(data); res.end(); } catch (e) { /* conexión cerrada */ }
  }));
  room.conns.clear();
  room.watchers.forEach((res) => { try { res.write(data); res.end(); } catch (e) { /* conexión cerrada */ } });
  room.watchers.clear();
  rooms.delete(room.code);
}

// Direcciones por las que los celulares pueden entrar, la mejor primero.
// Una computadora puede tener varias redes: WiFi/Ethernet (192.168.x.x, 10.x, 172.16-31.x),
// VPN como Tailscale (100.64-127.x), adaptadores virtuales (VirtualBox, WSL, Docker)...
// Solo la red local real sirve para los celulares, así que esa va primero.
function lanUrls() {
  const found = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal) found.push({ name, address: n.address });
    });
  });
  const virtualName = /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|vpn|tailscale|zerotier|loopback|bluetooth|pseudo/i;
  function score(c) {
    const a = c.address.split('.').map(Number);
    if (a[0] === 169 && a[1] === 254) return 5;                              // sin DHCP (inservible)
    if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return 4;                 // Tailscale / CGNAT
    const priv = a[0] === 10 || (a[0] === 192 && a[1] === 168) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31);
    if (!priv) return 3;
    if (virtualName.test(c.name)) return 2;                                  // adaptador virtual
    return a[0] === 192 && a[1] === 168 ? 0 : 1;                             // red local real
  }
  const forced = (process.env.MARATHON_IP || '').trim();
  const sorted = found.map((c, i) => ({ c, i, s: score(c) }))
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map((x) => 'http://' + x.c.address + ':' + PORT);
  if (forced) sorted.unshift('http://' + forced + ':' + PORT);
  return Array.from(new Set(sorted));
}

// ---------- Temporizadores ----------
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
  room.deadlineKind = null;
}
function setTimer(room, ms, kind, fn) {
  if (room.timer) clearTimeout(room.timer);
  room.deadline = Date.now() + ms;
  room.deadlineKind = kind;
  room.timer = setTimeout(() => { room.timer = null; fn(); }, ms);
}

// ---------- Vista que ve cada jugador (nunca incluye la respuesta correcta antes de revelar) ----------
function view(room, pid) {
  const me = pid ? room.players.find((p) => p.id === pid) : null;
  const left = { 1: 0, 2: 0, 3: 0 };
  room.deck.forEach((k) => { left[k]++; });
  const inGame = room.phase === 'question' || room.phase === 'reveal' || room.phase === 'rps';
  const deckSize = room.phase === 'lobby' ? sizeFor(room) : room.deckSize;
  const turnPlayer = room.config.play === 'turns' && room.phase === 'question' ? room.players[room.turn] : null;
  const rps = room.phase === 'rps' && room.rps ? {
    ids: room.rps.ids,
    round: room.rps.round,
    showing: room.rps.showing,
    picked: room.rps.ids.reduce((o, id) => { o[id] = !!room.rps.picks[id]; return o; }, {}),
    mine: pid ? (room.rps.picks[pid] || null) : null,
    last: room.rps.last
  } : null;
  return {
    room: room.code,
    phase: room.phase,
    you: me ? { id: me.id, name: me.name, isHost: room.hostId === me.id, choice: room.phase === 'question' && room.answers[pid] !== undefined ? room.answers[pid] : null } : null,
    config: Object.assign({}, room.config, { deckSize, comp: composition(deckSize) }),
    players: room.players.map((p) => ({
      id: p.id, name: p.name, km: p.km, cards: p.cards, hits: p.hits,
      connected: isConn(room, p), left: p.left,
      locked: room.locked.includes(p.id),
      answered: room.phase === 'question' && room.answers[p.id] !== undefined,
      isTurn: !!turnPlayer && turnPlayer.id === p.id,
      isHost: room.hostId === p.id
    })),
    totalKm: room.totalKm,
    deck: { left: room.deck.length, c1: left[1], c2: left[2], c3: left[3] },
    asked: room.asked,
    question: inGame && room.q && !(room.phase === 'question' && !room.unlocked)
      ? { text: room.q.text, options: room.q.options.map((o) => o.t) } : null,
    unlocked: room.unlocked,
    turnId: turnPlayer ? turnPlayer.id : null,
    notice: room.phase === 'question' ? room.notice : '',
    reveal: room.phase === 'reveal' ? room.reveal : null,
    rps,
    remainingMs: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    deadlineKind: room.deadlineKind,
    joinUrls: lanUrls()
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  room.conns.forEach((set, pid) => {
    if (!room.players.some((p) => p.id === pid)) return;
    const data = 'data: ' + JSON.stringify(view(room, pid)) + '\n\n';
    set.forEach((res) => { try { res.write(data); } catch (e) { /* conexión cerrada */ } });
  });
  if (room.watchers.size) {
    const spectator = 'data: ' + JSON.stringify(view(room, null)) + '\n\n';
    room.watchers.forEach((res) => { try { res.write(spectator); } catch (e) { /* conexión cerrada */ } });
  }
}

// ---------- Flujo del juego ----------
function startQuestion(room) {
  const d = QUESTIONS[nextQuestionIndex()];
  room.q = {
    text: d.q,
    options: shuffle([{ t: d.a, c: true }, { t: d.w[0], c: false }, { t: d.w[1], c: false }])
  };
  room.asked++;
  room.locked = [];
  room.answers = {};
  room.correct = [];
  room.unlocked = false;
  room.rps = null;
  room.notice = '';
  room.reveal = null;
  room.phase = 'question';

  if (room.config.play === 'turns') {
    // salta a quien se haya desconectado o salido
    for (let k = 0; k < room.players.length && !isConn(room, room.players[room.turn]); k++) {
      room.turn = (room.turn + 1) % room.players.length;
    }
  }
  // Las respuestas quedan bloqueadas unos segundos para que todos lean la pregunta.
  setTimer(room, LOCK_MS, 'lock', () => unlock(room));
  broadcast(room);
}

function unlock(room) {
  if (room.phase !== 'question' || room.unlocked) return;
  room.unlocked = true;
  if (room.config.play === 'turns') {
    setTimer(room, ANSWER_MS, 'answer', () => reveal(room, null, 'Se acabó el tiempo.', null));
  } else {
    setTimer(room, QUESTION_MS, 'answer', () => reveal(room, null, 'Nadie contestó.', null));
  }
  broadcast(room);
}

function reveal(room, winner, message, chosenIndex, extra) {
  if (room.phase !== 'question' && room.phase !== 'rps') return;
  clearTimer(room);
  let card = null;
  if (winner) {
    card = room.deck.pop();
    winner.km += card;
    winner.cards++;
    winner.hits++;
    message = '¡Correcto, ' + winner.name + '! Gana una carta de ' + card + ' km.' + (extra || '');
  } else {
    const ans = room.q.options.find((o) => o.c).t;
    message = (message || 'Nadie acertó.') + ' La respuesta era: ' + ans + '. Sin carta esta vez.';
  }
  room.phase = 'reveal';
  room.notice = '';
  room.rps = null;
  room.reveal = {
    correctIndex: room.q.options.findIndex((o) => o.c),
    chosenIndex: typeof chosenIndex === 'number' ? chosenIndex : null,
    winnerId: winner ? winner.id : null,
    card,
    message,
    last: room.deck.length === 0
  };
  setTimer(room, REVEAL_MS, 'next', () => advance(room));
  broadcast(room);
}

function advance(room) {
  if (room.phase !== 'reveal') return;
  if (room.deck.length === 0) { finish(room); return; }
  if (room.config.play === 'turns') room.turn = (room.turn + 1) % room.players.length;
  startQuestion(room);
}

function finish(room) {
  clearTimer(room);
  room.phase = 'results';
  room.q = null;
  room.reveal = null;
  room.rps = null;
  broadcast(room);
}

// Modo carrera: si ya nadie puede contestar (todos fallaron o se fueron), termina la pregunta.
function checkExhausted(room) {
  if (room.phase !== 'question' || room.config.play !== 'race' || !room.unlocked) return;
  if (room.correct.length) return;
  const candidates = room.players.filter((x) => isConn(room, x) && !room.locked.includes(x.id));
  if (!candidates.length) reveal(room, null, 'Nadie acertó.', null);
}

// Modo carrera: pasado el margen de empate, gana el único que acertó o se desempata a piedra, papel o tijera.
function resolveCorrect(room) {
  if (room.phase !== 'question') return;
  const ids = room.correct.slice();
  if (ids.length === 1) {
    const w = room.players.find((p) => p.id === ids[0]);
    reveal(room, w, null, null);
  } else {
    startRps(room, ids);
  }
}

function startRps(room, ids) {
  clearTimer(room);
  room.phase = 'rps';
  room.rps = { ids, round: 1, picks: {}, showing: false, last: null };
  setTimer(room, RPS_MS, 'rps', () => resolveRps(room));
  broadcast(room);
}

function pickRps(room, player, choice) {
  const r = room.rps;
  if (room.phase !== 'rps' || !r || r.showing) return 'No se puede elegir ahora.';
  if (!r.ids.includes(player.id)) return 'No participas en el desempate.';
  if (!RPS_BEATS[choice]) return 'Elección inválida.';
  if (r.picks[player.id]) return 'Ya elegiste.';
  r.picks[player.id] = choice;
  if (r.ids.every((id) => r.picks[id])) resolveRps(room);
  else broadcast(room);
  return null;
}

function resolveRps(room) {
  const r = room.rps;
  if (room.phase !== 'rps' || !r || r.showing) return;
  const options = Object.keys(RPS_BEATS);
  r.ids.forEach((id) => { if (!r.picks[id]) r.picks[id] = options[crypto.randomInt(3)]; });
  const used = Array.from(new Set(r.ids.map((id) => r.picks[id])));
  let survivors = r.ids.slice();
  let draw = true;
  if (used.length === 2) {
    const win = RPS_BEATS[used[0]] === used[1] ? used[0] : used[1];
    survivors = r.ids.filter((id) => r.picks[id] === win);
    draw = false;
  }
  if (survivors.length > 1 && r.round >= 8) { // seguridad: demasiados empates seguidos
    survivors = [survivors[crypto.randomInt(survivors.length)]];
  }
  r.last = { round: r.round, choices: Object.assign({}, r.picks), survivors, draw };
  r.showing = true;
  setTimer(room, RPS_SHOW_MS, 'rpsShow', () => afterRps(room));
  broadcast(room);
}

function afterRps(room) {
  const r = room.rps;
  if (room.phase !== 'rps' || !r) return;
  const survivors = r.last.survivors;
  if (survivors.length === 1) {
    const w = room.players.find((p) => p.id === survivors[0]);
    reveal(room, w, null, null, ' (ganó el desempate de piedra, papel o tijera)');
    return;
  }
  r.ids = survivors;
  r.round++;
  r.picks = {};
  r.showing = false;
  setTimer(room, RPS_MS, 'rps', () => resolveRps(room));
  broadcast(room);
}

function startGame(room) {
  const active = room.players.filter((p) => isConn(room, p));
  room.players = room.players.filter((p) => !p.left);
  if (active.length < MIN_PLAYERS) return 'Se necesitan al menos 2 participantes conectados.';
  room.players.forEach((p) => { p.km = 0; p.cards = 0; p.hits = 0; });
  room.deckSize = sizeFor(room);
  room.deck = buildDeck(room.deckSize);
  room.totalKm = room.deck.reduce((a, b) => a + b, 0);
  room.turn = 0;
  room.asked = 0;
  startQuestion(room);
  return null;
}

// ---------- Acciones ----------
function handleAction(room, player, body) {
  const isHost = room.hostId === player.id;
  switch (body.type) {
    case 'config': {
      if (!isHost || room.phase !== 'lobby') return 'Solo el anfitrión puede configurar en la sala.';
      if (body.play === 'turns' || body.play === 'race') room.config.play = body.play;
      if (body.deckMode === 'auto' || body.deckMode === 'manual') room.config.deckMode = body.deckMode;
      const m = Math.round(Number(body.manual));
      if (Number.isFinite(m)) room.config.manual = Math.min(MAX_CARDS, Math.max(MIN_CARDS, m));
      broadcast(room);
      return null;
    }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return 'Solo el anfitrión puede comenzar.';
      return startGame(room);
    }
    case 'answer': {
      if (room.phase !== 'question') return 'No hay pregunta activa.';
      if (!room.unlocked) return 'Espera: las respuestas aún están bloqueadas.';
      const i = Number(body.index);
      if (![0, 1, 2].includes(i)) return 'Respuesta inválida.';
      if (room.config.play === 'turns') {
        if (room.players[room.turn].id !== player.id) return 'No es tu turno.';
        if (room.q.options[i].c) reveal(room, player, null, i);
        else reveal(room, null, 'Incorrecto.', i);
      } else {
        if (room.locked.includes(player.id) || room.answers[player.id] !== undefined) return 'Ya contestaste esta pregunta.';
        room.answers[player.id] = i;
        if (room.q.options[i].c) {
          room.correct.push(player.id);
          // El primero que acierta abre un margen corto: quien acierte dentro de él empata.
          if (room.correct.length === 1) setTimer(room, TIE_MS, 'tie', () => resolveCorrect(room));
          broadcast(room);
        } else {
          room.locked.push(player.id);
          room.notice = player.name + ' falló y queda fuera de esta pregunta.';
          broadcast(room);
          checkExhausted(room);
        }
      }
      return null;
    }
    case 'rps': {
      return pickRps(room, player, String(body.choice || ''));
    }
    case 'next': {
      if (!isHost || room.phase !== 'reveal') return 'No se puede en este momento.';
      advance(room);
      return null;
    }
    case 'restart': {
      if (!isHost || room.phase !== 'results') return 'No se puede en este momento.';
      room.phase = 'lobby';
      room.players = room.players.filter((p) => !p.left);
      broadcast(room);
      return null;
    }
    case 'leave': {
      leavePlayer(room, player);
      return null;
    }
    default:
      return 'Acción desconocida.';
  }
}

function leavePlayer(room, player) {
  if (player.id === room.hostId) { closeRoom(room, 'El anfitrión salió de la sala: la partida terminó.'); return; }
  player.left = true;
  const set = room.conns.get(player.id);
  if (set) set.forEach((res) => { try { res.end(); } catch (e) { /* nada */ } });
  room.conns.delete(player.id);
  if (room.phase === 'lobby') room.players = room.players.filter((p) => p.id !== player.id);
  checkExhausted(room);
  if (!room.players.some((p) => isConn(room, p))) { closeRoom(room, 'Todos salieron de la sala.'); return; }
  broadcast(room);
}

// ---------- HTTP ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8'
};
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/online.html': 'online.html',
  '/style.css': 'style.css', '/app.js': 'app.js', '/online.js': 'online.js', '/questions.js': 'questions.js',
  '/board.html': 'board.html', '/board.js': 'board.js', '/board.css': 'board.css'
};
// Solo se entregan a la computadora que corre el servidor (no a los celulares de los participantes).
const LOCAL_ONLY = new Set(['questions.js', 'board.html', 'board.js', 'board.css']);

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10000) { reject(new Error('Solicitud demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

// ¿La petición viene de esta misma computadora? (localhost, o su propia IP de red local)
function isLoopback(req) {
  const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  const nets = os.networkInterfaces();
  return Object.keys(nets).some((name) => (nets[name] || []).some((n) => n.address === a));
}

function serveStatic(req, res, pathname) {
  const file = STATIC[pathname];
  if (!file) { res.writeHead(404); res.end('No encontrado'); return; }
  // Las preguntas con sus respuestas solo se entregan a la computadora que corre el servidor,
  // para que los demás participantes no puedan verlas desde el navegador.
  if (LOCAL_ONLY.has(file) && !isLoopback(req)) { res.writeHead(404); res.end('No encontrado'); return; }
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('No encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function findPlayer(room, pid) {
  return room.players.find((p) => p.id === pid && !p.left) || null;
}

// Tablero general: solo lectura, solo desde esta computadora, no cuenta como jugador.
function openWatch(req, res, url) {
  const room = isLoopback(req) ? rooms.get(String(url.searchParams.get('room') || '').toUpperCase()) : null;
  if (!room) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  room.watchers.add(res);
  res.write('data: ' + JSON.stringify(view(room, null)) + '\n\n');
  req.on('close', () => { room.watchers.delete(res); });
}

function openEvents(req, res, url) {
  const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
  const player = room && findPlayer(room, url.searchParams.get('pid'));
  if (!room || !player) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  if (!room.conns.has(player.id)) room.conns.set(player.id, new Set());
  room.conns.get(player.id).add(res);
  broadcast(room);
  req.on('close', () => {
    const set = room.conns.get(player.id);
    if (set) { set.delete(res); if (!set.size) room.conns.delete(player.id); }
    if (!rooms.has(room.code)) return;
    if (player.id === room.hostId) {
      setTimeout(() => {
        if (rooms.has(room.code) && !isConn(room, player)) {
          closeRoom(room, 'El anfitrión se desconectó: la partida terminó.');
        }
      }, HOST_GRACE_MS);
    }
    if (room.phase === 'lobby') {
      // en la sala de espera, quien no vuelve en 30 s sale de la lista
      setTimeout(() => {
        if (rooms.has(room.code) && room.phase === 'lobby' && !isConn(room, player)) leavePlayer(room, player);
      }, 30000);
    } else {
      checkExhausted(room);
    }
    if (rooms.has(room.code)) broadcast(room);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') return openEvents(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/watch') return openWatch(req, res, url);

    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      if (!isLoopback(req)) { res.writeHead(404); res.end(); return; }
      const list = [];
      rooms.forEach((room) => {
        const host = room.players.find((p) => p.id === room.hostId);
        list.push({ code: room.code, phase: room.phase, players: room.players.filter((p) => !p.left).length, host: host ? host.name : '' });
      });
      return sendJson(res, 200, { rooms: list, joinUrls: lanUrls() });
    }

    if (req.method === 'GET' && url.pathname === '/api/check') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      const ok = !!room && !!findPlayer(room, url.searchParams.get('pid'));
      return sendJson(res, ok ? 200 : 404, { ok });
    }

    if (req.method === 'POST' && url.pathname === '/api/create') {
      const body = await readJson(req);
      if (rooms.size >= 20) return sendJson(res, 429, { error: 'Hay demasiadas salas abiertas.' });
      const code = newCode();
      const room = {
        code, players: [], hostId: null, phase: 'lobby',
        config: { play: body.play === 'race' ? 'race' : 'turns', deckMode: 'auto', manual: 24 },
        deck: [], deckSize: 0, totalKm: 0, q: null, turn: 0, asked: 0,
        locked: [], answers: {}, correct: [], unlocked: false, rps: null, notice: '', reveal: null,
        timer: null, deadline: null, deadlineKind: null, conns: new Map(), watchers: new Set(), lastActive: Date.now()
      };
      const p = addPlayer(room, body.name);
      room.hostId = p.id;
      rooms.set(code, room);
      return sendJson(res, 200, { room: code, pid: p.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(req);
      const room = rooms.get(String(body.room || '').toUpperCase().trim());
      if (!room) return sendJson(res, 404, { error: 'No existe una sala con ese código.' });
      if (room.phase !== 'lobby') return sendJson(res, 409, { error: 'La partida ya comenzó.' });
      if (room.players.filter((p) => !p.left).length >= MAX_PLAYERS) return sendJson(res, 409, { error: 'La sala está llena (máximo ' + MAX_PLAYERS + ').' });
      const p = addPlayer(room, body.name);
      broadcast(room);
      return sendJson(res, 200, { room: room.code, pid: p.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readJson(req);
      const room = rooms.get(String(body.room || '').toUpperCase());
      const player = room && findPlayer(room, body.pid);
      if (!room || !player) return sendJson(res, 404, { error: 'La sala ya no existe.' });
      const err = handleAction(room, player, body);
      return err ? sendJson(res, 400, { error: err }) : sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: e.message || 'Solicitud inválida' });
  }
});

// Mantiene vivas las conexiones y limpia salas abandonadas.
setInterval(() => {
  rooms.forEach((room) => {
    room.conns.forEach((set) => set.forEach((res) => { try { res.write(': ping\n\n'); } catch (e) { /* nada */ } }));
    room.watchers.forEach((res) => { try { res.write(': ping\n\n'); } catch (e) { /* nada */ } });
    if (Date.now() - room.lastActive > 10 * 60 * 1000 && !room.players.some((p) => isConn(room, p))) {
      closeRoom(room, 'La sala se cerró por inactividad.');
    }
  });
}, 15000).unref();

// Si el puerto está ocupado (por ejemplo, otra ventana de Maratón sigue abierta), prueba con el siguiente.
function announce() {
  console.log('\n🏁 Maratón de preguntas — servidor listo (' + QUESTIONS.length + ' preguntas)\n');
  console.log('  En esta computadora:  http://localhost:' + PORT);
  console.log('  Tablero para proyectar (solo esta computadora):  http://localhost:' + PORT + '/board.html');
  const urls = lanUrls();
  if (urls.length) {
    console.log('  Para los celulares (mismo WiFi):');
    urls.forEach((u, i) => console.log('    ' + u + '/online.html' + (i === 0 && urls.length > 1 ? '   <-- usa esta' : '')));
    if (urls.length > 1) console.log('    (las demás son de otras redes: VPN o adaptadores virtuales; normalmente no sirven para los celulares)');
  } else {
    console.log('  (No se detectó una red local; conecta la computadora al WiFi.)');
  }
  if (PORT !== WANTED_PORT) {
    console.log('\n  ⚠ Usa el puerto ' + PORT + ' (el ' + WANTED_PORT + ' estaba ocupado). Si quieres el ' + WANTED_PORT + ', cierra la otra ventana negra y vuelve a abrir iniciar.bat.');
  }
  console.log('\n  Detén el servidor con Ctrl + C.\n');
}

let portRetries = 10;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && portRetries-- > 0) {
    console.log('  ⚠ El puerto ' + PORT + ' ya está en uso (¿sigue abierta otra ventana de Maratón?). Probando el ' + (PORT + 1) + '…');
    PORT++;
    server.listen(PORT, '0.0.0.0');
  } else {
    console.error('\nNo se pudo iniciar el servidor: ' + err.message);
    process.exit(1);
  }
});
server.once('listening', announce);
server.listen(PORT, '0.0.0.0');

module.exports = { composition, buildDeck, server };
