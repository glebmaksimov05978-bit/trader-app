// scripts/telegram/applyFills.mjs
//
// Переносит в Журнал сделки, которые исполнены кнопками в Telegram. Воркер бота, отправив заявку
// брокеру, оставляет в Cloudflare KV запись `fill:<id>` (у него нет доступа к базе); этот шаг
// забирает такие записи и:
//   • kind 'close' — закрывает (полностью или частично) сделку в Журнале ТЕМ ЖЕ расчётом, что и
//     приложение (applyTradeClose / computeClosePnl из src/services/tradeClose.js — не вторая копия
//     формулы);
//   • kind 'open'  — заводит в Журнале настоящую сделку по бумажной (source 'paper-repeat', как у
//     кнопки «Повторить реальной заявкой» в приложении) и помечает бумажную как повторённую.
// Повторный запуск безопасен: запись в Журнале узнаётся по orderId, дубль не создаётся.
//
// Если цена исполнения была ориентировочной (брокер её не вернул), это помечено в ступени сделки
// (priceApprox) — «Синхронизировать» в Журнале подтянет настоящие цены у брокера.
//
// Переменные окружения: FIREBASE_SERVICE_ACCOUNT, ALERT_UIDS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//   CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID. Флаг --dry — показать, что было бы сделано.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const DRY = process.argv.includes('--dry');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-fills-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
// Заглушка trades.js перехватывает запись applyTradeClose: патч не уходит в браузерный Firestore, а
// складывается в массив, откуда его забирает этот скрипт и пишет через админский доступ.
fs.writeFileSync(path.join(tmp, 'trades.js'), `
export const captured = [];
export async function updateTrade(id, patch) { captured.push({ id, patch }); }
export function resolveOpenedAt(t) {
  const v = t.openedAt || t.date;
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (v.seconds != null) return new Date(v.seconds * 1000);
  return new Date(v);
}
`);
fs.writeFileSync(path.join(tmp, 'tradePostmortem.js'), 'export async function computeTradePostmortem() { return null; }\n');
for (const f of ['strategy', 'commission', 'exitRules', 'indicators', 'candlestickPatterns', 'patterns', 'marketContext']) {
  esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
}
const closeUrl = esmify(path.join(repoRoot, 'src/services/tradeClose.js'), [
  ["from './analytics/strategy.js'", "from './strategy.js'"], ["from './analytics/commission.js'", "from './commission.js'"],
]);
const { applyTradeClose } = await import(closeUrl);
const { captured } = await import(pathToFileURL(path.join(tmp, 'trades.js')).href);
const { commissionRateFor, DEFAULT_TARIFF } = await import(pathToFileURL(path.join(tmp, 'commission.js')).href);

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true }); // см. комментарий в runPaperTrades.mjs
  return db;
}

const CF = () => {
  const token = process.env.CF_API_TOKEN, account = process.env.CF_ACCOUNT_ID, ns = process.env.CF_KV_NAMESPACE_ID;
  if (!token || !account || !ns) return null;
  return { base: `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}`, headers: { Authorization: `Bearer ${token}` } };
};

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { console.error(`Telegram: ${e.message}`); }
}

const money = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('ru-RU')} ₽`;

async function applyClose(db, uid, profile, fill) {
  const ref = db.collection('trades').doc(fill.tradeId);
  const snap = await ref.get();
  if (!snap.exists) return { done: true, note: `сделки ${fill.tradeId} в Журнале нет — пропускаю` };
  const trade = { id: snap.id, ...snap.data() };
  if ((trade.legs || []).some((l) => l.dealNumber && l.dealNumber === fill.orderId)) return { done: true, note: 'уже записано' };

  captured.length = 0;
  const closedAt = new Date(fill.at);
  const res = await applyTradeClose({
    trade, exitPrice: Number(fill.price), qty: Number(fill.lots), closedAtDate: closedAt, userProfile: profile, source: 'telegram',
  });
  const patch = captured.at(-1)?.patch || res.patch;
  // Номер заявки кладём в последнюю ступень: по нему узнаётся повтор, и по нему же видно источник.
  const legs = [...(patch.legs || [])];
  if (legs.length) legs[legs.length - 1] = { ...legs[legs.length - 1], dealNumber: fill.orderId, priceApprox: fill.priceApprox || undefined };
  if (DRY) return { done: false, note: `закрыл бы ${trade.ticker}: ${fill.lots} по ${fill.price}, ${money(res.pnl)}` };
  await ref.update({ ...patch, legs, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { done: true, note: `закрыто ${trade.ticker}: ${fill.lots} по ${fill.price}${fill.priceApprox ? ' (цена-ориентир)' : ''}, ${money(res.pnl)}${res.partial ? ' — частично' : ''}`, notify: true };
}

async function applyOpen(db, uid, profile, fill) {
  const dup = await db.collection('trades').where('uid', '==', uid).where('orderId', '==', fill.orderId).limit(1).get();
  if (!dup.empty) return { done: true, note: 'уже записано' };
  const paperRef = db.collection('paperTrades').doc(fill.paperId);
  const ps = await paperRef.get();
  if (!ps.exists) return { done: true, note: `бумажной сделки ${fill.paperId} нет — пропускаю` };
  const paper = ps.data();
  const type = paper.instrumentType || fill.type || 'stock';
  const lot = parseFloat(paper.lot) || 1;
  const commRate = parseFloat(paper.commissionRate) || commissionRateFor(profile.brokerTariff || DEFAULT_TARIFF, type).rate;
  const at = new Date(fill.at);
  const price = Number(fill.price);
  const trade = {
    uid,
    ticker: String(paper.ticker).toUpperCase(),
    date: at.toISOString().split('T')[0],
    openedAt: at.toISOString(),
    status: 'open',
    direction: paper.direction === 'short' ? 'short' : 'long',
    entryPrice: price,
    intendedEntryPrice: parseFloat(paper.entryPrice) || null,
    exitPrice: null,
    stopLoss: paper.stopLoss ?? null,
    takeProfit: paper.takeProfit ?? null,
    volume: Number(fill.lots),
    remainingVolume: Number(fill.lots),
    lot,
    instrumentType: type,
    isFuture: type === 'future',
    minStep: parseFloat(paper.minStep) || null,
    minStepAmount: parseFloat(paper.minStepAmount) || null,
    commissionRate: commRate,
    commission: Math.round(price * Number(fill.lots) * lot * commRate * 2),
    depositSize: parseFloat(profile.depositSize) || 0,
    pnl: null,
    source: 'paper-repeat',
    via: 'telegram',
    orderId: fill.orderId,
    orderAccountId: fill.accountId || null,
    entryTimeframe: paper.entryTimeframe || null,
    entryStrategyId: paper.entryStrategyId || null,
    entryStrategyName: paper.entryStrategyName || null,
    strategyMatchAtEntry: paper.entryTotal ? { passed: paper.entryPassed ?? null, total: paper.entryTotal, percent: paper.entryPercent ?? null } : null,
    repeatedFromPaperId: fill.paperId,
    legs: [{
      type: 'open', side: fill.direction, price, quantity: Number(fill.lots), commission: 0,
      timestampUtc: at.toISOString(), dealNumber: fill.orderId, source: 'telegram', priceApprox: fill.priceApprox || undefined,
    }],
  };
  if (DRY) return { done: false, note: `открыл бы в Журнале ${trade.ticker}: ${fill.lots} по ${price}` };
  await db.collection('trades').add({ ...trade, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  try { await paperRef.update({ repeatedAt: at.toISOString() }); } catch { /* отметка не критична */ }
  return { done: true, note: `открыто в Журнале ${trade.ticker}: ${fill.lots} по ${price}${fill.priceApprox ? ' (цена-ориентир)' : ''}`, notify: true };
}

async function main() {
  const cf = CF();
  if (!cf) { console.log('CF_* не заданы — переносить нечего'); return; }
  const db = initFirebase();
  const uid = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (!uid) throw new Error('Нет ALERT_UIDS');

  const list = await fetch(`${cf.base}/keys?prefix=fill:&limit=100`, { headers: cf.headers });
  if (!list.ok) throw new Error(`Cloudflare KV: ${list.status}`);
  const keys = (await list.json()).result || [];
  if (!keys.length) { console.log('Новых исполненных заявок из Telegram нет'); return; }

  const profile = (await db.collection('users').doc(uid).get()).data() || {};
  for (const { name } of keys) {
    try {
      const v = await fetch(`${cf.base}/values/${encodeURIComponent(name)}`, { headers: cf.headers });
      const fill = JSON.parse(await v.text());
      const out = fill.kind === 'close' ? await applyClose(db, uid, profile, fill) : await applyOpen(db, uid, profile, fill);
      console.log(`${name}: ${out.note}`);
      if (out.done && !DRY) {
        await fetch(`${cf.base}/values/${encodeURIComponent(name)}`, { method: 'DELETE', headers: cf.headers });
        if (out.notify) await notify(`📝 <b>Записано в Журнал</b>\n${out.note}`);
      }
    } catch (e) {
      console.error(`${name}: ${e.message}`); // запись остаётся в хранилище и будет разобрана при следующем проходе
    }
  }
}

main().catch((e) => { console.error(e); process.exit(0); }); // перенос вторичен: сбой не должен валить прогон
