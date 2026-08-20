// Идея трейдера (2026-08-17), лучшая из предложенных по проблеме чуринга: не слепой
// таймер охлаждения (провалился на walk-forward, HANDOFF п.25), а УСЛОВИЕ — не открывать
// новую сделку, пока НЕ ПРОШЛА та самая причина, по которой мы вышли из предыдущей.
// Плюс трейдер верно заметил, что мы полностью упустили УРОВНИ поддержки/сопротивления
// как условие входа/выхода (проверяли их только как признак качества фигуры — не помогло).
//
// Тестируем три варианта блокировки повторного входа после выхода по убыточной стороне:
//   A) blocked-while-signal: не входить, пока loss-score всё ещё высокий (>=3) — то есть
//      пока индикаторы, выгнавшие нас, продолжают сигналить.
//   B) blocked-until-level: не входить, пока цена не вернулась выше ближайшего уровня
//      поддержки (для лонга) — "рынок показал, что удержался".
//   C) blocked-until-rsi-recovers: не входить, пока RSI не вышел из зоны экстремума.
// Все три сравниваются с базой и между собой на ОДНИХ входах.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-reentry-'));

function esmify(srcAbsPath, extraReplacements = []) {
  let text = fs.readFileSync(srcAbsPath, 'utf8');
  text = text.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, spec) => {
    if (/\.[a-z]+$/i.test(spec)) return m;
    return `from ${q}${spec}.js${q}`;
  });
  for (const [find, replace] of extraReplacements) text = text.split(find).join(replace);
  const outPath = path.join(tmpDir, path.basename(srcAbsPath));
  fs.writeFileSync(outPath, text, 'utf8');
  return pathToFileURL(outPath).href;
}

fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), `
export class TinkoffAPI {}
export function moneyToFloat() { return 0; }
`);

const indicatorsUrl = esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
esmify(path.join(repoRoot, 'src/services/analytics/candlestickPatterns.js'));
const patternsUrl = esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'));
esmify(path.join(repoRoot, 'src/services/analytics/marketContext.js'));
esmify(path.join(repoRoot, 'src/services/analytics/exitRules.js'));
esmify(path.join(repoRoot, 'src/services/analytics/strategy.js'));
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
const { runBacktest } = await import(
  esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
    ["from '../analytics/", "from './"],
    ["from '../../utils/calculator.js'", "from './calculator.js'"],
  ])
);
const { computePatternsAtEntry } = await import(patternsUrl);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);
const { rsi, ema, sma } = await import(indicatorsUrl);

const STRATEGY = {
  id: 'patterns_levels', name: 'Фигуры разворота + уровень', readinessThreshold: 75,
  conditions: [
    { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
    { id: 'near_support', enabled: true, param: 1, direction: 'long' },
    { id: 'near_resistance', enabled: true, param: 1, direction: 'short' },
    { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
    { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
  ], customConditions: [],
};
const RULES = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null, stopType: 'none', takeType: 'none',
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
  trailAdverseEnabled: true, trailAdverseMult: 2,
};

const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' }, { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' }, { ticker: 'ROSN', instrumentType: 'stock' },
  { ticker: 'NVTK', instrumentType: 'stock' }, { ticker: 'TATN', instrumentType: 'stock' },
  { ticker: 'CHMF', instrumentType: 'stock' }, { ticker: 'MGNT', instrumentType: 'stock' },
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'RUAL', instrumentType: 'stock' },
  { ticker: 'VTBR', instrumentType: 'stock' }, { ticker: 'ALRS', instrumentType: 'stock' },
  { ticker: 'SNGS', instrumentType: 'stock' }, { ticker: 'MOEX', instrumentType: 'stock' },
  { ticker: 'PHOR', instrumentType: 'stock' }, { ticker: 'AFLT', instrumentType: 'stock' },
  { ticker: 'IRAO', instrumentType: 'stock' }, { ticker: 'HYDR', instrumentType: 'stock' },
  { ticker: 'IMOEXF', instrumentType: 'future' },
];

async function fetchWithRetry(args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchDailyCandles(args); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw lastErr;
}

console.log('Загружаю индекс для фильтра рынка...');
const indexCandles = await fetchWithRetry({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
const indexCloses = indexCandles.map((c) => c.close);
const indexSma50 = sma(indexCloses, 50);
function indexBelowSma50(date) {
  let idx = -1;
  for (let i = 0; i < indexCandles.length; i++) { if (new Date(indexCandles[i].date) <= date) idx = i; else break; }
  if (idx < 0 || indexSma50[idx] == null) return null;
  return indexCloses[idx] < indexSma50[idx];
}

// Портфель с УСЛОВНОЙ блокировкой повторного входа (вместо таймера).
// blockFn(ticker, entryDate) -> true если вход надо пропустить.
function runPortfolio(perTicker, { blockFn = null, riskPerTradePct = 10, maxConcurrentPositions = 8, startingCapital = 100000 } = {}) {
  const events = [];
  for (const { ticker, trades } of perTicker) {
    for (const t of trades) {
      if (!t.entryDate) continue;
      events.push({ type: 'entry', date: new Date(t.entryDate), ticker, trade: t });
      if (t.status === 'closed') events.push({ type: 'exit', date: new Date(t.exitDate), ticker, trade: t });
    }
  }
  events.sort((a, b) => a.date - b.date || (a.type === 'exit' ? -1 : 1));
  let equity = startingCapital, peak = equity, maxDrawdownPct = 0;
  const open = new Map();
  const lastAdverseExit = new Map(); // ticker -> дата выхода по убыточной стороне
  let closedTrades = 0, blocked = 0, worstTrade = 0;
  for (const ev of events) {
    if (ev.type === 'exit') {
      const allocated = open.get(ev.trade);
      if (allocated == null) continue;
      open.delete(ev.trade);
      equity += allocated * (ev.trade.pnlPct / 100);
      closedTrades += 1;
      worstTrade = Math.min(worstTrade, ev.trade.pnlPct);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
      if (ev.trade.exitReason === 'trail_adverse') lastAdverseExit.set(ev.ticker, ev.date);
    } else {
      if (open.size >= maxConcurrentPositions) continue;
      if (blockFn && lastAdverseExit.has(ev.ticker) && blockFn(ev.ticker, ev.date, lastAdverseExit.get(ev.ticker))) { blocked += 1; continue; }
      open.set(ev.trade, equity * (riskPerTradePct / 100));
    }
  }
  let mtm = equity;
  for (const [trade, allocated] of open) { mtm += allocated * (trade.pnlPct / 100); worstTrade = Math.min(worstTrade, trade.pnlPct); }
  return { totalReturnPct: ((mtm - startingCapital) / startingCapital) * 100, maxDrawdownPct, closedTrades, blocked, worstTrade };
}

const HOLDOUT_FRACTION = 0.2;
const perTicker = [];
const tickerState = new Map(); // ticker -> { candles, rsi14, sma20, levelsByDate }

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  const closes = candles.map((c) => c.close);
  const run = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: RULES, warmupBars: splitIndex });
  const trades = run.trades.filter((t) => t.entryIndex != null && !(t.direction === 'long' && indexBelowSma50(new Date(t.entryDate)) === true));
  if (!trades.length) continue;
  perTicker.push({ ticker, trades });
  tickerState.set(ticker, { candles, closes, rsi14: rsi(closes, 14), sma20: sma(closes, 20), ema21: ema(closes, 21) });
}

function indexAtDate(candles, date) {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) { if (new Date(candles[i].date) <= date) idx = i; else break; }
  return idx;
}

// A) блокировать, пока RSI всё ещё в зоне экстремума против нас (сигнал не прошёл)
function blockWhileRsiExtreme(ticker, entryDate) {
  const st = tickerState.get(ticker);
  if (!st) return false;
  const i = indexAtDate(st.candles, entryDate);
  if (i < 0 || st.rsi14[i] == null) return false;
  return st.rsi14[i] < 35; // ещё в перепроданности — "причина выхода не прошла"
}
// B) блокировать, пока цена не вернулась выше SMA20 (инструмент не восстановился)
function blockUntilAboveSma20(ticker, entryDate) {
  const st = tickerState.get(ticker);
  if (!st) return false;
  const i = indexAtDate(st.candles, entryDate);
  if (i < 0 || st.sma20[i] == null) return false;
  return st.closes[i] < st.sma20[i];
}
// C) блокировать, пока цена не вернулась выше ближайшего уровня поддержки (идея трейдера
// про уровни, которые мы упустили). Уровни считаются тем же боевым детектором.
function blockUntilAboveSupport(ticker, entryDate) {
  const st = tickerState.get(ticker);
  if (!st) return false;
  const i = indexAtDate(st.candles, entryDate);
  if (i < 60) return false;
  const p = computePatternsAtEntry(st.candles, st.candles[i].date, { timeframeMinutes: 1440 });
  const support = p?.supportResistance?.find((l) => l.type === 'support');
  if (!support) return false;
  return st.closes[i] < support.price; // ещё ниже поддержки — не восстановился
}
// D) комбинация: RSI вышел из экстремума И цена выше SMA20
function blockUntilBoth(ticker, entryDate) {
  return blockWhileRsiExtreme(ticker, entryDate) || blockUntilAboveSma20(ticker, entryDate);
}

console.log(`\n${'='.repeat(115)}`);
console.log('УСЛОВНАЯ блокировка повторного входа (не таймер!) — после выхода по убыточной стороне');
console.log(`${'='.repeat(115)}\n`);
console.log('Вариант                                        | Доходность | Просадка | Закрыто | Заблокировано');
console.log('-'.repeat(115));
for (const [label, blockFn] of [
  ['База (без блокировки)', null],
  ['A) пока RSI в перепроданности (<35)', blockWhileRsiExtreme],
  ['B) пока цена ниже SMA20', blockUntilAboveSma20],
  ['C) пока цена ниже ближайшей поддержки', blockUntilAboveSupport],
  ['D) A и B вместе', blockUntilBoth],
]) {
  const p = runPortfolio(perTicker, { blockFn });
  console.log(
    `${label.padEnd(46)} | ${((p.totalReturnPct >= 0 ? '+' : '') + p.totalReturnPct.toFixed(1)).padStart(6)}% | ${p.maxDrawdownPct.toFixed(1).padStart(5)}% | `
    + `${String(p.closedTrades).padStart(7)} | ${String(p.blocked).padStart(13)}`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
