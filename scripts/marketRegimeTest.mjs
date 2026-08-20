// Два вопроса трейдера (2026-08-14):
// 1) Помогает ли фильтр состояния рынка (не входить в лонг, пока индекс сам в нисходящем
//    тренде) — самая дешёвая непроверенная идея из всего, что обсуждали.
// 2) Стратегия одинаково хороша на всех инструментах, или конкретные бумаги тянут вниз?
//    Разбивка по тикерам за отложенный период.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-regime-'));

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
esmify(path.join(repoRoot, 'src/services/backtest/portfolio.js'));
const { runBacktest } = await import(
  esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
    ["from '../analytics/", "from './"],
    ["from '../../utils/calculator.js'", "from './calculator.js'"],
  ])
);
const { runPortfolioBacktest } = await import(pathToFileURL(path.join(tmpDir, 'portfolio.js')).href);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);
const { sma } = await import(indicatorsUrl);

const STRATEGY = {
  id: 'patterns_levels', name: 'Фигуры разворота + уровень', readinessThreshold: 75,
  conditions: [
    { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
    { id: 'near_support', enabled: true, param: 1, direction: 'long' },
    { id: 'near_resistance', enabled: true, param: 1, direction: 'short' },
    { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
    { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
  ],
  customConditions: [],
};
const RULES = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null, stopType: 'none', takeType: 'none',
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
  trailAdverseEnabled: true, trailAdverseMult: 3,
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

// Индекс — эталон "состояния рынка", один на все инструменты.
console.log('Загружаю индекс IMOEXF для фильтра рынка...');
const indexCandles = await fetchWithRetry({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
const indexCloses = indexCandles.map((c) => c.close);
const indexSma50 = sma(indexCloses, 50);
function indexBelowSma50(date) {
  let idx = -1;
  for (let i = 0; i < indexCandles.length; i++) { if (new Date(indexCandles[i].date) <= date) idx = i; else break; }
  if (idx < 0 || indexSma50[idx] == null) return null;
  return indexCloses[idx] < indexSma50[idx];
}

const HOLDOUT_FRACTION = 0.2;
const trainByTicker = [], testByTicker = [];
const testByTickerFiltered = [];

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));

  const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY, timeframeMinutes: 1440, exitRules: RULES });
  const test = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: RULES, warmupBars: splitIndex });
  trainByTicker.push({ ticker, trades: train.trades });
  testByTicker.push({ ticker, trades: test.trades });

  // Фильтр: убираем ЛОНГИ, вошедшие когда индекс сам ниже своей SMA50 (нисходящий рынок).
  const filteredTrades = test.trades.filter((t) => {
    if (t.direction !== 'long') return true; // шорты не трогаем
    const below = indexBelowSma50(new Date(t.entryDate));
    return below !== true; // убираем только те, где точно "рынок падает"
  });
  testByTickerFiltered.push({ ticker, trades: filteredTrades });
}

function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  const open = trades.filter((t) => t.status === 'open');
  if (!closed.length) return null;
  const wins = closed.filter((t) => t.pnlPct > 0).length;
  const avg = closed.reduce((s, t) => s + t.pnlPct, 0) / closed.length;
  let eq = 100;
  for (const t of [...closed].sort((a, b) => a.exitDate - b.exitDate)) eq *= 1 + t.pnlPct / 100;
  return { n: closed.length, winRate: (wins / closed.length) * 100, avg, compounded: eq - 100, openN: open.length };
}

console.log(`\n${'='.repeat(100)}`);
console.log('1) ФИЛЬТР РЫНКА: убираем лонги, вошедшие когда индекс сам ниже SMA50 (нисходящий тренд)');
console.log(`${'='.repeat(100)}\n`);
function toPortfolio(byTicker) { return byTicker; }
const pBefore = runPortfolioBacktest(toPortfolio(testByTicker), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
const pAfter = runPortfolioBacktest(toPortfolio(testByTickerFiltered), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
const totalBefore = testByTicker.reduce((s, x) => s + x.trades.length, 0);
const totalAfter = testByTickerFiltered.reduce((s, x) => s + x.trades.length, 0);
console.log(`БЕЗ фильтра: доходность ${(pBefore.totalReturnPct >= 0 ? '+' : '') + pBefore.totalReturnPct.toFixed(1)}%, просадка ${pBefore.maxDrawdownPct.toFixed(1)}%, худшая ${pBefore.worstTrade.toFixed(1)}%, сделок ${totalBefore}`);
console.log(`С фильтром:  доходность ${(pAfter.totalReturnPct >= 0 ? '+' : '') + pAfter.totalReturnPct.toFixed(1)}%, просадка ${pAfter.maxDrawdownPct.toFixed(1)}%, худшая ${pAfter.worstTrade.toFixed(1)}%, сделок ${totalAfter} (убрано ${totalBefore - totalAfter})`);

console.log(`\n${'='.repeat(100)}`);
console.log('2) РАЗБИВКА ПО ТИКЕРАМ (отложенный период) — какие инструменты тянут вниз, какие вверх');
console.log(`${'='.repeat(100)}\n`);
console.log('Тикер    | Сделок | Винрейт | Ср.сделка | Сложный % | Ещё открыто');
console.log('-'.repeat(75));
const perTicker = testByTicker.map(({ ticker, trades }) => ({ ticker, ...summarize(trades) })).filter((r) => r.n != null);
perTicker.sort((a, b) => b.compounded - a.compounded);
for (const r of perTicker) {
  console.log(`${r.ticker.padEnd(8)} | ${String(r.n).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(3)).padStart(8)}% | ${((r.compounded >= 0 ? '+' : '') + r.compounded.toFixed(1)).padStart(8)}% | ${r.openN}`);
}
const positive = perTicker.filter((r) => r.compounded > 0).length;
console.log(`\nВ плюсе: ${positive} из ${perTicker.length} инструментов на отложенном периоде.`);

fs.rmSync(tmpDir, { recursive: true, force: true });
