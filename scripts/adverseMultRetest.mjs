// Переделка траектории (2026-08-14) + объединение со всем, что нашли за сессию:
// 1. МЕДИАНА вместо среднего для "типичной" траектории (среднее портил редкий быстрый
//    выброс, из-за чего порог был нереально строгим с самого первого бара).
// 2. Отставание засчитывается только если ДЕРЖИТСЯ N баров подряд (не один укол).
// 3. Отдельно считаем траекторию для сделок "почти сразу пошли не туда" (провальные) —
//    чтобы точнее отличать "отстаёт от графика победителя" от "уже похоже на проигрыш".
// 4. Компонент траектории добавлен ОДНИМ очком в существующую систему "счёт из 6" (стало
//    7), порог остаётся >=3 (найденный ранее оптимум) — не изобретаем заново, расширяем.
// 5. Каждый вариант прогоняется И с фильтром рынка (не входить в лонг, когда индекс сам
//    ниже SMA50), И без него — отдельная проверка, что даёт фильтр рынка сам по себе на
//    фоне уже лучшего найденного правила выхода.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-traj2-'));

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
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const TRAJECTORY_BARS = 20;
const LAG_CONSECUTIVE_BARS = 3; // отставание должно держаться 3 бара подряд, не один укол
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
  const series = { closes, rsiS: rsi(closes, 14), bbS: bollingerSeries(closes, 20, 2), ema200S: ema(closes, 200) };
  const atrS = atrSeries(candles, 14);

  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null || t.status !== 'closed') continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;
    const traj = [];
    const end = Math.min(candles.length - 1, t.entryIndex + TRAJECTORY_BARS);
    for (let i = t.entryIndex + 1; i <= end; i++) {
      const ret = dir === 1 ? ((candles[i].close - t.entryPrice) / t.entryPrice) * 100 : ((t.entryPrice - candles[i].close) / t.entryPrice) * 100;
      traj.push(ret);
    }
    while (traj.length < TRAJECTORY_BARS) traj.push(traj[traj.length - 1] ?? 0);
    allEntries.push({
      ticker, candles, series, entryIndex: t.entryIndex, dir, entryPrice: t.entryPrice, atr,
      entryDate: t.entryDate, isTest: t.entryIndex >= splitIndex, traj, won: t.pnlPct > 0,
      marketDown: indexBelowSma50(new Date(t.entryDate)) === true,
    });
  }
}

// "Правильная" (медианная) траектория ПОБЕДИТЕЛЕЙ и, отдельно, ПРОИГРАВШИХ — на обучении.
const trainWin = allEntries.filter((e) => !e.isTest && e.won);
const trainLose = allEntries.filter((e) => !e.isTest && !e.won);
const medianWinTraj = [], medianLoseTraj = [];
for (let b = 0; b < TRAJECTORY_BARS; b++) {
  medianWinTraj.push(median(trainWin.map((e) => e.traj[b])));
  medianLoseTraj.push(median(trainLose.map((e) => e.traj[b])));
}
console.log('\nМедианная траектория ПОБЕДИТЕЛЕЙ:', medianWinTraj.map((v) => v.toFixed(2)).join(', '));
console.log('Медианная траектория ПРОИГРАВШИХ:  ', medianLoseTraj.map((v) => v.toFixed(2)).join(', '));

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
function baseScore(f) {
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
// mode: 'trail' | 'score' | 'score+traj' | 'traj-median-3bar'
// Множитель аварийного порога — то самое число, что задаёт РАЗМЕР среднего убытка.
// Найдено 2026-08-16: типичный ATR ≈2.5% цены, ×3 = 7.5%, и средний убыток вышел −7.56% —
// то есть размер убытка определяется напрямую этой настройкой, а не рынком. Проверяем
// более узкие варианты ПОВЕРХ фильтра рынка (раньше подбирали без него).
const ADVERSE_MULTS = { 'a1.5': 1.5, 'a2': 2, 'a2.5': 2.5, 'trail': 3, 'score': 3, 'score+traj': 3, 'traj-median-3bar': 3 };
function simulate(candles, series, entryIndex, dir, entryPrice, atr, mode) {
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * (ADVERSE_MULTS[mode] ?? 3);
  let peak = 0, evaluated = false, lagStreak = 0;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    const barsHeld = i - entryIndex;

    if ((mode === 'score+traj' || mode === 'traj-median-3bar') && barsHeld <= TRAJECTORY_BARS) {
      const expectedWin = medianWinTraj[barsHeld - 1];
      const laggingBadly = expectedWin > 0.3 && ret < expectedWin * 0.5;
      lagStreak = laggingBadly ? lagStreak + 1 : 0;
      if (lagStreak >= LAG_CONSECUTIVE_BARS) return { pnlPct: ret, barsHeld, reason: 'trajectory_lag' };
    }

    if ((mode === 'score' || mode === 'score+traj' || mode === 'score2') && !evaluated && -ret >= minPeakPct) {
      evaluated = true;
      const f = featuresAt(candles, series, entryIndex, i, dir, entryPrice, atr);
      if (f) {
        let s = baseScore(f);
        if (mode === 'score+traj') {
          const expectedWin = medianWinTraj[Math.min(barsHeld, TRAJECTORY_BARS) - 1];
          if (expectedWin > 0.3 && ret < expectedWin * 0.5) s += 1; // 7-й компонент
        }
        if (s >= 3) return { pnlPct: ret, barsHeld, reason: 'score_reversal' };
      }
    }
    if (-ret >= adverseThresholdPct) return { pnlPct: ret, barsHeld, reason: 'trail_adverse' };
    if (peak >= minPeakPct && ret <= peak * 0.5) return { pnlPct: ret, barsHeld, reason: 'trail' };
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

const testEntries = allEntries.filter((e) => e.isTest);
const MODES = [
  ['Аварийный ×1.5', 'a1.5'], ['Аварийный ×2 (новый дефолт)', 'a2'], ['Аварийный ×2.5', 'a2.5'], ['Аварийный ×3 (был)', 'trail'],
  ['×2 + счёт из 6 (score, порог 3)', 'score2'],
];
ADVERSE_MULTS.score2 = 2;

console.log(`\n${'='.repeat(120)}`);
console.log('ДЕНЬГИ: каждый режим — С фильтром рынка и БЕЗ (портфель риск10%/8 слотов, отложенный период)');
console.log(`${'='.repeat(120)}\n`);
console.log('Вариант             | Ср.выигрыш | Ср.убыток | RR   | Матожид. | С ФИЛЬТРОМ рынка       | без фильтра');
console.log('-'.repeat(120));
for (const [label, mode] of MODES) {
  const results = testEntries.map((e) => ({ ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, mode), ticker: e.ticker, entryDate: e.entryDate, dir: e.dir, marketDown: e.marketDown }));
  const withFilter = results.filter((r) => !(r.dir === 1 && r.marketDown));

  const closed = withFilter.filter((r) => !r.stillOpen);
  const wins = closed.filter((r) => r.pnlPct > 0), losses = closed.filter((r) => r.pnlPct <= 0);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0;
  const rr = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;
  const expectancy = closed.length ? closed.reduce((s, r) => s + r.pnlPct, 0) / closed.length : 0;

  const pNo = runPortfolioBacktest(toPortfolio(results), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  const pYes = runPortfolioBacktest(toPortfolio(withFilter), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  console.log(
    `${label.padEnd(19)} | ${('+' + avgWin.toFixed(2) + '%').padStart(10)} | ${(avgLoss.toFixed(2) + '%').padStart(9)} | ${rr.toFixed(2).padStart(4)} | `
    + `${((expectancy >= 0 ? '+' : '') + expectancy.toFixed(3) + '%').padStart(8)} | `
    + `${((pYes.totalReturnPct >= 0 ? '+' : '') + pYes.totalReturnPct.toFixed(1)).padStart(6)}% просад.${pYes.maxDrawdownPct.toFixed(1).padStart(5)}% | `
    + `${((pNo.totalReturnPct >= 0 ? '+' : '') + pNo.totalReturnPct.toFixed(1)).padStart(6)}% просад.${pNo.maxDrawdownPct.toFixed(1).padStart(5)}%`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
