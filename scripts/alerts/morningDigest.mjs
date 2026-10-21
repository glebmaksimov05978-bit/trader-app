// scripts/alerts/morningDigest.mjs
//
// Утренняя сводка в Telegram: что в рынке, что близко к входу, общий риск, итог вчерашнего дня.
// Шлётся один раз в сутки — при первом проходе робота после выбранного часа (по Москве, по
// умолчанию 8:00) и не позже полудня: сводка в семь вечера уже не «утренняя».
//
// Только чтение базы + одно сообщение; отметка «сегодня уже слали» хранится в профиле
// (users/<uid>.digestSentOn), поэтому повторные проходы и три будильника сообщение не дублируют.
// Выключается в Настройках (alertPrefs.morningDigest = false).
//
// Флаги: --dry — только показать текст, ничего не отправлять и не записывать;
//        --force — игнорировать час и «уже слали» (для проверки).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-digest-'));
function esmify(src) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
const { formatMorningDigest } = await import(esmify(path.join(repoRoot, 'src/services/alerts.js')));
const { buildOpenRisk } = await import(esmify(path.join(repoRoot, 'src/services/analytics/openRisk.js')));
const { summarizeDecisions } = await import(esmify(path.join(repoRoot, 'src/services/analytics/actionMatch.js')));
const { captionOf } = await import(esmify(path.join(repoRoot, 'src/services/analytics/strategyMeta.js')));

const MSK_MS = 3 * 3600 * 1000; // Москва без перехода на летнее время

/** Московские дата (YYYY-MM-DD) и час для момента nowMs. */
export function moscowParts(nowMs) {
  const d = new Date(nowMs + MSK_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hour: d.getUTCHours(), dow: d.getUTCDay() };
}

const toMs = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (v.toDate) return v.toDate().getTime();
  if (v.seconds != null) return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/** Слать ли сейчас: включено, наступил час, ещё не полдень, сегодня ещё не слали. */
export function shouldSendDigest({ prefs = {}, digestSentOn = null, nowMs, force = false }) {
  if (prefs.morningDigest === false) return { send: false, reason: 'выключена в Настройках' };
  if (force) return { send: true };
  const { date, hour } = moscowParts(nowMs);
  const from = Number.isFinite(Number(prefs.digestHour)) ? Number(prefs.digestHour) : 8;
  if (hour < from) return { send: false, reason: `ещё рано (${hour}:00 МСК, нужно с ${from}:00)` };
  if (hour >= 14) return { send: false, reason: 'утро прошло' };
  if (digestSentOn === date) return { send: false, reason: 'сегодня уже отправлена' };
  return { send: true };
}

/** Из текста проверки радара («… лонг 5/6 (83%), шорт 2/6 (33%), нужно 100%») достать лучший счёт. */
export function parseRobotCheck(text) {
  const m = /лонг (\d+)\/(\d+) \((\d+)%\), шорт (\d+)\/(\d+) \((\d+)%\), нужно (\d+)%/.exec(String(text || ''));
  if (!m) return null;
  const long = { passed: +m[1], total: +m[2], pct: +m[3] };
  const short = { passed: +m[4], total: +m[5], pct: +m[6] };
  const best = long.pct >= short.pct ? long : short;
  return { ...best, need: +m[7] };
}

/**
 * Собрать данные сводки и текст. Чистая функция — проверяется тестом.
 * @returns {{ text: string|null, payload: object }}
 */
export function buildDigest({ profile = {}, trades = [], paper = [], radar = [], nowMs }) {
  const strategies = Array.isArray(profile.strategies) ? profile.strategies : [];
  const stratById = new Map(strategies.map((s) => [s.id, s]));
  const isOpen = (t) => t.status === 'open' || t.status === 'partial';
  const dayMs = 86400000;
  const daysSince = (t) => {
    const o = toMs(t.openedAt) || toMs(t.date);
    return o != null ? Math.max(0, Math.round((nowMs - o) / dayMs)) : null;
  };

  const open = trades.filter(isOpen).map((t) => ({
    ticker: String(t.ticker || '').toUpperCase(), direction: t.direction, strategy: t.entryStrategyName || null,
    entryPrice: t.entryPrice, stopLoss: t.stopLoss ?? null, takeProfit: t.takeProfit ?? null, days: daysSince(t),
  }));

  const paperOpen = paper.filter(isOpen);
  const paperLines = paperOpen.map((t) => {
    const st = stratById.get(t.entryStrategyId);
    return {
      ticker: String(t.ticker || '').toUpperCase(), direction: t.direction, strategy: t.entryStrategyName || null,
      caption: st ? captionOf(st) : (t.entryTimeframe || ''),
    };
  });
  const pendingDecisions = paperOpen.filter((t) => !summarizeDecisions(t).last).length;

  const near = [];
  for (const it of radar) {
    const r = parseRobotCheck(it.robotCheck?.text);
    if (!r || r.need <= 0) continue;
    // «Близко»: не хватает не больше одного-двух условий, но сигнал ещё не сошёлся.
    if (r.pct < r.need && r.pct >= Math.max(50, r.need - 25)) {
      const st = stratById.get(it.strategyId);
      near.push({ ticker: String(it.ticker || '').toUpperCase(), passed: r.passed, total: r.total, strategy: st?.name || null, pct: r.pct });
    }
  }
  near.sort((a, b) => b.pct - a.pct);

  const riskObj = buildOpenRisk({
    trades, deposit: Number(profile.depositSize) || 0,
  });
  const risk = riskObj.total.count ? { riskRub: riskObj.total.riskRub, riskPct: riskObj.total.riskPct, count: riskObj.total.count } : null;

  // вчера по Москве
  const { date } = moscowParts(nowMs);
  const yDate = moscowParts(nowMs - dayMs).date;
  let yCount = 0, yPnl = 0;
  for (const t of [...trades, ...paper]) {
    if (t.status !== 'closed' || !Number.isFinite(Number(t.pnl))) continue;
    const c = toMs(t.closedAt) || toMs(t.closeDate);
    if (c != null && moscowParts(c).date === yDate) { yCount += 1; yPnl += Number(t.pnl); }
  }

  const payload = { open, paper: paperLines, near, risk, yesterday: yCount ? { count: yCount, pnl: yPnl } : null, pendingDecisions };
  // Дата для заголовка — московская (а не сервера в UTC).
  const [yy, mm, dd] = date.split('-').map(Number);
  const text = formatMorningDigest({ date: new Date(yy, mm - 1, dd), ...payload });
  return { text, payload };
}

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

async function send(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json();
  if (!data.ok) { console.error(`Telegram: ${data.description || res.status}`); return false; }
  return true;
}

async function main() {
  const DRY = process.argv.includes('--dry');
  const FORCE = process.argv.includes('--force');
  const db = initFirebase();
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');
  const nowMs = Date.now();

  for (const uid of uids) {
    const profile = (await db.collection('users').doc(uid).get()).data() || {};
    const gate = shouldSendDigest({ prefs: profile.alertPrefs || {}, digestSentOn: profile.digestSentOn || null, nowMs, force: FORCE });
    if (!gate.send) { console.log(`[${uid}] сводка: ${gate.reason}`); continue; }

    const [tSnap, pSnap, rSnap] = await Promise.all([
      db.collection('trades').where('uid', '==', uid).get(),
      db.collection('paperTrades').where('uid', '==', uid).get(),
      db.collection('radarItems').where('uid', '==', uid).get(),
    ]);
    const { text } = buildDigest({
      profile,
      trades: tSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      paper: pSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      radar: rSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      nowMs,
    });
    const today = moscowParts(nowMs).date;
    if (!text) { console.log(`[${uid}] сводка: слать нечего`); }
    else if (DRY) { console.log(`[${uid}] сводка (сухо):\n${text}`); continue; }
    else {
      const okSent = await send(text);
      console.log(`[${uid}] сводка ${okSent ? 'отправлена' : 'НЕ отправлена'}`);
      if (!okSent) continue; // не отметим — попробуем на следующем проходе
    }
    if (!DRY) await db.collection('users').doc(uid).set({ digestSentOn: today }, { merge: true });
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main().catch((e) => { console.error(e); process.exit(1); });
