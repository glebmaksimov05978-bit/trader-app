// Третье большое исследование, симметричное scripts/profitCaptureCalibration.mjs, но для
// УБЫТОЧНОЙ стороны (запрос трейдера 2026-08-16). Разница с scripts/reversalScoreSystem.mjs
// (п.7-13, УЖЕ сделано): там мерили БИНАРНЫЙ исход "вернулась цена выше входа или ушла
// дальше на 2× порога" — здесь, симметрично профит-модулю, мерим НЕПРЕРЫВНО "насколько
// ЕЩЁ хуже станет, прежде чем сделка достигнет своего фактического дна (MAE)". Это другой
// вопрос: не "разворот или откат", а "если это разворот — близко ли уже дно, или падение
// только начинается". Отвечает на вопрос трейдера "как лучше расставлять баллы" точнее,
// чем бинарная разметка.
//
// Методология: для каждой сделки, движение против входа впервые пересекло ATR-порог
// (армирование, как у следящего выхода). Дальше для каждого следующего бара — сколько ЕЩЁ
// просадки останется до фактического дна (MAE) этой сделки, в долях уже набранного убытка.
// "near_bottom" = осталось <20% сверху (падение почти закончилось, дно близко).
// "still_worsening" = осталось >50% сверху (упадёт заметно больше).
//
// Run: node scripts/lossPatternCalibration.mjs [D1|H1]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-losscap-'));

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
const ARM_ATR_MULT = 1.0; // тот же шумовой порог, что армирует следящий выход
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

      // Найти момент армирования по АДВЕРСНОЙ стороне (движение впервые против нас
      // превысило шумовой порог) и фактическое дно (MAE) в окне.
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

        if (rsiS[k] == null || !bbS[k] || rsiS[armIndex] == null) continue;
        const rsiChangeFromArm = (rsiS[k] - rsiS[armIndex]) * dir;
        const macdSide = macdS[k] != null ? macdS[k] * dir : null;
        const bbPos = (() => {
          const b = bbS[k];
          if (!b || b.upper === b.lower) return null;
          const raw = (closes[k] - b.lower) / (b.upper - b.lower);
          return dir === 1 ? raw : 1 - raw; // 0 = дальняя (плохая) сторона канала
        })();
        const ema9Side = ema9S[k] != null ? ((closes[k] - ema9S[k]) / ema9S[k]) * 100 * dir : null;
        const ema21Side = ema21S[k] != null ? ((closes[k] - ema21S[k]) / ema21S[k]) * 100 * dir : null;
        const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
        const volRatio = volAvg.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
        const barsFromArm = k - armIndex;
        const recentMoves = [];
        for (let m = Math.max(armIndex + 1, k - 2); m <= k; m++) {
          const prevClose = candles[m - 1].close;
          recentMoves.push(((candles[m].close - prevClose) / prevClose) * 100 * dir);
        }
        const avgRecentMove = recentMoves.length ? recentMoves.reduce((s, v) => s + v, 0) / recentMoves.length : null;

        rows.push({
          ticker, date: candles[i].date, label, dir,
          rsiLevel: rsiS[k], rsiChangeFromArm, macdSide, bbPos,
          ema9Side, ema21Side, volRatio, barsFromArm, avgRecentMove,
          currentAdvPct: currentAdv,
        });
      }
    }
  }
}

console.log(`\nВсего размеченных точек (near_bottom / still_worsening): ${rows.length}`);
const nearBottomN = rows.filter((r) => r.label === 'near_bottom').length;
console.log(`near_bottom: ${nearBottomN}, still_worsening: ${rows.length - nearBottomN}\n`);

const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
const splitAt = Math.floor(sorted.length / 2);
const train = sorted.slice(0, splitAt), test = sorted.slice(splitAt);
function baseRate(list) { return list.length ? (list.filter((r) => r.label === 'near_bottom').length / list.length) * 100 : 0; }
const trainBase = baseRate(train), testBase = baseRate(test);
console.log(`База "near_bottom" — обучение ${trainBase.toFixed(1)}%, проверка ${testBase.toFixed(1)}%\n`);

function rateOn(list, pred) {
  const sub = list.filter(pred);
  if (!sub.length) return { n: 0, rate: null };
  return { n: sub.length, rate: (sub.filter((r) => r.label === 'near_bottom').length / sub.length) * 100 };
}
function report(label, pred) {
  const tr = rateOn(train, pred), te = rateOn(test, pred);
  if (tr.n < 60 || te.n < 40) { console.log(`${label.padEnd(52)} | мало данных (обуч.${tr.n}/пров.${te.n})`); return null; }
  const trDelta = tr.rate - trainBase, teDelta = te.rate - testBase;
  const verdict = Math.sign(trDelta) === Math.sign(teDelta) && Math.abs(teDelta) >= Math.abs(trDelta) * 0.5 ? '✅' : (Math.abs(teDelta) < 3 ? '➖ слабо' : '⚠️');
  console.log(`${label.padEnd(52)} | обуч.${(trDelta >= 0 ? '+' : '') + trDelta.toFixed(1)}п.п. (n=${tr.n}) | пров.${(teDelta >= 0 ? '+' : '') + teDelta.toFixed(1)}п.п. (n=${te.n}) | ${verdict}`);
  return { label, pred, teDelta };
}

console.log('--- Признаки "падение почти закончилось (дно близко)" ---');
const feats = [];
feats.push(report('RSI на экстремуме ПРОТИВ нас', (r) => (r.dir === 1 ? r.rsiLevel < 30 : r.rsiLevel > 70)));
feats.push(report('RSI не падает от армирования (Δ>=-2)', (r) => r.rsiChangeFromArm >= -2 && r.barsFromArm >= 2));
feats.push(report('RSI продолжает валиться (Δ<=-10)', (r) => r.rsiChangeFromArm <= -10));
feats.push(report('MACD уже глубоко против нас', (r) => r.macdSide != null && r.macdSide < -0.5));
feats.push(report('Цена у дальней (плохой) границы Боллинджера (<0.15)', (r) => r.bbPos != null && r.bbPos < 0.15));
feats.push(report('Объём падает (<0.7×) — паника выдыхается', (r) => r.volRatio != null && r.volRatio < 0.7));
feats.push(report('Объём резко растёт (>1.8×) — паника продолжается', (r) => r.volRatio != null && r.volRatio > 1.8));
feats.push(report('Последние свечи замедлились (<0.3%)', (r) => r.avgRecentMove != null && Math.abs(r.avgRecentMove) < 0.3 && r.barsFromArm >= 2));
feats.push(report('Падаем уже долго (10+ баров)', (r) => r.barsFromArm >= 10));
feats.push(report('Падаем совсем недолго (<=2 бара)', (r) => r.barsFromArm <= 2));
feats.push(report('Отрыв от EMA21 большой (>4% против нас)', (r) => r.ema21Side != null && r.ema21Side < -4));
feats.push(report('Текущий убыток уже крупный (>5%)', (r) => r.currentAdvPct > 5));

const usable = feats.filter(Boolean);
console.log(`\nПодтвердилось (✅ или сильный ⚠️): ${usable.filter((f) => Math.abs(f.teDelta) >= 4).length} из ${usable.length} проверенных\n`);

fs.rmSync(tmpDir, { recursive: true, force: true });
