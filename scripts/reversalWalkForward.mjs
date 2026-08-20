// Walk-forward проверка правила "СЧЁТ >=3 из 6" (2026-08-14) — единственный вариант за всю
// ветку "откат vs разворот", давший плюс на ОДНОМ конкретном holdout-разрезе (+0.5%,
// см. HANDOFF п.13). Правило фиксированное (веса не переобучаются под каждое окно — это
// не переподбор, а честная проверка устойчивости уже готового правила), поэтому можно
// просто прогнать его на НЕСКОЛЬКИХ последовательных отрезках истории и посмотреть,
// держится ли результат, или тот единственный плюс был удачей одного конкретного периода.
//
// Делим календарную историю на 5 равных отрезков. Правило проверяется на отрезках 2-5 —
// каждый следующий отрезок сравнивается с базовым трейлом на ТОМ ЖЕ отрезке.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-walkfwd-'));

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
const { rsi, ema, bollingerSeries } = await import(indicatorsUrl);

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
function featuresAt(candles, series, entryIndex, k, dir, entryPrice, atrEntry) {
  const { closes, rsiS, bbS, ema200S } = series;
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
  return {
    rsiChange: (rsiS[k] - rsiS[entryIndex]) * dir,
    closesOutsideBand, volRatio,
    structureBroken: swing != null ? (dir === 1 ? closes[k] < swing : closes[k] > swing) : false,
    adverseAtr: atrEntry > 0 ? (dir === 1 ? (entryPrice - barK.low) : (barK.high - entryPrice)) / atrEntry : null,
    bodyRatio: range > 0 ? Math.abs(barK.close - barK.open) / range : null,
    bodyAgainst: dir === 1 ? barK.close < barK.open : barK.close > barK.open,
  };
}
function reversalScore(f) {
  let s = 0;
  if (f.rsiChange <= -10) s += 1;
  if (f.structureBroken) s += 1;
  if (f.adverseAtr != null && f.adverseAtr > 1.5) s += 1;
  if (f.closesOutsideBand === 1) s += 1;
  if (f.volRatio != null && f.volRatio > 2) s += 1;
  if (f.bodyAgainst && f.bodyRatio != null && f.bodyRatio > 0.6) s += 1;
  return s;
}

const MAX_WINDOW = 120;
function simulate(candles, series, entryIndex, dir, entryPrice, atr, scoreThreshold) {
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 3;
  let peak = 0, evaluated = false;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    if (!evaluated && -ret >= minPeakPct) {
      evaluated = true;
      if (scoreThreshold != null) {
        const f = featuresAt(candles, series, entryIndex, i, dir, entryPrice, atr);
        if (f && reversalScore(f) >= scoreThreshold) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'reversal_signal' };
      }
    }
    if (-ret >= adverseThresholdPct) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail_adverse' };
    if (peak >= minPeakPct && ret <= peak * 0.5) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail' };
  }
  const last = candles[end];
  const finalPct = dir === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data' };
}

const allEntries = []; // { ticker, entryDate, dir, entryPrice, atr, candles, series, entryIndex }
let minDate = null, maxDate = null;

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);
  const closes = candles.map((c) => c.close);
  const series = { closes, rsiS: rsi(closes, 14), bbS: bollingerSeries(closes, 20, 2), ema200S: ema(closes, 200) };
  const atrS = atrSeries(candles, 14);

  const first = new Date(candles[0].date), last = new Date(candles[candles.length - 1].date);
  if (!minDate || first < minDate) minDate = first;
  if (!maxDate || last > maxDate) maxDate = last;

  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;
    allEntries.push({ ticker, entryDate: t.entryDate, dir, entryPrice: t.entryPrice, atr, candles, series, entryIndex: t.entryIndex });
  }
}

const NUM_WINDOWS = 5;
const totalMs = maxDate - minDate;
const boundaries = Array.from({ length: NUM_WINDOWS + 1 }, (_, i) => new Date(minDate.getTime() + (totalMs * i) / NUM_WINDOWS));

console.log(`\n${'='.repeat(115)}`);
console.log(`WALK-FORWARD: история ${minDate.toISOString().slice(0, 10)} — ${maxDate.toISOString().slice(0, 10)}, разбита на ${NUM_WINDOWS} равных отрезков`);
console.log('Правило "СЧЁТ>=3" НЕ переобучается на каждом окне — веса фиксированы, проверяем устойчивость уже готового правила');
console.log(`${'='.repeat(115)}\n`);

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

console.log('Окно                        | Базовый трейл          | СЧЁТ>=3                 | СЧЁТ>=2');
console.log('-'.repeat(115));
for (let w = 0; w < NUM_WINDOWS; w++) {
  const from = boundaries[w], to = boundaries[w + 1];
  const windowEntries = allEntries.filter((e) => new Date(e.entryDate) >= from && new Date(e.entryDate) < to);
  if (windowEntries.length < 15) { console.log(`Окно ${w + 1} (${from.toISOString().slice(0, 10)}–${to.toISOString().slice(0, 10)}) | мало сделок (${windowEntries.length})`); continue; }

  const results = { trail: [], s3: [], s2: [] };
  for (const e of windowEntries) {
    results.trail.push({ ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, null), ticker: e.ticker, entryDate: e.entryDate });
    results.s3.push({ ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, 3), ticker: e.ticker, entryDate: e.entryDate });
    results.s2.push({ ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, 2), ticker: e.ticker, entryDate: e.entryDate });
  }
  const pTrail = runPortfolioBacktest(toPortfolio(results.trail), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  const pS3 = runPortfolioBacktest(toPortfolio(results.s3), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  const pS2 = runPortfolioBacktest(toPortfolio(results.s2), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });

  const label = `Окно ${w + 1} (${from.toISOString().slice(0, 10)}–${to.toISOString().slice(0, 10)}, n=${windowEntries.length})`;
  console.log(
    `${label.padEnd(28)} | ${((pTrail.totalReturnPct >= 0 ? '+' : '') + pTrail.totalReturnPct.toFixed(1)).padStart(6)}% просад.${pTrail.maxDrawdownPct.toFixed(1).padStart(5)}% | `
    + `${((pS3.totalReturnPct >= 0 ? '+' : '') + pS3.totalReturnPct.toFixed(1)).padStart(6)}% просад.${pS3.maxDrawdownPct.toFixed(1).padStart(5)}%  | `
    + `${((pS2.totalReturnPct >= 0 ? '+' : '') + pS2.totalReturnPct.toFixed(1)).padStart(6)}% просад.${pS2.maxDrawdownPct.toFixed(1).padStart(5)}%`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
