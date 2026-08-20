// Продолжение рейтинговой системы (запрос трейдера 2026-08-14): вместо «любые 2 очка из
// 10 признаков» — разобрать, КАКИЕ ИМЕННО пары дают сигнал, перебрав все пары честно, с
// проверкой на отложенных данных. Плюс добавлены 4 НОВЫХ признака, которые до сих пор не
// проверялись ни разу:
//   1. Слом структуры — пробит ли последний значимый свинг-минимум (для лонга). Самая
//      сильная неиспробованная структурная идея из всего обсуждённого списка.
//   2. Сколько свечей ПОДРЯД закрылись против позиции («упорство» движения).
//   3. Размер тела свечи на баре пересечения (большое тело против = агрессия;
//      маленькое тело с длинной тенью = скорее отбой/ложный прокол).
//   4. Насколько далеко ушли против нас в единицах ATR на момент пересечения.
//
// Порядок: (а) новые признаки по одному, (б) все пары из полного набора — отбор на старой
// половине, проверка на новой. Пары, выжившие на новых данных, идут в денежный тест.
//
// Run: node scripts/reversalPairsAnalysis.mjs [D1|H1]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-pairs-'));

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
const { computePatternsAtEntry, PATTERN_DIRECTIONS } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'))
);
const { rsi, macd, ema, sma, bollingerSeries } = await import(indicatorsUrl);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

const TF = process.argv[2] || 'D1';
const TF_MINUTES = TF === 'D1' ? 1440 : 60;

const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' }, { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' }, { ticker: 'ROSN', instrumentType: 'stock' },
  { ticker: 'NVTK', instrumentType: 'stock' }, { ticker: 'TATN', instrumentType: 'stock' },
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'CHMF', instrumentType: 'stock' },
  { ticker: 'MGNT', instrumentType: 'stock' }, { ticker: 'IMOEXF', instrumentType: 'future' },
];

const WARMUP_BARS = 210;
const ADVERSE_ATR_MULT = 1.0;
const FOLLOWUP_WINDOW = 30;

function directionOf(p) {
  if (PATTERN_DIRECTIONS.bullish.includes(p)) return 1;
  if (PATTERN_DIRECTIONS.bearish.includes(p)) return -1;
  return 0;
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
// НОВОЕ: последний значимый свинг-экстремум ДО входа — для проверки слома структуры.
// Свинг = бар, чей low ниже (high выше) чем у `span` соседей с каждой стороны.
function lastSwingBefore(candles, index, dir, span = 3, lookback = 60) {
  for (let i = index - span - 1; i >= Math.max(span, index - lookback); i--) {
    let isSwing = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i || j < 0 || j >= candles.length) continue;
      if (dir === 1 ? candles[j].low < candles[i].low : candles[j].high > candles[i].high) { isSwing = false; break; }
    }
    if (isSwing) return dir === 1 ? candles[i].low : candles[i].high;
  }
  return null;
}

const rows = [];

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: TF, lookbackDays: TF === 'D1' ? 2200 : 1500 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < WARMUP_BARS + 100) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);

  const closes = candles.map((c) => c.close);
  const rsiS = rsi(closes, 14);
  const { histogram: macdS } = macd(closes);
  const ema9S = ema(closes, 9), ema21S = ema(closes, 21);
  const ema100S = ema(closes, 100), ema200S = ema(closes, 200);
  const sma50S = sma(closes, 50);
  const bbS = bollingerSeries(closes, 20, 2);
  const atrS = atrSeries(candles, 14);

  const seen = new Set();
  const lastUsable = candles.length - 1 - FOLLOWUP_WINDOW * 2;

  for (let i = WARMUP_BARS; i <= lastUsable; i++) {
    const patterns = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: TF_MINUTES });
    if (!patterns) continue;
    for (const c of patterns.candidates) {
      if (c.status === 'forming') continue;
      const dir = directionOf(c.pattern);
      if (dir === 0) continue;
      const key = Array.isArray(c.points) && c.points.length
        ? `${c.pattern}|${c.points[0].index}-${c.points[c.points.length - 1].index}` : `${c.pattern}|${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entryPrice = closes[i];
      const atrEntry = atrS[i];
      if (!atrEntry) continue;
      const noisePct = (atrEntry * ADVERSE_ATR_MULT / entryPrice) * 100;

      let k = null;
      for (let j = i + 1; j <= Math.min(candles.length - 1, i + FOLLOWUP_WINDOW); j++) {
        const adv = dir === 1 ? ((entryPrice - candles[j].low) / entryPrice) * 100
          : ((candles[j].high - entryPrice) / entryPrice) * 100;
        if (adv >= noisePct) { k = j; break; }
      }
      if (k == null) continue;
      if (rsiS[i] == null || rsiS[k] == null || !bbS[k] || ema200S[k] == null) continue;

      const side = (series, idx) => series[idx] == null ? null : ((closes[idx] - series[idx]) / series[idx]) * 100 * dir;
      const bbPos = (idx) => {
        const b = bbS[idx];
        if (!b || b.upper === b.lower) return null;
        const raw = (closes[idx] - b.lower) / (b.upper - b.lower);
        return dir === 1 ? raw : 1 - raw;
      };

      let closesOutsideBand = 0;
      for (let m = i + 1; m <= k; m++) {
        const b = bbS[m];
        if (!b) continue;
        if (dir === 1 ? closes[m] < b.lower : closes[m] > b.upper) closesOutsideBand += 1;
      }
      const bandSlope = (() => {
        const f = bbS[Math.max(0, k - 5)], t = bbS[k];
        if (!f || !t) return null;
        const fv = dir === 1 ? f.lower : f.upper, tv = dir === 1 ? t.lower : t.upper;
        return ((tv - fv) / fv) * 100 * dir;
      })();
      const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
      const volRatio = volAvg.length && Number.isFinite(candles[k].volume)
        ? candles[k].volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;

      // --- НОВЫЕ ПРИЗНАКИ ---------------------------------------------------------
      // 1. Слом структуры: пробит ли последний свинг-минимум (для лонга), бывший ДО входа
      const swing = lastSwingBefore(candles, i, dir);
      const structureBroken = swing != null
        ? (dir === 1 ? closes[k] < swing : closes[k] > swing) : null;
      // 2. Сколько свечей ПОДРЯД закрылись против позиции, считая назад от бара k
      let consecutiveAgainst = 0;
      for (let m = k; m > i; m--) {
        const worse = dir === 1 ? closes[m] < closes[m - 1] : closes[m] > closes[m - 1];
        if (worse) consecutiveAgainst += 1; else break;
      }
      // 3. Тело свечи на баре пересечения — доля тела от полного размаха
      const barK = candles[k];
      const range = barK.high - barK.low;
      const bodyRatio = range > 0 ? Math.abs(barK.close - barK.open) / range : null;
      const bodyAgainst = (dir === 1 ? barK.close < barK.open : barK.close > barK.open);
      // 4. Насколько далеко ушли против нас в ATR на момент пересечения
      const adverseAtr = atrEntry > 0
        ? (dir === 1 ? (entryPrice - barK.low) : (barK.high - entryPrice)) / atrEntry : null;

      let recovered = null;
      for (let m = k + 1; m <= Math.min(candles.length - 1, k + FOLLOWUP_WINDOW); m++) {
        const ret = dir === 1 ? ((closes[m] - entryPrice) / entryPrice) * 100
          : ((entryPrice - closes[m]) / entryPrice) * 100;
        if (ret > 0) { recovered = true; break; }
        const adv = dir === 1 ? ((entryPrice - candles[m].low) / entryPrice) * 100
          : ((candles[m].high - entryPrice) / entryPrice) * 100;
        if (adv >= noisePct * 2) { recovered = false; break; }
      }
      if (recovered == null) continue;

      rows.push({
        date: candles[i].date, recovered,
        rsiChange: (rsiS[k] - rsiS[i]) * dir, rsiLevel: rsiS[k],
        macdChange: (macdS[k] - macdS[i]) * dir,
        atrChangePct: atrEntry ? ((atrS[k] - atrEntry) / atrEntry) * 100 : null,
        bbPosChange: (bbPos(i) != null && bbPos(k) != null) ? bbPos(k) - bbPos(i) : null,
        closesOutsideBand, bandSlope, volRatio,
        ema200Broken: (side(ema200S, i) > 0 && side(ema200S, k) < 0),
        ema200Side: side(ema200S, k), ema100Side: side(ema100S, k),
        structureBroken, consecutiveAgainst, bodyRatio, bodyAgainst, adverseAtr,
      });
    }
  }
}

const FEATURES = [
  // Подтвердившиеся ранее (из reversalScoreSystem)
  ['A. Пробита EMA200', (r) => r.ema200Broken === true],
  ['B. Боллинджер: 2+ выхода за границу', (r) => r.closesOutsideBand >= 2],
  ['C. RSI упал >15', (r) => r.rsiChange <= -15],
  ['D. Боллинджер: 1 выход за границу', (r) => r.closesOutsideBand === 1],
  ['E. Объём >2× (экстремальный)', (r) => r.volRatio != null && r.volRatio > 2],
  ['F. Ушли из верхней половины Боллинджера', (r) => r.bbPosChange != null && r.bbPosChange <= -0.3],
  ['G. RSI упал >10', (r) => r.rsiChange <= -10],
  ['H. Полоса Боллинджера едет против нас', (r) => r.bandSlope != null && r.bandSlope < -0.5],
  ['I. RSI в зоне слабости (<40)', (r) => r.rsiLevel != null && r.rsiLevel < 40],
  ['J. Цена ниже EMA100', (r) => r.ema100Side != null && r.ema100Side < 0],
  ['K. RSI почти не изменился (±3) [ОТКАТ]', (r) => Math.abs(r.rsiChange) <= 3],
  ['L. Цена ВЫШЕ EMA200 [ОТКАТ]', (r) => r.ema200Side != null && r.ema200Side > 0],
  // НОВЫЕ, ранее не проверявшиеся
  ['М*. Слом структуры (пробит свинг до входа)', (r) => r.structureBroken === true],
  ['Н*. 3+ свечи подряд против позиции', (r) => r.consecutiveAgainst >= 3],
  ['О*. 5+ свечей подряд против позиции', (r) => r.consecutiveAgainst >= 5],
  ['П*. Крупное тело свечи против (>60% размаха)', (r) => r.bodyAgainst && r.bodyRatio != null && r.bodyRatio > 0.6],
  ['Р*. Мелкое тело с тенью (<30% размаха)', (r) => r.bodyRatio != null && r.bodyRatio < 0.3],
  ['С*. Ушли против >1.5 ATR', (r) => r.adverseAtr != null && r.adverseAtr > 1.5],
];

const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
const splitAt = Math.floor(sorted.length / 2);
const train = sorted.slice(0, splitAt), test = sorted.slice(splitAt);
const trainBase = (train.filter((r) => r.recovered).length / train.length) * 100;
const testBase = (test.filter((r) => r.recovered).length / test.length) * 100;

console.log(`\n${'='.repeat(110)}`);
console.log(`ПАРЫ + НОВЫЕ ПРИЗНАКИ — ${TF}, ${rows.length} случаев`);
console.log(`Обучение n=${train.length} (база ${trainBase.toFixed(1)}%) | Проверка n=${test.length} (база ${testBase.toFixed(1)}%)`);
console.log(`${'='.repeat(110)}\n`);

function rateOn(list, pred, base) {
  const sub = list.filter(pred);
  if (!sub.length) return { n: 0, rate: null, delta: null };
  const rate = (sub.filter((r) => r.recovered).length / sub.length) * 100;
  return { n: sub.length, rate, delta: rate - base };
}

console.log('--- НОВЫЕ ПРИЗНАКИ ПО ОДНОМУ (звёздочкой отмечены те, что раньше не проверялись) ---');
console.log('Признак                                           | Обучение          | ПРОВЕРКА          | Вердикт');
console.log('-'.repeat(110));
for (const [label, pred] of FEATURES.filter(([l]) => l.includes('*'))) {
  const tr = rateOn(train, pred, trainBase), te = rateOn(test, pred, testBase);
  let verdict = 'мало данных';
  if (tr.n >= 40 && te.n >= 40) {
    if (Math.sign(te.delta) !== Math.sign(tr.delta)) verdict = '❌ развалился';
    else if (Math.abs(te.delta) >= Math.abs(tr.delta) * 0.5) verdict = '✅ подтвердился';
    else verdict = '⚠️ ослаб';
  }
  console.log(`${label.padEnd(49)} | ${String(tr.n).padStart(4)}шт ${tr.delta != null ? ((tr.delta >= 0 ? '+' : '') + tr.delta.toFixed(1)).padStart(6) : '   —  '}п.п. | `
    + `${String(te.n).padStart(4)}шт ${te.delta != null ? ((te.delta >= 0 ? '+' : '') + te.delta.toFixed(1)).padStart(6) : '   —  '}п.п. | ${verdict}`);
}

// --- ВСЕ КОМБИНАЦИИ размера 2, 3, 4: отбор на обучении, проверка на новых ---------------
// Запрос трейдера: перебрать не только пары, а вообще все сочетания. 18 признаков дают
// 153 пары + 816 троек + 3060 четвёрок ≈ 4000 комбинаций.
// ⚠️ Именно поэтому holdout здесь не формальность, а единственное, что отличает находку от
// самообмана: перебирая 4000 вариантов, «отличные» на обучении находишь СОТНЯМИ даже в
// чистом случайном шуме. Настоящими считаем только те, что сохранили и знак, и хотя бы
// половину силы на данных, которых отбор не видел.
const combos = [];
function evaluateCombo(indices) {
  const preds = indices.map((idx) => FEATURES[idx][1]);
  const pred = (r) => preds.every((p) => p(r));
  const tr = rateOn(train, pred, trainBase);
  if (tr.n < 40 || Math.abs(tr.delta) < 12) return;
  const te = rateOn(test, pred, testBase);
  if (te.n < 30) return;
  const confirmed = Math.sign(te.delta) === Math.sign(tr.delta) && Math.abs(te.delta) >= Math.abs(tr.delta) * 0.5;
  combos.push({ indices, labels: indices.map((idx) => FEATURES[idx][0]), pred, tr, te, confirmed, size: indices.length });
}
const N = FEATURES.length;
for (let a = 0; a < N; a++) {
  for (let b = a + 1; b < N; b++) {
    evaluateCombo([a, b]);
    for (let c = b + 1; c < N; c++) {
      evaluateCombo([a, b, c]);
      for (let d = c + 1; d < N; d++) evaluateCombo([a, b, c, d]);
    }
  }
}

let tested = 0;
for (let s = 2; s <= 4; s++) {
  const f = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); };
  tested += f(N, s);
}
console.log(`\n--- ВСЕ КОМБИНАЦИИ ИЗ 2/3/4 ПРИЗНАКОВ ---`);
console.log(`Всего перебрано сочетаний: ~${tested}. Прошли фильтр обучения (n>=40, |откл.|>=12 п.п.): ${combos.length}.`);

const confirmed = combos.filter((c) => c.confirmed);
console.log(`Из них ПОДТВЕРДИЛИСЬ на новых данных: ${confirmed.length} (${((confirmed.length / Math.max(1, combos.length)) * 100).toFixed(0)}%).\n`);

for (const size of [2, 3, 4]) {
  const bySize = confirmed.filter((c) => c.size === size).sort((x, y) => Math.abs(y.te.delta) - Math.abs(x.te.delta));
  console.log(`\n### Лучшие подтверждённые комбинации из ${size} признаков (${bySize.length} шт. всего):`);
  if (!bySize.length) { console.log('  нет подтвердившихся'); continue; }
  for (const c of bySize.slice(0, 6)) {
    const codes = c.labels.map((l) => l.split('.')[0]).join('+');
    console.log(`  ${c.te.delta > 0 ? 'ОТКАТ   ' : 'РАЗВОРОТ'} | обуч. ${((c.tr.delta >= 0 ? '+' : '') + c.tr.delta.toFixed(1)).padStart(6)}п.п. (n=${String(c.tr.n).padStart(4)}) -> ПРОВЕРКА ${((c.te.delta >= 0 ? '+' : '') + c.te.delta.toFixed(1)).padStart(6)}п.п. (n=${String(c.te.n).padStart(4)}, ${c.te.rate.toFixed(1)}% вернулось) | ${codes}`);
    console.log(`             ${c.labels.join('  +  ')}`);
  }
}

console.log(`\n### ТОП-8 ПО СИЛЕ НА НОВЫХ ДАННЫХ (кандидаты в денежный тест):`);
for (const c of [...confirmed].sort((x, y) => Math.abs(y.te.delta) - Math.abs(x.te.delta)).slice(0, 8)) {
  console.log(`  [${c.size} призн.] ${c.te.delta > 0 ? 'ОТКАТ' : 'РАЗВОРОТ'} ${c.te.rate.toFixed(1)}% вернулось (n=${c.te.n}, откл. ${((c.te.delta >= 0 ? '+' : '') + c.te.delta.toFixed(1))}п.п.)`);
  console.log(`     ${c.labels.join(' + ')}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
