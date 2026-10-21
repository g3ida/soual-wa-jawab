'use strict';

(() => {
  const parts = location.pathname.split('/').filter(Boolean);
  const code = (parts[1] || '').toUpperCase();
  const tokenKey = `sj-host-${code}`;
  const lanKey = `sj-lan-${code}`;
  const socket = io();

  let state = null;
  let hostToken = '';
  let lanUrl = '';
  let lastStageKey = '';
  let lastSidebarKey = '';
  let wheelActive = false;
  let prevResultSig = null;
  let prevAnswererId = null;
  let endArmed = false;
  let endTimer = null;
  let preservedLobbyInput = '';

  const els = {
    roomCode: SJ.$('#roomCode'),
    connDot: SJ.$('#connDot'),
    soundBtn: SJ.$('#soundBtn'),
    endBtn: SJ.$('#endBtn'),
    stage: SJ.$('#stage'),
    sidebar: SJ.$('#sidebar'),
    gateScreen: SJ.$('#gateScreen'),
    wheelOverlay: SJ.$('#wheelOverlay'),
    wheelTitle: SJ.$('#wheelTitle'),
    wheelSub: SJ.$('#wheelSub'),
    wheelCanvas: SJ.$('#wheelCanvas'),
  };

  const ICON_MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>`;
  const ICON_WHEEL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M12 3v6M4.2 16.5l5.2-3M19.8 16.5l-5.2-3"/></svg>`;
  const ICON_SOUND_ON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>`;
  const ICON_SOUND_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;

  /* ------------------------------- الاتصال ------------------------------- */

  if (!/^[A-Z0-9]{4}$/.test(code)) {
    location.href = '/';
    return;
  }

  try {
    hostToken = localStorage.getItem(tokenKey) || '';
    lanUrl = localStorage.getItem(lanKey) || '';
  } catch (err) {
    /* ignore */
  }

  els.roomCode.textContent = code;
  updateSoundBtn();

  socket.on('connect', () => {
    els.connDot.classList.remove('off');
    if (hostToken) joinAsHost();
  });

  socket.on('disconnect', () => {
    els.connDot.classList.add('off');
    SJ.toast('انقطع الاتصال... جارٍ إعادة المحاولة');
  });

  function joinAsHost() {
    socket.emit('host:join', { code, hostToken }, (res) => {
      if (!res || !res.ok) {
        els.gateScreen.classList.remove('hidden');
        return;
      }
      els.gateScreen.classList.add('hidden');
      if (res.lanUrls && res.lanUrls.length) {
        lanUrl = res.lanUrls[0];
        try {
          localStorage.setItem(lanKey, lanUrl);
        } catch (err) {
          /* ignore */
        }
      }
    });
  }

  if (!hostToken) {
    els.gateScreen.classList.remove('hidden');
  } else if (socket.connected) {
    joinAsHost();
  }

  socket.on('hostState', (s) => {
    state = s;
    render();
  });

  /* ------------------------------- الإجراءات ------------------------------- */

  function act(event, payload, errorMap) {
    socket.emit(event, payload || {}, (res) => {
      if (res && res.ok) return;
      const msg = (errorMap && errorMap[res && res.error]) || 'تعذّر تنفيذ الإجراء';
      SJ.toast(msg);
    });
  }

  els.soundBtn.addEventListener('click', () => {
    const muted = Sound.toggle();
    updateSoundBtn();
    SJ.toast(muted ? 'تم كتم الصوت' : 'تم تشغيل الصوت');
  });

  function updateSoundBtn() {
    els.soundBtn.innerHTML = Sound.isMuted() ? ICON_SOUND_OFF : ICON_SOUND_ON;
  }

  els.endBtn.addEventListener('click', () => {
    if (!state || state.phase === 'lobby' || state.phase === 'ended') return;
    if (!endArmed) {
      endArmed = true;
      els.endBtn.textContent = 'تأكيد الإنهاء؟';
      els.endBtn.classList.remove('btn-ghost');
      els.endBtn.classList.add('btn-red');
      clearTimeout(endTimer);
      endTimer = setTimeout(resetEndBtn, 3200);
      return;
    }
    resetEndBtn();
    act('host:end');
  });

  function resetEndBtn() {
    endArmed = false;
    clearTimeout(endTimer);
    els.endBtn.textContent = 'إنهاء';
    els.endBtn.classList.add('btn-ghost');
    els.endBtn.classList.remove('btn-red');
  }

  function shareUrl() {
    const host = location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    const base = isLocal && lanUrl ? lanUrl : location.origin;
    return `${String(base).replace(/\/+$/, '')}/${code}`;
  }

  /* ------------------------------- العرض ------------------------------- */

  function render() {
    if (!state) return;
    document.body.dataset.phase = state.phase;
    els.endBtn.classList.toggle('hidden', state.phase === 'lobby' || state.phase === 'ended');

    handleTransitions();

    const key = stageKey();
    if (key !== lastStageKey) {
      lastStageKey = key;
      renderStage();
    }
    renderSidebar();
    syncWheel();
  }

  function handleTransitions() {
    const sig = state.lastResult ? JSON.stringify(state.lastResult) : null;
    if (sig && sig !== prevResultSig) {
      if (state.lastResult.correct) Sound.correct();
      else Sound.wrong();
    }
    prevResultSig = sig;

    if (state.phase === 'answering' && prevAnswererId !== state.answererId && state.answererId) {
      Sound.buzz();
    }
    prevAnswererId = state.answererId;
  }

  function playersSig() {
    return state.players.map((p) => `${p.id}${p.score}${p.connected ? 1 : 0}${p.locked ? 1 : 0}`).join(',');
  }

  function stageKey() {
    if (state.phase === 'wheel') return `wheel-keep::${state.qIndex}`;
    return [
      state.phase,
      state.qIndex,
      state.totalQuestions,
      state.answererId,
      state.answerMode,
      JSON.stringify(state.deltas),
      JSON.stringify(state.questions || []),
      state.lastResult ? JSON.stringify(state.lastResult) : '',
      playersSig(),
    ].join('::');
  }

  function renderStage() {
    const prevLobby = SJ.$('#qInput', els.stage);
    if (prevLobby) preservedLobbyInput = prevLobby.value;

    switch (state.phase) {
      case 'lobby':
        els.stage.innerHTML = lobbyHTML();
        bindLobby();
        break;
      case 'question':
        els.stage.innerHTML = questionPhaseHTML();
        bindQuestion();
        break;
      case 'answering':
        els.stage.innerHTML = answeringPhaseHTML();
        bindAnswering();
        break;
      case 'reveal':
        els.stage.innerHTML = revealPhaseHTML();
        bindReveal();
        break;
      case 'ended':
        els.stage.innerHTML = endedPhaseHTML();
        bindEnded();
        break;
      case 'wheel':
        break;
    }
  }

  /* ------------------------------ مراحل اللعبة ------------------------------ */

  function questionCardHTML() {
    if (state.qIndex < 0 || !state.question) return '';
    return `<div class="card question-card">
      <div class="q-count">السؤال ${state.qIndex + 1} من ${state.totalQuestions}</div>
      <p class="q-text">${SJ.esc(state.question)}</p>
    </div>`;
  }

  function lobbyPlayersHTML() {
    if (!state.players.length) {
      return `<div class="empty-hint">بانتظار انضمام اللاعبين...<br>شارك الرابط أو رمز QR</div>`;
    }
    return `<div class="join-rows">${state.players
      .map(
        (p) => `<div class="join-row">
          <span class="avatar sm" style="--c:${SJ.colorFor(p.slot)}">${SJ.esc(SJ.avatarLetter(p.name))}</span>
          <span class="name">${SJ.esc(p.name)}</span>
          <span class="dot ${p.connected ? '' : 'off'}"></span>
          <button class="kick" data-kick="${p.id}" type="button">إزالة</button>
        </div>`
      )
      .join('')}</div>`;
  }

  function questionsListHTML(removable) {
    const rows = (state.questions || [])
      .map(
        (q, i) => `<div class="q-item ${i === state.qIndex ? 'current' : ''}">
          <span class="num">${i + 1}</span>
          <span class="txt">${SJ.esc(q)}</span>
          ${removable ? `<button class="x" data-qremove="${i}" type="button">✕</button>` : ''}
        </div>`
      )
      .join('');
    return rows || `<div class="empty-hint">لا توجد أسئلة بعد — أضف أسئلتك قبل بدء اللعبة</div>`;
  }

  function lobbyHTML() {
    const canStart = state.players.length >= 1 && state.questions.length >= 1;
    let hint = 'أضف لاعباً واحداً وسؤالاً واحداً على الأقل';
    if (canStart) {
      hint = `جاهز للبدء: ${state.players.length} لاعبين · ${state.questions.length} أسئلة`;
    }
    return `
    <div class="setup-grid">
      <div class="panel">
        <h3>دعوة اللاعبين</h3>
        <div class="link-box">
          <input id="linkInput" readonly value="${SJ.esc(shareUrl())}">
          <button class="btn btn-ghost" id="copyBtn" type="button">نسخ</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="qrBtn" type="button" style="margin-top:10px">عرض رمز QR</button>
        <div class="qr-wrap hidden" id="qrWrap">
          <img id="qrImg" alt="رمز QR للانضمام للجلسة">
          <div class="muted" style="font-size:13px">يمسحه كل لاعب من جواله للانضمام مباشرة</div>
        </div>
        <div class="hint-line" style="margin-top:12px">${ICON_MIC} اطلب من اللاعبين تجهيز مكالمة صوتية</div>
      </div>

      <div class="panel">
        <h3>اللاعبون <span>${state.players.length}/${state.maxPlayers}</span></h3>
        ${lobbyPlayersHTML()}
      </div>

      <div class="panel span-2">
        <h3>الأسئلة <span>${state.questions.length}</span></h3>
        <div class="q-input-wrap">
          <textarea class="input" id="qInput" rows="3" placeholder="اكتب السؤال هنا واضغط إضافة — يمكنك لصق عدة أسئلة، كل سطر يعتبر سؤالاً مستقلاً"></textarea>
          <button class="btn btn-primary" id="addQBtn" type="button">إضافة الأسئلة</button>
        </div>
        <div class="q-list" id="qList">${questionsListHTML(true)}</div>
      </div>

      <div class="card span-2" style="text-align:center">
        <button class="btn btn-gold btn-lg btn-block" id="startBtn" type="button" ${canStart ? '' : 'disabled'}>ابدأ اللعبة</button>
        <div class="muted" style="margin-top:10px;font-size:14px">${hint}</div>
      </div>
    </div>`;
  }

  function bindLobby() {
    const input = SJ.$('#qInput', els.stage);
    if (input && preservedLobbyInput) input.value = preservedLobbyInput;

    SJ.$('#copyBtn', els.stage).addEventListener('click', (e) => {
      SJ.copyText(shareUrl()).then(() => {
        e.target.textContent = 'تم النسخ';
        setTimeout(() => {
          if (e.target) e.target.textContent = 'نسخ';
        }, 1800);
      });
    });

    SJ.$('#qrBtn', els.stage).addEventListener('click', () => {
      const wrap = SJ.$('#qrWrap', els.stage);
      if (wrap.classList.contains('hidden')) {
        const img = SJ.$('#qrImg', els.stage);
        if (!img.src) img.src = `/api/qr?url=${encodeURIComponent(shareUrl())}`;
        wrap.classList.remove('hidden');
      } else {
        wrap.classList.add('hidden');
      }
    });

    SJ.$('#addQBtn', els.stage).addEventListener('click', () => {
      const el = SJ.$('#qInput', els.stage);
      const texts = el.value
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean);
      if (!texts.length) {
        SJ.toast('اكتب سؤالاً واحداً على الأقل');
        return;
      }
      act('host:addQuestions', { texts });
      el.value = '';
      preservedLobbyInput = '';
    });

    SJ.$('#startBtn', els.stage).addEventListener('click', () => {
      act('host:start', {}, {
        NO_PLAYERS: 'أضف لاعباً واحداً على الأقل',
        NO_QUESTIONS: 'أضف سؤالاً واحداً على الأقل قبل البدء',
      });
    });

    els.stage.querySelectorAll('[data-qremove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        act('host:removeQuestion', { index: Number(btn.dataset.qremove) }, {
          LOCKED: 'لا يمكن حذف الأسئلة أثناء اللعبة',
        });
      });
    });

    els.stage.querySelectorAll('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', () => act('host:kick', { playerId: btn.dataset.kick }));
    });
  }

  function buzzFeedHTML() {
    return state.buzzOrder
      .map((id) => {
        const p = state.players.find((x) => x.id === id);
        if (!p) return '';
        const delta = state.deltas[id];
        const what =
          delta != null
            ? `<span class="what" style="color:var(--red)">أخطأ <span style="direction:ltr;display:inline-block">${SJ.fmtScore(delta)}</span></span>`
            : `<span class="what" style="color:var(--gold)">ضغط${id === state.answererId ? ' — يجيب الآن' : ''}</span>`;
        return `<div class="feed-item">
          <span class="avatar sm" style="--c:${SJ.colorFor(p.slot)}">${SJ.esc(SJ.avatarLetter(p.name))}</span>
          <span>${SJ.esc(p.name)}</span>
          ${what}
        </div>`;
      })
      .join('');
  }

  function questionPhaseHTML() {
    const feed = buzzFeedHTML();
    const candidates = state.players.filter((p) => p.connected && !p.locked);
    const allLocked = !candidates.length;
    return `
      ${questionCardHTML()}
      <div class="card">
        ${feed ? `<h3 class="muted" style="margin:0 0 10px;font-size:14px">سجل الضغطات</h3>${feed}` : ''}
        <div class="waiting-box">
          ${allLocked
            ? '<span>أخطأ جميع اللاعبين — اعرض النتيجة وانتقل للسؤال التالي</span>'
            : '<span class="pulse-dot"></span><span class="pulse-dot d2"></span><span class="pulse-dot d3"></span><span style="margin-inline-start:6px">الأسرع يضغط زر الإجابة على جواله...</span>'}
        </div>
      </div>
      <div class="action-row">
        <button class="btn btn-gold btn-lg" id="wheelBtn" type="button" ${allLocked ? 'disabled' : ''}>${ICON_WHEEL} عجلة الحظ</button>
        <button class="btn btn-ghost btn-lg" id="skipBtn" type="button">لا أحد يعرف — عرض النتيجة</button>
      </div>`;
  }

  function bindQuestion() {
    SJ.$('#wheelBtn', els.stage).addEventListener('click', () => {
      act('host:wheel', {}, {
        NO_CANDIDATES: 'لا يوجد لاعبون متاحون للاختيار',
        BAD_PHASE: 'انتظر قليلاً...',
      });
    });
    SJ.$('#skipBtn', els.stage).addEventListener('click', () => act('host:skip'));
  }

  function answeringPhaseHTML() {
    const p = state.players.find((x) => x.id === state.answererId);
    if (!p) return questionPhaseHTML();
    const pts = SJ.SCORE;
    const tier = SJ.buzzTierLabel(state, p.id, state.answerMode);
    return `
      ${questionCardHTML()}
      <div class="card answerer-card">
        <div class="who">
          <span class="avatar" style="--c:${SJ.colorFor(p.slot)}">${SJ.esc(SJ.avatarLetter(p.name))}</span>
          <span>${SJ.esc(p.name)} يجيب الآن...</span>
        </div>
        <div class="hint">${SJ.esc(tier)} · استمع للإجابة الصوتية عبر المكالمة ثم حدّد النتيجة</div>
        <div class="pts-chip">
          <span>صحيحة <b class="pts-pos">+${pts.correct}</b></span>
          <span>خاطئة <b class="pts-neg">${pts.wrong}</b></span>
        </div>
      </div>
      <div class="action-row">
        <button class="btn btn-green btn-lg" id="correctBtn" type="button">إجابة صحيحة <span class="pts">+${pts.correct}</span></button>
        <button class="btn btn-red btn-lg" id="wrongBtn" type="button">إجابة خاطئة <span class="pts">${pts.wrong}</span></button>
      </div>`;
  }

  function bindAnswering() {
    const correctBtn = SJ.$('#correctBtn', els.stage);
    const wrongBtn = SJ.$('#wrongBtn', els.stage);
    if (!correctBtn || !wrongBtn) return;
    correctBtn.addEventListener('click', () => act('host:evaluate', { correct: true }));
    wrongBtn.addEventListener('click', () => act('host:evaluate', { correct: false }));
  }

  function revealPhaseHTML() {
    const r = state.lastResult;
    let banner;
    if (r) {
      banner = r.correct
        ? `<div class="result-banner good"><span class="emo">✓</span><span>${SJ.esc(r.playerName)} أجاب صحيحاً <b style="direction:ltr;display:inline-block">${SJ.fmtScore(r.points)}</b></span></div>`
        : `<div class="result-banner bad"><span class="emo">✕</span><span>${SJ.esc(r.playerName)} أجاب خطأً <b style="direction:ltr;display:inline-block">${SJ.fmtScore(r.points)}</b></span></div>`;
    } else {
      banner = `<div class="card" style="text-align:center;padding:16px;font-weight:800;color:var(--muted)">انتهى السؤال دون إجابة — لا نقاط لأحد</div>`;
    }
    const isLast = state.qIndex + 1 >= state.totalQuestions;
    return `
      ${banner}
      ${questionCardHTML()}
      <div class="panel">
        <h3>لوحة النتائج</h3>
        ${SJ.leaderboardHTML(state.players, { deltas: state.deltas })}
      </div>
      <div class="action-row single">
        <button class="btn btn-primary btn-lg" id="nextBtn" type="button">
          ${isLast ? 'عرض النتائج النهائية' : 'السؤال التالي'}
        </button>
      </div>`;
  }

  function bindReveal() {
    SJ.$('#nextBtn', els.stage).addEventListener('click', () => act('host:next'));
  }

  function endedPhaseHTML() {
    return `
      <div class="card">
        <h2 style="text-align:center;margin:0 0 4px;font-size:28px">النتائج النهائية</h2>
        ${SJ.podiumHTML(state.players)}
      </div>
      <div class="panel">
        <h3>ترتيب اللاعبين</h3>
        ${SJ.leaderboardHTML(state.players, {})}
      </div>
      <div class="action-row">
        <button class="btn btn-gold btn-lg" id="restartBtn" type="button">العب مرة أخرى</button>
        <button class="btn btn-ghost btn-lg" id="newSessionBtn" type="button">جلسة جديدة</button>
      </div>`;
  }

  function bindEnded() {
    SJ.$('#restartBtn', els.stage).addEventListener('click', () => act('host:restart'));
    SJ.$('#newSessionBtn', els.stage).addEventListener('click', () => {
      location.href = '/';
    });
  }

  /* ------------------------------- الشريط الجانبي ------------------------------- */

  function sidebarKey() {
    return [
      state.phase,
      state.qIndex,
      state.answererId,
      JSON.stringify(state.deltas),
      JSON.stringify(state.questions || []),
      playersSig(),
    ].join('::');
  }

  function renderSidebar() {
    if (state.phase === 'lobby' || state.phase === 'ended') {
      els.sidebar.innerHTML = '';
      lastSidebarKey = '';
      return;
    }
    const key = sidebarKey();
    if (key === lastSidebarKey) return;
    lastSidebarKey = key;

    const prevQuick = SJ.$('#quickQ', els.sidebar);
    const quickValue = prevQuick ? prevQuick.value : '';

    els.sidebar.innerHTML = `
      <div class="panel">
        <h3>المتصدرون</h3>
        ${SJ.leaderboardHTML(state.players, { deltas: state.phase === 'reveal' ? state.deltas : null })}
      </div>
      <div class="panel">
        <h3>الأسئلة <span>${state.qIndex + 1}/${state.totalQuestions}</span></h3>
        <div class="q-list">${questionsListHTML(false)}</div>
        <div class="link-box" style="margin-top:10px">
          <input class="input" id="quickQ" placeholder="إضافة سؤال جديد..." maxlength="300">
          <button class="btn btn-ghost btn-sm" id="quickAddBtn" type="button">إضافة</button>
        </div>
      </div>`;

    const quick = SJ.$('#quickQ', els.sidebar);
    if (quick) quick.value = quickValue;

    const add = () => {
      const el = SJ.$('#quickQ', els.sidebar);
      const text = el.value.trim();
      if (!text) return;
      act('host:addQuestions', { texts: [text] });
      el.value = '';
      SJ.toast('تمت إضافة السؤال');
    };
    SJ.$('#quickAddBtn', els.sidebar).addEventListener('click', add);
    if (quick) {
      quick.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add();
        }
      });
    }
  }

  /* ------------------------------- عجلة الحظ ------------------------------- */

  function syncWheel() {
    const isWheel = state.phase === 'wheel' && state.wheel;
    if (isWheel && !wheelActive) {
      wheelActive = true;
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
})();
