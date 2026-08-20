// Улучшение рейтинговой системы (2026-08-14, запрос трейдера) — теперь ПОВЕРХ фильтра
// рынка, раз связка "фильтр рынка + счёт>=3" дала лучший результат сессии (+17.3%).
// Проверяем разом:
//   - пороги 2 / 3 / 4 очка (трейдер спрашивал про 2 и 3 — берём и 4 для полноты),
//   - ВЗВЕШЕННЫЕ очки (сильным признакам вес 2, слабым 1) вместо равных ±1,
//   - расширенный набор признаков (добавлены EMA200-пробой и RSI-в-зоне-слабости, которые
//     хорошо показали себя в п.11, но не входили в "счёт из 6"),
//   - момент оценки: только при первом пересечении шумового порога (как сейчас) ИЛИ
//     переоценка на КАЖДОМ баре (трейдер просил "быстрее реагировать").
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-tuning-'));

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
function lastSwingBefore(candles, index, dir, span = 3, lookback = 60) {
  for (let i = index - span - 1; i >= Math.max(span, index - lookback); i--) {
    let isSwing = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i || j < 0 || j >= candles.length) continue;
      if (dir === 1 ? candles[j].low < candles[i].low : candles[j].high > candles[i].high) { isSwing = false; break; }
    }
    if (isSwing) return dir === 1 ? candles[i].low : candles[i].high;
  }
  return null;
}

const HOLDOUT_FRACTION = 0.2;
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
    closes, rsiS: rsi(closes, 14), bbS: bollingerSeries(closes, 20, 2),
    ema200S: ema(closes, 200), ema100S: ema(closes, 100),
  };
  const atrS = atrSeries(candles, 14);
  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;
    if (t.entryIndex < splitIndex) continue; // только отложенный период
    allEntries.push({
      ticker, candles, series, entryIndex: t.entryIndex, dir, entryPrice: t.entryPrice, atr,
      entryDate: t.entryDate, marketDown: indexBelowSma50(new Date(t.entryDate)) === true,
    });
  }
}

function featuresAt(candles, series, entryIndex, k, dir, entryPrice, atrEntry) {
  const { closes, rsiS, bbS, ema200S, ema100S } = series;
  if (rsiS[entryIndex] == null || rsiS[k] == null || !bbS[k] || ema200S[k] == null) return null;
  let closesOutsideBand = 0;
  for (let m = entryIndex + 1; m <= k; m++) {
    const b = bbS[m];
    if (!b) continue;
    if (dir === 1 ? closes[m] < b.lower : closes[m] > b.upper) closesOutsideBand += 1;
  }
  const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
  const volRatio = volAvg.length && Number.isFinite(candles[k].volume)
    ? candles[k].volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
  const swing = lastSwingBefore(candles, entryIndex, dir);
  const barK = candles[k];
  const range = barK.high - barK.low;
  const sideAt = (series2, idx) => series2[idx] == null ? null : ((closes[idx] - series2[idx]) / series2[idx]) * 100 * dir;
  return {
    rsiChange: (rsiS[k] - rsiS[entryIndex]) * dir,
    rsiLevel: rsiS[k],
    closesOutsideBand, volRatio,
    structureBroken: swing != null ? (dir === 1 ? closes[k] < swing : closes[k] > swing) : false,
    adverseAtr: atrEntry > 0 ? (dir === 1 ? (entryPrice - barK.low) : (barK.high - entryPrice)) / atrEntry : null,
    bodyRatio: range > 0 ? Math.abs(barK.close - barK.open) / range : null,
    bodyAgainst: dir === 1 ? barK.close < barK.open : barK.close > barK.open,
    ema200Broken: sideAt(ema200S, entryIndex) > 0 && sideAt(ema200S, k) < 0,
    ema100Side: sideAt(ema100S, k),
  };
}

// Варианты подсчёта очков
function scoreEqual(f) { // нынешний: 6 признаков, вес 1
  let s = 0;
  if (f.rsiChange <= -10) s += 1;
  if (f.structureBroken) s += 1;
  if (f.adverseAtr != null && f.adverseAtr > 1.5) s += 1;
  if (f.closesOutsideBand === 1) s += 1;
  if (f.volRatio != null && f.volRatio > 2) s += 1;
  if (f.bodyAgainst && f.bodyRatio != null && f.bodyRatio > 0.6) s += 1;
  return s;
}
function scoreWeighted(f) { // сильным признакам вес 2 (по силе из п.11/12)
  let s = 0;
  if (f.rsiChange <= -10) s += 2;                              // RSI — сильнейший
  if (f.adverseAtr != null && f.adverseAtr > 1.5) s += 2;       // >1.5 ATR — сильнейший из новых
  if (f.structureBroken) s += 1;
  if (f.closesOutsideBand === 1) s += 1;
  if (f.volRatio != null && f.volRatio > 2) s += 1;
  if (f.bodyAgainst && f.bodyRatio != null && f.bodyRatio > 0.6) s += 1;
  return s;
}
function scoreExtended(f) { // 8 признаков: + пробой EMA200 и RSI в зоне слабости
  let s = scoreEqual(f);
  if (f.ema200Broken) s += 1;
  if (f.rsiLevel != null && f.rsiLevel < 40) s += 1;
  return s;
}

const MAX_WINDOW = 120;
function simulate(candles, series, entryIndex, dir, entryPrice, atr, scoreFn, threshold, everyBar) {
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 3;
  let peak = 0, evaluatedOnce = false;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;

    if (scoreFn && -ret >= minPeakPct && (everyBar || !evaluatedOnce)) {
      evaluatedOnce = true;
      const f = featuresAt(candles, series, entryIndex, i, dir, entryPrice, atr);
      if (f && scoreFn(f) >= threshold) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'score' };
    }
    if (-ret >= adverseThresholdPct) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail_adverse' };
    if (peak >= minPeakPct && ret <= peak * 0.5) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail' };
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

const VARIANTS = [
  ['Без счёта (только трейл)', null, 0, false],
  ['Равные веса, порог 2', scoreEqual, 2, false],
  ['Равные веса, порог 3 (нынешний)', scoreEqual, 3, false],
  ['Равные веса, порог 4', scoreEqual, 4, false],
  ['ВЗВЕШЕННЫЕ, порог 3', scoreWeighted, 3, false],
  ['ВЗВЕШЕННЫЕ, порог 4', scoreWeighted, 4, false],
  ['ВЗВЕШЕННЫЕ, порог 5', scoreWeighted, 5, false],
  ['РАСШИРЕННЫЙ (8 призн.), порог 3', scoreExtended, 3, false],
  ['РАСШИРЕННЫЙ (8 призн.), порог 4', scoreExtended, 4, false],
  ['Равные, порог 3, оценка КАЖДЫЙ бар', scoreEqual, 3, true],
  ['ВЗВЕШЕННЫЕ, порог 4, оценка КАЖДЫЙ бар', scoreWeighted, 4, true],
];

console.log(`\n${'='.repeat(120)}`);
console.log('ТЮНИНГ РЕЙТИНГОВОЙ СИСТЕМЫ — всё ПОВЕРХ фильтра рынка (лучшая связка сессии), отложенный период');
console.log(`${'='.repeat(120)}\n`);
console.log('Вариант                                        | С ФИЛЬТРОМ рынка         | без фильтра');
console.log('-'.repeat(120));
for (const [label, scoreFn, threshold, everyBar] of VARIANTS) {
  const results = allEntries.map((e) => ({
    ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, scoreFn, threshold, everyBar),
    ticker: e.ticker, entryDate: e.entryDate, dir: e.dir, marketDown: e.marketDown,
  }));
  const filtered = results.filter((r) => !(r.dir === 1 && r.marketDown));
  const pYes = runPortfolioBacktest(toPortfolio(filtered), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  const pNo = runPortfolioBacktest(toPortfolio(results), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  const scoreExits = filtered.filter((r) => r.reason === 'score').length;
  console.log(
    `${label.padEnd(46)} | ${((pYes.totalReturnPct >= 0 ? '+' : '') + pYes.totalReturnPct.toFixed(1)).padStart(6)}% просад.${pYes.maxDrawdownPct.toFixed(1).padStart(5)}% срб.${String(scoreExits).padStart(3)} | `
    + `${((pNo.totalReturnPct >= 0 ? '+' : '') + pNo.totalReturnPct.toFixed(1)).padStart(6)}% просад.${pNo.maxDrawdownPct.toFixed(1).padStart(5)}%`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
