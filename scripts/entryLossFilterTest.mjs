// Точная проверка (2026-08-17): использовать ТУ ЖЕ самую loss-формулу (RSI21 экстремум,
// RSI14 недавний тренд, EMA13 отрыв — из п.25, 64.6% точности внутри сделки) как ФИЛЬТР
// НА НОВЫЙ ВХОД — не входить в лонг, если в момент сигнала эти же условия уже "против".
// Раньше (smartReentryTest.mjs) проверялся упрощённый суррогат (RSI<35 сам по себе),
// сейчас — статический снимок полной формулы на момент входа.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-entryfilter-'));

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
esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'));
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

console.log('Загружаю индекс...');
const indexCandles = await fetchWithRetry({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
const indexCloses = indexCandles.map((c) => c.close);
const indexSma50 = sma(indexCloses, 50);
function indexBelowSma50(date) {
  let idx = -1;
  for (let i = 0; i < indexCandles.length; i++) { if (new Date(indexCandles[i].date) <= date) idx = i; else break; }
  if (idx < 0 || indexSma50[idx] == null) return null;
  return indexCloses[idx] < indexSma50[idx];
}

function runPortfolio(list, { riskPerTradePct = 10, maxConcurrentPositions = 8, startingCapital = 100000 } = {}) {
  const byTicker = new Map();
  for (const r of list) { if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []); byTicker.get(r.ticker).push(r); }
  const events = [];
  for (const [ticker, trades] of byTicker) {
    for (const t of trades) {
      events.push({ type: 'entry', date: new Date(t.entryDate), ticker, trade: t });
      if (t.status === 'closed') events.push({ type: 'exit', date: new Date(t.exitDate), ticker, trade: t });
    }
  }
  events.sort((a, b) => a.date - b.date || (a.type === 'exit' ? -1 : 1));
  let equity = startingCapital, peak = equity, maxDrawdownPct = 0;
  const open = new Map();
  let closedTrades = 0, worstTrade = 0;
  for (const ev of events) {
    if (ev.type === 'exit') {
      const alloc = open.get(ev.trade);
      if (alloc == null) continue;
      open.delete(ev.trade);
      equity += alloc * (ev.trade.pnlPct / 100);
      closedTrades += 1;
      worstTrade = Math.min(worstTrade, ev.trade.pnlPct);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    } else {
      if (open.size >= maxConcurrentPositions) continue;
      open.set(ev.trade, equity * (riskPerTradePct / 100));
    }
  }
  let mtm = equity;
  for (const [t, alloc] of open) { mtm += alloc * (t.pnlPct / 100); worstTrade = Math.min(worstTrade, t.pnlPct); }
  return { totalReturnPct: ((mtm - startingCapital) / startingCapital) * 100, maxDrawdownPct, closedTrades, worstTrade };
}

const HOLDOUT_FRACTION = 0.2;
const allTrades = [], allTradesFiltered = [];
let blockedCount = 0;

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
  const rsi14S = rsi(closes, 14), rsi21S = rsi(closes, 21), ema13S = ema(closes, 13);

  const run = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: RULES, warmupBars: splitIndex });

  for (const t of run.trades) {
    if (t.entryIndex == null) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    if (dir === 1 && indexBelowSma50(new Date(t.entryDate)) === true) continue;
    const i = t.entryIndex;

    // Статический снимок loss-формулы В МОМЕНТ ВХОДА (не "с армирования" — тут нет
    // ещё открытой позиции): RSI21 экстремум против направления + RSI14 в недавнем
    // падении (5 баров) + большой отрыв EMA13 против направления.
    let bad = false;
    if (rsi21S[i] != null && rsi14S[i] != null && rsi14S[i - 5] != null && ema13S[i] != null) {
      const rsi21Extreme = dir === 1 ? rsi21S[i] < 35 : rsi21S[i] > 65;
      const rsi14Recent5 = (rsi14S[i] - rsi14S[i - 5]) * dir;
      const ema13Side = ((closes[i] - ema13S[i]) / ema13S[i]) * 100 * dir;
      let score = 0;
      if (rsi21Extreme) score += 2;
      if (rsi14Recent5 <= -10) score += 2;
      if (ema13Side < -4) score += 1;
      bad = score >= 3;
    }

    const record = { ...t, ticker };
    allTrades.push(record);
    if (!bad) allTradesFiltered.push(record); else blockedCount += 1;
  }
}

console.log(`\n${'='.repeat(100)}`);
console.log('ФИЛЬТР ВХОДА той же loss-формулой (статический снимок на момент сигнала)');
console.log(`${'='.repeat(100)}\n`);
const before = runPortfolio(allTrades);
const after = runPortfolio(allTradesFiltered);
console.log(`БЕЗ фильтра входа: доходность ${(before.totalReturnPct >= 0 ? '+' : '') + before.totalReturnPct.toFixed(1)}%, просадка ${before.maxDrawdownPct.toFixed(1)}%, сделок ${before.closedTrades}, худшая ${before.worstTrade.toFixed(1)}%`);
console.log(`С фильтром входа:  доходность ${(after.totalReturnPct >= 0 ? '+' : '') + after.totalReturnPct.toFixed(1)}%, просадка ${after.maxDrawdownPct.toFixed(1)}%, сделок ${after.closedTrades}, худшая ${after.worstTrade.toFixed(1)}% (заблокировано ${blockedCount})`);

fs.rmSync(tmpDir, { recursive: true, force: true });
