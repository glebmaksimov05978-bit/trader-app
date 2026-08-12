// Multi-instrument comparison of EXIT RULE configurations (roadmap item #2 —
// "мультиинструментальный бэктест" — applied to the specific question the trader raised
// on 2026-08-11: is a 2%-safety-stop + trailing "movement exhausted" exit actually better
// than the classic fixed stop/take, once you look at more than one ticker?).
//
// The browser page runs one ticker at a time, which is how we ended up drawing
// conclusions from 3 out-of-sample trades. This runs the SAME runBacktest() engine across
// many tickers and both in-sample/out-of-sample halves, so the comparison rests on
// hundreds of trades instead of a handful.
//
// Run: node scripts/exitRulesComparison.mjs
// Needs network access to iss.moex.com. Reads production sources directly (same esmify
// trick as goldenImportTests.mjs / patternCalibration.mjs) — never a hand-copied strategy.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-exitcmp-'));

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

// Reconstruction of the trader's live "Фигуры разворота + уровень" strategy, matching
// what the Бэктест page shows for it (5 conditions, readiness threshold 75%).
const STRATEGY = {
  id: 'patterns_levels',
  name: 'Фигуры разворота + уровень',
  readinessThreshold: 75,
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
  { name: 'Б. Стоп за структурой / тейк 4%', rules: { ...base, stopType: 'structure', takeType: 'pct', takePct: 4 } },
  { name: 'В. Стоп за структурой + следящий', rules: { ...base, stopType: 'structure', takeType: 'none', trailEnabled: true } },
  // Идея трейдера (2026-08-11): страховочный стоп 2%, а обычный выход — по выдыханию.
  { name: 'Г. Стоп 2% (страховка) + следящий', rules: { ...base, stopType: 'pct', stopPct: 2, takeType: 'none', trailEnabled: true } },
  { name: 'Д. Стоп 4% (страховка) + следящий', rules: { ...base, stopType: 'pct', stopPct: 4, takeType: 'none', trailEnabled: true } },
  { name: 'Е. Без стопа, только следящий', rules: { ...base, stopType: 'none', takeType: 'none', trailEnabled: true } },
  // Три доп. проверки, запрошенные трейдером 2026-08-11:
  // 1) где именно проходит точка перелома у страховочного стопа (2%/4% в минус — где он
  //    перестаёт мешать следящему выходу и уходит в плюс).
  { name: 'Ж. Стоп 6% (страховка) + следящий', rules: { ...base, stopType: 'pct', stopPct: 6, takeType: 'none', trailEnabled: true } },
  { name: 'З. Стоп 8% (страховка) + следящий', rules: { ...base, stopType: 'pct', stopPct: 8, takeType: 'none', trailEnabled: true } },
  // 2) своя доля отката для каждой фигуры вместо одного общего числа — на большой
  //    выборке, а не только вручную на одном тикере.
  { name: 'И. Без стопа + следящий (своя доля по фигуре)', rules: { ...base, stopType: 'none', takeType: 'none', trailEnabled: true, trailPerPattern: true } },
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

// Один конкретный сетевой сбой не должен выбрасывать инструмент из выборки целиком —
// реальный кейс 2026-08-11, когда ровно 2 из 11 тикеров отвалились по сети именно в
// момент запроса (сеть у трейдера при этом работала нормально — отдельный канал).
async function fetchWithRetry(args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchDailyCandles(args); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw lastErr;
}

const HOLDOUT_FRACTION = 0.2;

function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  if (!closed.length) return null;
  let equity = 100;
  let wins = 0, grossWin = 0, grossLoss = 0, worst = 0;
  for (const t of closed) {
    equity *= 1 + t.pnlPct / 100;
    if (t.pnlPct > 0) { wins += 1; grossWin += t.pnlPct; } else { grossLoss += Math.abs(t.pnlPct); }
    worst = Math.min(worst, t.pnlPct);
  }
  return {
    n: closed.length, returnPct: equity - 100,
    winRate: (wins / closed.length) * 100,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    worst,
  };
}

// Вторая стратегия — проверка, специфичен ли эффект следящего выхода для "Фигуры
// разворота + уровень", или он работает так же на другой логике входа. Реконструкция
// "Выход по уровням S/R + Фигуры" (та самая, где чинили противоречивую логику 2026-08-09:
// цена у поддержки + RSI ниже 50 + выше EMA200, то есть откат к поддержке ВНУТРИ
// восходящего тренда).
const STRATEGY2 = {
  id: 'sr_levels_patterns',
  name: 'Выход по уровням S/R + Фигуры',
  readinessThreshold: 75,
  conditions: [
    { id: 'near_support', enabled: true, param: 1, direction: 'long' },
    { id: 'pattern_confirmed', enabled: true, param: 65, direction: 'both' },
    { id: 'market_trending', enabled: true, param: null, direction: 'both' },
    { id: 'rsi_below', enabled: true, param: 50, direction: 'long' },
    { id: 'price_above_ema200', enabled: true, param: null, direction: 'long' },
  ],
  customConditions: [],
};
// Только два самых показательных варианта — полный список на 21 тикере занял бы ещё
// столько же времени, а вопрос узкий: "работает ли ТА ЖЕ идея на другой стратегии".
const STRATEGY2_CONFIGS = [
  CONFIGS.find((c) => c.name.startsWith('A.')),
  CONFIGS.find((c) => c.name.startsWith('Е.')),
];

const results = {};
for (const cfg of CONFIGS) results[cfg.name] = { train: [], test: [], instrumentType: {} };
const results2 = {};
for (const cfg of STRATEGY2_CONFIGS) results2[cfg.name] = { train: [], test: [] };

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка после 3 попыток: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  console.log(`${candles.length} свечей`);

  for (const cfg of CONFIGS) {
    const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules });
    const test = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules, warmupBars: splitIndex });
    const trainSum = summarize(train.trades);
    const testSum = summarize(test.trades);
    if (trainSum) results[cfg.name].train.push({ ticker, instrumentType, ...trainSum });
    if (testSum) results[cfg.name].test.push({ ticker, instrumentType, ...testSum });
  }

  for (const cfg of STRATEGY2_CONFIGS) {
    const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY2, timeframeMinutes: 1440, exitRules: cfg.rules });
    const test = runBacktest({ candles, strategy: STRATEGY2, timeframeMinutes: 1440, exitRules: cfg.rules, warmupBars: splitIndex });
    const trainSum = summarize(train.trades);
    const testSum = summarize(test.trades);
    if (trainSum) results2[cfg.name].train.push({ ticker, ...trainSum });
    if (testSum) results2[cfg.name].test.push({ ticker, ...testSum });
  }
}

function aggregate(list) {
  if (!list.length) return null;
  const n = list.reduce((s, r) => s + r.n, 0);
  const wins = list.reduce((s, r) => s + (r.winRate / 100) * r.n, 0);
  const avgReturn = list.reduce((s, r) => s + r.returnPct, 0) / list.length;
  const positive = list.filter((r) => r.returnPct > 0).length;
  const worst = Math.min(...list.map((r) => r.worst));
  return {
    n, winRate: (wins / n) * 100, avgReturn, positive, tickers: list.length, worst,
  };
}

console.log(`\n${'='.repeat(100)}`);
console.log(`Сравнение правил выхода — стратегия «${STRATEGY.name}», ${TICKERS.length} инструментов, ~6 лет истории`);
console.log(`${'='.repeat(100)}\n`);
console.log('Вариант                                   | Период  | Сделок | Винрейт | Ср.дох. | В плюсе | Худшая сделка');
console.log('-'.repeat(100));
for (const cfg of CONFIGS) {
  for (const period of ['train', 'test']) {
    const agg = aggregate(results[cfg.name][period]);
    const label = period === 'train' ? 'обучен' : 'ОТЛОЖ.';
    if (!agg) { console.log(`${cfg.name.padEnd(41)} | ${label}  | нет сделок`); continue; }
    console.log(
      `${(period === 'train' ? cfg.name : '').padEnd(41)} | ${label}  | ${String(agg.n).padStart(6)} | `
      + `${agg.winRate.toFixed(1).padStart(6)}% | ${(agg.avgReturn >= 0 ? '+' : '') + agg.avgReturn.toFixed(1).padStart(6)}% | `
      + `${agg.positive}/${agg.tickers}`.padStart(7) + ` | ${agg.worst.toFixed(1)}%`
    );
  }
  console.log('-'.repeat(100));
}

// Разбивка по каждому инструменту для варианта Е ("без стопа, только следящий") — прямой
// ответ на вопрос трейдера "может, стратегия просто подходит не всем инструментам,
// а не всем одинаково". Показываем ОТЛОЖЕННЫЙ период — он честный, не подогнан.
const eName = CONFIGS.find((c) => c.name.startsWith('Е.')).name;
console.log(`\nПо каждому инструменту, отложенный период, вариант «${eName}»:`);
console.log('Тикер    | Тип     | Сделок | Винрейт | Доходность');
console.log('-'.repeat(55));
for (const r of [...results[eName].test].sort((a, b) => b.returnPct - a.returnPct)) {
  console.log(`${r.ticker.padEnd(8)} | ${r.instrumentType.padEnd(7)} | ${String(r.n).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${(r.returnPct >= 0 ? '+' : '') + r.returnPct.toFixed(1)}%`);
}

console.log(`\n${'='.repeat(100)}`);
console.log(`Та же проверка на ДРУГОЙ стратегии — «${STRATEGY2.name}» — работает ли идея не только`);
console.log('на "Фигуры разворота + уровень":');
console.log(`${'='.repeat(100)}\n`);
console.log('Вариант                                   | Период  | Сделок | Винрейт | Ср.дох. | В плюсе | Худшая сделка');
console.log('-'.repeat(100));
for (const cfg of STRATEGY2_CONFIGS) {
  for (const period of ['train', 'test']) {
    const agg = aggregate(results2[cfg.name][period]);
    const label = period === 'train' ? 'обучен' : 'ОТЛОЖ.';
    if (!agg) { console.log(`${cfg.name.padEnd(41)} | ${label}  | нет сделок`); continue; }
    console.log(
      `${(period === 'train' ? cfg.name : '').padEnd(41)} | ${label}  | ${String(agg.n).padStart(6)} | `
      + `${agg.winRate.toFixed(1).padStart(6)}% | ${(agg.avgReturn >= 0 ? '+' : '') + agg.avgReturn.toFixed(1).padStart(6)}% | `
      + `${agg.positive}/${agg.tickers}`.padStart(7) + ` | ${agg.worst.toFixed(1)}%`
    );
  }
  console.log('-'.repeat(100));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
