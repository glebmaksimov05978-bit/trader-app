// Идея ТРЕЙДЕРА (2026-08-14), самая перспективная из всего обсуждённого: смотреть не на
// ЗНАЧЕНИЕ индикаторов в момент входа (это мы уже мерили много раз), а на ИХ ИЗМЕНЕНИЕ
// после входа — то есть на динамику развития конкретной сделки. Плюс автоматический
// перебор ПАРНЫХ связок (RSI+Боллинджер, MACD+EMA и т.д.), раз по отдельности признаки
// давали слабый сигнал.
//
// Что измеряем: для каждого реального сигнала фигуры ловим момент, когда движение ПРОТИВ
// позиции впервые пересекает "шумовой" ATR-порог. На этот момент считаем ИЗМЕНЕНИЕ каждого
// индикатора относительно входа. Дальше смотрим форвардно: цена вернулась выше входа
// (был ОТКАТ) или ушла ещё дальше против, не отыграв (был РАЗВОРОТ).
//
// ⚠️ Против look-ahead bias: все признаки считаются ТОЛЬКО по свечам до момента
// пересечения включительно (`candles.slice(0, crossIndex + 1)`), исход — строго ПОСЛЕ него.
//
// Run: node scripts/indicatorDynamicsCalibration.mjs [D1|H1]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-inddyn-'));

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
const { rsi, macd, ema, bollingerSeries } = await import(indicatorsUrl);
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
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'IMOEXF', instrumentType: 'future' },
];

const WARMUP_BARS = 210; // нужно ≥200 для EMA200
const ADVERSE_ATR_MULT = 1.0;
const FOLLOWUP_WINDOW = 30;

function directionOf(pattern) {
  if (PATTERN_DIRECTIONS.bullish.includes(pattern)) return 1;
  if (PATTERN_DIRECTIONS.bearish.includes(pattern)) return -1;
  return 0;
}

// Стохастик — у нас его не было, добавляю здесь (трейдер просил проверить, стоит ли он
// внимания). По конструкции это тот же класс индикатора, что RSI (осциллятор импульса),
// поэтому ожидаемо будет сильно скоррелирован с ним — но пусть данные скажут сами.
function stochastic(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const hi = Math.max(...slice.map((c) => c.high));
    const lo = Math.min(...slice.map((c) => c.low));
    out[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  return out;
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

const rows = [];

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: TF, lookbackDays: TF === 'D1' ? 2200 : 1500 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < WARMUP_BARS + 100) { console.log(`мало данных (${candles?.length ?? 0})`); continue; }
  console.log(`${candles.length} свечей`);

  // Все серии считаем один раз по всей истории — но ЧИТАЕМ только индексы <= момента
  // расчёта, поэтому look-ahead не возникает (каждое значение серии зависит только от
  // прошлого: rsi/macd/ema/bollinger/atr — все причинные, без центрирования).
  const closes = candles.map((c) => c.close);
  const rsiS = rsi(closes, 14);
  const { histogram: macdS } = macd(closes);
  const ema9S = ema(closes, 9);
  const ema100S = ema(closes, 100);
  const ema200S = ema(closes, 200);
  const bbS = bollingerSeries(closes, 20, 2);
  const atrS = atrSeries(candles, 14);
  const stochS = stochastic(candles, 14);

  const seen = new Set();
  const lastUsable = candles.length - 1 - FOLLOWUP_WINDOW * 2;

  for (let i = WARMUP_BARS; i <= lastUsable; i++) {
    const patterns = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: TF_MINUTES });
    if (!patterns) continue;
    for (const c of patterns.candidates) {
      if (c.status === 'forming') continue;
      const direction = directionOf(c.pattern);
      if (direction === 0) continue;
      const dedupeKey = Array.isArray(c.points) && c.points.length
        ? `${c.pattern}|${c.points[0].index}-${c.points[c.points.length - 1].index}`
        : `${c.pattern}|${i}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const entryPrice = candles[i].close;
      const atrAtEntry = atrS[i];
      if (!atrAtEntry) continue;
      const noiseThresholdPct = (atrAtEntry * ADVERSE_ATR_MULT / entryPrice) * 100;

      // Момент, когда движение против входа пересекло шумовой порог.
      let crossIndex = null;
      for (let j = i + 1; j <= Math.min(candles.length - 1, i + FOLLOWUP_WINDOW); j++) {
        const adversePct = direction === 1
          ? ((entryPrice - candles[j].low) / entryPrice) * 100
          : ((candles[j].high - entryPrice) / entryPrice) * 100;
        if (adversePct >= noiseThresholdPct) { crossIndex = j; break; }
      }
      if (crossIndex == null) continue;

      const k = crossIndex;
      if (rsiS[i] == null || rsiS[k] == null || macdS[i] == null || macdS[k] == null) continue;
      if (!bbS[i] || !bbS[k] || ema200S[i] == null || ema200S[k] == null) continue;

      // --- ИЗМЕНЕНИЕ индикаторов от входа к моменту пересечения (идея трейдера) ---------
      // Знак нормализуем по направлению сделки: "хуже для нас" всегда отрицательное.
      const rsiChange = (rsiS[k] - rsiS[i]) * direction;
      const macdChange = (macdS[k] - macdS[i]) * direction;
      const stochChange = (stochS[k] != null && stochS[i] != null) ? (stochS[k] - stochS[i]) * direction : null;
      // ATR: расширение волатильности (доп. признак от меня — трейдер не называл)
      const atrChangePct = atrS[k] != null && atrAtEntry ? ((atrS[k] - atrAtEntry) / atrAtEntry) * 100 : null;
      // Положение внутри полос Боллинджера: 0 = нижняя, 1 = верхняя. Для шорта переворачиваем.
      const bbPosAt = (idx) => {
        const b = bbS[idx];
        if (!b || b.upper === b.lower) return null;
        const raw = (closes[idx] - b.lower) / (b.upper - b.lower);
        return direction === 1 ? raw : 1 - raw;
      };
      const bbPosEntry = bbPosAt(i), bbPosCross = bbPosAt(k);
      const bbPosChange = (bbPosEntry != null && bbPosCross != null) ? bbPosCross - bbPosEntry : null;
      // Ширина полос — сжимаются или расширяются
      const bbWidth = (idx) => { const b = bbS[idx]; return b ? (b.upper - b.lower) / closes[idx] * 100 : null; };
      const bbWidthChange = (bbWidth(i) != null && bbWidth(k) != null) ? bbWidth(k) - bbWidth(i) : null;
      // Слом быстрой/медленных EMA: было ли цена по нужную сторону, стало ли нет
      const emaSide = (emaS, idx) => emaS[idx] == null ? null : ((closes[idx] - emaS[idx]) / emaS[idx]) * 100 * direction;
      const ema9Entry = emaSide(ema9S, i), ema9Cross = emaSide(ema9S, k);
      const ema9Broken = (ema9Entry != null && ema9Cross != null) ? (ema9Entry > 0 && ema9Cross < 0) : null;
      const ema100Cross = emaSide(ema100S, k);
      const ema200Cross = emaSide(ema200S, k);
      const ema200Broken = ema200Cross != null ? ema200Cross < 0 : null;

      // --- НАБЛЮДЕНИЕ ТРЕЙДЕРА (2026-08-14) ------------------------------------------
      // "Когда идёт настоящий разворот — цена уходит за дальнюю границу Боллинджера
      // НЕСКОЛЬКО раз подряд, и сама полоса начинает идти вниз. Когда обычный откат —
      // максимум один раз выходит и возвращается к противоположной границе."
      // Формализуем ровно это, тремя отдельными признаками:
      //   1) сколько раз ЗАКРЫЛИСЬ за дальней границей от входа до момента пересечения,
      //   2) наклон самой полосы (идёт ли она против нас) за последние 5 баров,
      //   3) вернулась ли цена хоть раз в верхнюю половину канала после первого выхода.
      let closesOutsideBand = 0, returnedToFarHalf = false, sawOutside = false;
      for (let m = i + 1; m <= k; m++) {
        const b = bbS[m];
        if (!b) continue;
        const outside = direction === 1 ? closes[m] < b.lower : closes[m] > b.upper;
        if (outside) { closesOutsideBand += 1; sawOutside = true; }
        else if (sawOutside) {
          const pos = bbPosAt(m);
          if (pos != null && pos > 0.5) returnedToFarHalf = true;
        }
      }
      // Наклон дальней (для лонга — нижней) границы за 5 баров, нормализован по цене и
      // по направлению сделки: отрицательный = полоса едет против нас.
      const bandSlopePct = (() => {
        const from = bbS[Math.max(0, k - 5)], to = bbS[k];
        if (!from || !to) return null;
        const fromVal = direction === 1 ? from.lower : from.upper;
        const toVal = direction === 1 ? to.lower : to.upper;
        return ((toVal - fromVal) / fromVal) * 100 * direction;
      })();

      // --- Исход: откат (вернулось) или разворот (ушло дальше) --------------------------
      let recovered = null;
      const followEnd = Math.min(candles.length - 1, k + FOLLOWUP_WINDOW);
      for (let m = k + 1; m <= followEnd; m++) {
        const closeReturn = direction === 1
          ? ((candles[m].close - entryPrice) / entryPrice) * 100
          : ((entryPrice - candles[m].close) / entryPrice) * 100;
        if (closeReturn > 0) { recovered = true; break; }
        const adversePct = direction === 1
          ? ((entryPrice - candles[m].low) / entryPrice) * 100
          : ((candles[m].high - entryPrice) / entryPrice) * 100;
        if (adversePct >= noiseThresholdPct * 2) { recovered = false; break; }
      }
      if (recovered == null) continue; // неопределившийся исход — не тянем за уши

      rows.push({
        ticker, pattern: c.pattern, recovered, entryDate: candles[i].date,
        rsiChange, macdChange, stochChange, atrChangePct,
        bbPosChange, bbWidthChange, ema9Broken, ema100Cross, ema200Cross, ema200Broken,
        closesOutsideBand, returnedToFarHalf, bandSlopePct,
        volumeRatio: (() => {
          const avg = candles.slice(Math.max(0, k - 20), k).map((c2) => c2.volume).filter(Number.isFinite);
          if (!avg.length || !Number.isFinite(candles[k].volume)) return null;
          return candles[k].volume / (avg.reduce((s, v) => s + v, 0) / avg.length);
        })(),
      });
    }
  }
}

const base = rows.length ? (rows.filter((r) => r.recovered).length / rows.length) * 100 : 0;
console.log(`\n${'='.repeat(105)}`);
console.log(`ДИНАМИКА ИНДИКАТОРОВ после входа — ${TF}, ${rows.length} случаев`);
console.log(`Базовая доля "вернулось" (был откат): ${base.toFixed(1)}%  — всё, что заметно выше/ниже, несёт сигнал`);
console.log(`${'='.repeat(105)}\n`);

function report(label, pred) {
  const yes = rows.filter(pred);
  if (yes.length < 40) { console.log(`${label.padEnd(52)} | n=${String(yes.length).padStart(4)} — мало, пропускаем`); return null; }
  const rate = (yes.filter((r) => r.recovered).length / yes.length) * 100;
  const delta = rate - base;
  const mark = Math.abs(delta) >= 8 ? (delta > 0 ? ' ← откат' : ' ← РАЗВОРОТ') : '';
  console.log(`${label.padEnd(52)} | n=${String(yes.length).padStart(4)} | вернулось ${rate.toFixed(1).padStart(5)}% | ${(delta >= 0 ? '+' : '') + delta.toFixed(1)} п.п.${mark}`);
  return { label, n: yes.length, rate, delta, pred };
}

const singles = [];
console.log('--- ПО ОДНОМУ ПРИЗНАКУ ---');
singles.push(report('RSI упал сильно (>10 пунктов против нас)', (r) => r.rsiChange <= -10));
singles.push(report('RSI почти не изменился (в пределах ±3)', (r) => Math.abs(r.rsiChange) <= 3));
singles.push(report('MACD-гистограмма развернулась против', (r) => r.macdChange < 0));
singles.push(report('Стохастик упал сильно (>15 против нас)', (r) => r.stochChange != null && r.stochChange <= -15));
singles.push(report('ATR расширился >20% (паника/агрессия)', (r) => r.atrChangePct != null && r.atrChangePct > 20));
singles.push(report('ATR сжался (вялое движение)', (r) => r.atrChangePct != null && r.atrChangePct < -10));
singles.push(report('Ушли из верхней половины полос Боллинджера', (r) => r.bbPosChange != null && r.bbPosChange <= -0.3));
singles.push(report('Полосы Боллинджера расширяются', (r) => r.bbWidthChange != null && r.bbWidthChange > 0.5));
singles.push(report('Пробита EMA9 (быстрая) — слом импульса', (r) => r.ema9Broken === true));
singles.push(report('Цена ушла ниже EMA100', (r) => r.ema100Cross != null && r.ema100Cross < 0));
singles.push(report('Цена ушла ниже EMA200 (слом тренда)', (r) => r.ema200Broken === true));
singles.push(report('Цена ВЫШЕ EMA200 (тренд ещё цел)', (r) => r.ema200Cross != null && r.ema200Cross > 0));
console.log('\n--- НАБЛЮДЕНИЕ ТРЕЙДЕРА про Боллинджер + объём ---');
singles.push(report('За границу Боллинджера вышли ОДИН раз', (r) => r.closesOutsideBand === 1));
singles.push(report('За границу вышли 2+ раза (по наблюдению — разворот)', (r) => r.closesOutsideBand >= 2));
singles.push(report('За границу вышли 3+ раза', (r) => r.closesOutsideBand >= 3));
singles.push(report('Вернулись к противоположной половине канала', (r) => r.returnedToFarHalf === true));
singles.push(report('Полоса Боллинджера едет ПРОТИВ нас (наклон)', (r) => r.bandSlopePct != null && r.bandSlopePct < -0.5));
singles.push(report('Объём на баре пересечения слабый (<0.8×)', (r) => r.volumeRatio != null && r.volumeRatio < 0.8));
singles.push(report('Объём на баре пересечения крупный (>1.3×)', (r) => r.volumeRatio != null && r.volumeRatio > 1.3));

const usable = singles.filter(Boolean);

// --- Автоматический перебор ПАРНЫХ связок ------------------------------------------------
// Трейдер просил именно связки. Перебираем все пары из признаков выше и печатаем те, что
// дают отклонение сильнее любого из двух признаков по отдельности — то есть где связка
// реально усиливает, а не просто наследует сигнал одного из участников.
console.log('\n--- СВЯЗКИ ПО ДВА (показаны только те, что СИЛЬНЕЕ каждого участника по отдельности) ---');
const combos = [];
for (let a = 0; a < usable.length; a++) {
  for (let b = a + 1; b < usable.length; b++) {
    const A = usable[a], B = usable[b];
    const list = rows.filter((r) => A.pred(r) && B.pred(r));
    if (list.length < 40) continue;
    const rate = (list.filter((r) => r.recovered).length / list.length) * 100;
    const delta = rate - base;
    if (Math.abs(delta) <= Math.max(Math.abs(A.delta), Math.abs(B.delta))) continue; // связка не усиливает
    combos.push({ a: A.label, b: B.label, n: list.length, rate, delta });
  }
}
combos.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
if (!combos.length) console.log('Ни одна пара не усилила сигнал сверх своих участников — связки не помогают.');
for (const c of combos.slice(0, 12)) {
  console.log(`n=${String(c.n).padStart(4)} | вернулось ${c.rate.toFixed(1).padStart(5)}% | ${(c.delta >= 0 ? '+' : '') + c.delta.toFixed(1)} п.п. ${c.delta > 0 ? '(откат)' : '(РАЗВОРОТ)'}`);
  console.log(`       ${c.a}`);
  console.log(`     + ${c.b}\n`);
}

// --- ЧЕСТНАЯ ПРОВЕРКА НА ОТЛОЖЕННЫХ ДАННЫХ ----------------------------------------------
// Обязательный шаг: перебрав ~66 пар на одних данных, лучшую находишь ВСЕГДА — даже в
// случайном шуме. Поэтому: делим историю по времени пополам, ищем лучшие связки ТОЛЬКО на
// первой половине, и проверяем их на второй, которую поиск не видел. Если связка держится
// на обеих — она настоящая. Если разваливается — это была подгонка, и хорошо, что поймали.
console.log(`\n${'='.repeat(105)}`);
console.log('ЧЕСТНАЯ ПРОВЕРКА: ищем связки на СТАРОЙ половине истории, проверяем на НОВОЙ');
console.log(`${'='.repeat(105)}\n`);

const sorted = [...rows].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
const splitAt = Math.floor(sorted.length / 2);
const trainRows = sorted.slice(0, splitAt);
const testRows = sorted.slice(splitAt);
const splitDate = new Date(sorted[splitAt].entryDate).toISOString().slice(0, 10);
const trainBase = (trainRows.filter((r) => r.recovered).length / trainRows.length) * 100;
const testBase = (testRows.filter((r) => r.recovered).length / testRows.length) * 100;
console.log(`Разрез по дате ${splitDate}: обучение n=${trainRows.length} (база ${trainBase.toFixed(1)}%), проверка n=${testRows.length} (база ${testBase.toFixed(1)}%)\n`);

function rateOn(list, pred) {
  const sub = list.filter(pred);
  return sub.length ? { n: sub.length, rate: (sub.filter((r) => r.recovered).length / sub.length) * 100 } : { n: 0, rate: null };
}

// Ищем лучшие пары ТОЛЬКО на обучающей половине
const trainCombos = [];
for (let a = 0; a < usable.length; a++) {
  for (let b = a + 1; b < usable.length; b++) {
    const A = usable[a], B = usable[b];
    const pred = (r) => A.pred(r) && B.pred(r);
    const tr = rateOn(trainRows, pred);
    if (tr.n < 30) continue;
    trainCombos.push({ a: A.label, b: B.label, pred, trainN: tr.n, trainRate: tr.rate, trainDelta: tr.rate - trainBase });
  }
}
trainCombos.sort((x, y) => Math.abs(y.trainDelta) - Math.abs(x.trainDelta));

console.log('Связка (найдена на старых данных)                    | Обучение          | ПРОВЕРКА (новые)   | Вердикт');
console.log('-'.repeat(115));
for (const c of trainCombos.slice(0, 10)) {
  const te = rateOn(testRows, c.pred);
  const testDelta = te.rate != null ? te.rate - testBase : null;
  let verdict;
  if (te.n < 25) verdict = 'мало данных';
  else if (testDelta == null) verdict = '—';
  else if (Math.sign(testDelta) !== Math.sign(c.trainDelta)) verdict = '❌ РАЗВАЛИЛАСЬ (знак сменился)';
  else if (Math.abs(testDelta) >= Math.abs(c.trainDelta) * 0.5) verdict = '✅ ПОДТВЕРДИЛАСЬ';
  else verdict = '⚠️ ослабла вдвое+';
  const label = `${c.a.slice(0, 24)} + ${c.b.slice(0, 22)}`;
  console.log(`${label.padEnd(52)} | ${String(c.trainN).padStart(4)}шт ${(c.trainDelta >= 0 ? '+' : '') + c.trainDelta.toFixed(1).padStart(5)}п.п. | `
    + `${String(te.n).padStart(4)}шт ${te.rate != null ? ((testDelta >= 0 ? '+' : '') + testDelta.toFixed(1)).padStart(6) + 'п.п.' : '   —   '} | ${verdict}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
