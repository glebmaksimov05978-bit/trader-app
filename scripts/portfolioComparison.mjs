// Проверка портфельного слоя (2026-08-13): режет ли распределение капитала между
// несколькими одновременными позициями ту самую проблему, которую нашли — что ЛЮБОЙ
// ранний выход (стоп, симметричный трейл) портит результат из-за модели "весь депозит в
// одну сделку". Сигналы входа/выхода НЕ меняются (тот же runBacktest на каждый тикер) —
// меняется только КАК распределяются деньги между уже принятыми решениями.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-portfolio-'));

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

const RULES = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null, stopType: 'none', takeType: 'none',
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
  trailAdverseEnabled: true, trailAdverseMult: 3,
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

const HOLDOUT_FRACTION = 0.2;
const trainByTicker = [];
const testByTicker = [];

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  console.log(`${candles.length} свечей`);

  const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY, timeframeMinutes: 1440, exitRules: RULES });
  const test = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: RULES, warmupBars: splitIndex });
  trainByTicker.push({ ticker, trades: train.trades });
  testByTicker.push({ ticker, trades: test.trades });
}

// "Старое поведение" для сравнения: сумма отдельных сложнопроцентных доходностей по
// каждому тикеру, усреднённая — то самое число, что мы показывали раньше (не портфель,
// каждый инструмент как будто торговался отдельным депозитом).
function isolatedAvgReturn(byTicker) {
  const rets = byTicker.map(({ trades }) => {
    const closed = trades.filter((t) => t.status === 'closed').sort((a, b) => a.exitDate - b.exitDate);
    let eq = 100;
    for (const t of closed) eq *= 1 + t.pnlPct / 100;
    return eq - 100;
  });
  return rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : null;
}

console.log(`\n${'='.repeat(110)}`);
console.log('Портфельный режим: капитал ОБЩИЙ на все инструменты, доля на сделку + лимит одновременных позиций');
console.log(`${'='.repeat(110)}\n`);

const isolatedTrain = isolatedAvgReturn(trainByTicker);
const isolatedTest = isolatedAvgReturn(testByTicker);
console.log(`СТАРОЕ (каждый инструмент как отдельный депозит, усреднено): обучение ${isolatedTrain.toFixed(1)}%, отложено ${isolatedTest.toFixed(1)}%\n`);

const CONFIGS = [
  { name: 'риск 5% / до 10 позиций', riskPerTradePct: 5, maxConcurrentPositions: 10 },
  { name: 'риск 10% / до 8 позиций', riskPerTradePct: 10, maxConcurrentPositions: 8 },
  { name: 'риск 15% / до 5 позиций', riskPerTradePct: 15, maxConcurrentPositions: 5 },
  { name: 'риск 20% / до 3 позиций', riskPerTradePct: 20, maxConcurrentPositions: 3 },
];

console.log('Вариант                     | Период | Доходность | Просадка | Закрыто | Открыто | Пропущено сигналов | Худшая сделка');
console.log('-'.repeat(120));
for (const cfg of CONFIGS) {
  for (const [label, byTicker] of [['обучен', trainByTicker], ['ОТЛОЖ.', testByTicker]]) {
    const r = runPortfolioBacktest(byTicker, { startingCapital: 100000, riskPerTradePct: cfg.riskPerTradePct, maxConcurrentPositions: cfg.maxConcurrentPositions });
    console.log(
      `${(label === 'обучен' ? cfg.name : '').padEnd(28)} | ${label} | `
      + `${(r.totalReturnPct >= 0 ? '+' : '') + r.totalReturnPct.toFixed(1)}%`.padStart(10) + ` | `
      + `${r.maxDrawdownPct.toFixed(1)}%`.padStart(8) + ` | ${String(r.closedTrades).padStart(7)} | ${String(r.openTrades).padStart(7)} | `
      + `${String(r.skippedSignals).padStart(19)} | ${r.worstTrade.toFixed(1)}%`
    );
  }
  console.log('-'.repeat(120));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
