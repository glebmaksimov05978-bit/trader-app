// Денежная проверка рейтинговой системы (2026-08-14) — веса и признаки взяты из
// scripts/reversalScoreSystem.mjs (обучены ТОЛЬКО на старой половине D1-истории, см.
// HANDOFF). Здесь — не повторный поиск признаков, а честная проверка: если добавить это
// правило поверх обычного трейла (выходим раньше при score>=4, "подтверждённый разворот"),
// становится ли лучше по РЕАЛЬНЫМ деньгам, через тот же портфельный режим, что и раньше.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-scoremoney-'));

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

// Веса из scripts/reversalScoreSystem.mjs, обученные на старой половине D1 (см. HANDOFF).
const SCORE_THRESHOLD = 4; // "score>=4" — там, где на holdout доля отката падала до 17-27%
function computeScore(feat) {
  let s = 0;
  if (feat.ema200Broken) s += 1;
  if (feat.closesOutsideBand >= 2) s += 1;
  if (feat.rsiChange <= -15) s += 1;
  if (feat.closesOutsideBand === 1) s += 1;
  if (feat.volRatio != null && feat.volRatio > 2) s += 1;
  if (feat.bbPosChange != null && feat.bbPosChange <= -0.3) s += 1;
  if (feat.rsiChange <= -10) s += 1;
  if (feat.bandSlope != null && feat.bandSlope < -0.5) s += 1;
  if (feat.rsiLevel != null && feat.rsiLevel < 40) s += 1;
  if (Math.abs(feat.rsiChange) <= 3) s -= 1;
  return s;
}

const MAX_WINDOW = 120;

function simulateWithScore(candles, series, entryIndex, direction, entryPrice, atr) {
  const { closes, rsiS, macdS, bbS, atrS, volumes } = series;
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 3; // блант-подстраховка ×3, как обычно
  let peakFavorablePct = 0;
  let scoreEvaluated = false;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  const entryEma200 = series.ema200S[entryIndex];

  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorableHigh = direction === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peakFavorablePct = Math.max(peakFavorablePct, favorableHigh);
    const closeReturnPct = direction === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;

    // Score-выход: оцениваем ОДИН РАЗ, в момент первого пересечения шумового порога
    // (та же точка, где обучалась система) — не на каждом баре.
    if (!scoreEvaluated && -closeReturnPct >= minPeakPct) {
      scoreEvaluated = true;
      if (rsiS[i] != null && rsiS[entryIndex] != null && bbS[i] && series.ema200S[i] != null) {
        let closesOutsideBand = 0;
        for (let m = entryIndex + 1; m <= i; m++) {
          const b = bbS[m];
          if (!b) continue;
          if (direction === 1 ? closes[m] < b.lower : closes[m] > b.upper) closesOutsideBand += 1;
        }
        const bbPosAt = (idx) => {
          const b = bbS[idx];
          if (!b || b.upper === b.lower) return null;
          const raw = (closes[idx] - b.lower) / (b.upper - b.lower);
          return direction === 1 ? raw : 1 - raw;
        };
        const bandSlope = (() => {
          const f = bbS[Math.max(0, i - 5)], t = bbS[i];
          if (!f || !t) return null;
          const fv = direction === 1 ? f.lower : f.upper, tv = direction === 1 ? t.lower : t.upper;
          return ((tv - fv) / fv) * 100 * direction;
        })();
        const volAvg = volumes.slice(Math.max(0, i - 20), i).filter(Number.isFinite);
        const volRatio = volAvg.length && Number.isFinite(volumes[i]) ? volumes[i] / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
        const ema200Broken = entryEma200 != null && series.ema200S[i] != null
          ? (((closes[entryIndex] - entryEma200) / entryEma200) * direction > 0) && (((closes[i] - series.ema200S[i]) / series.ema200S[i]) * direction < 0)
          : false;

        const score = computeScore({
          ema200Broken, closesOutsideBand,
          rsiChange: (rsiS[i] - rsiS[entryIndex]) * direction,
          volRatio, bbPosChange: (bbPosAt(entryIndex) != null && bbPosAt(i) != null) ? bbPosAt(i) - bbPosAt(entryIndex) : null,
          bandSlope, rsiLevel: rsiS[i],
        });
        if (score >= SCORE_THRESHOLD) {
          return { pnlPct: closeReturnPct, barsHeld: i - entryIndex, reason: 'score_reversal', score };
        }
      }
    }

    // Обычный трейл (прибыльная сторона + блант-×3 подстраховка) — если score не признал разворот.
    if (-closeReturnPct >= adverseThresholdPct) return { pnlPct: closeReturnPct, barsHeld: i - entryIndex, reason: 'trail_adverse' };
    if (peakFavorablePct >= minPeakPct && closeReturnPct <= peakFavorablePct * 0.5) return { pnlPct: closeReturnPct, barsHeld: i - entryIndex, reason: 'trail' };
  }
  const last = candles[end];
  const finalPct = direction === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data' };
}

function simulateOurTrail(candles, entryIndex, direction, entryPrice, atr) {
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 3;
  let peakFavorablePct = 0;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorableHigh = direction === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peakFavorablePct = Math.max(peakFavorablePct, favorableHigh);
    const closeReturnPct = direction === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    if (-closeReturnPct >= adverseThresholdPct) return { pnlPct: closeReturnPct, barsHeld: i - entryIndex, reason: 'trail_adverse' };
    if (peakFavorablePct >= minPeakPct && closeReturnPct <= peakFavorablePct * 0.5) return { pnlPct: closeReturnPct, barsHeld: i - entryIndex, reason: 'trail' };
  }
  const last = candles[end];
  const finalPct = direction === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data' };
}

const HOLDOUT_FRACTION = 0.2;
const resultsScoreTrain = [], resultsScoreTest = [], resultsTrailTrain = [], resultsTrailTest = [];
const reasonCounts = {};

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
    closes, rsiS: rsi(closes, 14), macdS: macd(closes).histogram,
    bbS: bollingerSeries(closes, 20, 2), atrS: atrSeries(candles, 14),
    ema200S: ema(closes, 200), volumes: candles.map((c) => c.volume),
  };

  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atrAt = series.atrS[t.entryIndex - 1] ?? series.atrS[t.entryIndex];
    if (!atrAt) continue;
    const isTest = t.entryIndex >= splitIndex;
    const sc = simulateWithScore(candles, series, t.entryIndex, dir, t.entryPrice, atrAt);
    const tr = simulateOurTrail(candles, t.entryIndex, dir, t.entryPrice, atrAt);
    (isTest ? resultsScoreTest : resultsScoreTrain).push({ ...sc, ticker, entryDate: t.entryDate });
    (isTest ? resultsTrailTest : resultsTrailTrain).push({ ...tr, ticker, entryDate: t.entryDate });
    if (isTest) reasonCounts[sc.reason] = (reasonCounts[sc.reason] || 0) + 1;
  }
}

function summarize(list) {
  const n = list.length;
  const wins = list.filter((r) => r.pnlPct > 0).length;
  const avg = list.reduce((s, r) => s + r.pnlPct, 0) / n;
  const worst = Math.min(...list.map((r) => r.pnlPct));
  return { n, winRate: (wins / n) * 100, avg, worst };
}

console.log(`\n${'='.repeat(105)}`);
console.log('Рейтинговая система (score>=4 -> ранний выход) vs обычный трейл — на ОДНИХ И ТЕХ ЖЕ входах');
console.log(`${'='.repeat(105)}\n`);
for (const [label, tr, te] of [['Обычный трейл', resultsTrailTrain, resultsTrailTest], ['Рейтинговая система', resultsScoreTrain, resultsScoreTest]]) {
  const strTrain = summarize(tr), strTest = summarize(te);
  console.log(`${label}:`);
  console.log(`  Обучение: n=${strTrain.n}, винрейт ${strTrain.winRate.toFixed(1)}%, ср.сделка ${(strTrain.avg >= 0 ? '+' : '') + strTrain.avg.toFixed(3)}%, худшая ${strTrain.worst.toFixed(1)}%`);
  console.log(`  ОТЛОЖ.:   n=${strTest.n}, винрейт ${strTest.winRate.toFixed(1)}%, ср.сделка ${(strTest.avg >= 0 ? '+' : '') + strTest.avg.toFixed(3)}%, худшая ${strTest.worst.toFixed(1)}%\n`);
}
console.log('Причины закрытия (рейтинговая система, отложенный период):', reasonCounts);

// Портфельный честный расчёт денег — конвертируем в формат trades для runPortfolioBacktest
function toPortfolioTrades(list) {
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

console.log(`\n${'='.repeat(105)}`);
console.log('ЧЕСТНЫЕ ДЕНЬГИ (портфель: риск 10% / до 8 позиций)');
console.log(`${'='.repeat(105)}\n`);
for (const [label, list] of [['Обычный трейл', resultsTrailTest], ['Рейтинговая система', resultsScoreTest]]) {
  const p = runPortfolioBacktest(toPortfolioTrades(list), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  console.log(`${label}: доходность ${(p.totalReturnPct >= 0 ? '+' : '') + p.totalReturnPct.toFixed(1)}%, просадка ${p.maxDrawdownPct.toFixed(1)}%, худшая ${p.worstTrade.toFixed(1)}%, закрыто ${p.closedTrades}, открыто ${p.openTrades}, пропущено ${p.skippedSignals}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
