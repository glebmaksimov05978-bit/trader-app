// Quick check of the trader's idea (2026-08-12): does running the SAME entry/exit logic
// on the HOURLY timeframe shrink holding time to something reasonable (hours/a day or
// two instead of ~24 calendar days on D1), while keeping the trailing-exit edge?
//
// H1 is free (no Tinkoff token needed, see TIMEFRAMES.H1 in candles.js) but MOEX ISS only
// serves ~135 days of it — too short for a real train/holdout split, so this is a single-
// period sanity check, not a rigorous validation. Just enough to decide whether it's worth
// building real UI support for it on the Бэктест page.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-h1-'));

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
  onSignalLoss: false, maxBars: null,
  trailEnabled: false, trailGiveBackPct: 50, trailMinPeakPct: 1, trailPerPattern: false,
};
const CONFIGS = [
  { name: 'A. Стоп 2% / тейк 4% (классика)', rules: { ...base, stopType: 'pct', stopPct: 2, takeType: 'pct', takePct: 4 } },
  { name: 'Е. Без стопа, только следящий', rules: { ...base, stopType: 'none', takeType: 'none', trailEnabled: true } },
];

const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' }, { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' }, { ticker: 'ROSN', instrumentType: 'stock' },
  { ticker: 'NVTK', instrumentType: 'stock' }, { ticker: 'TATN', instrumentType: 'stock' },
  { ticker: 'CHMF', instrumentType: 'stock' }, { ticker: 'MGNT', instrumentType: 'stock' },
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
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

function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  if (!closed.length) return null;
  let equity = 100, peak = 100, maxDrawdownPct = 0;
  let wins = 0, worst = 0, totalBars = 0;
  for (const t of closed) {
    equity *= 1 + t.pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    if (t.pnlPct > 0) wins += 1;
    worst = Math.min(worst, t.pnlPct);
    totalBars += t.barsHeld || 0;
  }
  return {
    n: closed.length, returnPct: equity - 100, winRate: (wins / closed.length) * 100,
    worst, maxDrawdownPct, avgHoldHours: totalBars / closed.length, // 1 bar = 1 hour on H1
  };
}

const results = {};
for (const cfg of CONFIGS) results[cfg.name] = [];

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'H1', lookbackDays: 135 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log(`мало данных (${candles?.length ?? 0} баров)`); continue; }
  console.log(`${candles.length} часовых баров (~${Math.round(candles.length / 7)} торговых дней)`);

  for (const cfg of CONFIGS) {
    const run = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 60, exitRules: cfg.rules });
    const sum = summarize(run.trades);
    if (sum) results[cfg.name].push({ ticker, ...sum });
  }
}

function aggregate(list) {
  if (!list.length) return null;
  const n = list.reduce((s, r) => s + r.n, 0);
  const wins = list.reduce((s, r) => s + (r.winRate / 100) * r.n, 0);
  const avgReturn = list.reduce((s, r) => s + r.returnPct, 0) / list.length;
  const positive = list.filter((r) => r.returnPct > 0).length;
  const worst = Math.min(...list.map((r) => r.worst));
  const avgDrawdown = list.reduce((s, r) => s + r.maxDrawdownPct, 0) / list.length;
  const avgHoldHours = list.reduce((s, r) => s + r.avgHoldHours, 0) / list.length;
  return { n, winRate: (wins / n) * 100, avgReturn, positive, tickers: list.length, worst, avgDrawdown, avgHoldHours };
}

console.log(`\n${'='.repeat(90)}`);
console.log(`Часовой график (H1), ~135 дней истории, БЕЗ holdout (данных мало) — только прикидка`);
console.log(`${'='.repeat(90)}\n`);
console.log('Вариант                          | Сделок | Винрейт | Ср.дох. | В плюсе | Худшая | Просадка | Ср.часов (~дней)');
console.log('-'.repeat(110));
for (const cfg of CONFIGS) {
  const agg = aggregate(results[cfg.name]);
  if (!agg) { console.log(`${cfg.name.padEnd(33)} | нет сделок`); continue; }
  console.log(
    `${cfg.name.padEnd(33)} | ${String(agg.n).padStart(6)} | ${agg.winRate.toFixed(1).padStart(6)}% | `
    + `${(agg.avgReturn >= 0 ? '+' : '') + agg.avgReturn.toFixed(1).padStart(6)}% | ${agg.positive}/${agg.tickers}`.padStart(7)
    + ` | ${agg.worst.toFixed(1)}% | ${agg.avgDrawdown.toFixed(1)}% | ${agg.avgHoldHours.toFixed(1)}ч (~${(agg.avgHoldHours / 7).toFixed(1)}д)`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
