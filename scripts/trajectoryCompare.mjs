// Идея трейдера (2026-08-14): записать "правильную" траекторию сделки после фигуры (как в
// среднем ведёт себя УСПЕШНАЯ сделка бар за баром) и сравнивать текущую сделку с ней — если
// сделка "отстаёт от графика" (набрала меньше половины того, что типичная выигрышная сделка
// набирает к этому же бару) — выходить.
//
// Методология: считаем среднюю траекторию ВЫИГРЫШНЫХ сделок (bar 1..20, % от входа,
// направление уже нормализовано) на ОБУЧАЮЩЕЙ половине — это и есть "правильный путь".
// Проверяем на ОТЛОЖЕННОЙ половине: если сделка к бару k набрала МЕНЬШЕ 50% от того, что
// типичная выигрышная сделка набирала к этому бару (и типичная траектория уже положительна
// к этому бару) — закрываем как "отстаёт от графика".
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-traj-'));

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

esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
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

const TRAJECTORY_BARS = 20;
const HOLDOUT_FRACTION = 0.2;

// Шаг 1: собираем входы + их фактические траектории на 6 лет истории по 21 тикеру.
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
  const atrS = atrSeries(candles, 14);

  const harvest = runBacktest({ candles: candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
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
      ticker, candles, entryIndex: t.entryIndex, dir, entryPrice: t.entryPrice, atr,
      entryDate: t.entryDate, isTest: t.entryIndex >= splitIndex, traj, won: t.pnlPct > 0,
    });
  }
}

// Шаг 2: "правильная траектория" — средняя ПО ВЫИГРЫШНЫМ сделкам (label win пришёл от
// классики 2%/4%, не от нашего механизма выхода — независимая оценка "куда обычно идёт
// удачная сделка"), считаем ТОЛЬКО на обучающей половине.
const trainWinning = allEntries.filter((e) => !e.isTest && e.won);
const typicalTrajectory = [];
for (let b = 0; b < TRAJECTORY_BARS; b++) {
  const vals = trainWinning.map((e) => e.traj[b]);
  typicalTrajectory.push(vals.reduce((s, v) => s + v, 0) / vals.length);
}
console.log(`\n"Правильная" траектория (обучение, ${trainWinning.length} выигрышных сделок), % от входа по барам:`);
console.log(typicalTrajectory.map((v) => v.toFixed(2)).join(', '));

// Шаг 3: симулируем на ОТЛОЖЕННЫХ входах — обычный трейл vs "отстаёт от графика"
const MAX_WINDOW = 120;
function simulate(candles, entryIndex, dir, entryPrice, atr, useTrajectory) {
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 3;
  let peak = 0;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    const barsHeld = i - entryIndex;

    if (useTrajectory && barsHeld <= TRAJECTORY_BARS) {
      const expected = typicalTrajectory[barsHeld - 1];
      if (expected > 0.3 && ret < expected * 0.5) {
        return { pnlPct: ret, barsHeld, reason: 'trajectory_lag' };
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
const resultsBase = [], resultsTraj = [];
const reasonCounts = {};
for (const e of testEntries) {
  const rBase = simulate(e.candles, e.entryIndex, e.dir, e.entryPrice, e.atr, false);
  const rTraj = simulate(e.candles, e.entryIndex, e.dir, e.entryPrice, e.atr, true);
  resultsBase.push({ ...rBase, ticker: e.ticker, entryDate: e.entryDate });
  resultsTraj.push({ ...rTraj, ticker: e.ticker, entryDate: e.entryDate });
  reasonCounts[rTraj.reason] = (reasonCounts[rTraj.reason] || 0) + 1;
}

function summarize(list) {
  const n = list.length;
  const wins = list.filter((r) => r.pnlPct > 0).length;
  return { n, winRate: (wins / n) * 100, avg: list.reduce((s, r) => s + r.pnlPct, 0) / n, worst: Math.min(...list.map((r) => r.pnlPct)) };
}

console.log(`\n${'='.repeat(100)}`);
console.log('ТРАЕКТОРИЯ: обычный трейл vs "отстаёт от графика удачной сделки"');
console.log(`${'='.repeat(100)}\n`);
for (const [label, list] of [['Обычный трейл', resultsBase], ['Проверка траектории', resultsTraj]]) {
  const s = summarize(list);
  const p = runPortfolioBacktest(toPortfolio(list), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  console.log(`${label}: n=${s.n}, винрейт ${s.winRate.toFixed(1)}%, ср.сделка ${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)}%, худшая ${s.worst.toFixed(1)}%`);
  console.log(`  Портфель: доходность ${(p.totalReturnPct >= 0 ? '+' : '') + p.totalReturnPct.toFixed(1)}%, просадка ${p.maxDrawdownPct.toFixed(1)}%\n`);
}
console.log('Причины закрытия (проверка траектории):', reasonCounts);

fs.rmSync(tmpDir, { recursive: true, force: true });
