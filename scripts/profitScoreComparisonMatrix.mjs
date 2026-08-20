// Сверка старой и новой рейтинговой системы прибыли (2026-08-17) + разбивка по режиму
// рынка (тренд/боковик), как просил трейдер. Убыточная сторона НЕ пересобирается — уже
// установлено (HANDOFF п.23), что любой ранний выход там структурно вредит независимо от
// силы сигнала, повторный поиск не изменит вывод.
//
// СТАРАЯ система (12 признаков, п.22): RSI14/EMA9/Боллинджер20/держим10+/объём20/прибыль>5%
// НОВАЯ система (27 признаков, полный перебор, 2026-08-17): усилена ADX, EMA13, Боллинджер10,
// держим15+, прибыль>8% — по факту расширенного поиска.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-scorecmp-'));

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
const { computeMarketContextAtEntry } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/marketContext.js'))
);
const { rsi, ema, sma, bollingerSeries } = await import(indicatorsUrl);

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
const ENTRY_HARVEST_RULES = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null,
  stopType: 'pct', stopPct: 2, takeType: 'pct', takePct: 4, trailEnabled: false,
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
function atrSeries(candles, period = 14) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i >= period) sum -= trs[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function adxLite(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let upSum = 0, downSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const up = candles[j].high - candles[j - 1].high;
      const down = candles[j - 1].low - candles[j].low;
      if (up > down && up > 0) upSum += up;
      if (down > up && down > 0) downSum += down;
    }
    const total = upSum + downSum;
    out[i] = total > 0 ? (Math.abs(upSum - downSum) / total) * 100 : 0;
  }
  return out;
}

function oldScore(f) {
  let s = 0;
  const rsiExtreme = f.dir === 1 ? f.rsi14 > 70 : f.rsi14 < 30;
  if (rsiExtreme) s += 1;
  if (f.ema9Side != null && f.ema9Side > 3) s += 1;
  if (f.currentFavPct > 5) s += 1;
  if (f.bbPos20 != null && f.bbPos20 > 0.85) s += 1;
  if (f.barsFromArm >= 10) s += 1;
  if (f.volRatio20 != null && f.volRatio20 > 1.8) s += 1;
  if (f.rsi14ChangeArm != null && f.rsi14ChangeArm <= -5) s -= 1;
  if (f.avgRecentMove != null && f.avgRecentMove < 0.3 && f.barsFromArm >= 2) s -= 1;
  if (f.barsFromArm <= 2) s -= 1;
  return s;
}
function newScore(f) {
  let s = 0;
  const rsiExtreme = f.dir === 1 ? f.rsi14 > 70 : f.rsi14 < 30;
  if (rsiExtreme) s += 1;
  if (f.ema13Side != null && f.ema13Side > 4) s += 1;
  if (f.currentFavPct > 8) s += 1;
  if (f.bbPos10 != null && f.bbPos10 > 0.85) s += 1;
  if (f.barsFromArm >= 15) s += 1;
  if (f.adx != null && f.adx < 15) s += 1; // новое: слабый тренд/боковик усиливает сигнал
  if (f.volRatio20 != null && f.volRatio20 > 1.8) s += 1;
  if (f.barsFromArm <= 2) s -= 1;
  return s;
}

const MAX_WINDOW = 120;
function simulate(candles, series, entryIndex, dir, entryPrice, atr, scoreFn, threshold) {
  const { closes, rsiS, bbS10, bbS20, ema9S, ema13S } = series;
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 2;
  const adxS = series.adxS;
  let peak = 0, armIndex = null, armRsi = null;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    if (peak >= minPeakPct && armIndex == null) { armIndex = i; armRsi = rsiS[i] ?? null; }

    if (scoreFn && armIndex != null && ret > 0 && rsiS[i] != null) {
      const barsFromArm = i - armIndex;
      const sideOf = (s2, idx) => s2[idx] == null ? null : ((closes[idx] - s2[idx]) / s2[idx]) * 100 * dir;
      const bbPosOf = (b) => { if (!b || b.upper === b.lower) return null; const raw = (closes[i] - b.lower) / (b.upper - b.lower); return dir === 1 ? raw : 1 - raw; };
      const volAvg = candles.slice(Math.max(0, i - 20), i).map((x) => x.volume).filter(Number.isFinite);
      const volRatio20 = volAvg.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
      const recentMoves = [];
      for (let m = Math.max(armIndex + 1, i - 2); m <= i; m++) {
        const prevClose = candles[m - 1].close;
        recentMoves.push(((candles[m].close - prevClose) / prevClose) * 100 * dir);
      }
      const avgRecentMove = recentMoves.length ? recentMoves.reduce((s, v) => s + v, 0) / recentMoves.length : null;
      const rsi14ChangeArm = armRsi != null ? (rsiS[i] - armRsi) * dir : null;

      const f = {
        dir, rsi14: rsiS[i], rsi14ChangeArm, currentFavPct: ret, barsFromArm,
        bbPos20: bbPosOf(bbS20[i]), bbPos10: bbPosOf(bbS10[i]),
        ema9Side: sideOf(ema9S, i), ema13Side: sideOf(ema13S, i),
        volRatio20, avgRecentMove, adx: adxS[i],
      };
      const score = scoreFn(f);
      if (score >= threshold) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'profit_score' };
    }
    if (-ret >= adverseThresholdPct) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail_adverse' };
    if (peak >= minPeakPct && ret <= peak * 0.5) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail_giveback' };
  }
  const last = candles[end];
  const finalPct = dir === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data' };
}
function toPortfolio(list) {
  const byTicker = new Map();
  for (const r of list) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push({
      status: r.stillOpen ? 'open' : 'closed', pnlPct: r.pnlPct,
      entryDate: r.entryDate, exitDate: new Date(new Date(r.entryDate).getTime() + r.barsHeld * 86400000),
    });
  }
  return [...byTicker.entries()].map(([ticker, trades]) => ({ ticker, trades }));
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

const HOLDOUT_FRACTION = 0.2;
const allEntries = [];
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
  const series = {
    closes, rsiS: rsi(closes, 14), bbS10: bollingerSeries(closes, 10, 2), bbS20: bollingerSeries(closes, 20, 2),
    ema9S: ema(closes, 9), ema13S: ema(closes, 13), adxS: adxLite(candles, 14),
  };
  const atrS = atrSeries(candles, 14);
  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null || t.entryIndex < splitIndex) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;
    const mc = computeMarketContextAtEntry(candles, t.entryDate);
    const gauge = mc?.trend?.gaugePercent ?? null;
    const isTrending = gauge != null ? Math.abs(gauge - 50) > 20 : null;
    allEntries.push({ ticker, candles, series, entryIndex: t.entryIndex, dir, entryPrice: t.entryPrice, atr, entryDate: t.entryDate, marketDown: indexBelowSma50(new Date(t.entryDate)) === true, isTrending });
  }
}

function runConfig(scoreFn, threshold, regimeFilter) {
  const results = allEntries.filter((e) => regimeFilter(e)).map((e) => ({
    ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, scoreFn, threshold),
    ticker: e.ticker, entryDate: e.entryDate, dir: e.dir, marketDown: e.marketDown,
  }));
  const filtered = results.filter((r) => !(r.dir === 1 && r.marketDown));
  const p = runPortfolioBacktest(toPortfolio(filtered), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  return { ret: p.totalReturnPct, dd: p.maxDrawdownPct, n: filtered.length };
}

console.log(`\n${'='.repeat(120)}`);
console.log('СВЕРКА: старая vs новая рейтинговая система прибыли, по режимам рынка (портфель: фильтр рынка + ×2)');
console.log(`${'='.repeat(120)}\n`);
console.log('Вариант                       | Все режимы          | Только тренд        | Только боковик');
console.log('-'.repeat(120));

const REGIMES = [
  ['Все режимы', () => true],
  ['Только тренд', (e) => e.isTrending === true],
  ['Только боковик', (e) => e.isTrending === false],
];
const CONFIGS = [
  ['Базовое (giveback 50%)', null, null],
  ['СТАРАЯ система (12 призн., порог>=2)', oldScore, 2],
  ['НОВАЯ система (27 призн., порог>=3)', newScore, 3],
  ['НОВАЯ система, порог>=4', newScore, 4],
];

for (const [label, scoreFn, threshold] of CONFIGS) {
  const cells = REGIMES.map(([, filterFn]) => runConfig(scoreFn, threshold, filterFn));
  console.log(
    `${label.padEnd(30)} | ${((cells[0].ret >= 0 ? '+' : '') + cells[0].ret.toFixed(1)).padStart(6)}% dd${cells[0].dd.toFixed(1).padStart(5)}% n=${cells[0].n} | `
    + `${((cells[1].ret >= 0 ? '+' : '') + cells[1].ret.toFixed(1)).padStart(6)}% dd${cells[1].dd.toFixed(1).padStart(5)}% n=${cells[1].n} | `
    + `${((cells[2].ret >= 0 ? '+' : '') + cells[2].ret.toFixed(1)).padStart(6)}% dd${cells[2].dd.toFixed(1).padStart(5)}% n=${cells[2].n}`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
