// Подбор множителя `trailAdverseMult` для нового симметричного трейла (2026-08-13).
// Раньше следящий выход был односторонним — фиксировал прибыль, но никогда не закрывал
// сделку, которая сразу пошла против входа и не вернулась (зависала до конца истории,
// исключалась из статистики). Починка: тот же ATR-порог, что и у прибыльной стороны,
// умноженный на trailAdverseMult — движение против входа должно быть в N раз больше
// "шумового" порога, прежде чем считается подтверждённым трендом против нас, а не шумом.
// Подбираем N по данным (то же самое честное сравнение train/holdout).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-adversesweep-'));

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

const base = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null, stopType: 'none', takeType: 'none',
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
};

const CONFIGS = [
  { name: 'Е0. Старое поведение (одностороннее)', rules: { ...base, trailAdverseEnabled: false } },
  { name: 'С2. Симметрично, ×2', rules: { ...base, trailAdverseEnabled: true, trailAdverseMult: 2 } },
  { name: 'С3. Симметрично, ×3 (новый дефолт)', rules: { ...base, trailAdverseEnabled: true, trailAdverseMult: 3 } },
  { name: 'С4. Симметрично, ×4', rules: { ...base, trailAdverseEnabled: true, trailAdverseMult: 4 } },
  { name: 'С6. Симметрично, ×6', rules: { ...base, trailAdverseEnabled: true, trailAdverseMult: 6 } },
];

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

const HOLDOUT_FRACTION = 0.2;

// Считаем ВСЕ сделки (закрытые по факту + открытые по mark-to-market) — честный номер,
// не тот, что раньше прятал зависшие позиции.
function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'closed').sort((a, b) => a.exitDate - b.exitDate);
  const open = trades.filter((t) => t.status !== 'closed');
  const all = [...closed, ...open];
  if (!all.length) return null;
  let equity = 100, peak = 100, maxDrawdownPct = 0;
  let wins = 0, grossWin = 0, grossLoss = 0, worst = 0;
  for (const t of closed) {
    equity *= 1 + t.pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }
  for (const t of all) {
    if (t.pnlPct > 0) { wins += 1; grossWin += t.pnlPct; } else { grossLoss += Math.abs(t.pnlPct); }
    worst = Math.min(worst, t.pnlPct);
  }
  const sumPnl = all.reduce((s, t) => s + t.pnlPct, 0);
  return {
    n: closed.length, openN: open.length, returnPct: equity - 100,
    winRateHonest: (wins / all.length) * 100,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity, worst, maxDrawdownPct,
    avgTradePnl: sumPnl / all.length, // арифметическое (не сложный процент) — честно сравнивает КАЧЕСТВО одной сделки между вариантами
  };
}

const results = {};
for (const cfg of CONFIGS) results[cfg.name] = { train: [], test: [] };

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  console.log(`${candles.length} свечей`);

  for (const cfg of CONFIGS) {
    const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules });
    const test = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules, warmupBars: splitIndex });
    const trainSum = summarize(train.trades);
    const testSum = summarize(test.trades);
    if (trainSum) results[cfg.name].train.push({ ticker, ...trainSum });
    if (testSum) results[cfg.name].test.push({ ticker, ...testSum });
  }
}

function aggregate(list) {
  if (!list.length) return null;
  const avgReturn = list.reduce((s, r) => s + r.returnPct, 0) / list.length;
  const positive = list.filter((r) => r.returnPct > 0).length;
  const worst = Math.min(...list.map((r) => r.worst));
  const avgDrawdown = list.reduce((s, r) => s + r.maxDrawdownPct, 0) / list.length;
  const avgWinRateHonest = list.reduce((s, r) => s + r.winRateHonest, 0) / list.length;
  const n = list.reduce((s, r) => s + r.n, 0);
  const openN = list.reduce((s, r) => s + r.openN, 0);
  const avgTradePnl = list.reduce((s, r) => s + r.avgTradePnl * (r.n + r.openN), 0) / list.reduce((s, r) => s + r.n + r.openN, 0);
  return { n, openN, avgReturn, positive, tickers: list.length, worst, avgDrawdown, avgWinRateHonest, avgTradePnl };
}

console.log(`\n${'='.repeat(120)}`);
console.log(`Подбор trailAdverseMult — Д1, ${TICKERS.length} инструментов, holdout ${HOLDOUT_FRACTION * 100}%`);
console.log(`Винрейт ЧЕСТНЫЙ (закрытые + открытые по mark-to-market вместе)`);
console.log(`${'='.repeat(120)}\n`);
console.log('Вариант                                 | Период | Закр. | Откр. | Ср.сделка(ариф) | Честн.винрейт | Слож.дох. | В плюсе | Худшая | Просадка');
console.log('-'.repeat(150));
for (const cfg of CONFIGS) {
  for (const period of ['train', 'test']) {
    const agg = aggregate(results[cfg.name][period]);
    const label = period === 'train' ? 'обучен' : 'ОТЛОЖ.';
    if (!agg) { console.log(`${cfg.name.padEnd(40)} | ${label} | нет сделок`); continue; }
    console.log(
      `${(period === 'train' ? cfg.name : '').padEnd(40)} | ${label} | ${String(agg.n).padStart(5)} | ${String(agg.openN).padStart(5)} | `
      + `${(agg.avgTradePnl >= 0 ? '+' : '') + agg.avgTradePnl.toFixed(3)}%`.padStart(15) + ` | `
      + `${agg.avgWinRateHonest.toFixed(1).padStart(6)}%      | ${(agg.avgReturn >= 0 ? '+' : '') + agg.avgReturn.toFixed(1).padStart(6)}% | `
      + `${agg.positive}/${agg.tickers}`.padStart(7) + ` | ${agg.worst.toFixed(1).padStart(6)}% | ${agg.avgDrawdown.toFixed(1).padStart(6)}%`
    );
  }
  console.log('-'.repeat(150));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
