// Шаг 1 плана (2026-08-16): базовые характеристики КАЖДОЙ стратегии — прямой ответ на
// вопрос трейдера "какое у каждой стратегии число правильно угаданных направлений и
// винрейт". Без этого нельзя понять, что вообще чинить: если стратегия плохо угадывает
// направление — это проблема входа, и никакой выход её не спасёт.
//
// Меряем на ОДНИХ И ТЕХ ЖЕ данных, для каждой стратегии:
//   - directionHit% — цена хоть раз прошла 2% в предсказанную сторону за 45 баров
//     (НЕ зависит от механизма выхода вообще);
//   - винрейт с классикой 2%/4% — сколько бы реально выиграли с жёстким стопом;
//   - винрейт со следящим выходом — сколько выигрываем нашим механизмом;
//   - разрыв "направление минус винрейт" — сколько теряется на выходе, а не на входе.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-baseline-'));

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

const STRATEGIES = {
  'Фигуры разворота + уровень': {
    id: 'patterns_levels', readinessThreshold: 75,
    conditions: [
      { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
      { id: 'near_support', enabled: true, param: 1, direction: 'long' },
      { id: 'near_resistance', enabled: true, param: 1, direction: 'short' },
      { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
      { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
    ], customConditions: [],
  },
  'RSI + Боллинджер (mean-reversion)': {
    id: 'rsi_bollinger', readinessThreshold: 66,
    conditions: [
      { id: 'rsi_below', enabled: true, param: 35, direction: 'long' },
      { id: 'rsi_above', enabled: true, param: 65, direction: 'short' },
      { id: 'bollinger_lower', enabled: true, param: null, direction: 'long' },
      { id: 'bollinger_upper', enabled: true, param: null, direction: 'short' },
      { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
      { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
    ], customConditions: [],
  },
  'EMA200 + MACD (следование за трендом)': {
    id: 'ema_macd_trend', readinessThreshold: 66,
    conditions: [
      { id: 'price_above_ema200', enabled: true, param: null, direction: 'long' },
      { id: 'price_below_ema200', enabled: true, param: null, direction: 'short' },
      { id: 'macd_positive', enabled: true, param: null, direction: 'long' },
      { id: 'macd_negative', enabled: true, param: null, direction: 'short' },
      { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
      { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
    ], customConditions: [],
  },
};

const BASE = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null,
};
const CLASSIC = { ...BASE, stopType: 'pct', stopPct: 2, takeType: 'pct', takePct: 4, trailEnabled: false };
const TRAIL = {
  ...BASE, stopType: 'none', takeType: 'none', trailEnabled: true, trailGiveBackPct: 50,
  trailPerPattern: false, trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
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

const OUTCOME_WINDOW = 45;
const THRESHOLD_PCT = 2;
// Угадано ли направление — независимо от того, как мы выходили.
function directionHit(candles, entryIndex, dir, entryPrice) {
  const end = Math.min(candles.length - 1, entryIndex + OUTCOME_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const fav = dir === 1
      ? ((candles[i].high - entryPrice) / entryPrice) * 100
      : ((entryPrice - candles[i].low) / entryPrice) * 100;
    if (fav >= THRESHOLD_PCT) return true;
  }
  return false;
}

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

console.log(`\n${'='.repeat(118)}`);
console.log('БАЗОВЫЕ ХАРАКТЕРИСТИКИ КАЖДОЙ СТРАТЕГИИ (21 тикер, Д1, вся история)');
console.log('Направление = цена хоть раз прошла 2% в нужную сторону за 45 баров (НЕ зависит от выхода)');
console.log(`${'='.repeat(118)}\n`);
console.log('Стратегия                              | Сделок | Направление | Винрейт классика | Винрейт трейл | Разрыв напр.−классика');
console.log('-'.repeat(118));

const perStrategyTrail = {};
for (const [name, strat] of Object.entries(STRATEGIES)) {
  let total = 0, dirHits = 0, classicWins = 0, classicClosed = 0, trailWins = 0, trailClosed = 0;
  const trailTrades = [];
  for (const { candles } of candlesByTicker) {
    let classicRun, trailRun;
    try {
      classicRun = runBacktest({ candles, strategy: strat, timeframeMinutes: 1440, exitRules: CLASSIC });
      trailRun = runBacktest({ candles, strategy: strat, timeframeMinutes: 1440, exitRules: TRAIL });
    } catch (e) { continue; }
    for (const t of classicRun.trades) {
      if (t.entryIndex == null) continue;
      total += 1;
      const dir = t.direction === 'long' ? 1 : -1;
      if (directionHit(candles, t.entryIndex, dir, t.entryPrice)) dirHits += 1;
      if (t.status === 'closed') { classicClosed += 1; if (t.pnlPct > 0) classicWins += 1; }
    }
    for (const t of trailRun.trades) {
      if (t.status === 'closed') { trailClosed += 1; if (t.pnlPct > 0) trailWins += 1; trailTrades.push(t.pnlPct); }
    }
  }
  if (!total) { console.log(`${name.padEnd(38)} | нет сделок`); continue; }
  const dirPct = (dirHits / total) * 100;
  const classicWr = classicClosed ? (classicWins / classicClosed) * 100 : 0;
  const trailWr = trailClosed ? (trailWins / trailClosed) * 100 : 0;
  console.log(
    `${name.padEnd(38)} | ${String(total).padStart(6)} | ${dirPct.toFixed(1).padStart(10)}% | `
    + `${classicWr.toFixed(1).padStart(15)}% | ${trailWr.toFixed(1).padStart(12)}% | ${(dirPct - classicWr).toFixed(1).padStart(20)} п.п.`
  );
  perStrategyTrail[name] = trailTrades;
}

console.log('\nКак читать: большой разрыв "направление − винрейт классики" = стратегия УГАДЫВАЕТ, но жёсткий');
console.log('стоп не даёт заработать (лечится выходом). Низкое направление = проблема ВХОДА, выход не спасёт.');

console.log(`\n${'='.repeat(110)}`);
console.log('РАЗМЕР ВЫИГРЫША/ПРОИГРЫША (следящий выход) — почему одинаковый винрейт даёт разные деньги');
console.log(`${'='.repeat(110)}\n`);
console.log('Стратегия                              | Ср.выигрыш | Ср.проигрыш | RR (выигрыш/проигрыш) | Матожидание/сделку');
console.log('-'.repeat(110));
for (const [name, trades] of Object.entries(perStrategyTrail)) {
  const wins = trades.filter((p) => p > 0), losses = trades.filter((p) => p <= 0);
  const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
  const rr = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;
  const expectancy = trades.reduce((s, p) => s + p, 0) / trades.length;
  console.log(
    `${name.padEnd(38)} | ${('+' + avgWin.toFixed(2) + '%').padStart(10)} | ${(avgLoss.toFixed(2) + '%').padStart(11)} | `
    + `${rr.toFixed(2).padStart(22)} | ${((expectancy >= 0 ? '+' : '') + expectancy.toFixed(3) + '%').padStart(19)}`
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
