// scripts/paper/managePaperTrades.mjs
//
// Робот бумажных сделок, шаг 3: ведёт уже ОТКРЫТЫЕ бумажные сделки и закрывает их сам —
// по стопу/цели, если они есть, или следящим выходом, если стратегия сознательно
// торгует без стопа. Открытие новых бумажных сделок — scripts/paper/runPaperTrades.mjs,
// это отдельный робот.
//
// Главное правило то же, что и у открытия: считается ТЕМИ ЖЕ функциями, что и бэктест —
// computeLiveState в режиме 'shadow'. У бумажной сделки нет трейдера, который мог бы
// вмешаться, поэтому режим 'shadow' (движок исполняет КАЖДЫЙ свой сигнал сам) — это не
// гипотеза для сравнения, как в Сопровождении у настоящей сделки, а буквально то, что с
// бумажной сделкой происходит: решения принимает только движок.
//
// P&L считается той же функцией, что и в Журнале/Сопровождении — computeClosePnl из
// tradeClose.js, а не второй копией формулы. Сам tradeClose.js тянет ещё updateTrade
// (браузерный Firestore) и computeTradePostmortem (разбор сделки, работает с
// браузерными источниками свечей) — оба тут не нужны и заменены пустыми заглушками,
// как tinkoff.js в остальных роботах; сама формула P&L при этом ни разу не копируется.
//
// Флаги: --dry — посчитать и показать, но в базу ничего не писать.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-paper-manage-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
// Заглушки для двух браузерных зависимостей tradeClose.js — сама формула P&L
// (computeClosePnl) их не вызывает, но ES-модуль обязан разрешить все свои import
// в момент загрузки, даже неиспользуемые в конкретном вызове.
fs.writeFileSync(path.join(tmp, 'trades.js'), `
export async function updateTrade() {}
export function resolveOpenedAt(t) {
  if (t.openedAt) return t.openedAt.seconds ? new Date(t.openedAt.seconds * 1000) : new Date(t.openedAt);
  if (t.date) return new Date(t.date);
  return null;
}
`);
fs.writeFileSync(path.join(tmp, 'tradePostmortem.js'), 'export async function computeTradePostmortem() { return null; }\n');
const analyticsUrls = {};
for (const f of ['indicators', 'candlestickPatterns', 'patterns', 'marketContext', 'strategy', 'exitRules', 'commission']) {
  analyticsUrls[f] = esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
}
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
// engine.js не импортируется отсюда напрямую — его на диск кладёт сам esmify(), а
// использует его livePosition.js (следующая строка) своим относительным импортом.
esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
  ["from '../analytics/", "from './"], ["from '../../utils/calculator.js'", "from './calculator.js'"],
]);
const liveUrl = esmify(path.join(repoRoot, 'src/services/backtest/livePosition.js'), [["from './engine'", "from './engine.js'"]]);
const candlesUrl = esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]);
// Осторожно: общий шаг esmify() выше уже сам дописывает ".js" к путям без расширения —
// заменять нужно ПОСЛЕ этого дописывания, иначе строка для поиска не совпадёт ни с чем.
const closeUrl = esmify(path.join(repoRoot, 'src/services/tradeClose.js'), [
  ["from './trades.js'", "from './trades.js'"], ["from './tradePostmortem.js'", "from './tradePostmortem.js'"],
  ["from './analytics/strategy.js'", "from './strategy.js'"], ["from './analytics/commission.js'", "from './commission.js'"],
]);

const { computeLiveState } = await import(liveUrl);
const { fetchDailyCandles, TIMEFRAMES, DEFAULT_TIMEFRAME } = await import(candlesUrl);
const { computeClosePnl } = await import(closeUrl);
const { commissionRateFor, DEFAULT_TARIFF } = await import(analyticsUrls.commission);

const DRY = process.argv.includes('--dry');

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return admin.firestore();
}

// Индекс бара, ближайшего к дате и не позже неё — тот же приём, что в Cockpit.js и
// runAlerts.mjs при восстановлении картины «на момент входа».
function indexAtOrBefore(candles, date) {
  const target = new Date(date).getTime();
  let found = -1;
  for (let i = 0; i < candles.length; i++) {
    if (new Date(candles[i].date).getTime() <= target) found = i; else break;
  }
  return found;
}

function strategyForTrade(trade, profile) {
  const all = profile.strategies || [];
  return all.find((s) => s.id === trade.entryStrategyId) || all.find((s) => s.id === profile.activeStrategyId) || all[0] || null;
}

/**
 * ЧИСТОЕ решение: что произошло с бумажной сделкой к текущему бару. Ни сети, ни базы —
 * на вход свечи и сделка, на выход патч и список событий. Вынесено отдельно, чтобы это
 * можно было прогнать на выдуманных свечах тестом: без такого разделения проверить
 * бухгалтерию частичных фиксаций и закрытия можно было бы только на живой базе.
 *
 * Идемпотентность держится на `paperFillsApplied`: режим 'shadow' каждый раз
 * переигрывает историю сделки с самого входа и заново выдаёт ВЕСЬ список срабатываний,
 * поэтому применяем только те, которых ещё не было в прошлый проход. Цены прошлых баров
 * не меняются, значит префикс списка от запуска к запуску один и тот же.
 *
 * @returns {{skipped: string} | {events: string[], patch: object}}
 */
export function planPaperUpdate({ trade, rules, candles, entryIndex, commRate }) {
  // Полное закрытие по стопу/цели приходит из state.exit, а он, в отличие от частичных
  // фиксаций, НЕ попадает в paperFillsApplied — счётчик считает только срабатывания из
  // state.fired. Значит повторный проход по уже закрытой сделке добавил бы вторую
  // закрывающую ступень и задвоил P&L. В бою до этого не доходит (главный цикл выбирает
  // только open/partial), но держаться на такой неявной защите нельзя — проверяем явно.
  if (trade.status === 'closed') return { skipped: 'уже закрыта' };

  const state = computeLiveState({
    candles, entryIndex,
    direction: trade.direction === 'short' ? 'short' : 'long',
    entryPrice: parseFloat(trade.entryPrice),
    rules,
    // У бумажной сделки нет трейдера, который мог бы вмешаться: решения принимает только
    // движок, поэтому 'shadow' — это не гипотеза для сравнения, как у настоящей сделки в
    // «Сопровождении», а буквально то, что с ней происходит.
    stopPrice: trade.stopLoss != null ? parseFloat(trade.stopLoss) : null,
    takePrice: trade.takeProfit != null ? parseFloat(trade.takeProfit) : null,
    mode: 'shadow',
  });

  const originalVolume = parseFloat(trade.volume) || 1;
  const alreadyApplied = trade.paperFillsApplied || 0;
  const newFires = (state.fired || []).slice(alreadyApplied);

  const legs = Array.isArray(trade.legs) ? [...trade.legs] : [];
  let pnlAdd = 0, commissionAdd = 0;
  const events = [];

  for (const fire of newFires) {
    const qty = Math.max(1, Math.round(fire.fraction * originalVolume));
    const result = computeClosePnl({ trade, exitPrice: fire.price, qty, commRate });
    if (!result) continue;
    pnlAdd += result.pnl;
    commissionAdd += result.commission;
    legs.push({
      type: 'close', side: trade.direction === 'long' ? 'sell' : 'buy',
      price: fire.price, quantity: qty, commission: result.commission,
      timestampUtc: new Date(fire.date).toISOString(), dealNumber: null, source: 'paper',
    });
    events.push(`зафиксировал ${qty} по ${fire.price} (${fire.reason})`);
  }

  const closedSoFar = legs.filter((l) => l.type === 'close').reduce((s, l) => s + (l.quantity || 0), 0);
  const remainingAfterFires = Math.max(0, originalVolume - closedSoFar);

  let patch = null;
  if (state.exit) {
    // У объекта выхода есть index и цена, но НЕТ даты: движок собирает его как
    // `{ index: i, ...intrabar }`, а checkIntrabarExit/updateTrailAndCheckExit возвращают
    // только { price, reason }. (У частичных фиксаций из state.fired дата есть — там её
    // кладут явно.) Читать state.exit.date означало получить undefined и уронить робота
    // на первой же закрытой сделке — поймано тестом. Берём дату из свечи по индексу.
    const exitDate = candles[state.exit.index]?.date ?? candles[candles.length - 1].date;
    const exitAt = new Date(exitDate).toISOString();
    const qty = Math.max(1, Math.round(remainingAfterFires) || originalVolume);
    const result = computeClosePnl({ trade, exitPrice: state.exit.price, qty, commRate });
    if (result) {
      pnlAdd += result.pnl;
      commissionAdd += result.commission;
      legs.push({
        type: 'close', side: trade.direction === 'long' ? 'sell' : 'buy',
        price: state.exit.price, quantity: qty, commission: result.commission,
        timestampUtc: exitAt, dealNumber: null, source: 'paper',
      });
      events.push(`закрыл остаток ${qty} по ${state.exit.price} (${state.exit.reason})`);
    }
    patch = {
      status: 'closed',
      remainingVolume: 0,
      closeDate: exitAt,
      closedAt: exitAt,
      exitPrice: state.exit.price,
    };
  } else if (remainingAfterFires < originalVolume) {
    patch = { status: 'partial', remainingVolume: remainingAfterFires };
  }

  if (!events.length) return { skipped: 'без изменений' };

  return {
    events,
    patch: {
      ...(patch || {}),
      legs,
      pnl: (trade.pnl ?? 0) + pnlAdd,
      commission: (trade.commission ?? 0) + commissionAdd,
      paperFillsApplied: alreadyApplied + newFires.length,
    },
  };
}

// Обвязка вокруг чистого решения выше: сходить за свечами, применить результат к базе.
async function manageTrade({ db, uid, profile, trade }) {
  const strategy = strategyForTrade(trade, profile);
  if (!strategy) return { skipped: 'стратегия сделки удалена — нечем вести' };

  const tfKey = trade.entryTimeframe || DEFAULT_TIMEFRAME;
  const tf = TIMEFRAMES[tfKey] || TIMEFRAMES[DEFAULT_TIMEFRAME];
  const candles = await fetchDailyCandles({
    ticker: trade.ticker, instrumentType: trade.instrumentType || 'stock',
    toDate: new Date(), timeframe: tfKey, lookbackDays: tf.lookbackDays,
  });
  if (!candles?.length) return { skipped: 'нет свечей' };

  const entryIndex = indexAtOrBefore(candles, trade.openedAt);
  if (entryIndex < 0 || entryIndex >= candles.length - 1) return { skipped: 'новых баров ещё нет' };

  const commRate = trade.commissionRate
    ?? commissionRateFor(profile.brokerTariff || DEFAULT_TARIFF, trade.instrumentType || 'stock').rate;

  const plan = planPaperUpdate({
    trade, rules: strategy.exitRules || {}, candles, entryIndex, commRate,
  });
  if (plan.skipped) return plan;

  if (DRY) return { ...plan, dry: true };
  await db.collection('paperTrades').doc(trade.id).update({
    ...plan.patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return plan;
}

async function main() {
  const db = initFirebase();
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');

  for (const uid of uids) {
    const profile = (await db.collection('users').doc(uid).get()).data() || {};
    const snap = await db.collection('paperTrades')
      .where('uid', '==', uid)
      .where('status', 'in', ['open', 'partial'])
      .get();
    console.log(`[${uid}] бумажных в работе: ${snap.size}`);

    for (const doc of snap.docs) {
      const trade = { id: doc.id, ...doc.data() };
      try {
        const res = await manageTrade({ db, uid, profile, trade });
        if (res.events?.length) {
          console.log(`[${uid}] ${trade.ticker}: ${res.events.join('; ')}${res.dry ? ' [сухой прогон]' : ''}`);
        } else {
          console.log(`[${uid}] ${trade.ticker}: ${res.skipped}`);
        }
      } catch (e) {
        console.error(`[${uid}] ${trade.ticker}: ${e.message}`);
      }
    }
  }
}

// main() запускается только когда файл вызвали напрямую. Без этой проверки тест, который
// импортирует planPaperUpdate, немедленно поднимал бы Firebase и падал на отсутствии ключа.
const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main().catch((e) => { console.error(e); process.exit(1); });
