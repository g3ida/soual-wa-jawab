'use strict';

/* ------------------------------ عجلة الحظ ------------------------------ */

window.Wheel = (() => {
  let raf = null;

  function truncate(name, max) {
    const clean = String(name || '').trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  }

  function draw(canvas, players, rotation) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const size = canvas.clientWidth || 300;
    const px = Math.round(size * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const cx = px / 2;
    const cy = px / 2;
    const r = px / 2 - 4 * dpr;
    const n = Math.max(players.length, 1);
    const seg = (Math.PI * 2) / n;

    ctx.clearRect(0, 0, px, px);
    ctx.direction = 'rtl';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < n; i++) {
      const start = i * seg - Math.PI / 2 + rotation;
      const end = start + seg;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, end);
      ctx.closePath();
      ctx.fillStyle = SJ.colorFor(players[i].slot);
      ctx.fill();
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(10, 14, 26, 0.5)';
      ctx.stroke();
    }

    const fs = Math.max(13 * dpr, px * 0.042);
    ctx.font = `800 ${fs}px Cairo, Tahoma, sans-serif`;
    ctx.fillStyle = '#0b1020';
    for (let i = 0; i < n; i++) {
      const mid = i * seg - Math.PI / 2 + seg / 2 + rotation;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(mid);
      ctx.textAlign = 'center';
      let ax = r * 0.64;
      if (Math.cos(mid) < 0) {
        ctx.rotate(Math.PI);
        ax = -r * 0.64;
      }
      ctx.fillText(truncate(players[i].name, 10), ax, 0);
      ctx.restore();
    }

    const hub = px * 0.115;
    ctx.beginPath();
    ctx.arc(cx, cy, hub, 0, Math.PI * 2);
    ctx.fillStyle = '#121936';
    ctx.fill();
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 ${hub * 0.95}px Cairo, Tahoma, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('؟', cx, cy + hub * 0.06);
  }

  function targetRotation(n, winnerIndex) {
    const seg = (Math.PI * 2) / Math.max(n, 1);
    const spins = 4;
    let target = spins * Math.PI * 2 - (winnerIndex * seg + seg / 2);
    while (target < 2 * Math.PI) target += Math.PI * 2;
    return target;
  }

  /**
   * يشغّل حركة الدوران لمدة محددة مسبقاً (متزامنة مع الجميع).
   * players: [{id, name, slot}]
   */
  function spin(canvas, players, winnerId, startedAt, endsAt, onDone) {
    stop();
    if (!canvas || !players || !players.length) return;
    const n = players.length;
    const winnerIndex = Math.max(
      0,
      players.findIndex((p) => p.id === winnerId)
    );
    const seg = (Math.PI * 2) / n;
    const target = targetRotation(n, winnerIndex);
    const duration = Math.max(600, endsAt - startedAt);
    let lastSeg = -1;

    function frame() {
      const p = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const rotation = target * eased;
      draw(canvas, players, rotation);
      const segIndex = Math.floor(rotation / seg);
      if (segIndex !== lastSeg) {
        if (lastSeg !== -1) Sound.tick();
        lastSeg = segIndex;
      }
      if (p < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = null;
        if (typeof onDone === 'function') onDone();
      }
    }
    Sound.spin();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  return { spin, stop, draw };
})();
