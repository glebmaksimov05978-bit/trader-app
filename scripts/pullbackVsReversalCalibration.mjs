// Проверка идеи трейдера (2026-08-14): можно ли научить движок отличать ОТКАТ (шум перед
// продолжением движения) от РАЗВОРОТА (движение реально пошло против входа) в момент,
// когда цена только начала идти против позиции — используя объём и скорость движения,
// а НЕ слепой таймер/фиксированный % (те два способа уже проверены и провалились,
// см. HANDOFF: задержка входа N свечей — не сработала; авторазворот после "выдыхания" —
// ровно монетка 50.1%).
//
// Методология: для каждого реального сигнала фигуры находим момент, когда движение против
// входа впервые пересекает "шумовой" ATR-порог (тот же принцип, что у trailAdverseMult в
// эксплуатации, но здесь мы смотрим ФОРВАРД, что было дальше, а не просто закрываем
// сделку). Дальше смотрим: цена в итоге ВЕРНУЛАСЬ выше входа (был откат, движение
// продолжилось) или УШЛА ЕЩЁ ДАЛЬШЕ против нас, не восстановившись (был реальный разворот).
// Сравниваем долю "вернулось" по трём признакам на МОМЕНТ пересечения порога:
//   1) объём на этом баре против среднего за 20 баров до входа,
//   2) сколько баров потребовалось, чтобы дойти до порога (быстро = 1-3 бара, медленно = дольше),
//   3) есть ли подтверждённая ВСТРЕЧНАЯ фигура (противоположного направления) в этот момент.
//
// Run: node scripts/pullbackVsReversalCalibration.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-pullback-'));

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
const { computePatternsAtEntry, PATTERN_DIRECTIONS } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'))
);
const { computeIndicatorsAtEntry } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'))
);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' }, { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' }, { ticker: 'IMOEXF', instrumentType: 'future' },
];

const WARMUP_BARS = 60;
const ADVERSE_ATR_MULT = 1.0;   // тот же "шумовой" порог, что у trailMinPeakAtrMult
const FOLLOWUP_WINDOW = 30;     // сколько баров смотрим ПОСЛЕ пересечения порога
const VOLUME_LOOKBACK = 20;

function directionOf(pattern) {
  if (PATTERN_DIRECTIONS.bullish.includes(pattern)) return 1;
  if (PATTERN_DIRECTIONS.bearish.includes(pattern)) return -1;
  return 0;
}

const rows = [];
const seen = new Set();

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 1500 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles?.length) { console.log('нет данных'); continue; }
  console.log(`${candles.length} свечей`);

  const lastUsable = candles.length - 1 - (ADVERSE_ATR_MULT ? 60 + FOLLOWUP_WINDOW : 0);
  for (let i = WARMUP_BARS; i <= lastUsable; i++) {
    const result = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: 1440 });
    if (!result) continue;
    const indicators = computeIndicatorsAtEntry(candles, candles[i].date);
    const atr = indicators?.atr14;
    if (!atr) continue;

    for (const c of result.candidates) {
      if (c.status === 'forming') continue;
      const direction = directionOf(c.pattern);
      if (direction === 0) continue;
      const key = `${ticker}|${c.pattern}|${i}`;
      if (Array.isArray(c.points) && c.points.length) {
        const dedupeKey = `${ticker}|${c.pattern}|${c.points[0].index}-${c.points[c.points.length - 1].index}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
      } else if (seen.has(key)) continue;
      else seen.add(key);

      const entryPrice = candles[i].close;
      const noiseThresholdPct = (atr * ADVERSE_ATR_MULT / entryPrice) * 100;
      const avgVolBefore = candles.slice(Math.max(0, i - VOLUME_LOOKBACK), i)
        .map((c2) => c2.volume).filter(Number.isFinite);
      const avgVol = avgVolBefore.length ? avgVolBefore.reduce((s, v) => s + v, 0) / avgVolBefore.length : null;

      // Ищем первый бар, где движение ПРОТИВ входа пересекает шумовой порог.
      let crossBar = null, crossIndex = null;
      const searchEnd = Math.min(candles.length - 1, i + FOLLOWUP_WINDOW);
      for (let j = i + 1; j <= searchEnd; j++) {
        const bar = candles[j];
        const adversePct = direction === 1
          ? ((entryPrice - bar.low) / entryPrice) * 100
          : ((bar.high - entryPrice) / entryPrice) * 100;
        if (adversePct >= noiseThresholdPct) { crossBar = bar; crossIndex = j; break; }
      }
      if (crossIndex == null) continue; // никогда не пошло против нас достаточно — не наш случай

      const volumeRatio = avgVol ? crossBar.volume / avgVol : null;
      const speedBars = crossIndex - i;
      // Размах фигуры в % цены — единственный признак, что реально сработал в прошлых
      // калибровках (крупные фигуры дают направление увереннее). Проверяем в связке.
      const amplitudePct = Array.isArray(c.points) && c.points.length
        ? ((Math.max(...c.points.map((p) => p.price)) - Math.min(...c.points.map((p) => p.price))) / entryPrice) * 100
        : null;

      // Встречная фигура на момент пересечения — подтверждённая фигура ПРОТИВОПОЛОЖНОГО
      // направления в этот же день.
      let opposingPattern = false;
      const crossPatterns = computePatternsAtEntry(candles, crossBar.date, { timeframeMinutes: 1440 });
      if (crossPatterns) {
        opposingPattern = crossPatterns.candidates.some((cc) =>
          cc.status !== 'forming' && directionOf(cc.pattern) === -direction);
      }

      // Что было ДАЛЬШЕ: вернулась ли цена выше входа (recovered) в оставшемся окне, или
      // ушла ещё на столько же порогов дальше против нас, ни разу не отыграв (continued).
      const followEnd = Math.min(candles.length - 1, crossIndex + FOLLOWUP_WINDOW);
      let recovered = false, continuedFurther = false;
      for (let k = crossIndex + 1; k <= followEnd; k++) {
        const bar = candles[k];
        const closeReturn = direction === 1
          ? ((bar.close - entryPrice) / entryPrice) * 100
          : ((entryPrice - bar.close) / entryPrice) * 100;
        if (closeReturn > 0) { recovered = true; break; }
        const adversePct = direction === 1
          ? ((entryPrice - bar.low) / entryPrice) * 100
          : ((bar.high - entryPrice) / entryPrice) * 100;
        if (adversePct >= noiseThresholdPct * 2) { continuedFurther = true; break; }
      }
      if (!recovered && !continuedFurther) continue; // неопределившийся исход в окне — пропускаем, не тянем за уши

      rows.push({ ticker, pattern: c.pattern, volumeRatio, speedBars, opposingPattern, amplitudePct, recovered });
    }
  }
}

console.log(`\nВсего случаев (движение против входа пересекло шумовой порог): ${rows.length}\n`);

function bucketStats(pred, label) {
  const yes = rows.filter(pred);
  const no = rows.filter((r) => !pred(r));
  const rate = (list) => list.length ? (list.filter((r) => r.recovered).length / list.length) * 100 : null;
  console.log(`${label}: ДА (n=${yes.length}) откат/восстановилось ${rate(yes)?.toFixed(1)}% | НЕТ (n=${no.length}) откат/восстановилось ${rate(no)?.toFixed(1)}%`);
}

console.log('=== Признак 1: объём на баре пересечения ===');
const withVol = rows.filter((r) => r.volumeRatio != null);
bucketStats((r) => r.volumeRatio != null && r.volumeRatio < 0.8, 'Слабый объём (<0.8× среднего)');
bucketStats((r) => r.volumeRatio != null && r.volumeRatio >= 0.8 && r.volumeRatio < 1.3, 'Обычный объём (0.8-1.3×)');
bucketStats((r) => r.volumeRatio != null && r.volumeRatio >= 1.3, 'Крупный объём (>1.3× среднего)');
console.log(`(баз выборка с объёмом: ${withVol.length})\n`);

console.log('=== Признак 2: скорость движения до порога ===');
bucketStats((r) => r.speedBars <= 2, 'Быстро (1-2 бара)');
bucketStats((r) => r.speedBars >= 3 && r.speedBars <= 6, 'Средне (3-6 баров)');
bucketStats((r) => r.speedBars >= 7, 'Медленно (7+ баров)');
console.log();

console.log('=== Признак 3: встречная фигура в момент пересечения ===');
bucketStats((r) => r.opposingPattern, 'Есть встречная фигура');
console.log();

console.log(`Базовая доля отката/восстановления по всей выборке: ${((rows.filter((r) => r.recovered).length / rows.length) * 100).toFixed(1)}%\n`);

// --- Связка: объём + амплитуда фигуры ---------------------------------------------------
// По отдельности объём дал слабый намёк (42% vs 33%), амплитуда — сильный сигнал в
// прошлых калибровках (крупные фигуры точнее). Проверяем, усиливают ли они друг друга —
// именно то, что просил трейдер, вместо перебора "ещё одного одиночного признака".
console.log('=== Связка: слабый объём (<0.8×) + крупная фигура (амплитуда выше медианы) ===');
const withAmp = rows.filter((r) => r.amplitudePct != null);
const medianAmp = [...withAmp.map((r) => r.amplitudePct)].sort((a, b) => a - b)[Math.floor(withAmp.length / 2)];
console.log(`(медиана амплитуды: ${medianAmp?.toFixed(2)}%, n с амплитудой: ${withAmp.length})`);
function comboStats(pred, label) {
  const list = rows.filter(pred);
  const rate = list.length ? (list.filter((r) => r.recovered).length / list.length) * 100 : null;
  console.log(`${label}: n=${list.length}, откат/восстановилось ${rate?.toFixed(1)}%`);
}
comboStats((r) => r.volumeRatio != null && r.volumeRatio < 0.8 && r.amplitudePct != null && r.amplitudePct >= medianAmp,
  'Слабый объём + крупная фигура (ожидаем: сигнал сильный, вероятно откат)');
comboStats((r) => r.volumeRatio != null && r.volumeRatio >= 1.3 && r.amplitudePct != null && r.amplitudePct >= medianAmp,
  'Крупный объём + крупная фигура (ожидаем: сигнал сильный, вероятно разворот)');
comboStats((r) => r.volumeRatio != null && r.volumeRatio < 0.8 && r.amplitudePct != null && r.amplitudePct < medianAmp,
  'Слабый объём + мелкая фигура');
comboStats((r) => r.volumeRatio != null && r.volumeRatio >= 1.3 && r.amplitudePct != null && r.amplitudePct < medianAmp,
  'Крупный объём + мелкая фигура');

fs.rmSync(tmpDir, { recursive: true, force: true });
