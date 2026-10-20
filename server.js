'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 6;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{4}$/;
const WHEEL_MS = 4600;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_QUESTIONS = 100;
const MAX_NAME = 16;

const SCORES = {
  first: { correct: 10, wrong: -20 },
  later: { correct: 7, wrong: -14 },
  wheel: { correct: 5, wrong: -5 },
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });
const rooms = new Map();
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR));

app.get('/host/:code', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'host.html'));
});

app.get('/api/qr', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > 500) return res.status(400).end();
    const png = await QRCode.toBuffer(url, {
      width: 640,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1020', light: '#ffffff' },
    });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).end();
  }
});

app.get('/:code', (req, res, next) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!CODE_RE.test(code)) return next();
  if (!rooms.has(code)) return res.status(404).send(notFoundPage());
  res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
});

app.use((req, res) => res.status(404).send(notFoundPage()));

/* ---------------------------------- utils --------------------------------- */

function notFoundPage() {
  return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>جلسة غير موجودة | سؤال وجواب</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0a0e1a;color:#f2f5ff;font-family:Cairo,system-ui,Tahoma,sans-serif;text-align:center;padding:24px}
  .card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:40px 28px;max-width:420px}
  h1{font-size:26px;margin:0 0 10px}
  p{color:#8b93b0;margin:0 0 24px;line-height:1.8}
  a{display:inline-block;background:linear-gradient(135deg,#6d5dfc,#39d2ff);color:#fff;text-decoration:none;font-weight:800;padding:14px 28px;border-radius:16px}
  .icon{font-size:56px;margin-bottom:12px}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">؟</div>
    <h1>الجلسة غير موجودة</h1>
    <p>تأكد من صحة الرابط أو اطلب من المشرف إنشاء جلسة جديدة ومشاركة الرابط من جديد.</p>
    <a href="/">إنشاء جلسة جديدة</a>
  </div>
</body>
</html>`;
}

function randomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
  } while (rooms.has(code));
  return code;
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function newRoom() {
  return {
    code: randomCode(),
    hostToken: randomToken(),
    hostSocketId: null,
    players: [],
    questions: [],
    phase: 'lobby',
    qIndex: -1,
    answererId: null,
    answerMode: null,
    buzzOrder: [],
    deltas: {},
    lastResult: null,
    wheel: null,
    wheelTimer: null,
    lastActivity: Date.now(),
  };
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id) || null;
}

function nextSlot(room) {
  const used = new Set(room.players.map((p) => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return room.players.length;
}

function resetQuestionState(room) {
  if (room.wheelTimer) clearTimeout(room.wheelTimer);
  room.wheelTimer = null;
  room.buzzOrder = [];
  room.answererId = null;
  room.answerMode = null;
  room.deltas = {};
  room.lastResult = null;
  room.wheel = null;
  for (const p of room.players) p.locked = false;
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      locked: p.locked,
      slot: p.slot,
    })),
    maxPlayers: MAX_PLAYERS,
    qIndex: room.qIndex,
    totalQuestions: room.questions.length,
    question:
      room.qIndex >= 0 && room.questions[room.qIndex] ? room.questions[room.qIndex].text : null,
    answererId: room.answererId,
    answerMode: room.answerMode,
    buzzOrder: room.buzzOrder,
    deltas: room.deltas,
    lastResult: room.lastResult,
    wheel: room.wheel,
  };
}

function hostState(room) {
  return {
    ...publicState(room),
    questions: room.questions.map((q) => q.text),
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  io.to(room.code).emit('state', publicState(room));
  if (room.hostSocketId) io.to(room.hostSocketId).emit('hostState', hostState(room));
}

function attachSocket(socket, room, role/*, playerId */) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.role = role;
  room.lastActivity = Date.now();
}

function reply(socket, ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

/* ------------------------------ scoring logic ------------------------------ */

function applyScore(room, playerId, mode, correct) {
  let points;
  if (mode === 'wheel') {
    points = correct ? SCORES.wheel.correct : SCORES.wheel.wrong;
  } else {
    const idx = room.buzzOrder.indexOf(playerId);
    const tier = idx === 0 ? SCORES.first : SCORES.later;
    points = correct ? tier.correct : tier.wrong;
  }
  const player = findPlayer(room, playerId);
  if (player) player.score += points;
  room.deltas[playerId] = (room.deltas[playerId] || 0) + points;
  room.lastResult = {
    playerId,
    playerName: player ? player.name : '',
    mode,
    correct,
    points,
  };
  return points;
}

/* -------------------------------- socket.io -------------------------------- */

io.on('connection', (socket) => {
  socket.on('host:create', (payload, ack) => {
    const room = newRoom();
    rooms.set(room.code, room);
    room.hostSocketId = socket.id;
    attachSocket(socket, room, 'host');
    reply(socket, ack, { ok: true, code: room.code, hostToken: room.hostToken, lanUrls: lanUrls() });
    socket.emit('hostState', hostState(room));
    broadcast(room);
  });

  socket.on('host:join', (payload, ack) => {
    const code = String(payload && payload.code || '').toUpperCase();
    const hostToken = String(payload && payload.hostToken || '');
    const room = rooms.get(code);
    if (!room) return reply(socket, ack, { ok: false, error: 'ROOM_NOT_FOUND' });
    if (!hostToken || room.hostToken !== hostToken) {
      return reply(socket, ack, { ok: false, error: 'FORBIDDEN' });
    }
    room.hostSocketId = socket.id;
    attachSocket(socket, room, 'host');
    reply(socket, ack, { ok: true, code: room.code, lanUrls: lanUrls() });
    socket.emit('hostState', hostState(room));
    broadcast(room);
  });

  socket.on('player:join', (payload, ack) => {
    const code = String(payload && payload.code || '').toUpperCase();
    const token = payload && payload.token ? String(payload.token) : null;
    const name = cleanName(payload && payload.name);
    const room = rooms.get(code);
    if (!room) return reply(socket, ack, { ok: false, error: 'ROOM_NOT_FOUND' });

    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        existing.connected = true;
        existing.socketId = socket.id;
        if (name && name !== existing.name) existing.name = name;
        attachSocket(socket, room, 'player');
        socket.data.playerId = existing.id;
        reply(socket, ack, {
          ok: true,
          playerId: existing.id,
          token: existing.token,
          name: existing.name,
        });
        broadcast(room);
        return;
      }
    }

    if (room.phase !== 'lobby') {
      return reply(socket, ack, { ok: false, error: 'GAME_STARTED' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return reply(socket, ack, { ok: false, error: 'ROOM_FULL' });
    }
    if (!name) return reply(socket, ack, { ok: false, error: 'BAD_NAME' });
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return reply(socket, ack, { ok: false, error: 'NAME_TAKEN' });
    }

    const player = {
      id: crypto.randomUUID(),
      token: randomToken(),
      name,
      score: 0,
      connected: true,
      locked: false,
      socketId: socket.id,
      slot: nextSlot(room),
    };
    room.players.push(player);
    attachSocket(socket, room, 'player');
    socket.data.playerId = player.id;
    reply(socket, ack, { ok: true, playerId: player.id, token: player.token, name: player.name });
    broadcast(room);
  });

  socket.on('player:buzz', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'player') return reply(socket, ack, { ok: false });
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return reply(socket, ack, { ok: false, error: 'NO_PLAYER' });
    if (room.phase !== 'question') return reply(socket, ack, { ok: false, error: 'TOO_LATE' });
    if (player.locked) return reply(socket, ack, { ok: false, error: 'ALREADY_WRONG' });
    if (room.answererId) return reply(socket, ack, { ok: false, error: 'TOO_LATE' });

    room.buzzOrder.push(player.id);
    room.answererId = player.id;
    room.answerMode = 'buzz';
    room.phase = 'answering';
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:addQuestions', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    const texts = Array.isArray(payload && payload.texts) ? payload.texts : [];
    const cleaned = texts
      .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, MAX_QUESTIONS);
    const room_left = MAX_QUESTIONS - room.questions.length;
    const toAdd = cleaned.slice(0, Math.max(0, room_left));
    for (const text of toAdd) {
      room.questions.push({ id: crypto.randomUUID(), text: text.slice(0, 300) });
    }
    reply(socket, ack, { ok: true, added: toAdd.length, total: room.questions.length });
    if (toAdd.length) broadcast(room);
    else socket.emit('hostState', hostState(room));
  });

  socket.on('host:removeQuestion', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    if (room.phase !== 'lobby' && room.phase !== 'ended') {
      return reply(socket, ack, { ok: false, error: 'LOCKED' });
    }
    const index = Number(payload && payload.index);
    if (!Number.isInteger(index) || index < 0 || index >= room.questions.length) {
      return reply(socket, ack, { ok: false });
    }
    room.questions.splice(index, 1);
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:kick', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    if (room.phase !== 'lobby') return reply(socket, ack, { ok: false, error: 'LOCKED' });
    const id = String(payload && payload.playerId || '');
    const player = findPlayer(room, id);
    if (!player) return reply(socket, ack, { ok: false });
    room.players = room.players.filter((p) => p.id !== id);
    if (player.socketId && io.sockets.sockets.get(player.socketId)) {
      io.sockets.sockets.get(player.socketId).emit('kicked');
    }
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:start', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    if (room.phase !== 'lobby') return reply(socket, ack, { ok: false, error: 'BAD_PHASE' });
    if (room.players.length < 1) return reply(socket, ack, { ok: false, error: 'NO_PLAYERS' });
    if (room.questions.length < 1) return reply(socket, ack, { ok: false, error: 'NO_QUESTIONS' });
    room.qIndex = 0;
    resetQuestionState(room);
    room.phase = 'question';
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:evaluate', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    if (room.phase !== 'answering' || !room.answererId) {
      return reply(socket, ack, { ok: false, error: 'BAD_PHASE' });
    }
    const correct = Boolean(payload && payload.correct);
    const player = findPlayer(room, room.answererId);
    if (!player) return reply(socket, ack, { ok: false });
    const mode = room.answerMode;
    applyScore(room, player.id, mode, correct);

    if (correct) {
      room.phase = 'reveal';
      room.answererId = null;
      room.answerMode = null;
    } else {
      player.locked = true;
      room.answererId = null;
      room.answerMode = null;
      if (mode === 'wheel') {
        room.phase = 'reveal';
      } else {
        const hasFreePlayer = room.players.some((p) => p.connected && !p.locked);
        room.phase = hasFreePlayer ? 'question' : 'reveal';
      }
    }
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:skip', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    if (room.phase !== 'question') return reply(socket, ack, { ok: false, error: 'BAD_PHASE' });
    room.phase = 'reveal';
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:wheel', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    if (room.phase !== 'question') return reply(socket, ack, { ok: false, error: 'BAD_PHASE' });
    const candidates = room.players.filter((p) => p.connected && !p.locked);
    if (!candidates.length) return reply(socket, ack, { ok: false, error: 'NO_CANDIDATES' });
    const winner = candidates[crypto.randomInt(candidates.length)];
    const startedAt = Date.now();
    const endsAt = startedAt + WHEEL_MS;
    room.phase = 'wheel';
    room.wheel = { winnerId: winner.id, startedAt, endsAt };
    reply(socket, ack, { ok: true });
    broadcast(room);

    room.wheelTimer = setTimeout(() => {
      const r = rooms.get(room.code);
      if (!r || r.phase !== 'wheel' || !r.wheel) return;
      const w = findPlayer(r, r.wheel.winnerId);
      if (!w || w.locked || !w.connected) {
        r.wheel = null;
        r.phase = 'question';
        broadcast(r);
        return;
      }
      r.answererId = w.id;
      r.answerMode = 'wheel';
      r.wheel = null;
      r.wheelTimer = null;
      r.phase = 'answering';
      broadcast(r);
    }, WHEEL_MS);
  });

  socket.on('host:next', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    if (room.phase !== 'reveal') return reply(socket, ack, { ok: false, error: 'BAD_PHASE' });
    if (room.qIndex + 1 < room.questions.length) {
      room.qIndex += 1;
      resetQuestionState(room);
      room.phase = 'question';
    } else {
      resetQuestionState(room);
      room.phase = 'ended';
    }
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:end', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    resetQuestionState(room);
    room.phase = 'ended';
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('host:restart', (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return reply(socket, ack, { ok: false });
    for (const p of room.players) {
      p.score = 0;
      p.locked = false;
    }
    room.qIndex = -1;
    resetQuestionState(room);
    room.phase = 'lobby';
    reply(socket, ack, { ok: true });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.role === 'host') {
      if (room.hostSocketId === socket.id) room.hostSocketId = null;
      return;
    }
    if (socket.data.role === 'player') {
      const player = findPlayer(room, socket.data.playerId);
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      player.socketId = null;
      if (room.phase === 'lobby') {
        room.players = room.players.filter((p) => p.id !== player.id);
      }
      broadcast(room);
    }
  });
});

/* --------------------------------- startup --------------------------------- */

function lanUrls() {
  const urls = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${PORT}`);
    }
  }
  return urls;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      if (room.wheelTimer) clearTimeout(room.wheelTimer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log('');
  console.log('  سؤال وجواب — الخادم يعمل الآن');
  console.log(`  الجهاز المحلي:  http://localhost:${PORT}`);
  for (const url of lanUrls()) {
    console.log(`  الشبكة المحلية: ${url}   (شارك هذا الرابط مع اللاعبين)`);
  }
  console.log('');
});
