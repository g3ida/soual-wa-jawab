'use strict';

(() => {
  const code = decodeURIComponent(location.pathname.replace(/^\/+|\/+$/g, '')).toUpperCase();
  const storageKey = `sj-player-${code}`;
  const socket = io();

  let state = null;
  let me = null;
  let joined = false;
  let joining = false;
  let lastStageKey = '';
  let wheelActive = false;
  let prevResultSig = null;
  let prevAnswererId = null;
  let prevPhase = null;

  const els = {
    joinScreen: SJ.$('#joinScreen'),
    gameScreen: SJ.$('#gameScreen'),
    joinForm: SJ.$('#joinForm'),
    nameInput: SJ.$('#nameInput'),
    joinError: SJ.$('#joinError'),
    joinBtn: SJ.$('#joinBtn'),
    stage: SJ.$('#stage'),
    meName: SJ.$('#meName'),
    meAvatar: SJ.$('#meAvatar'),
    meScore: SJ.$('#meScore'),
    connDot: SJ.$('#connDot'),
    soundBtn: SJ.$('#soundBtn'),
    wheelOverlay: SJ.$('#wheelOverlay'),
    wheelTitle: SJ.$('#wheelTitle'),
    wheelSub: SJ.$('#wheelSub'),
    wheelCanvas: SJ.$('#wheelCanvas'),
  };

  const ICON_MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>`;
  const ICON_SOUND_ON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>`;
  const ICON_SOUND_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;

  const ERRORS = {
    ROOM_NOT_FOUND: 'الجلسة غير موجودة أو انتهت. تأكد من الرابط.',
    GAME_STARTED: 'اللعبة بدأت بالفعل، لا يمكن الانضمام الآن.',
    ROOM_FULL: 'الغرفة ممتلئة — الحد الأقصى ١٠ لاعبين.',
    NAME_TAKEN: 'هذا الاسم مستخدم بالفعل، جرّب اسماً آخر.',
    BAD_NAME: 'اكتب اسماً صحيحاً أولاً.',
  };

  /* ------------------------------- الانضمام ------------------------------- */

  function loadSaved() {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) || 'null');
      return raw && raw.token ? raw : null;
    } catch (err) {
      return null;
    }
  }

  function saveMe() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(me));
    } catch (err) {
      /* ignore */
    }
  }

  function showJoinError(message) {
    els.joinError.textContent = message;
    els.joinError.classList.remove('hidden');
    els.joinError.style.animation = 'none';
    void els.joinError.offsetWidth;
    els.joinError.style.animation = '';
  }

  function setJoining(on) {
    joining = on;
    els.joinBtn.disabled = on;
    els.joinBtn.textContent = on ? 'جارٍ الدخول...' : 'دخول الجلسة';
  }

  function attemptJoin(name, token, silent) {
    if (joining) return;
    if (!silent) setJoining(true);
    socket.emit('player:join', { code, name, token }, (res) => {
      setJoining(false);
      if (res && res.ok) {
        const isNew = !joined;
        me = { playerId: res.playerId, token: res.token, name: res.name };
        saveMe();
        joined = true;
        els.joinScreen.classList.add('hidden');
        els.gameScreen.classList.remove('hidden');
        els.meName.textContent = res.name;
        updateSoundBtn();
        SJ.keepAwake(true);
        if (isNew) Sound.join();
        if (state) {
          lastStageKey = '';
          render();
        }
      } else {
        joined = false;
        els.gameScreen.classList.add('hidden');
        els.joinScreen.classList.remove('hidden');
        showJoinError(ERRORS[res && res.error] || 'تعذّر الدخول، حاول مرة أخرى.');
      }
    });
  }

  els.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.nameInput.value.replace(/\s+/g, ' ').trim();
    if (!name) {
      showJoinError(ERRORS.BAD_NAME);
      return;
    }
    els.joinError.classList.add('hidden');
    const saved = loadSaved();
    attemptJoin(name, saved && saved.token, false);
  });

  /* ------------------------------- الاتصال ------------------------------- */

  socket.on('connect', () => {
    els.connDot.classList.remove('off');
    if (joined && me) {
      attemptJoin(me.name, me.token, true);
    } else if (!joined) {
      const saved = loadSaved();
      if (saved) {
        els.nameInput.value = saved.name || '';
        attemptJoin(saved.name, saved.token, true);
      }
    }
  });

  socket.on('disconnect', () => {
    els.connDot.classList.add('off');
    if (joined) SJ.toast('انقطع الاتصال... جارٍ إعادة المحاولة');
  });

  socket.on('kicked', () => {
    joined = false;
    me = null;
    try {
      localStorage.removeItem(storageKey);
    } catch (err) {
      /* ignore */
    }
    els.gameScreen.classList.add('hidden');
    els.joinScreen.classList.remove('hidden');
    showJoinError('تم إخراجك من الجلسة بواسطة المشرف.');
  });

  socket.on('state', (s) => {
    state = s;
    render();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && joined) SJ.keepAwake(true);
  });

  /* ------------------------------- العرض ------------------------------- */

  function updateSoundBtn() {
    els.soundBtn.innerHTML = Sound.isMuted() ? ICON_SOUND_OFF : ICON_SOUND_ON;
  }

  els.soundBtn.addEventListener('click', () => {
    const muted = Sound.toggle();
    updateSoundBtn();
    SJ.toast(muted ? 'تم كتم الصوت' : 'تم تشغيل الصوت');
  });
  updateSoundBtn();

  function myState() {
    if (!state || !me) return null;
    return state.players.find((p) => p.id === me.playerId) || null;
  }

  function render() {
    const mine = myState();
    if (!state || !mine || !joined) return;

    els.meName.textContent = mine.name;
    els.meAvatar.textContent = SJ.avatarLetter(mine.name);
    els.meAvatar.style.setProperty('--c', SJ.colorFor(mine.slot));
    els.meScore.textContent = mine.score;

    handleTransitions(mine);
    syncWheel();

    const key = stageKey(mine);
    if (key !== lastStageKey) {
      lastStageKey = key;
      renderStage(mine);
    }
  }

  function handleTransitions(mine) {
    const resultSig = state.lastResult ? JSON.stringify(state.lastResult) : null;
    if (resultSig && resultSig !== prevResultSig && state.lastResult.playerId === mine.id) {
      if (state.lastResult.correct) {
        Sound.correct();
        SJ.vibrate(70);
      } else {
        Sound.wrong();
        SJ.vibrate([90, 50, 90]);
      }
    }
    prevResultSig = resultSig;

    if (
      state.phase === 'answering' &&
      prevAnswererId !== state.answererId &&
      state.answererId === mine.id
    ) {
      Sound.buzz();
      SJ.vibrate([130, 60, 130]);
    }
    prevAnswererId = state.answererId;
    prevPhase = state.phase;
  }

  function stageKey(mine) {
    if (state.phase === 'wheel') return `wheel-keep::${state.qIndex}`;
    return [
      state.phase,
      state.qIndex,
      state.totalQuestions,
      mine.locked,
      mine.score,
      state.answererId,
      state.answerMode,
      JSON.stringify(state.deltas),
      state.players.map((p) => `${p.id}${p.score}${p.connected ? 1 : 0}${p.locked ? 1 : 0}`).join(','),
    ].join('::');
  }

  function renderStage(mine) {
    switch (state.phase) {
      case 'lobby':
        els.stage.innerHTML = lobbyHTML();
        break;
      case 'question':
        els.stage.innerHTML = questionHTML(mine);
        if (!mine.locked) bindBuzz();
        break;
      case 'answering':
        els.stage.innerHTML =
          state.answererId === mine.id ? turnHTML(mine) : otherTurnHTML(mine);
        break;
      case 'reveal':
        els.stage.innerHTML = revealHTML(mine);
        break;
      case 'ended':
        els.stage.innerHTML = endedHTML(mine);
        break;
      case 'wheel':
        /* تبقى الشاشة كما هي خلف طبقة العجلة */
        break;
    }
  }

  /* ------------------------------ عناصر الواجهة ------------------------------ */

  function playersChipsHTML() {
    return `<div class="join-rows">${state.players
      .map(
        (p) => `<div class="join-row">
          <span class="avatar sm" style="--c:${SJ.colorFor(p.slot)}">${SJ.esc(SJ.avatarLetter(p.name))}</span>
          <span class="name">${SJ.esc(p.name)}</span>
          <span class="dot ${p.connected ? '' : 'off'}"></span>
        </div>`
      )
      .join('')}</div>`;
  }

  function leaderboardHTML(mineId, deltas) {
    return SJ.leaderboardHTML(state.players, { mineId, deltas });
  }

  function questionCardHTML() {
    return `<div class="card question-card">
      <div class="q-count">السؤال ${state.qIndex + 1} من ${state.totalQuestions}</div>
      <p class="q-text">${SJ.esc(state.question || '')}</p>
    </div>`;
  }

  function lobbyHTML() {
    return `
      <div class="card" style="text-align:center;padding:30px 20px">
        <div class="waiting-box">
          <span class="pulse-dot"></span><span class="pulse-dot d2"></span><span class="pulse-dot d3"></span>
        </div>
        <div style="font-size:23px;font-weight:900">انضممت بنجاح</div>
        <p class="muted" style="line-height:1.9;margin:6px 0 0">بانتظار أن يبدأ المشرف الجلسة...</p>
      </div>
      <div class="panel">
        <h3>اللاعبون <span>${state.players.length}/${state.maxPlayers}</span></h3>
        ${playersChipsHTML()}
      </div>
      <div class="hint-line">${ICON_MIC} جهّزوا مكالمة صوتية جماعية قبل البدء</div>`;
  }

  function questionHTML(mine) {
    if (mine.locked) {
      const d = state.deltas[mine.id] != null ? state.deltas[mine.id] : -10;
      return `
        <div class="card locked-card">
          <div class="xmark">×</div>
          <div class="t">أجبت خطأً</div>
          <div class="s">خسرت ${Math.abs(d)} نقاط — انتظر بقية اللاعبين</div>
        </div>
        ${questionCardHTML()}
        <div class="hint-line">${ICON_MIC} من يعرف الإجابة يضغط الآن</div>`;
    }
    return `
      ${questionCardHTML()}
      <div class="buzz-wrap">
        <button class="buzz-btn" id="buzzBtn">اضغط!<span class="buzz-sub">لتكون الأسرع</span></button>
      </div>
      <div class="hint-line">${ICON_MIC} من يضغط أولاً يجيب بصوت واضح</div>`;
  }

  function bindBuzz() {
    const btn = SJ.$('#buzzBtn', els.stage);
    if (!btn) return;
    btn.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        if (btn.classList.contains('pressed')) return;
        btn.classList.add('pressed');
        Sound.tap();
        SJ.vibrate(35);
        socket.emit('player:buzz', {}, (res) => {
          if (res && res.ok) return;
          if (res && res.error === 'TOO_LATE') SJ.toast('سبقك أحد اللاعبين!');
          else if (res && res.error === 'ALREADY_WRONG') SJ.toast('لا يمكنك الضغط مجدداً');
          const b = SJ.$('#buzzBtn', els.stage);
          if (b) b.classList.remove('pressed');
        });
      },
      { passive: false }
    );
  }

  function turnHTML(mine) {
    const pts = SJ.SCORE;
    const tier = SJ.buzzTierLabel(state, mine.id, state.answerMode);
    return `
      <div class="chip gold" style="align-self:center">${SJ.esc(tier)}</div>
      ${questionCardHTML()}
      <div class="card turn-card">
        <div class="turn-title">دورك!</div>
        <div class="turn-sub">
          أجب الآن بصوت واضح عبر المكالمة<br>
          صحيحة <b class="pts-pos">+${pts.correct}</b> · خاطئة <b class="pts-neg">${pts.wrong}</b>
        </div>
      </div>`;
  }

  function otherTurnHTML(mine) {
    const who = state.players.find((p) => p.id === state.answererId);
    const pts = SJ.SCORE;
    return `
      ${questionCardHTML()}
      <div class="card other-turn">
        <span class="avatar" style="--c:${SJ.colorFor(who ? who.slot : 0)}">${SJ.esc(SJ.avatarLetter(who ? who.name : ''))}</span>
        <div class="who" style="margin-top:10px">${SJ.esc(who ? who.name : '')} يجيب الآن...</div>
        <div class="wait">
          ${state.answerMode === 'wheel' ? 'اختارته عجلة الحظ' : 'ضغط أولاً'} —
          صحيحة <b class="pts-pos">+${pts.correct}</b> / خاطئة <b class="pts-neg">${pts.wrong}</b>
        </div>
        ${mine.locked ? '<div class="form-error" style="margin-top:14px">سبق أن أخطأت في هذا السؤال</div>' : ''}
      </div>`;
  }

  function revealHTML(mine) {
    const r = state.lastResult;
    let banner;
    if (r) {
      banner = r.correct
        ? `<div class="result-banner good"><span class="emo">✓</span><span>${SJ.esc(r.playerName)} أجاب صحيحاً <b>${SJ.fmtScore(r.points)}</b></span></div>`
        : `<div class="result-banner bad"><span class="emo">✕</span><span>${SJ.esc(r.playerName)} أجاب خطأً <b>${SJ.fmtScore(r.points)}</b></span></div>`;
    } else {
      banner = `<div class="card" style="text-align:center;padding:16px;font-weight:800;color:var(--muted)">انتهى السؤال دون إجابة</div>`;
    }
    return `
      ${banner}
      <div class="panel">
        <h3>لوحة النتائج</h3>
        ${leaderboardHTML(mine.id, state.deltas)}
      </div>
      <div class="center-box">بانتظار المشرف للانتقال للسؤال التالي</div>`;
  }

  function endedHTML(mine) {
    return `
      <div class="card">
        <h2 style="text-align:center;margin:0 0 4px;font-size:26px">النتائج النهائية</h2>
        ${SJ.podiumHTML(state.players)}
      </div>
      <div class="panel">
        <h3>ترتيب اللاعبين</h3>
        ${leaderboardHTML(mine.id, null)}
      </div>
      <div class="center-box">شكراً للعب!</div>`;
  }

  /* ------------------------------- عجلة الحظ ------------------------------- */

  function syncWheel() {
    const isWheel = state.phase === 'wheel' && state.wheel;
    if (isWheel && !wheelActive) {
      wheelActive = true;
      SJ.keepAwake(true);
      const candidates = state.players.filter((p) => p.connected && !p.locked);
      if (!candidates.length) {
        wheelActive = false;
        return;
      }
      els.wheelTitle.textContent = 'عجلة الحظ تدور...';
      els.wheelSub.textContent = 'سيتم اختيار لاعب عشوائياً للإجابة';
      els.wheelOverlay.classList.remove('leaving');
      els.wheelOverlay.classList.remove('hidden');
      Wheel.spin(
        els.wheelCanvas,
        candidates,
        state.wheel.winnerId,
        state.wheel.startedAt,
        state.wheel.endsAt
      );
    } else if (!isWheel && wheelActive) {
      wheelActive = false;
      Wheel.stop();
      const winner =
        state.phase === 'answering' && state.answerMode === 'wheel'
          ? state.players.find((p) => p.id === state.answererId)
          : null;
      if (winner) {
        els.wheelTitle.textContent = winner.name;
        els.wheelSub.textContent = 'أجب الآن!';
        Sound.win();
        if (me && winner.id === me.playerId) SJ.vibrate([140, 60, 140, 60, 140]);
        els.wheelOverlay.classList.add('leaving');
        setTimeout(() => {
          els.wheelOverlay.classList.add('hidden');
          els.wheelOverlay.classList.remove('leaving');
        }, 850);
      } else {
        els.wheelOverlay.classList.add('hidden');
        els.wheelOverlay.classList.remove('leaving');
      }
    }
  }

  /* ------------------------------- البدء ------------------------------- */

  const saved = loadSaved();
  if (saved && saved.name) els.nameInput.value = saved.name;
})();
