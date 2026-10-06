// scripts/telegram/writeSnapshot.mjs
//
// Снимок состояния для меню в Telegram: что сейчас открыто, сколько каждая сделка принесла
// или потеряла, что показывает радар и когда в последний раз отработал робот.
//
// Почему снимок, а не живой запрос: бот в Telegram живёт в Cloudflare Worker, у которого нет и
// не должно быть доступа к базе (только токен самого бота). Поэтому раз в проход робот
// складывает готовые цифры в Cloudflare KV под ключом `snap:main`, а воркер при нажатии
// кнопки меню просто читает их оттуда и отвечает мгновенно. Цена вопроса — цифры не старше
// 15 минут, и в самом сообщении всегда указано время снимка.
//
// Только чтение: ни одной записи в Firestore, ни одной заявки брокеру. Если секретов
// Cloudflare нет — тихо выходит (бот просто не получит свежих данных).
//
// Переменные окружения: FIREBASE_SERVICE_ACCOUNT, ALERT_UIDS, TELEGRAM_CHAT_ID,
//   CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID.
// Флаг --dry — посчитать и напечатать снимок, но не отправлять.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const DRY = process.argv.includes('--dry');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-snapshot-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
// Заглушки тех же браузерных зависимостей, что и у managePaperTrades.mjs: формула P&L
// (computeClosePnl) их не вызывает, но модуль обязан их разрешить при загрузке.
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
fs.writeFileSync(path.join(tmp, 'trades.js'), 'export async function updateTrade() {}\nexport function resolveOpenedAt(t) { return t.openedAt ? new Date(t.openedAt) : null; }\n');
fs.writeFileSync(path.join(tmp, 'tradePostmortem.js'), 'export async function computeTradePostmortem() { return null; }\n');
for (const f of ['strategy', 'commission', 'exitRules', 'indicators', 'candlestickPatterns', 'patterns', 'marketContext']) {
  esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
}
const closeUrl = esmify(path.join(repoRoot, 'src/services/tradeClose.js'), [
  ["from './analytics/strategy.js'", "from './strategy.js'"], ["from './analytics/commission.js'", "from './commission.js'"],
]);
const candlesUrl = esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]);
const scheduleUrl = esmify(path.join(repoRoot, 'src/services/marketData/tradingSchedule.js'));

const { computeClosePnl } = await import(closeUrl);
const { fetchDailyCandles } = await import(candlesUrl);
const { marketPhase } = await import(scheduleUrl);

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  // Firestore Admin ОТВЕРГАЕТ поля со значением undefined целиком («Cannot use "undefined" as a
  // Firestore value»). Робот бумажных сделок собирает документ с полями вида `x || undefined`,
  // поэтому запись открытия падала у КАЖДОГО сигнала — тихо, шаг помечен continue-on-error, а в
  // сухом прогоне и тестах записи нет вовсе (найдено 2026-10-07: ни одной бумажной сделки за всё
  // время работы). Настройка ниже просто выбрасывает такие поля при записи.
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

// Последняя известная цена: закрытие самой свежей часовой свечи (за неё же отвечают и
// остальные роботы). Не получилось — null, в меню будет «цены нет», а не выдуманная цифра.
const priceCache = new Map();
async function lastPrice(ticker, instrumentType) {
  const key = `${instrumentType}:${ticker}`;
  if (priceCache.has(key)) return priceCache.get(key);
  let price = null;
  try {
    const candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: 'H1', lookbackDays: 7 });
    const last = candles?.[candles.length - 1];
    price = Number.isFinite(last?.close) ? last.close : null;
  } catch { /* цены нет — не ошибка снимка */ }
  priceCache.set(key, price);
  return price;
}

function toIso(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate().toISOString();
  if (v.seconds) return new Date(v.seconds * 1000).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function position(t) {
  const type = t.instrumentType || 'stock';
  const entry = parseFloat(t.entryPrice);
  const vol = parseFloat(t.remainingVolume ?? t.volume) || 0;
  const price = await lastPrice(String(t.ticker).toUpperCase(), type);
  let pnl = null, pct = null;
  if (price != null && entry) {
    const r = computeClosePnl({ trade: t, exitPrice: price, qty: vol, commRate: t.commissionRate });
    pnl = r ? r.pnl : null;
    pct = Math.round(((t.direction === 'short' ? entry - price : price - entry) / entry) * 10000) / 100;
  }
  return {
    id: t.id, ticker: String(t.ticker).toUpperCase(), type, dir: t.direction === 'short' ? 'short' : 'long',
    vol, entry, price, pnl, pct,
    stop: t.stopLoss ?? null, take: t.takeProfit ?? null,
    openedAt: toIso(t.openedAt || t.openDate || t.date),
    phase: marketPhase(type).label,
  };
}

async function putKv(key, value) {
  const token = process.env.CF_API_TOKEN, account = process.env.CF_ACCOUNT_ID, ns = process.env.CF_KV_NAMESPACE_ID;
  if (!token || !account || !ns) { console.log('CF_* не заданы — снимок не отправляю'); return; }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}?expiration_ttl=259200`;
  const res = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(value) });
  if (!res.ok) throw new Error(`Cloudflare KV: ${res.status} ${await res.text()}`);
}

async function main() {
  const db = initFirebase();
  const uid = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (!uid) throw new Error('Нет ALERT_UIDS');

  const [realSnap, paperOpenSnap, paperAllSnap, radarSnap] = await Promise.all([
    db.collection('trades').where('uid', '==', uid).where('status', 'in', ['open', 'partial']).get(),
    db.collection('paperTrades').where('uid', '==', uid).where('status', 'in', ['open', 'partial']).get(),
    db.collection('paperTrades').where('uid', '==', uid).get(),
    db.collection('radarItems').where('uid', '==', uid).get(),
  ]);

  const real = [];
  for (const d of realSnap.docs) real.push(await position({ id: d.id, ...d.data() }));
  const paper = [];
  for (const d of paperOpenSnap.docs) paper.push(await position({ id: d.id, ...d.data() }));

  // Закрытые бумажные: сколько всего и итог по ним — чтобы в меню было видно, как система торгует.
  const closed = paperAllSnap.docs.map((d) => d.data()).filter((p) => p.status === 'closed');
  const closedPnl = closed.reduce((s, p) => s + (Number(p.pnl) || 0), 0);
  const last5 = closed
    .sort((a, b) => String(toIso(b.closedAt) || '').localeCompare(String(toIso(a.closedAt) || '')))
    .slice(0, 5)
    .map((p) => ({ ticker: p.ticker, dir: p.direction, pnl: Number(p.pnl) || 0, closedAt: toIso(p.closedAt) }));

  const radar = radarSnap.docs.map((d) => d.data()).map((r) => ({
    ticker: String(r.ticker || '').toUpperCase(),
    robot: r.robotCheck ? { at: r.robotCheck.at, text: r.robotCheck.text, opened: !!r.robotCheck.opened } : null,
  }));
  const lastRobot = radar.map((r) => r.robot?.at).filter(Boolean).sort().pop() || null;

  const snapshot = {
    at: new Date().toISOString(),
    chatId: String(process.env.TELEGRAM_CHAT_ID || ''),
    real, paper,
    paperClosed: { count: closed.length, pnl: Math.round(closedPnl * 100) / 100, last: last5 },
    radar,
    robot: { lastCheckAt: lastRobot, radarCount: radar.length },
  };

  if (DRY) { console.log(JSON.stringify(snapshot, null, 1)); return; }
  await putKv('snap:main', snapshot);
  console.log(`Снимок для Telegram записан: реальных ${real.length}, бумажных ${paper.length}, радар ${radar.length}`);
}

main().catch((e) => { console.error(e); process.exit(0); }); // снимок вторичен: его сбой не валит прогон
