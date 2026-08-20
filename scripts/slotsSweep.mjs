// Проверка гипотезы (2026-08-14): сигнальный выход не окупился, возможно, из-за
// конкуренции за освободившийся слот (архитектура «один слот на инструмент» + лимит
// одновременных позиций). Если слотов БОЛЬШЕ — ранний выход перестаёт быть проблемой,
// потому что освободившийся слот не отбирает капитал у более качественной сделки.
// Прогоняем те же варианты при разном числе слотов.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-slots-'));

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

const base = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null, stopType: 'none', takeType: 'none',
  trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1, trailEnabled: true,
};

const CONFIGS = [
  { name: 'Е. Трейл без сигнального', rules: { ...base, trailAdverseEnabled: true, trailAdverseMult: 3, signalExitEnabled: false } },
  { name: 'F. Трейл + сигнальный', rules: { ...base, trailAdverseEnabled: true, trailAdverseMult: 3, signalExitEnabled: true } },
];

const SLOT_CONFIGS = [
  { slots: 8, risk: 10 }, { slots: 12, risk: 7 }, { slots: 16, risk: 5 }, { slots: 21, risk: 4 },
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
const candlesByTicker = [];
for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);
  candlesByTicker.push({ ticker, candles });
}

// Прогоняем движок один раз на конфигурацию правил, портфель — много раз на разных слотах
const runsByConfig = {};
for (const cfg of CONFIGS) {
  const trainByTicker = [], testByTicker = [];
  for (const { ticker, candles } of candlesByTicker) {
    const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
    const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules });
    const test = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules, warmupBars: splitIndex });
    trainByTicker.push({ ticker, trades: train.trades });
    testByTicker.push({ ticker, trades: test.trades });
  }
  runsByConfig[cfg.name] = { trainByTicker, testByTicker };
}

console.log(`\n${'='.repeat(115)}`);
console.log('Гипотеза: помогает ли сигнальному выходу БОЛЬШЕЕ число слотов (меньше конкуренции за освободившийся слот)?');
console.log(`${'='.repeat(115)}\n`);
console.log('Слотов/риск  | Вариант                   | Обучение          | ОТЛОЖЕННЫЙ        | Пропущено сигн. | Худшая');
console.log('-'.repeat(115));
for (const sc of SLOT_CONFIGS) {
  for (const cfg of CONFIGS) {
    const { trainByTicker, testByTicker } = runsByConfig[cfg.name];
    const tr = runPortfolioBacktest(trainByTicker, { startingCapital: 100000, riskPerTradePct: sc.risk, maxConcurrentPositions: sc.slots });
    const te = runPortfolioBacktest(testByTicker, { startingCapital: 100000, riskPerTradePct: sc.risk, maxConcurrentPositions: sc.slots });
    console.log(
      `${String(sc.slots).padStart(2)} слот/${String(sc.risk).padStart(2)}% | ${cfg.name.padEnd(25)} | `
      + `${(tr.totalReturnPct >= 0 ? '+' : '') + tr.totalReturnPct.toFixed(1)}% просад.${tr.maxDrawdownPct.toFixed(1)}%`.padEnd(18) + ` | `
      + `${(te.totalReturnPct >= 0 ? '+' : '') + te.totalReturnPct.toFixed(1)}% просад.${te.maxDrawdownPct.toFixed(1)}%`.padEnd(18) + ` | `
      + `${String(te.skippedSignals).padStart(15)} | ${te.worstTrade.toFixed(1)}%`
    );
  }
  console.log('-'.repeat(115));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
