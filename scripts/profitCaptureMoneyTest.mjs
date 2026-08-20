// Денежная проверка рейтинговой системы фиксации прибыли (2026-08-16), собранной из
// scripts/profitCaptureCalibration.mjs (11 из 12 признаков подтвердились на holdout).
// Заменяет грубое правило "отдали 50% от пика" на систему очков.
//
// Веса ±1, включены только признаки с отклонением >=4 п.п. на проверке (та же
// дисциплина, что и в рейтинговой системе разворотов):
//   +1 (пора фиксировать): RSI на экстремуме, отрыв от EMA9 >3%, прибыль уже >5%,
//      верхняя треть Боллинджера, держим 10+ баров, резкий всплеск объёма >1.8×
//   -1 (ещё рано, держать): RSI резко упал (Δ<=-5), последние свечи замедлились,
//      держим совсем недолго (<=2 бара)
// Тестируем пороги 2/3/4 — поверх УЖЕ лучшей найденной базы (фильтр рынка + аварийный ×2,
// см. HANDOFF п.20-21, БЕЗ рейтинга разворота — он оказался избыточен поверх ×2).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-profitmoney-'));

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
const { rsi, macd, ema, sma, bollingerSeries } = await import(indicatorsUrl);

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

function profitScore(f) {
  let s = 0;
  if (f.rsiExtreme) s += 1;
  if (f.ema9Dist > 3) s += 1;
  if (f.currentFavPct > 5) s += 1;
  if (f.bbPos != null && f.bbPos > 0.85) s += 1;
  if (f.barsFromArm >= 10) s += 1;
  if (f.volRatio != null && f.volRatio > 1.8) s += 1;
  if (f.rsiChangeFromArm <= -5) s -= 1;
  if (f.avgRecentMove != null && f.avgRecentMove < 0.3 && f.barsFromArm >= 2) s -= 1;
  if (f.barsFromArm <= 2) s -= 1;
  return s;
}

const MAX_WINDOW = 120;
function simulate(candles, series, entryIndex, dir, entryPrice, atr, mode, profitThreshold) {
  const { closes, rsiS, bbS, ema9S } = series;
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 2; // новый дефолт ×2 (п.20)
  let peak = 0, armIndex = null;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    const barsHeld = i - entryIndex;

    if (peak >= minPeakPct && armIndex == null) armIndex = i;

    if (mode === 'score' && armIndex != null && ret > 0 && rsiS[i] != null && rsiS[armIndex] != null && bbS[i] && ema9S[i] != null) {
      const barsFromArm = i - armIndex;
      const rsiChangeFromArm = (rsiS[i] - rsiS[armIndex]) * dir;
      const rsiExtreme = dir === 1 ? rsiS[i] > 70 : rsiS[i] < 30;
      const bbPosCalc = (() => {
        const b = bbS[i];
        if (!b || b.upper === b.lower) return null;
        const raw = (closes[i] - b.lower) / (b.upper - b.lower);
        return dir === 1 ? raw : 1 - raw;
      })();
      const ema9Dist = ((closes[i] - ema9S[i]) / ema9S[i]) * 100 * dir;
      const volAvg = candles.slice(Math.max(0, i - 20), i).map((x) => x.volume).filter(Number.isFinite);
      const volRatio = volAvg.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
      const recentMoves = [];
      for (let m = Math.max(armIndex + 1, i - 2); m <= i; m++) {
        const prevClose = candles[m - 1].close;
        recentMoves.push(((candles[m].close - prevClose) / prevClose) * 100 * dir);
      }
      const avgRecentMove = recentMoves.length ? recentMoves.reduce((s, v) => s + v, 0) / recentMoves.length : null;

      const score = profitScore({ rsiExtreme, ema9Dist, currentFavPct: ret, bbPos: bbPosCalc, barsFromArm, volRatio, rsiChangeFromArm, avgRecentMove });
      if (score >= profitThreshold) return { pnlPct: ret, barsHeld, reason: 'profit_score' };
    }

    if (-ret >= adverseThresholdPct) return { pnlPct: ret, barsHeld, reason: 'trail_adverse' };
    if (peak >= minPeakPct && ret <= peak * 0.5) return { pnlPct: ret, barsHeld, reason: 'trail_giveback' };
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
  const series = { closes, rsiS: rsi(closes, 14), bbS: bollingerSeries(closes, 20, 2), ema9S: ema(closes, 9) };
  const atrS = atrSeries(candles, 14);
  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null || t.entryIndex < splitIndex) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;
    allEntries.push({ ticker, candles, series, entryIndex: t.entryIndex, dir, entryPrice: t.entryPrice, atr, entryDate: t.entryDate, marketDown: indexBelowSma50(new Date(t.entryDate)) === true });
  }
}

console.log(`\n${'='.repeat(115)}`);
console.log('РЕЙТИНГОВАЯ СИСТЕМА ФИКСАЦИИ ПРИБЫЛИ — поверх фильтра рынка + аварийный ×2, отложенный период');
console.log(`${'='.repeat(115)}\n`);
console.log('Вариант                          | Доходность | Просадка | Ср.выигрыш | Ср.убыток | Срабат.');
console.log('-'.repeat(115));
for (const [label, mode, threshold] of [
  ['Базовое: отдать 50% от пика', 'giveback', null],
  ['Рейтинг прибыли, порог >=2', 'score', 2],
  ['Рейтинг прибыли, порог >=3', 'score', 3],
  ['Рейтинг прибыли, порог >=4', 'score', 4],
]) {
  const results = allEntries.map((e) => ({ ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, mode, threshold), ticker: e.ticker, entryDate: e.entryDate, dir: e.dir, marketDown: e.marketDown }));
  const filtered = results.filter((r) => !(r.dir === 1 && r.marketDown));
  const p = runPortfolioBacktest(toPortfolio(filtered), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  const closed = filtered.filter((r) => !r.stillOpen);
  const wins = closed.filter((r) => r.pnlPct > 0), losses = closed.filter((r) => r.pnlPct <= 0);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0;
  const scoreExits = filtered.filter((r) => r.reason === 'profit_score').length;
  console.log(
    `${label.padEnd(33)} | ${((p.totalReturnPct >= 0 ? '+' : '') + p.totalReturnPct.toFixed(1)).padStart(6)}% | ${p.maxDrawdownPct.toFixed(1).padStart(5)}% | `
    + `${('+' + avgWin.toFixed(2) + '%').padStart(9)} | ${(avgLoss.toFixed(2) + '%').padStart(9)} | ${String(scoreExits).padStart(4)}`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
