'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return io(BASE, { transports: ['websocket'], forceNew: true });
}

function emit(sock, event, payload) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), 5000);
    sock.emit(event, payload || {}, (res) => {
      clearTimeout(t);
      resolve(res || {});
    });
  });
}

function waitState(getState, pred, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const s = getState();
      if (s && pred(s)) {
        clearInterval(timer);
        resolve(s);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(timer);
        reject(new Error('waitState timeout'));
      }
    }, 25);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: data }));
      })
      .on('error', reject);
  });
}

async function main() {
  console.log('\n=== اختبار شامل للعبة سؤال وجواب ===\n');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try {
      const r = await get(BASE + '/');
      ready = r.status === 200;
    } catch (err) {
      await sleep(150);
    }
  }
  check('الخادم يعمل ويقدّم الصفحة الرئيسية', ready);
  if (!ready) {
    server.kill();
    process.exit(1);
  }

  const host = connect();
  let hostState = null;
  host.on('hostState', (s) => (hostState = s));

  const create = await emit(host, 'host:create');
  check('إنشاء جلسة جديدة', create.ok && /^[A-Z0-9]{4}$/.test(create.code), create);
  const code = create.code;
  await waitState(() => hostState, (s) => s.phase === 'lobby');

  const badHost = connect();
  const badHostRes = await emit(badHost, 'host:join', { code, hostToken: 'wrong-token' });
  check('رفض استرجاع الإدارة برمز خاطئ', badHostRes.error === 'FORBIDDEN', badHostRes);
  badHost.disconnect();

  const goodHost = await emit(host, 'host:join', { code, hostToken: create.hostToken });
  check('استرجاع الإدارة بالرمز الصحيح (بعد تحديث الصفحة)', goodHost.ok, goodHost);

  const idx = await get(BASE + '/');
  check('GET / → الصفحة الرئيسية', idx.status === 200 && idx.body.includes('سؤال وجواب'));
  const pp = await get(`${BASE}/${code}`);
  check('GET /:code → صفحة اللاعب', pp.status === 200 && pp.body.includes('دخول الجلسة'));
  const hp = await get(`${BASE}/host/${code}`);
  check('GET /host/:code → لوحة المشرف', hp.status === 200 && hp.body.includes('رمز الجلسة'));
  const nf = await get(`${BASE}/ZZZZ`);
  check('GET /ZZZZ → صفحة جلسة غير موجودة (404)', nf.status === 404);
  const qr = await get(`${BASE}/api/qr?url=${encodeURIComponent(BASE + '/' + code)}`);
  check('GET /api/qr → صورة PNG', qr.status === 200 && qr.type.includes('image/png'));

  const players = [];
  for (let i = 1; i <= 9; i++) {
    const s = connect();
    const res = await emit(s, 'player:join', { code, name: `لاعب ${i}` });
    check(`انضمام اللاعب ${i}`, res.ok, res);
    players.push({ sock: s, id: res.playerId, token: res.token, name: `لاعب ${i}` });
  }

  const dup = connect();
  const dupRes = await emit(dup, 'player:join', { code, name: 'لاعب 1' });
  check('رفض الاسم المكرر', dupRes.error === 'NAME_TAKEN', dupRes);
  dup.disconnect();

  const s10 = connect();
  const res10 = await emit(s10, 'player:join', { code, name: 'لاعب 10' });
  check('انضمام اللاعب 10', res10.ok, res10);
  players.push({ sock: s10, id: res10.playerId, token: res10.token, name: 'لاعب 10' });

  const extra = connect();
  const extraRes = await emit(extra, 'player:join', { code, name: 'لاعب زائد' });
  check('رفض اللاعب الحادي عشر (الحد الأقصى ١٠)', extraRes.error === 'ROOM_FULL', extraRes);
  extra.disconnect();

  /* ---------- الإزالة من اللوبي ---------- */

  let gotKicked = false;
  players[5].sock.once('kicked', () => {
    gotKicked = true;
  });
  const kickRes = await emit(host, 'host:kick', { playerId: players[5].id });
  check('المشرف يستطيع إزالة لاعب في اللوبي', kickRes.ok, kickRes);
  await waitState(() => hostState, (s) => s.players.length === 9);
  check('اللاعب المُزال يبقى خارج القائمة', true);
  await sleep(400);
  check('اللاعب المُزال يستلم إشعار الإخراج', gotKicked);

  const evilKick = await emit(players[0].sock, 'host:kick', { playerId: players[1].id });
  check('لاعب عادي لا يستطيع إزالة غيره', evilKick.ok !== true, evilKick);

  const rejoin = connect();
  const rejoinRes = await emit(rejoin, 'player:join', { code, name: 'لاعب 6', token: players[5].token });
  check('إعادة الانضمام بعد الإزالة تعمل', rejoinRes.ok, rejoinRes);
  players[5] = { sock: rejoin, id: rejoinRes.playerId, token: rejoinRes.token, name: 'لاعب 6' };
  await waitState(() => hostState, (s) => s.players.length === 10);

  const add = await emit(host, 'host:addQuestions', { texts: ['سؤال أول', 'سؤال ثاني', 'سؤال ثالث', 'سؤال رابع'] });
  check('إضافة ٤ أسئلة', add.ok && add.total === 4, add);
  await waitState(() => hostState, (s) => s.totalQuestions === 4);

  const start = await emit(host, 'host:start');
  check('بدء اللعبة يعرض السؤال الأول', start.ok, start);
  await waitState(() => hostState, (s) => s.phase === 'question' && s.qIndex === 0);

  /* ---------- الجولة ١: أول ضغطة صحيحة → +10 ---------- */

  const buzz1 = await emit(players[0].sock, 'player:buzz');
  check('اللاعب الأول يضغط بنجاح', buzz1.ok, buzz1);
  await waitState(() => hostState, (s) => s.phase === 'answering' && s.answererId === players[0].id);
  const lateBuzz = await emit(players[1].sock, 'player:buzz');
  check('رفض ضغطة لاعب آخر أثناء الإجابة', lateBuzz.error === 'TOO_LATE', lateBuzz);

  await emit(host, 'host:evaluate', { correct: true });
  let s = await waitState(() => hostState, (s) => s.phase === 'reveal');
  check(
    'إجابة صحيحة (أول ضغطة) → +10',
    s.players.find((p) => p.id === players[0].id).score === 10 && s.deltas[players[0].id] === 10,
    s.deltas
  );

  /* ---------- الجولة ٢: خطأ -10 ثم خطأ -10 ثم صحيحة +10 ---------- */

  await emit(host, 'host:next');
  await waitState(() => hostState, (s) => s.phase === 'question' && s.qIndex === 1);

  await emit(players[1].sock, 'player:buzz');
  await waitState(() => hostState, (s) => s.phase === 'answering' && s.answererId === players[1].id);
  await emit(host, 'host:evaluate', { correct: false });
  s = await waitState(() => hostState, (s) => s.phase === 'question');
  check(
    'إجابة خاطئة (أول ضغطة) → -10 مع قفل اللاعب',
    s.players.find((p) => p.id === players[1].id).score === -10 &&
      s.players.find((p) => p.id === players[1].id).locked === true
  );
  const lockedBuzz = await emit(players[1].sock, 'player:buzz');
  check('اللاعب المخطئ لا يستطيع الضغط مجدداً', lockedBuzz.error === 'ALREADY_WRONG', lockedBuzz);

  await emit(players[2].sock, 'player:buzz');
  await waitState(() => hostState, (s) => s.phase === 'answering' && s.answererId === players[2].id);
  await emit(host, 'host:evaluate', { correct: false });
  s = await waitState(() => hostState, (s) => s.phase === 'question');
  check('إجابة خاطئة (ضغطة ثانية) → -10', s.players.find((p) => p.id === players[2].id).score === -10);

  await emit(players[0].sock, 'player:buzz');
  await waitState(() => hostState, (s) => s.phase === 'answering' && s.answererId === players[0].id);
  await emit(host, 'host:evaluate', { correct: true });
  s = await waitState(() => hostState, (s) => s.phase === 'reveal');
  check(
    'إجابة صحيحة (ضغطة ثانية) → +10 والمجموع 20',
    s.players.find((p) => p.id === players[0].id).score === 20
  );

  /* ---------- الجولة ٣: عجلة الحظ → +10 ---------- */

  await emit(host, 'host:next');
  await waitState(() => hostState, (s) => s.phase === 'question' && s.qIndex === 2);
  const wheelRes = await emit(host, 'host:wheel');
  check('تشغيل عجلة الحظ', wheelRes.ok, wheelRes);
  const w1 = await waitState(() => hostState, (s) => s.phase === 'wheel' && s.wheel);
  check('حالة العجلة تحدد الفائز ومدة الدوران', !!w1.wheel.winnerId && w1.wheel.endsAt > w1.wheel.startedAt);
  const winnerId = w1.wheel.winnerId;
  const w2 = await waitState(
    () => hostState,
    (s) => s.phase === 'answering' && s.answerMode === 'wheel',
    9000
  );
  check('اختتام العجلة يحوّل الدور للاعب المختار', w2.answererId === winnerId);
  const before =
    winnerId === players[0].id ? 20 : winnerId === players[1].id ? -10 : winnerId === players[2].id ? -10 : 0;
  await emit(host, 'host:evaluate', { correct: true });
  s = await waitState(() => hostState, (s) => s.phase === 'reveal');
  check('إجابة صحيحة عبر العجلة → +10', s.players.find((p) => p.id === winnerId).score === before + 10);

  /* ---------- الجولة ٤: لا أحد يعرف → لا نقاط ---------- */

  await emit(host, 'host:next');
  await waitState(() => hostState, (s) => s.phase === 'question' && s.qIndex === 3);
  await emit(host, 'host:skip');
  s = await waitState(() => hostState, (s) => s.phase === 'reveal');
  check('تخطي السؤال لا يغيّر النقاط', Object.keys(s.deltas).length === 0 && s.lastResult === null);

  /* ---------- النهاية وإعادة اللعب ---------- */

  await emit(host, 'host:next');
  s = await waitState(() => hostState, (s) => s.phase === 'ended');
  check('انتهاء كل الأسئلة → النتائج النهائية', s.phase === 'ended');

  const top = [...s.players].sort((a, b) => b.score - a.score)[0];
  const expectedTop = 20 + (winnerId === players[0].id ? 10 : 0);
  check('المتصدر هو اللاعب صاحب أعلى نقاط', top.id === players[0].id && top.score === expectedTop, top);

  await emit(host, 'host:restart');
  s = await waitState(() => hostState, (s) => s.phase === 'lobby');
  check('إعادة اللعب تصفّر النقاط وتعيد اللاعبين', s.players.length === 10 && s.players.every((p) => p.score === 0));

  /* ---------- إعادة الاتصال أثناء اللعب ---------- */

  await emit(host, 'host:start');
  await waitState(() => hostState, (s) => s.phase === 'question');

  players[3].sock.disconnect();
  await waitState(() => hostState, (s) => s.players.find((p) => p.id === players[3].id).connected === false);
  check('انقطاع لاعب أثناء اللعبة يبقى في القائمة كغير متصل', true);

  const re = connect();
  const reRes = await emit(re, 'player:join', { code, name: players[3].name, token: players[3].token });
  check(
    'إعادة الاتصال بالتوكن تستعيد اللاعب ونقاطه',
    reRes.ok && reRes.playerId === players[3].id,
    reRes
  );
  players[3].sock = re;

  const late = connect();
  const lateRes = await emit(late, 'player:join', { code, name: 'متأخر' });
  check('رفض الانضمام بعد بدء اللعبة', lateRes.error === 'GAME_STARTED', lateRes);
  late.disconnect();

  /* ---------- إنهاء يدوي ---------- */

  const noAuth = connect();
  const noAuthRes = await emit(noAuth, 'host:end');
  check('لاعب عادي لا يملك صلاحيات المشرف', noAuthRes.ok !== true, noAuthRes);
  noAuth.disconnect();

  const endRes = await emit(host, 'host:end');
  s = await waitState(() => hostState, (s) => s.phase === 'ended');
  check('إنهاء اللعبة يدوياً يعرض النتائج', endRes.ok && s.phase === 'ended');

  host.disconnect();
  players.forEach((p) => p.sock && p.sock.disconnect());
  server.kill();
  await sleep(250);

  console.log(`\nالنتيجة: ${passed} نجحت، ${failed} فشلت\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nفشل الاختبار:', err.message);
  process.exit(1);
});
