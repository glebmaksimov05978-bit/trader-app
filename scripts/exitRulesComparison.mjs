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

// Раунд 2026-08-12: трейдер поднял вопрос "может, без стопа выигрывает не умный выход,
// а просто «дольше сидим в позиции на растущем рынке»" — и предложил проверить: (1)
// аварийный стоп ДРУГОГО типа (ATR/уровень), не только фикс. %, раз фикс. % монотонно
// вредил на любой ширине (см. Ж/З ниже — оставлены как справка о прошлом раунде, но не
// перезапускаются, чтобы не дублировать уже полученный ответ); (2) жёсткий лимит времени
// в сделке (трейдер ориентируется на 5-14 дней для фьючерсов) — не даёт ли он почти тот
// же эффект, что следящий выход, но с управляемым горизонтом.
const CONFIGS = [
  { name: 'A. Стоп 2% / тейк 4% (классика)', rules: { ...base, stopType: 'pct', stopPct: 2, takeType: 'pct', takePct: 4 } },
  { name: 'Е. Без стопа, только следящий', rules: { ...base, stopType: 'none', takeType: 'none', trailEnabled: true } },
  // Новое: жёсткий лимит времени в сделке поверх следящего выхода — прямой ответ на
  // "сколько оптимально сидеть в позиции" и на подозрение "просто держим слишком долго".
  { name: 'М. Без стопа + следящий, макс. 14 дней', rules: { ...base, stopType: 'none', takeType: 'none', trailEnabled: true, maxBars: 14 } },
  { name: 'Н. Без стопа + следящий, макс. 7 дней', rules: { ...base, stopType: 'none', takeType: 'none', trailEnabled: true, maxBars: 7 } },
  // Новое: аварийный стоп ДРУГОГО типа, не фиксированный % — идея трейдера (2026-08-12)
  // "ATR или последний локальный экстремум", раз фикс.% монотонно вредил на любой ширине.
  { name: 'О. Стоп ×ATR(3) + следящий', rules: { ...base, stopType: 'atr', stopAtrMult: 3, takeType: 'none', trailEnabled: true } },
  { name: 'П. Стоп «У уровня» + следящий', rules: { ...base, stopType: 'level', takeType: 'none', trailEnabled: true } },
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
  const closed = trades.filter((t) => t.status === 'closed').sort((a, b) => a.exitDate - b.exitDate);
  if (!closed.length) return null;
  let equity = 100, peak = 100, maxDrawdownPct = 0;
  let wins = 0, grossWin = 0, grossLoss = 0, worst = 0;
  let longWins = 0, longN = 0, shortWins = 0, shortN = 0;
  let longReturn = 0, shortReturn = 0;
  let totalBars = 0;
  for (const t of closed) {
    equity *= 1 + t.pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    if (t.pnlPct > 0) { wins += 1; grossWin += t.pnlPct; } else { grossLoss += Math.abs(t.pnlPct); }
    worst = Math.min(worst, t.pnlPct);
    totalBars += t.barsHeld || 0;
    if (t.direction === 'long') { longN += 1; if (t.pnlPct > 0) longWins += 1; longReturn += t.pnlPct; }
    else { shortN += 1; if (t.pnlPct > 0) shortWins += 1; shortReturn += t.pnlPct; }
  }
  return {
    n: closed.length, returnPct: equity - 100,
    winRate: (wins / closed.length) * 100,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    worst, maxDrawdownPct,
    avgHoldDays: totalBars / closed.length,
    longN, longWinRate: longN ? (longWins / longN) * 100 : null, longReturn,
    shortN, shortWinRate: shortN ? (shortWins / shortN) * 100 : null, shortReturn,
  };
}

// "Купил и держи" за тот же ровно кусок истории — раз без стопа позиции живут гораздо
// дольше (реальное подозрение трейдера 2026-08-12: "может, выигрывает не умный выход,
// а просто то, что мы дольше сидим в позиции на растущем рынке"), нужен честный ноль для
// сравнения. Не взвешено по времени входа/выхода стратегии — просто "а если ничего не
// делать, просто купить в начале периода и держать до конца".
function buyAndHoldReturn(candles) {
  if (candles.length < 2) return null;
  const first = candles[0].close, last = candles[candles.length - 1].close;
  return ((last - first) / first) * 100;
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
// STRATEGY2 (кросс-проверка на другой логике входа) уже подтверждена в прошлом раунде
// (2026-08-12, "работает ли эффект на ДРУГОЙ стратегии — ДА"), не повторяем — экономим
// время ради новых вопросов этого раунда (просадка/бенчмарк/лимит времени/тип стопа).

const results = {};
for (const cfg of CONFIGS) results[cfg.name] = { train: [], test: [], instrumentType: {} };
const benchmark = { train: [], test: [] };

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка после 3 попыток: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  console.log(`${candles.length} свечей`);

  const bhTrain = buyAndHoldReturn(candles.slice(0, splitIndex));
  const bhTest = buyAndHoldReturn(candles.slice(splitIndex));
  if (bhTrain != null) benchmark.train.push({ ticker, returnPct: bhTrain });
  if (bhTest != null) benchmark.test.push({ ticker, returnPct: bhTest });

  for (const cfg of CONFIGS) {
    const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules });
    const test = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules, warmupBars: splitIndex });
    const trainSum = summarize(train.trades);
    const testSum = summarize(test.trades);
    if (trainSum) results[cfg.name].train.push({ ticker, instrumentType, ...trainSum });
    if (testSum) results[cfg.name].test.push({ ticker, instrumentType, ...testSum });
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
  const avgHoldDays = list.reduce((s, r) => s + r.avgHoldDays, 0) / list.length;
  const longN = list.reduce((s, r) => s + r.longN, 0);
  const shortN = list.reduce((s, r) => s + r.shortN, 0);
  const longWins = list.reduce((s, r) => s + ((r.longWinRate ?? 0) / 100) * r.longN, 0);
  const shortWins = list.reduce((s, r) => s + ((r.shortWinRate ?? 0) / 100) * r.shortN, 0);
  return {
    n, winRate: (wins / n) * 100, avgReturn, positive, tickers: list.length, worst,
    avgDrawdown, avgHoldDays, longN, shortN,
    longWinRate: longN ? (longWins / longN) * 100 : null,
    shortWinRate: shortN ? (shortWins / shortN) * 100 : null,
  };
}
function aggregateBenchmark(list) {
  if (!list.length) return null;
  return { avgReturn: list.reduce((s, r) => s + r.returnPct, 0) / list.length, positive: list.filter((r) => r.returnPct > 0).length, tickers: list.length };
}

console.log(`\n${'='.repeat(100)}`);
console.log(`Сравнение правил выхода — стратегия «${STRATEGY.name}», ${TICKERS.length} инструментов, ~6 лет истории`);
console.log(`${'='.repeat(100)}\n`);
console.log('Вариант                                   | Период  | Сделок | Винрейт | Ср.дох. | В плюсе | Худш.сделка| Просадка| Ср.дней | Лонг вр%/шорт вр%');
console.log('-'.repeat(140));
for (const cfg of CONFIGS) {
  for (const period of ['train', 'test']) {
    const agg = aggregate(results[cfg.name][period]);
    const label = period === 'train' ? 'обучен' : 'ОТЛОЖ.';
    if (!agg) { console.log(`${cfg.name.padEnd(41)} | ${label}  | нет сделок`); continue; }
    const longShort = `Л:${agg.longN}(${agg.longWinRate?.toFixed(0) ?? '-'}%) Ш:${agg.shortN}(${agg.shortWinRate?.toFixed(0) ?? '-'}%)`;
    console.log(
      `${(period === 'train' ? cfg.name : '').padEnd(41)} | ${label}  | ${String(agg.n).padStart(6)} | `
      + `${agg.winRate.toFixed(1).padStart(6)}% | ${(agg.avgReturn >= 0 ? '+' : '') + agg.avgReturn.toFixed(1).padStart(6)}% | `
      + `${agg.positive}/${agg.tickers}`.padStart(7) + ` | ${agg.worst.toFixed(1).padStart(6)}% | ${agg.avgDrawdown.toFixed(1).padStart(6)}% | `
      + `${agg.avgHoldDays.toFixed(1).padStart(6)} | ${longShort}`
    );
  }
  console.log('-'.repeat(140));
}

// Бенчмарк "купил и держи" — тот самый честный ноль. Если стратегия хуже него, весь
// "прорыв" без стопа объясняется просто тем, что рынок в среднем рос, а не мастерством
// выбора момента входа/выхода.
const bhTrain = aggregateBenchmark(benchmark.train);
const bhTest = aggregateBenchmark(benchmark.test);
console.log('\nБЕНЧМАРК «Купил и держи» (ничего не делаем, просто держим весь период):');
if (bhTrain) console.log(`  Обучение: средняя доходность ${(bhTrain.avgReturn >= 0 ? '+' : '') + bhTrain.avgReturn.toFixed(1)}%, в плюсе ${bhTrain.positive}/${bhTrain.tickers} инструментов`);
if (bhTest) console.log(`  Отложено: средняя доходность ${(bhTest.avgReturn >= 0 ? '+' : '') + bhTest.avgReturn.toFixed(1)}%, в плюсе ${bhTest.positive}/${bhTest.tickers} инструментов`);

// Разбивка по каждому инструменту для варианта Е ("без стопа, только следящий") — прямой
// ответ на вопрос трейдера "может, стратегия просто подходит не всем инструментам,
// а не всем одинаково". Показываем ОТЛОЖЕННЫЙ период — он честный, не подогнан.
const eName = CONFIGS.find((c) => c.name.startsWith('Е.')).name;
console.log(`\nПо каждому инструменту, отложенный период, вариант «${eName}» — стратегия vs купи-и-держи:`);
console.log('Тикер    | Тип     | Сделок | Винрейт | Доходность | Купи-и-держи | Разница');
console.log('-'.repeat(80));
for (const r of [...results[eName].test].sort((a, b) => b.returnPct - a.returnPct)) {
  const bh = benchmark.test.find((b) => b.ticker === r.ticker);
  const bhVal = bh ? bh.returnPct : null;
  const diff = bhVal != null ? r.returnPct - bhVal : null;
  console.log(`${r.ticker.padEnd(8)} | ${r.instrumentType.padEnd(7)} | ${String(r.n).padStart(6)} | ${r.winRate.toFixed(1).padStart(6)}% | `
    + `${(r.returnPct >= 0 ? '+' : '') + r.returnPct.toFixed(1)}%`.padStart(11) + ' | '
    + `${bhVal != null ? (bhVal >= 0 ? '+' : '') + bhVal.toFixed(1) + '%' : '—'}`.padStart(12) + ' | '
    + `${diff != null ? (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%' : '—'}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
