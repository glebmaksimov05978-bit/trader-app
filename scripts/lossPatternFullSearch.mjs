// Расширенный поиск для убыточной стороны (2026-08-17), симметричный
// scripts/profitCaptureFullSearch.mjs — трейдер справедливо попросил не ограничиваться
// 12 признаками, а искать так же тщательно, как для прибыли: много вариаций одного
// индикатора, полный перебор, НЕСКОЛЬКО СТРАТЕГИЙ (не только фигурная).
//
// ВАЖНО (см. чат с трейдером): это НЕ повтор денежного теста — денежный тест уже
// провалился (HANDOFF п.23) не из-за слабости предсказания, а из-за портфельной механики
// (ранний выход = чуринг). Здесь просто убеждаемся, что предсказание — лучшее из
// возможного, чтобы потом попробовать ПРИМЕНИТЬ его иначе (фильтр на входе, не резать
// на середине сделки).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-lossfull-'));

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
const { computeMarketContextAtEntry } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/marketContext.js'))
);
const { rsi, macd, ema, bollingerSeries } = await import(indicatorsUrl);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

const STRATEGIES = {
  'Фигуры': {
    id: 'patterns_levels', readinessThreshold: 75,
    conditions: [
      { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
      { id: 'near_support', enabled: true, param: 1, direction: 'long' },
      { id: 'near_resistance', enabled: true, param: 1, direction: 'short' },
      { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
      { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
    ], customConditions: [],
  },
  'EMA200+MACD': {
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
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'CHMF', instrumentType: 'stock' },
  { ticker: 'MGNT', instrumentType: 'stock' }, { ticker: 'RUAL', instrumentType: 'stock' },
  { ticker: 'VTBR', instrumentType: 'stock' }, { ticker: 'ALRS', instrumentType: 'stock' },
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
function stochastic(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const s = candles.slice(i - period + 1, i + 1);
    const hi = Math.max(...s.map((c) => c.high)), lo = Math.min(...s.map((c) => c.low));
    out[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
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

const ARM_ATR_MULT = 1.0;
const FOLLOWUP_WINDOW = 45;
const rows = [];

for (const [stratName, strategy] of Object.entries(STRATEGIES)) {
  for (const { ticker, instrumentType } of TICKERS) {
    process.stdout.write(`${stratName}/${ticker}... `);
    let candles;
    try {
      candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
    } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
    if (!candles || candles.length < 310) { console.log('мало данных'); continue; }
    console.log(`${candles.length} свечей`);

    const closes = candles.map((c) => c.close);
    const rsi7 = rsi(closes, 7), rsi14 = rsi(closes, 14), rsi21 = rsi(closes, 21);
    const { histogram: macdS } = macd(closes);
    const ema5S = ema(closes, 5), ema9S = ema(closes, 9), ema13S = ema(closes, 13), ema21S = ema(closes, 21), ema50S = ema(closes, 50);
    const bbS20 = bollingerSeries(closes, 20, 2), bbS10 = bollingerSeries(closes, 10, 2);
    const atrS = atrSeries(candles, 14);
    const stochS = stochastic(candles, 14);
    const adxS = adxLite(candles, 14);

    // Собираем реальные входы через сам движок (та же стратегия), не через поиск фигур.
    let harvest;
    try {
      harvest = runBacktest({ candles, strategy, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
    } catch (e) { continue; }

    for (const t of harvest.trades) {
      if (t.entryIndex == null) continue;
      const i = t.entryIndex;
      const dir = t.direction === 'long' ? 1 : -1;
      const entryPrice = t.entryPrice;
      const atrEntry = atrS[i - 1] ?? atrS[i];
      if (!atrEntry) continue;
      const armPct = (atrEntry * ARM_ATR_MULT / entryPrice) * 100;

      const end = Math.min(candles.length - 1, i + FOLLOWUP_WINDOW);
      let armIndex = null, eventualMae = 0, eventualMaeIndex = i;
      for (let j = i + 1; j <= end; j++) {
        const bar = candles[j];
        const adv = dir === 1 ? ((entryPrice - bar.low) / entryPrice) * 100 : ((bar.high - entryPrice) / entryPrice) * 100;
        if (adv > eventualMae) { eventualMae = adv; eventualMaeIndex = j; }
        if (armIndex == null && adv >= armPct) armIndex = j;
      }
      if (armIndex == null || eventualMae < armPct * 1.2) continue;

      for (let k = armIndex; k <= eventualMaeIndex; k++) {
        const bar = candles[k];
        const currentAdv = dir === 1 ? ((entryPrice - bar.close) / entryPrice) * 100 : ((bar.close - entryPrice) / entryPrice) * 100;
        if (currentAdv <= 0) continue;
        const remaining = eventualMae - currentAdv;
        if (remaining < -0.01) continue;
        const remainingFraction = remaining / currentAdv;
        let label = null;
        if (remainingFraction < 0.2) label = 'near_bottom';
        else if (remainingFraction > 0.5) label = 'still_worsening';
        if (!label) continue;
        if (rsi14[k] == null || !bbS20[k]) continue;

        const sideOf = (series, idx) => series[idx] == null ? null : ((closes[idx] - series[idx]) / series[idx]) * 100 * dir;
        const bbPosOf = (b) => { if (!b || b.upper === b.lower) return null; const raw = (closes[k] - b.lower) / (b.upper - b.lower); return dir === 1 ? raw : 1 - raw; };
        const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
        const volRatio20 = volAvg.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;

        const mc = computeMarketContextAtEntry(candles, candles[i].date);
        const gauge = mc?.trend?.gaugePercent ?? null;
        const isTrending = gauge != null ? Math.abs(gauge - 50) > 20 : null;

        rows.push({
          strategy: stratName, ticker, label, dir, date: candles[i].date,
          rsi7: rsi7[k], rsi14: rsi14[k], rsi21: rsi21[k],
          rsi14ChangeArm: rsi14[armIndex] != null && rsi14[k] != null ? (rsi14[k] - rsi14[armIndex]) * dir : null,
          stoch: stochS[k], macdSide: macdS[k] != null ? macdS[k] * dir : null, adx: adxS[k],
          bbPos20: bbPosOf(bbS20[k]), bbPos10: bbPosOf(bbS10[k]),
          ema5Side: sideOf(ema5S, k), ema9Side: sideOf(ema9S, k), ema13Side: sideOf(ema13S, k),
          ema21Side: sideOf(ema21S, k), ema50Side: sideOf(ema50S, k),
          volRatio20, barsFromArm: k - armIndex, currentAdvPct: currentAdv, isTrending,
        });
      }
    }
  }
}

console.log(`\nВсего размеченных точек (все стратегии вместе): ${rows.length}`);
const nearBottomN = rows.filter((r) => r.label === 'near_bottom').length;
console.log(`near_bottom: ${nearBottomN}, still_worsening: ${rows.length - nearBottomN}\n`);

const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
const splitAt = Math.floor(sorted.length / 2);
const train = sorted.slice(0, splitAt), test = sorted.slice(splitAt);
function baseRate(list) { return list.length ? (list.filter((r) => r.label === 'near_bottom').length / list.length) * 100 : 0; }
const trainBase = baseRate(train), testBase = baseRate(test);
console.log(`База — обучение ${trainBase.toFixed(1)}%, проверка ${testBase.toFixed(1)}%\n`);

const FEATURES = [
  ['RSI7 экстремум против', (r) => r.dir === 1 ? r.rsi7 < 25 : r.rsi7 > 75],
  ['RSI14 экстремум против (<30)', (r) => r.dir === 1 ? r.rsi14 < 30 : r.rsi14 > 70],
  ['RSI21 экстремум против', (r) => r.dir === 1 ? r.rsi21 < 35 : r.rsi21 > 65],
  ['RSI14 продолжает валиться (Δ<=-10)', (r) => r.rsi14ChangeArm != null && r.rsi14ChangeArm <= -10],
  ['RSI14 стабилен (Δ>=-2)', (r) => r.rsi14ChangeArm != null && r.rsi14ChangeArm >= -2],
  ['Стохастик экстремум против (<15)', (r) => r.stoch != null && r.stoch < 15],
  ['MACD глубоко против', (r) => r.macdSide != null && r.macdSide < -0.5],
  ['ADX высокий (>40, сильный тренд ПРОТИВ)', (r) => r.adx != null && r.adx > 40],
  ['ADX низкий (<15, слабый тренд)', (r) => r.adx != null && r.adx < 15],
  ['Боллинджер20 дальняя граница (<0.15)', (r) => r.bbPos20 != null && r.bbPos20 < 0.15],
  ['Боллинджер10 дальняя граница (<0.15)', (r) => r.bbPos10 != null && r.bbPos10 < 0.15],
  ['Отрыв EMA5 большой против (>2%)', (r) => r.ema5Side != null && r.ema5Side < -2],
  ['Отрыв EMA9 большой против (>3%)', (r) => r.ema9Side != null && r.ema9Side < -3],
  ['Отрыв EMA13 большой против (>4%)', (r) => r.ema13Side != null && r.ema13Side < -4],
  ['Отрыв EMA21 большой против (>5%)', (r) => r.ema21Side != null && r.ema21Side < -5],
  ['Отрыв EMA50 большой против (>7%)', (r) => r.ema50Side != null && r.ema50Side < -7],
  ['Объём всплеск (>1.8×)', (r) => r.volRatio20 != null && r.volRatio20 > 1.8],
  ['Объём падает (<0.6×)', (r) => r.volRatio20 != null && r.volRatio20 < 0.6],
  ['Держим 10+ баров', (r) => r.barsFromArm >= 10],
  ['Держим 15+ баров', (r) => r.barsFromArm >= 15],
  ['Держим <=2 бара', (r) => r.barsFromArm <= 2],
  ['Убыток >5%', (r) => r.currentAdvPct > 5],
  ['Убыток >8%', (r) => r.currentAdvPct > 8],
  ['Рынок в тренде (детектор)', (r) => r.isTrending === true],
];

function rateOn(list, pred, base) {
  const sub = list.filter(pred);
  if (!sub.length) return { n: 0, rate: null, delta: null };
  const rate = (sub.filter((r) => r.label === 'near_bottom').length / sub.length) * 100;
  return { n: sub.length, rate, delta: rate - base };
}

console.log('--- ОДИНОЧНЫЕ ПРИЗНАКИ (все стратегии вместе) ---');
const usable = [];
for (const [label, pred] of FEATURES) {
  const tr = rateOn(train, pred, trainBase), te = rateOn(test, pred, testBase);
  if (tr.n < 80 || te.n < 60) { console.log(`${label.padEnd(48)} | мало данных`); continue; }
  const verdict = Math.sign(tr.delta) === Math.sign(te.delta) && Math.abs(te.delta) >= Math.abs(tr.delta) * 0.5 ? '✅' : '❌';
  console.log(`${label.padEnd(48)} | обуч.${(tr.delta >= 0 ? '+' : '') + tr.delta.toFixed(1)}п.п. | пров.${(te.delta >= 0 ? '+' : '') + te.delta.toFixed(1)}п.п. (n=${te.n}) | ${verdict}`);
  if (verdict === '✅') usable.push({ label, pred, teDelta: te.delta });
}

console.log(`\n--- ПЕРЕБОР ПАР/ТРОЕК ИЗ ${usable.length} ПОДТВЕРДИВШИХСЯ ---`);
const combos = [];
function evalCombo(idxs) {
  const preds = idxs.map((i) => usable[i].pred);
  const pred = (r) => preds.every((p) => p(r));
  const tr = rateOn(train, pred, trainBase);
  if (tr.n < 50 || Math.abs(tr.delta) < 10) return;
  const te = rateOn(test, pred, testBase);
  if (te.n < 35) return;
  const confirmed = Math.sign(te.delta) === Math.sign(tr.delta) && Math.abs(te.delta) >= Math.abs(tr.delta) * 0.5;
  if (!confirmed) return;
  combos.push({ labels: idxs.map((i) => usable[i].label), n: te.n, rate: te.rate, delta: te.delta });
}
for (let a = 0; a < usable.length; a++) {
  for (let b = a + 1; b < usable.length; b++) {
    evalCombo([a, b]);
    for (let c = b + 1; c < usable.length; c++) evalCombo([a, b, c]);
  }
}
combos.sort((x, y) => y.rate - x.rate);
console.log(`Подтвердившихся: ${combos.length}\n`);
console.log('ТОП-10 ПО ТОЧНОСТИ (доля near_bottom на проверке):');
for (const c of combos.slice(0, 10)) {
  console.log(`  ${c.rate.toFixed(1)}% (n=${c.n}, откл. ${(c.delta >= 0 ? '+' : '') + c.delta.toFixed(1)}п.п.) | ${c.labels.join(' + ')}`);
}

// Разбивка лучшей связки по стратегиям — универсальна ли она, как и просил трейдер.
if (combos.length) {
  const best = combos[0];
  const bestPreds = usable.filter((u) => best.labels.includes(u.label)).map((u) => u.pred);
  const bestPred = (r) => bestPreds.every((p) => p(r));
  console.log('\n--- ЛУЧШАЯ СВЯЗКА ПО СТРАТЕГИЯМ ОТДЕЛЬНО ---');
  for (const stratName of Object.keys(STRATEGIES)) {
    const sub = test.filter((r) => r.strategy === stratName && bestPred(r));
    if (sub.length < 20) { console.log(`${stratName.padEnd(15)} | мало данных (n=${sub.length})`); continue; }
    const rate = (sub.filter((r) => r.label === 'near_bottom').length / sub.length) * 100;
    console.log(`${stratName.padEnd(15)} | n=${sub.length} | ${rate.toFixed(1)}% near_bottom`);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
