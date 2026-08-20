// Проверка идеи, предложенной трейдеру другим ИИ (2026-08-14): трёхслойный выход —
// (1) несгибаемый аварийный стоп 2×ATR, (2) чандельер-трейл: активируется после +1×ATR
// в свою пользу, дальше держит стоп на расстоянии 1.5×ATR от лучшей достигнутой цены
// (не % от пика, как наш текущий следящий выход, а фиксированное расстояние — по сути
// классический "chandelier exit"), (3) time-stop только для ЗАСТРЯВШИХ около нуля сделок
// (не любых старых, а конкретно тех, что через N баров всё ещё в диапазоне -0.5%..+0.5%).
//
// Важное отличие от того, что уже пробовали: старый time-stop (HANDOFF, 08-12) закрывал
// ЛЮБУЮ сделку по календарю независимо от текущей цены — и это резко ухудшало результат
// (мог закрыть прямо в моменте временной просадки). Эта версия закрывает только явно
// "неразвившиеся" сделки, что логически другое условие — стоит проверить отдельно, а не
// считать её автоматически такой же плохой.
//
// Методология (по совету того же чата — "раздели качество входа и качество выхода"):
// берём ОДИН И ТОТ ЖЕ набор входов (собран через классику 2%/4%, сам стоп/тейк тут не
// важен, важны только entryIndex/entryPrice/direction/ATR на момент входа) и независимо
// прогоняем через ТРИ разных механизма выхода на одних и тех же случаях — честное
// сравнение "то же самое место входа, разные способы выйти".
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-gptcombo-'));

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
const { computeIndicatorsAtEntry } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'))
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

const MAX_WINDOW = 120; // достаточно далеко, чтобы почти все сделки успели закрыться

// --- Три независимых механизма выхода, применяемые к ОДНОМУ И ТОМУ ЖЕ входу ------------

// А) Наш нынешний симметричный трейл (сегодняшний дефолт) — как в engine.js, но
// реализован здесь заново для честного покандидатного сравнения на тех же входах.
function simulateOurTrail(candles, entryIndex, direction, entryPrice, atr) {
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 3;
  let peakFavorablePct = 0;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorableHigh = direction === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peakFavorablePct = Math.max(peakFavorablePct, favorableHigh);
    const closeReturnPct = direction === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    if (-closeReturnPct >= adverseThresholdPct) return { pnlPct: closeReturnPct, barsHeld: i - entryIndex };
    if (peakFavorablePct >= minPeakPct && closeReturnPct <= peakFavorablePct * 0.5) return { pnlPct: closeReturnPct, barsHeld: i - entryIndex };
  }
  const last = candles[end];
  const finalPct = direction === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true };
}

// Б) Комбо из чата: жёсткий стоп 2×ATR + чандельер-трейл (активация +1×ATR, ширина
// 1.5×ATR от ЛУЧШЕЙ достигнутой цены, не от % пика) + time-stop для застрявших.
const FLAT_TIMESTOP_BARS = 15;
const FLAT_TIMESTOP_BAND_PCT = 0.5;
function simulateGptCombo(candles, entryIndex, direction, entryPrice, atr) {
  const hardStopPrice = entryPrice - direction * 2 * atr;
  let bestPrice = entryPrice; // лучшая цена в нашу пользу, для чандельера
  let trailActive = false;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    // Аварийный стоп — проверяем по тени (это несгибаемая линия, не про закрытие).
    const stopHit = direction === 1 ? bar.low <= hardStopPrice : bar.high >= hardStopPrice;
    if (stopHit) return { pnlPct: ((hardStopPrice - entryPrice) / entryPrice) * 100 * direction, barsHeld: i - entryIndex, reason: 'hard_stop' };

    const extreme = direction === 1 ? bar.high : bar.low;
    bestPrice = direction === 1 ? Math.max(bestPrice, extreme) : Math.min(bestPrice, extreme);
    const favorableFromBest = Math.abs(bestPrice - entryPrice);
    if (!trailActive && favorableFromBest >= atr * 1.0) trailActive = true;

    if (trailActive) {
      const chandelierPrice = bestPrice - direction * 1.5 * atr;
      const trailHit = direction === 1 ? bar.low <= chandelierPrice : bar.high >= chandelierPrice;
      if (trailHit) return { pnlPct: ((chandelierPrice - entryPrice) / entryPrice) * 100 * direction, barsHeld: i - entryIndex, reason: 'chandelier' };
    }

    // Time-stop только для застрявших около нуля — проверяем на закрытии, не по тени.
    const barsHeld = i - entryIndex;
    if (barsHeld === FLAT_TIMESTOP_BARS) {
      const closeReturnPct = direction === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
      if (Math.abs(closeReturnPct) < FLAT_TIMESTOP_BAND_PCT) {
        return { pnlPct: closeReturnPct, barsHeld, reason: 'flat_timestop' };
      }
    }
  }
  const last = candles[end];
  const finalPct = direction === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data' };
}

// В) Классика 2%/4% — как эталон, пересчитана на тех же входах для контроля (должна
// почти совпасть с исходным харвестом, если харвест классикой же и делался).
function simulateClassic(candles, entryIndex, direction, entryPrice) {
  const stopPrice = entryPrice * (1 - direction * 0.02);
  const takePrice = entryPrice * (1 + direction * 0.04);
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const stopHit = direction === 1 ? bar.low <= stopPrice : bar.high >= stopPrice;
    const takeHit = direction === 1 ? bar.high >= takePrice : bar.low <= takePrice;
    if (stopHit) return { pnlPct: -2, barsHeld: i - entryIndex };
    if (takeHit) return { pnlPct: 4, barsHeld: i - entryIndex };
  }
  const last = candles[end];
  const finalPct = direction === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true };
}

const allResults = { classic: [], ourTrail: [], gptCombo: [] };
let comboReasons = {};

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);

  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  const entries = harvest.trades.filter((t) => t.entryIndex != null);

  for (const t of entries) {
    const entryIndex = t.entryIndex;
    const direction = t.direction === 'long' ? 1 : -1;
    const entryPrice = t.entryPrice;
    const indicators = computeIndicatorsAtEntry(candles, candles[entryIndex - 1]?.date ?? t.entryDate);
    const atr = indicators?.atr14;
    if (!atr) continue;

    const c = simulateClassic(candles, entryIndex, direction, entryPrice);
    const ot = simulateOurTrail(candles, entryIndex, direction, entryPrice, atr);
    const gc = simulateGptCombo(candles, entryIndex, direction, entryPrice, atr);
    allResults.classic.push(c);
    allResults.ourTrail.push({ ...ot, ticker, entryDate: t.entryDate, direction: t.direction, entryPrice, atr });
    allResults.gptCombo.push(gc);
    comboReasons[gc.reason] = (comboReasons[gc.reason] || 0) + 1;
  }
}

const CRASH_START = new Date('2022-02-15');
const CRASH_END = new Date('2022-04-15');
function excludingCrash(list) {
  return list.filter((r) => !(r.entryDate && new Date(r.entryDate) >= CRASH_START && new Date(r.entryDate) <= CRASH_END));
}

function summarize(list) {
  const n = list.length;
  const wins = list.filter((r) => r.pnlPct > 0).length;
  const avg = list.reduce((s, r) => s + r.pnlPct, 0) / n;
  const worst = Math.min(...list.map((r) => r.pnlPct));
  const stillOpen = list.filter((r) => r.stillOpen).length;
  let equity = 100, peak = 100, maxDD = 0;
  for (const r of list) {
    equity *= 1 + r.pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
  }
  return { n, winRate: (wins / n) * 100, avg, worst, stillOpen, compoundedReturn: equity - 100, maxDD };
}

console.log(`\n${'='.repeat(110)}`);
console.log('Три механизма выхода на ОДНИХ И ТЕХ ЖЕ входах (честное сравнение по совету второго ИИ)');
console.log(`${'='.repeat(110)}\n`);
for (const [label, list] of [['Классика 2%/4%', allResults.classic], ['Наш симметричный трейл (сегодня)', allResults.ourTrail], ['Комбо из чата (стоп2×ATR+чандельер1.5×ATR+time-stop)', allResults.gptCombo]]) {
  const s = summarize(list);
  console.log(`${label}:`);
  console.log(`  n=${s.n}, винрейт ${s.winRate.toFixed(1)}%, ср.сделка ${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)}%, худшая ${s.worst.toFixed(1)}%, ещё открыто ${s.stillOpen}`);
  console.log(`  сложный %: ${(s.compoundedReturn >= 0 ? '+' : '') + s.compoundedReturn.toFixed(1)}%, макс.просадка ${s.maxDD.toFixed(1)}%\n`);
}

console.log('Причины закрытия у комбо из чата:', comboReasons);

console.log(`\n${'='.repeat(110)}`);
console.log('Наш трейл: С форс-мажором 2022 vs БЕЗ него (15.02-15.04.2022 — вторжение, обвал рынка, закрытие биржи)');
console.log(`${'='.repeat(110)}\n`);
const withCrash = summarize(allResults.ourTrail);
const withoutCrash = summarize(excludingCrash(allResults.ourTrail));
console.log(`С форс-мажором:  n=${withCrash.n}, винрейт ${withCrash.winRate.toFixed(1)}%, ср.сделка ${(withCrash.avg >= 0 ? '+' : '') + withCrash.avg.toFixed(3)}%, худшая ${withCrash.worst.toFixed(1)}%`);
console.log(`БЕЗ форс-мажора: n=${withoutCrash.n}, винрейт ${withoutCrash.winRate.toFixed(1)}%, ср.сделка ${(withoutCrash.avg >= 0 ? '+' : '') + withoutCrash.avg.toFixed(3)}%, худшая ${withoutCrash.worst.toFixed(1)}%`);
console.log(`(исключено сделок: ${withCrash.n - withoutCrash.n})`);

const worstOurTrail = [...allResults.ourTrail].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 5);
console.log('\nХудшие 5 сделок нашего трейла (найдём, что там произошло):');
for (const t of worstOurTrail) {
  console.log(`  ${t.ticker} | вход ${new Date(t.entryDate).toISOString().slice(0, 10)} | ${t.direction} | цена входа ${t.entryPrice.toFixed(2)} | ATR ${t.atr.toFixed(2)} | итог ${t.pnlPct.toFixed(1)}% | держал ${t.barsHeld} баров | ${t.stillOpen ? 'ЕЩЁ ОТКРЫТА' : 'закрыта'}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
