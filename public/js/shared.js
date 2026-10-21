'use strict';

/* ------------------------------ أدوات مشتركة ------------------------------ */

window.SJ = (() => {
  const PALETTE = ['#6d5dfc', '#39d2ff', '#2ecc71', '#ffc94d', '#ff6b6b', '#c86bff'];

  const $ = (sel, el = document) => el.querySelector(sel);

  function colorFor(slot) {
    const i = ((Number(slot) || 0) % PALETTE.length + PALETTE.length) % PALETTE.length;
    return PALETTE[i];
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function avatarLetter(name) {
    const clean = String(name || '').trim();
    return clean ? clean.charAt(0) : '؟';
  }

  function sortedPlayers(players) {
    return [...(players || [])].sort(
      (a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name), 'ar')
    );
  }

  const SCORE = { correct: 10, wrong: -10 };

  function buzzTierLabel(state, playerId, mode) {
    if (mode === 'wheel') return 'اختيار العجلة';
    const idx = (state.buzzOrder || []).indexOf(playerId);
    return idx === 0 ? 'أول ضغطة' : `ضغطة رقم ${idx + 1}`;
  }

  function toast(message, ms = 2200) {
    const host = document.getElementById('toast');
    if (!host) return;
    host.innerHTML = `<div class="inner">${esc(message)}</div>`;
    host.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => host.classList.add('hidden'), ms);
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (err) {
      /* ignore */
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext !== false) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (err) {
      /* ignore */
    }
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (!('wakeLock' in navigator)) return;
      if (on && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (err) {
      /* ignore */
    }
  }

  function fmtScore(n) {
    const v = Number(n) || 0;
    return v > 0 ? `+${v}` : String(v);
  }

  function leaderboardHTML(players, { mineId = null, deltas = null } = {}) {
    const sorted = sortedPlayers(players);
    const best = Math.max(0, ...sorted.map((p) => p.score), 1);
    return `<div class="lb">${sorted
      .map((p, i) => {
        const w = Math.max(0, Math.round((Math.max(p.score, 0) / best) * 100));
        const delta = deltas ? deltas[p.id] : null;
        const rankClass = i === 0 ? 'top-1' : i === 1 ? 'top-2' : i === 2 ? 'top-3' : '';
        return `<div class="lb-row ${rankClass} ${p.id === mineId ? 'me' : ''}">
          <i class="fill" style="--w:${w}%"></i>
          <span class="rank">${i + 1}</span>
          <span class="avatar sm" style="--c:${colorFor(p.slot)}">${esc(avatarLetter(p.name))}</span>
          <span class="pname">${esc(p.name)}${p.connected ? '' : ' <small class="muted">(غير متصل)</small>'}</span>
          ${delta ? `<span class="delta ${delta > 0 ? 'pos' : 'neg'}">${fmtScore(delta)}</span>` : ''}
          <span class="total">${p.score}</span>
        </div>`;
      })
      .join('')}</div>`;
  }

  function podiumHTML(players) {
    const top = sortedPlayers(players).slice(0, 3);
    if (!top.length) return '';
    const items = [1, 0, 2]
      .map((idx) => {
        const p = top[idx];
        if (!p) return '';
        const rank = idx + 1;
        return `<div class="spot spot-${rank}">
          <span class="avatar" style="--c:${colorFor(p.slot)}">${esc(avatarLetter(p.name))}</span>
          <div class="who-name">${esc(p.name)}</div>
          <div class="who-score">${p.score} نقطة</div>
          <div class="base">${rank}</div>
        </div>`;
      })
      .join('');
    return `<div class="podium">${items}</div>`;
  }

  return {
    PALETTE,
    $,
    colorFor,
    esc,
    avatarLetter,
    sortedPlayers,
    SCORE,
    buzzTierLabel,
    toast,
    vibrate,
    copyText,
    keepAwake,
    fmtScore,
    leaderboardHTML,
    podiumHTML,
  };
})();

/* ------------------------------ المؤثرات الصوتية ------------------------------ */

window.Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem('sj-muted') === '1';

  function ensure() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch (err) {
      return null;
    }
  }

  function tone(freq, dur = 0.12, type = 'sine', gain = 0.14, delay = 0) {
    if (muted) return;
    const audio = ensure();
    if (!audio) return;
    try {
      const t0 = audio.currentTime + delay;
      const osc = audio.createOscillator();
      const g = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(audio.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch (err) {
      /* ignore */
    }
  }

  document.addEventListener(
    'pointerdown',
    () => {
      ensure();
    },
    { once: true, capture: true }
  );

  return {
    isMuted: () => muted,
    toggle() {
      muted = !muted;
      localStorage.setItem('sj-muted', muted ? '1' : '0');
      if (!muted) tone(660, 0.1, 'sine', 0.12);
      return muted;
    },
    tap() {
      tone(520, 0.05, 'square', 0.07);
    },
    buzz() {
      tone(840, 0.09, 'square', 0.16);
      tone(1260, 0.12, 'square', 0.13, 0.07);
    },
    correct() {
      tone(620, 0.11, 'sine', 0.18);
      tone(830, 0.11, 'sine', 0.18, 0.1);
      tone(1180, 0.22, 'sine', 0.18, 0.2);
    },
    wrong() {
      tone(220, 0.22, 'sawtooth', 0.14);
      tone(150, 0.32, 'sawtooth', 0.14, 0.16);
    },
    tick() {
      tone(1050, 0.03, 'square', 0.045);
    },
    spin() {
      tone(300, 0.3, 'sine', 0.08);
    },
    win() {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'sine', 0.16, i * 0.13));
    },
    join() {
      tone(660, 0.09, 'sine', 0.12);
      tone(990, 0.14, 'sine', 0.12, 0.08);
    },
  };
})();
