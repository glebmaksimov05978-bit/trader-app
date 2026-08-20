// Честная проверка идеи "охлаждения" (2026-08-17) — трейдер справедливо не поверил
// одному разрезу (7 дней дало лучший результат случайно один раз). Проверяем на 5
// последовательных отрезках истории, как делали для рейтинга разворотов
// (scripts/reversalWalkForward.mjs) — держится ли эффект, или это была удача.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-cooldownwf-'));

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

function runPortfolioWithCooldown(perTicker, options = {}) {
  const { startingCapital = 100000, riskPerTradePct = 10, maxConcurrentPositions = 8, cooldownBars = 0 } = options;
  const events = [];
  for (const { ticker, trades } of perTicker) {
    for (const t of trades) {
      if (!t.entryDate) continue;
      const exitDate = t.status === 'closed' ? t.exitDate : null;
      events.push({ type: 'entry', date: new Date(t.entryDate), ticker, trade: t });
      if (exitDate) events.push({ type: 'exit', date: new Date(exitDate), ticker, trade: t });
    }
  }
  events.sort((a, b) => a.date - b.date || (a.type === 'exit' ? -1 : 1));
  let equity = startingCapital, peak = equity, maxDrawdownPct = 0;
  const open = new Map();
  const lastExitByTicker = new Map();
  let closedTrades = 0, worstTrade = 0;
  for (const ev of events) {
    if (ev.type === 'exit') {
      const allocated = open.get(ev.trade);
      if (allocated == null) continue;
      open.delete(ev.trade);
      equity += allocated * (ev.trade.pnlPct / 100);
      closedTrades += 1;
      worstTrade = Math.min(worstTrade, ev.trade.pnlPct);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
      lastExitByTicker.set(ev.ticker, ev.date);
    } else {
      if (open.size >= maxConcurrentPositions) continue;
      if (cooldownBars > 0) {
        const lastExit = lastExitByTicker.get(ev.ticker);
        if (lastExit && (ev.date - lastExit) / 86400000 < cooldownBars) continue;
      }
      open.set(ev.trade, equity * (riskPerTradePct / 100));
    }
  }
  let mtmEquity = equity;
  for (const [trade, allocated] of open) { mtmEquity += allocated * (trade.pnlPct / 100); worstTrade = Math.min(worstTrade, trade.pnlPct); }
  return { totalReturnPct: ((mtmEquity - startingCapital) / startingCapital) * 100, maxDrawdownPct, closedTrades };
}

const STRATEGY = {
  id: 'patterns_levels', name: 'Фигуры разворота + уровень', readinessThreshold: 75,
  conditions: [
    { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
    { id: 'near_support', enabled: true, param: 1, direction: 'long' },
    { id: 'near_resistance', enabled: true, param: 1, direction: 'short' },
    { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
    { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
  ], customConditions: [],
};
const RULES = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null, stopType: 'none', takeType: 'none',
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
  trailAdverseEnabled: true, trailAdverseMult: 2,
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

const perTickerTrades = [];
let minDate = null, maxDate = null;
for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);
  const first = new Date(candles[0].date), last = new Date(candles[candles.length - 1].date);
  if (!minDate || first < minDate) minDate = first;
  if (!maxDate || last > maxDate) maxDate = last;
  const run = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: RULES });
  perTickerTrades.push({ ticker, trades: run.trades });
}

const NUM_WINDOWS = 5;
const totalMs = maxDate - minDate;
const boundaries = Array.from({ length: NUM_WINDOWS + 1 }, (_, i) => new Date(minDate.getTime() + (totalMs * i) / NUM_WINDOWS));

console.log(`\n${'='.repeat(115)}`);
console.log(`WALK-FORWARD ОХЛАЖДЕНИЯ: история ${minDate.toISOString().slice(0, 10)} — ${maxDate.toISOString().slice(0, 10)}, 5 отрезков`);
console.log(`${'='.repeat(115)}\n`);
console.log('Окно                          | Без охлажд.      | 3 дня            | 7 дней           | 15 дней');
console.log('-'.repeat(115));

for (let w = 0; w < NUM_WINDOWS; w++) {
  const from = boundaries[w], to = boundaries[w + 1];
  const windowTrades = perTickerTrades.map(({ ticker, trades }) => ({
    ticker, trades: trades.filter((t) => t.entryDate && new Date(t.entryDate) >= from && new Date(t.entryDate) < to),
  })).filter((x) => x.trades.length);
  const totalN = windowTrades.reduce((s, x) => s + x.trades.length, 0);
  if (totalN < 15) { console.log(`Окно ${w + 1} — мало сделок (${totalN})`); continue; }

  const results = [0, 3, 7, 15].map((cd) => runPortfolioWithCooldown(windowTrades, { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8, cooldownBars: cd }));
  const label = `Окно ${w + 1} (${from.toISOString().slice(0, 10)}–${to.toISOString().slice(0, 10)}, n=${totalN})`;
  console.log(
    `${label.padEnd(30)} | ${((results[0].totalReturnPct >= 0 ? '+' : '') + results[0].totalReturnPct.toFixed(1)).padStart(6)}% dd${results[0].maxDrawdownPct.toFixed(1).padStart(5)}% | `
    + `${((results[1].totalReturnPct >= 0 ? '+' : '') + results[1].totalReturnPct.toFixed(1)).padStart(6)}% dd${results[1].maxDrawdownPct.toFixed(1).padStart(5)}% | `
    + `${((results[2].totalReturnPct >= 0 ? '+' : '') + results[2].totalReturnPct.toFixed(1)).padStart(6)}% dd${results[2].maxDrawdownPct.toFixed(1).padStart(5)}% | `
    + `${((results[3].totalReturnPct >= 0 ? '+' : '') + results[3].totalReturnPct.toFixed(1)).padStart(6)}% dd${results[3].maxDrawdownPct.toFixed(1).padStart(5)}%`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
