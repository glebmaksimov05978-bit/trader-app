// Второе большое исследование, симметричное scripts/reversalPairsAnalysis.mjs, но для
// ПРИБЫЛЬНОЙ стороны сделки (запрос трейдера 2026-08-16): сейчас прибыль фиксируется по
// грубому правилу "отдали 50% от пика" — рано, средний выигрыш всего +2.5% при типичном
// ATR ~2.5%. Вопрос: какие индикаторы реально сигналят "движение выдыхается, пора
// закрывать" — а не просто отдать процент от пика вслепую?
//
// Методология (зеркало reversal-калибровки): для каждой сделки, которая набрала хотя бы
// 1×ATR в свою пользу (тот же "шумовой" порог, что армирует следящий выход), смотрим на
// каждый следующий бар: сколько ЕЩЁ движения останется до фактического пика (MFE) этой
// сделки. Метка "уже близко к вершине" = осталось меньше 20% от уже набранного; "ещё есть
// куда расти" = осталось больше 50% сверху. Признаки считаются ТОЛЬКО по прошлому
// (никакого заглядывания вперёд), метка "что будет дальше" — специально из будущего, для
// разметки, не для признаков.
//
// Run: node scripts/profitCaptureCalibration.mjs [D1|H1]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-profitcap-'));

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
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'CHMF', instrumentType: 'stock' },
  { ticker: 'MGNT', instrumentType: 'stock' }, { ticker: 'IMOEXF', instrumentType: 'future' },
];

const WARMUP_BARS = 210;
const ARM_ATR_MULT = 1.0;
const FOLLOWUP_WINDOW = 45;

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
      const armPct = (atrEntry * ARM_ATR_MULT / entryPrice) * 100;

      // Найти сначала момент "армирования" — пик впервые превысил порог.
      const end = Math.min(candles.length - 1, i + FOLLOWUP_WINDOW);
      let armIndex = null, peakSoFar = 0, eventualMfe = 0, eventualMfeIndex = i;
      for (let j = i + 1; j <= end; j++) {
        const bar = candles[j];
        const fav = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
        if (fav > eventualMfe) { eventualMfe = fav; eventualMfeIndex = j; }
        if (armIndex == null && fav >= armPct) armIndex = j;
      }
      if (armIndex == null || eventualMfe < armPct * 1.2) continue; // не набрало смысла разбирать

      // Для КАЖДОГО бара от армирования до пика — признаки (только прошлое) + метка
      // "сколько ЕЩЁ движения останется до фактического пика, в долях уже набранного".
      for (let k = armIndex; k <= eventualMfeIndex; k++) {
        const bar = candles[k];
        const currentFav = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
        if (currentFav <= 0) continue;
        const remaining = eventualMfe - currentFav;
        if (remaining < -0.01) continue; // после факта пика (close может чуть превышать high предыдущих баров при гэпе) — пропустить
        const remainingFraction = remaining / currentFav;
        // Метка: "near_top" — почти всё движение уже позади (остаётся <20% от набранного).
        // "still_running" — ещё минимум +50% сверху набранного впереди.
        let label = null;
        if (remainingFraction < 0.2) label = 'near_top';
        else if (remainingFraction > 0.5) label = 'still_running';
        if (!label) continue; // средняя зона — неопределённо, не тянем за уши

        if (rsiS[k] == null || !bbS[k] || rsiS[armIndex] == null) continue;
        const rsiChangeFromArm = (rsiS[k] - rsiS[armIndex]) * dir;
        const macdChange = macdS[k] != null && macdS[armIndex] != null ? (macdS[k] - macdS[armIndex]) * dir : null;
        const macdSide = macdS[k] != null ? macdS[k] * dir : null;
        const bbPos = (() => {
          const b = bbS[k];
          if (!b || b.upper === b.lower) return null;
          const raw = (closes[k] - b.lower) / (b.upper - b.lower);
          return dir === 1 ? raw : 1 - raw;
        })();
        const ema9Side = ema9S[k] != null ? ((closes[k] - ema9S[k]) / ema9S[k]) * 100 * dir : null;
        const ema21Side = ema21S[k] != null ? ((closes[k] - ema21S[k]) / ema21S[k]) * 100 * dir : null;
        const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
        const volRatio = volAvg.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
        const barsFromArm = k - armIndex;
        // Замедление: свежая свеча меньше средней из последних 3-х по размаху движения.
        const recentMoves = [];
        for (let m = Math.max(armIndex + 1, k - 2); m <= k; m++) {
          const prevClose = candles[m - 1].close;
          recentMoves.push(((candles[m].close - prevClose) / prevClose) * 100 * dir);
        }
        const avgRecentMove = recentMoves.length ? recentMoves.reduce((s, v) => s + v, 0) / recentMoves.length : null;

        rows.push({
          ticker, date: candles[i].date, label, dir,
          rsiLevel: rsiS[k], rsiChangeFromArm, macdChange, macdSide, bbPos,
          ema9Side, ema21Side, volRatio, barsFromArm, avgRecentMove,
          currentFavPct: currentFav,
        });
      }
    }
  }
}

console.log(`\nВсего размеченных точек (near_top / still_running): ${rows.length}`);
const nearTopN = rows.filter((r) => r.label === 'near_top').length;
console.log(`near_top: ${nearTopN}, still_running: ${rows.length - nearTopN}\n`);

const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
const splitAt = Math.floor(sorted.length / 2);
const train = sorted.slice(0, splitAt), test = sorted.slice(splitAt);
function baseRate(list) { return list.length ? (list.filter((r) => r.label === 'near_top').length / list.length) * 100 : 0; }
const trainBase = baseRate(train), testBase = baseRate(test);
console.log(`База "near_top" — обучение ${trainBase.toFixed(1)}%, проверка ${testBase.toFixed(1)}%\n`);

function rateOn(list, pred) {
  const sub = list.filter(pred);
  if (!sub.length) return { n: 0, rate: null };
  return { n: sub.length, rate: (sub.filter((r) => r.label === 'near_top').length / sub.length) * 100 };
}
function report(label, pred) {
  const tr = rateOn(train, pred), te = rateOn(test, pred);
  if (tr.n < 60 || te.n < 40) { console.log(`${label.padEnd(52)} | мало данных (обуч.${tr.n}/пров.${te.n})`); return null; }
  const trDelta = tr.rate - trainBase, teDelta = te.rate - testBase;
  const verdict = Math.sign(trDelta) === Math.sign(teDelta) && Math.abs(teDelta) >= Math.abs(trDelta) * 0.5 ? '✅' : (Math.abs(teDelta) < 3 ? '➖ слабо' : '⚠️');
  console.log(`${label.padEnd(52)} | обуч.${(trDelta >= 0 ? '+' : '') + trDelta.toFixed(1)}п.п. (n=${tr.n}) | пров.${(teDelta >= 0 ? '+' : '') + teDelta.toFixed(1)}п.п. (n=${te.n}) | ${verdict}`);
  return { label, pred, teDelta };
}

console.log('--- Признаки "движение выдыхается / уже близко к вершине" ---');
const feats = [];
feats.push(report('RSI высокий сейчас (экстремум по направлению)', (r) => (r.dir === 1 ? r.rsiLevel > 70 : r.rsiLevel < 30)));
feats.push(report('RSI не растёт от армирования (Δ<=2)', (r) => Math.abs(r.rsiChangeFromArm) <= 2 && r.barsFromArm >= 2));
feats.push(report('RSI падает от армирования (Δ<=-5)', (r) => r.rsiChangeFromArm <= -5));
feats.push(report('MACD-гистограмма ослабевает (Δ<0)', (r) => r.macdChange != null && r.macdChange < 0));
feats.push(report('Цена в верхней трети канала Боллинджера (>0.85)', (r) => r.bbPos != null && r.bbPos > 0.85));
feats.push(report('Объём падает (<0.7×)', (r) => r.volRatio != null && r.volRatio < 0.7));
feats.push(report('Объём растёт резко (>1.8×)', (r) => r.volRatio != null && r.volRatio > 1.8));
feats.push(report('Последние свечи замедлились (сред.движение <0.3%)', (r) => r.avgRecentMove != null && r.avgRecentMove < 0.3 && r.barsFromArm >= 2));
feats.push(report('Держим уже долго (10+ баров от армирования)', (r) => r.barsFromArm >= 10));
feats.push(report('Держим совсем недолго (<=2 бара)', (r) => r.barsFromArm <= 2));
feats.push(report('Отрыв от EMA9 большой (>2×ATR-эквив., >3%)', (r) => r.ema9Side != null && r.ema9Side > 3));
feats.push(report('Текущая прибыль уже крупная (>5%)', (r) => r.currentFavPct > 5));

const usable = feats.filter(Boolean);
console.log(`\nПодтвердилось (✅): ${usable.filter((f) => Math.abs(f.teDelta) >= 3).length} из ${usable.length} проверенных\n`);

fs.rmSync(tmpDir, { recursive: true, force: true });
