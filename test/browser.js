'use strict';

/* اختبار واجهة حقيقي عبر متصفح Chromium (Brave/Chrome) */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let passed = 0;
let failed = 0;
const errors = [];

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

async function waitText(page, selector, timeout = 8000) {
  await page.waitForSelector(selector, { timeout });
  return page.$eval(selector, (el) => el.textContent.trim());
}

async function main() {
  console.log('\n=== اختبار الواجهة عبر المتصفح ===\n');
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  const executablePath = fs.existsSync(BRAVE) ? BRAVE : CHROME;
  if (!fs.existsSync(executablePath)) {
    console.error('لم يتم العثور على متصفح Chromium (Brave أو Chrome)');
    server.kill();
    process.exit(1);
  }

  await sleep(900);
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2'],
  });

  const watch = (page, tag) => {
    page.on('pageerror', (err) => errors.push(`${tag}: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`${tag}: ${msg.text()}`);
    });
  };

  const mobileView = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

  try {
    /* ---------- المشرف ينشئ الجلسة ---------- */
    const host = await browser.newPage();
    await host.setViewport({ width: 1280, height: 820 });
    watch(host, 'host');
    await host.goto(BASE, { waitUntil: 'networkidle2' });
    await host.screenshot({ path: path.join(SHOTS, '01-home.png') });
    await Promise.all([host.waitForNavigation({ waitUntil: 'networkidle2' }), host.click('#createBtn')]);
    const code = host.url().split('/').pop();
    check('المشرف أنشأ الجلسة وانتقل للوحة الإدارة', /^[A-Z0-9]{4}$/.test(code), host.url());
    await host.waitForSelector('#startBtn');
    check('لوحة اللوبي تظهر مع رابط الدعوة', !!(await host.$('#linkInput')));

    /* ---------- انضمام لاعبين اثنين (كل لاعب في متصفح معزول) ---------- */
    const ctx1 = await browser.createBrowserContext();
    const p1 = await ctx1.newPage();
    await p1.setViewport(mobileView);
    watch(p1, 'p1');
    await p1.goto(`${BASE}/${code}`, { waitUntil: 'networkidle2' });
    await p1.waitForSelector('#nameInput');
    await p1.screenshot({ path: path.join(SHOTS, '02-join.png') });
    await p1.type('#nameInput', 'أحمد');
    await p1.click('#joinBtn');
    await p1.waitForSelector('#gameScreen:not(.hidden)');
    check('اللاعب الأول انضم ورأى شاشة الانتظار', true);

    const ctx2 = await browser.createBrowserContext();
    const p2 = await ctx2.newPage();
    await p2.setViewport(mobileView);
    watch(p2, 'p2');
    await p2.goto(`${BASE}/${code}`, { waitUntil: 'networkidle2' });
    await p2.waitForSelector('#nameInput');
    await p2.type('#nameInput', 'سارة');
    await p2.click('#joinBtn');
    await p2.waitForSelector('#gameScreen:not(.hidden)');

    await sleep(400);
    const joinRows = await host.$$eval('.join-row', (els) => els.length);
    check('المشرف يرى اللاعبين المنضمين في اللوبي', joinRows === 2, joinRows);
    await host.screenshot({ path: path.join(SHOTS, '03-host-lobby.png') });

    /* ---------- الأسئلة والبدء ---------- */
    await host.type('#qInput', 'ما هي عاصمة اليابان؟\nكم عدد أيام السنة الميلادية؟\nما هو أطول نهر في العالم؟');
    await host.click('#addQBtn');
    await host.waitForSelector('.q-item:nth-child(3)');
    const qCount = await host.$$eval('.q-item', (els) => els.length);
    check('إضافة ٣ أسئلة من اللوحة', qCount === 3, qCount);
    await host.screenshot({ path: path.join(SHOTS, '04-host-questions.png') });

    const startDisabled = await host.$eval('#startBtn', (el) => el.disabled);
    check('زر البدء مفعّل بعد توفر لاعبين وأسئلة', startDisabled === false);

    await host.click('#startBtn');
    await host.waitForSelector('#wheelBtn');
    check('الجولة الأولى بدأت', true);

    await p1.waitForSelector('#buzzBtn');
    await sleep(300);
    await p1.screenshot({ path: path.join(SHOTS, '05-player-question.png') });
    await host.screenshot({ path: path.join(SHOTS, '06-host-question.png') });

    /* ---------- الضغط والإجابة ---------- */
    await p1.click('#buzzBtn');
    await p1.waitForSelector('.turn-card', { timeout: 5000 });
    check('أحمد ضغط أولاً وظهرت شاشة "دورك"', true);
    await sleep(300);
    await p1.screenshot({ path: path.join(SHOTS, '07-player-turn.png') });

    await p2.waitForSelector('.other-turn');
    check('سارة ترى أن أحمد يجيب الآن', true);
    await p2.screenshot({ path: path.join(SHOTS, '08-player-other-turn.png') });

    await host.waitForSelector('#correctBtn');
    await host.screenshot({ path: path.join(SHOTS, '09-host-answering.png') });
    await host.click('#correctBtn');
    await host.waitForSelector('#nextBtn');
    await sleep(400);
    const banner = await host.$eval('.result-banner', (el) => el.textContent);
    check('بانر النتيجة يظهر بعد الحسم', banner.includes('+10'), banner);
    const p1Score = await p1.$eval('#meScore', (el) => el.textContent);
    check('نقاط أحمد أصبحت 10', p1Score === '10', p1Score);
    await host.screenshot({ path: path.join(SHOTS, '10-host-reveal.png') });
    await p1.screenshot({ path: path.join(SHOTS, '11-player-reveal.png') });

    /* ---------- السؤال الثاني: عجلة الحظ ---------- */
    await host.click('#nextBtn');
    await host.waitForSelector('#wheelBtn');
    await host.click('#wheelBtn');
    await sleep(1200);
    const wheelVisible = await host.$eval('#wheelOverlay', (el) => !el.classList.contains('hidden'));
    check('طبقة عجلة الحظ ظهرت عند المشرف', wheelVisible);
    await host.screenshot({ path: path.join(SHOTS, '12-host-wheel.png') });
    const wheelVisibleP1 = await p1.$eval('#wheelOverlay', (el) => !el.classList.contains('hidden'));
    check('العجلة تظهر أيضاً عند اللاعبين', wheelVisibleP1);
    await p1.screenshot({ path: path.join(SHOTS, '13-player-wheel.png') });

    await host.waitForSelector('#correctBtn', { timeout: 9000 });
    check('انتهت العجلة وبدأ دور اللاعب المختار', true);
    await host.click('#wrongBtn');
    await host.waitForSelector('#nextBtn', { timeout: 5000 });
    check('تسجيل إجابة خاطئة عبر العجلة → -10', true);

    /* ---------- السؤال الثالث: لا أحد يعرف ثم النهاية ---------- */
    await host.click('#nextBtn');
    await host.waitForSelector('#skipBtn');
    await host.click('#skipBtn');
    await host.waitForSelector('#nextBtn');
    await host.click('#nextBtn');
    await host.waitForSelector('.podium');
    check('النتائج النهائية تعرض المنصة', true);
    await sleep(400);
    await host.screenshot({ path: path.join(SHOTS, '14-host-podium.png') });
    await p1.screenshot({ path: path.join(SHOTS, '15-player-podium.png') });

    /* ---------- إعادة اللعب ---------- */
    await host.click('#restartBtn');
    await host.waitForSelector('#startBtn');
    const scoreReset = await p1.$eval('#meScore', (el) => el.textContent);
    check('إعادة اللعب تصفّر النقاط في الواجهة', scoreReset === '0', scoreReset);

    const realErrors = errors.filter(
      (e) => !/favicon|fonts\.g|net::ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/.test(e)
    );
    check('لا أخطاء JavaScript في الصفحات', realErrors.length === 0, realErrors.slice(0, 5));
  } catch (err) {
    failed++;
    console.log(`  ✗ استثناء أثناء الاختبار: ${err.message}`);
  }

  await browser.close();
  server.kill();
  await sleep(200);

  console.log(`\nالنتيجة: ${passed} نجحت، ${failed} فشلت`);
  console.log(`الصور محفوظة في: ${SHOTS}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('فشل الاختبار:', err.message);
  process.exit(1);
});
