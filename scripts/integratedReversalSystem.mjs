// АРХИТЕКТУРА ТРЕЙДЕРА (2026-08-17) — объединение всех найденных за сессию систем в одну
// связную схему, вместо отдельных заплаток:
//
//   1. Убыточная сделка закрывается, когда loss-система (64.6% точности, HANDOFF п.25)
//      подтверждает, что это РАЗВОРОТ, а не откат.
//   2. Пока индикаторы loss-системы всё ещё сигналят — НЕ открываем сделку в ТУ ЖЕ
//      сторону (в прошлых тестах блокировки использовались суррогаты — RSI<35, SMA20 —
//      а не сама loss-система; трейдер верно указал на эту ошибку).
//   3. ВМЕСТО этого открываем сделку в ПРОТИВОПОЛОЖНУЮ сторону — раз система говорит
//      "настоящий разворот", то разворот и есть новое движение.
//      ⚠️ Отличие от уже провалившегося теста "авторазворот после выдыхания" (50.1%,
//      монетка): там разворачивались после ЗАТУХАНИЯ движения, здесь — после
//      ПОДТВЕРЖДЁННОГО разворотного сигнала. Разные условия, тест честно новый.
//   4. Обратной сделкой управляет profit-система (знает, когда движение выдохлось).
//   5. Ключевой аргумент трейдера по риску: обратных сделок будет РОВНО столько же,
//      сколько выходов по развороту — количество сделок не взрывается.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-integrated-'));

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

const indicatorsUrl = esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
esmify(path.join(repoRoot, 'src/services/analytics/candlestickPatterns.js'));
const patternsUrl = esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'));
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
const { computePatternsAtEntry } = await import(patternsUrl);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);
const { rsi, ema, sma, bollingerSeries } = await import(indicatorsUrl);

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
const HARVEST_RULES = {
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
function adxLite(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let upSum = 0, downSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const up = candles[j].high - candles[j - 1].high;
      const down = candles[j - 1].low - candles[j].low;
      if (up > down && up > 0) upSum += up;
      if (down > up && down > 0) downSum += down;
    }
    const total = upSum + downSum;
    out[i] = total > 0 ? (Math.abs(upSum - downSum) / total) * 100 : 0;
  }
  return out;
}

// LOSS-система (из полного перебора, п.25 — топ-комбо 64.6%): "это подтверждённый разворот"
function lossScore(f) {
  let s = 0;
  if (f.rsi21Extreme) s += 2;
  if (f.rsi14ChangeArm != null && f.rsi14ChangeArm <= -10) s += 2;
  if (f.barsFromArm >= 15) s += 1;
  if (f.ema13Side != null && f.ema13Side < -4) s += 1;
  if (f.currentAdvPct > 8) s += 1;
  return s;
}
// PROFIT-система (п.24, обновлённая): "движение выдохлось, фиксируй"
function profitScore(f) {
  let s = 0;
  if (f.rsiExtreme) s += 1;
  if (f.ema13Side != null && f.ema13Side > 4) s += 1;
  if (f.currentFavPct > 8) s += 1;
  if (f.bbPos10 != null && f.bbPos10 > 0.85) s += 1;
  if (f.barsFromArm >= 15) s += 1;
  if (f.adx != null && f.adx < 15) s += 1;
  if (f.volRatio != null && f.volRatio > 1.8) s += 1;
  if (f.barsFromArm <= 2) s -= 1;
  return s;
}

const MAX_WINDOW = 120;
const LOSS_THRESHOLD = 3;
const PROFIT_THRESHOLD = 4;

// Симуляция ОДНОЙ сделки. useProfitScore — управлять выходом профит-системой.
// Возвращает также lossScore на момент выхода (нужно решить, разворачиваться ли).
function simulateTrade(candles, series, entryIndex, dir, entryPrice, atr, useProfitScore, useLossScore, disableBlunt) {
  const { closes, rsi14S, rsi21S, ema13S, bbS10, adxS } = series;
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = disableBlunt ? Infinity : minPeakPct * 2;
  let peak = 0, favArm = null, advArm = null, advArmRsi = null;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    if (peak >= minPeakPct && favArm == null) favArm = i;
    if (advArm == null && -ret >= minPeakPct) { advArm = i; advArmRsi = rsi14S[i] ?? null; }

    const sideOf = (s2, idx) => s2[idx] == null ? null : ((closes[idx] - s2[idx]) / s2[idx]) * 100 * dir;

    // Прибыльная сторона — профит-система
    if (useProfitScore && favArm != null && ret > 0 && rsi14S[i] != null) {
      const bbPos10 = (() => { const b = bbS10[i]; if (!b || b.upper === b.lower) return null; const raw = (closes[i] - b.lower) / (b.upper - b.lower); return dir === 1 ? raw : 1 - raw; })();
      const volAvg = candles.slice(Math.max(0, i - 20), i).map((x) => x.volume).filter(Number.isFinite);
      const volRatio = volAvg.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
      const s = profitScore({
        rsiExtreme: dir === 1 ? rsi14S[i] > 70 : rsi14S[i] < 30,
        ema13Side: sideOf(ema13S, i), currentFavPct: ret, bbPos10,
        barsFromArm: i - favArm, adx: adxS[i], volRatio,
      });
      if (s >= PROFIT_THRESHOLD) return { pnlPct: ret, exitIndex: i, barsHeld: i - entryIndex, reason: 'profit_score', lossScoreAtExit: 0 };
    }

    // Убыточная сторона — loss-система решает, разворот ли это
    let lsNow = 0;
    if (useLossScore && advArm != null && ret < 0 && rsi21S[i] != null) {
      lsNow = lossScore({
        rsi21Extreme: dir === 1 ? rsi21S[i] < 35 : rsi21S[i] > 65,
        rsi14ChangeArm: advArmRsi != null && rsi14S[i] != null ? (rsi14S[i] - advArmRsi) * dir : null,
        barsFromArm: i - advArm, ema13Side: sideOf(ema13S, i), currentAdvPct: -ret,
      });
      if (lsNow >= LOSS_THRESHOLD) {
        return { pnlPct: ret, exitIndex: i, barsHeld: i - entryIndex, reason: 'loss_score_reversal', lossScoreAtExit: lsNow };
      }
    }
    if (-ret >= adverseThresholdPct) return { pnlPct: ret, exitIndex: i, barsHeld: i - entryIndex, reason: 'trail_adverse', lossScoreAtExit: lsNow };
    if (favArm != null && !useProfitScore && ret <= peak * 0.5) return { pnlPct: ret, exitIndex: i, barsHeld: i - entryIndex, reason: 'trail_giveback', lossScoreAtExit: 0 };
  }
  const last = candles[end];
  const finalPct = dir === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, exitIndex: end, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data', lossScoreAtExit: 0 };
}

console.log('Загружаю индекс...');
const indexCandles = await fetchWithRetry({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
const indexCloses = indexCandles.map((c) => c.close);
const indexSma50 = sma(indexCloses, 50);
function indexBelowSma50(date) {
  let idx = -1;
  for (let i = 0; i < indexCandles.length; i++) { if (new Date(indexCandles[i].date) <= date) idx = i; else break; }
  if (idx < 0 || indexSma50[idx] == null) return null;
  return indexCloses[idx] < indexSma50[idx];
}

function runPortfolio(list, { riskPerTradePct = 10, maxConcurrentPositions = 8, startingCapital = 100000 } = {}) {
  const byTicker = new Map();
  for (const r of list) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  const events = [];
  for (const [ticker, trades] of byTicker) {
    for (const t of trades) {
      events.push({ type: 'entry', date: new Date(t.entryDate), ticker, trade: t });
      if (!t.stillOpen) events.push({ type: 'exit', date: new Date(t.exitDate), ticker, trade: t });
    }
  }
  events.sort((a, b) => a.date - b.date || (a.type === 'exit' ? -1 : 1));
  let equity = startingCapital, peak = equity, maxDrawdownPct = 0;
  const open = new Map();
  let closedTrades = 0, worstTrade = 0;
  for (const ev of events) {
    if (ev.type === 'exit') {
      const alloc = open.get(ev.trade);
      if (alloc == null) continue;
      open.delete(ev.trade);
      equity += alloc * (ev.trade.pnlPct / 100);
      closedTrades += 1;
      worstTrade = Math.min(worstTrade, ev.trade.pnlPct);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    } else {
      if (open.size >= maxConcurrentPositions) continue;
      open.set(ev.trade, equity * (riskPerTradePct / 100));
    }
  }
  let mtm = equity;
  for (const [t, alloc] of open) { mtm += alloc * (t.pnlPct / 100); worstTrade = Math.min(worstTrade, t.pnlPct); }
  return { totalReturnPct: ((mtm - startingCapital) / startingCapital) * 100, maxDrawdownPct, closedTrades, worstTrade };
}

const HOLDOUT_FRACTION = 0.2;
const variants = { blunt: [], lossOnly: [], profitOnly: [], both: [], withReversal: [], noBluntBase: [], noBluntLoss: [] };
let reversalCount = 0, reversalWins = 0, reversalPnlSum = 0;

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  const closes = candles.map((c) => c.close);
  const series = {
    closes, rsi14S: rsi(closes, 14), rsi21S: rsi(closes, 21), ema13S: ema(closes, 13),
    bbS10: bollingerSeries(closes, 10, 2), adxS: adxLite(candles, 14),
  };
  const atrS = atrSeries(candles, 14);
  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: HARVEST_RULES });

  for (const t of harvest.trades) {
    if (t.entryIndex == null || t.entryIndex < splitIndex) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    if (dir === 1 && indexBelowSma50(new Date(t.entryDate)) === true) continue; // фильтр рынка
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;

    const blunt = simulateTrade(candles, series, t.entryIndex, dir, t.entryPrice, atr, false, false, false);
    variants.blunt.push({ ...blunt, ticker, entryDate: t.entryDate, exitDate: candles[blunt.exitIndex].date });

    const lossOnly = simulateTrade(candles, series, t.entryIndex, dir, t.entryPrice, atr, false, true, false);
    variants.lossOnly.push({ ...lossOnly, ticker, entryDate: t.entryDate, exitDate: candles[lossOnly.exitIndex].date });

    const profitOnly = simulateTrade(candles, series, t.entryIndex, dir, t.entryPrice, atr, true, false, false);
    variants.profitOnly.push({ ...profitOnly, ticker, entryDate: t.entryDate, exitDate: candles[profitOnly.exitIndex].date });

    const wp = simulateTrade(candles, series, t.entryIndex, dir, t.entryPrice, atr, true, true, false);
    variants.both.push({ ...wp, ticker, entryDate: t.entryDate, exitDate: candles[wp.exitIndex].date });

    // Запрос трейдера: без аварийного порога вообще — только следящий выход, loss-система
    // (если включена) — единственная защита от убытка.
    const noBluntBase = simulateTrade(candles, series, t.entryIndex, dir, t.entryPrice, atr, false, false, true);
    variants.noBluntBase.push({ ...noBluntBase, ticker, entryDate: t.entryDate, exitDate: candles[noBluntBase.exitIndex].date });
    const noBluntLoss = simulateTrade(candles, series, t.entryIndex, dir, t.entryPrice, atr, false, true, true);
    variants.noBluntLoss.push({ ...noBluntLoss, ticker, entryDate: t.entryDate, exitDate: candles[noBluntLoss.exitIndex].date });

    // Полная схема трейдера: то же + при выходе по подтверждённому развороту открываем
    // сделку в ОБРАТНУЮ сторону, ведём её профит-системой.
    variants.withReversal.push({ ...wp, ticker, entryDate: t.entryDate, exitDate: candles[wp.exitIndex].date });
    if (wp.reason === 'loss_score_reversal' && wp.exitIndex + 1 < candles.length) {
      const revEntryIndex = wp.exitIndex + 1;
      const revDir = -dir;
      const revEntryPrice = candles[revEntryIndex].open;
      const revAtr = atrS[revEntryIndex - 1] ?? atr;
      if (revAtr) {
        const rev = simulateTrade(candles, series, revEntryIndex, revDir, revEntryPrice, revAtr, true, true, false);
        variants.withReversal.push({ ...rev, ticker, entryDate: candles[revEntryIndex].date, exitDate: candles[rev.exitIndex].date, isReversal: true });
        reversalCount += 1;
        if (rev.pnlPct > 0) reversalWins += 1;
        reversalPnlSum += rev.pnlPct;
      }
    }
  }
}

console.log(`\n${'='.repeat(115)}`);
console.log('ИНТЕГРИРОВАННАЯ СХЕМА ТРЕЙДЕРА: loss-система выходит → открываем В ОБРАТНУЮ сторону → ведём профит-системой');
console.log(`${'='.repeat(115)}\n`);
console.log('Вариант                                              | Доходность | Просадка | Сделок | Худшая');
console.log('-'.repeat(115));
for (const [label, list] of [
  ['ЧЕСТНАЯ база (только блант ×2, ничего умного)', variants.blunt],
  ['+ ТОЛЬКО loss-система (без profit)', variants.lossOnly],
  ['+ ТОЛЬКО profit-система (без loss)', variants.profitOnly],
  ['+ ОБЕ системы вместе', variants.both],
  ['+ ОБЕ + обратные сделки (схема целиком)', variants.withReversal],
  ['БЕЗ аварийного порога вообще, ничего умного', variants.noBluntBase],
  ['БЕЗ аварийного порога, ТОЛЬКО loss-система', variants.noBluntLoss],
]) {
  const p = runPortfolio(list);
  console.log(`${label.padEnd(52)} | ${((p.totalReturnPct >= 0 ? '+' : '') + p.totalReturnPct.toFixed(1)).padStart(6)}% | ${p.maxDrawdownPct.toFixed(1).padStart(5)}% | ${String(p.closedTrades).padStart(6)} | ${p.worstTrade.toFixed(1)}%`);
}

console.log(`\nСами обратные сделки отдельно: ${reversalCount} шт.`);
if (reversalCount) {
  console.log(`  винрейт ${((reversalWins / reversalCount) * 100).toFixed(1)}%, средний результат ${(reversalPnlSum / reversalCount >= 0 ? '+' : '') + (reversalPnlSum / reversalCount).toFixed(3)}%`);
  console.log('  (если винрейт ~50% и средний ~0 — разворот снова оказался монеткой, как в прошлом тесте)');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
