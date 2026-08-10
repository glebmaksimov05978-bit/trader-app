// Calibration check for pattern-detector "confidence" scores (roadmap item #1, agreed
// with the trader 2026-08-09 — see project-backtest-lab-roadmap.md in Claude memory and
// HANDOFF_NEXT_SESSION.md). The confidence numbers computePatternsAtEntry() reports
// (e.g. "double-bottom, 82%") are hand-tuned geometric-fit formulas — they have never
// been checked against what actually happened to price afterward. This script does that
// check: walk real MOEX daily history for several tickers, record every confirmed
// pattern instance the REAL production detector finds (no lookahead — same function the
// app itself calls), then look forward and see whether higher-confidence instances
// actually won more often than lower-confidence ones.
//
// Run with: node scripts/patternCalibration.mjs
//
// Uses the same esmify-into-tmp-dir technique as scripts/goldenImportTests.mjs so this
// always reads the real, current production source — never a hand-copied duplicate that
// can drift out of sync.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-calib-'));

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

// candles.js imports this only for the Tinkoff-token code path, which we never use here
// (MOEX ISS is free, no auth) — stub keeps the module graph loadable without pulling in
// real Tinkoff API code.
fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), `
export class TinkoffAPI {}
export function moneyToFloat() { return 0; }
`);

esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
esmify(path.join(repoRoot, 'src/services/analytics/candlestickPatterns.js'));
const { computePatternsAtEntry, PATTERN_DIRECTIONS } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'))
);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

// Mix of categories the trader already uses for cross-checks (index future, blue-chip
// stocks with different volatility character) — enough spread to not be a single-
// instrument fluke, not so many that the script takes forever.
const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' },
  { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' },
  { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' },
  { ticker: 'IMOEXF', instrumentType: 'future' },
];

const WARMUP_BARS = 60;
const OUTCOME_WINDOW_BARS = 15;
const SUCCESS_THRESHOLD_PCT = 2; // matches the 2% stop many of the trader's real strategies use

function directionOf(pattern) {
  if (PATTERN_DIRECTIONS.bullish.includes(pattern)) return 1;
  if (PATTERN_DIRECTIONS.bearish.includes(pattern)) return -1;
  return 0; // neutral (symmetric triangle, horizontal flag) — can't score a "direction" call
}

// For multi-bar swing patterns, `points` (the swing coordinates) is a stable identity —
// use it to dedupe the SAME formation being reported again on every subsequent day it
// stays confirmed (otherwise one real pattern instance would be counted dozens of times,
// drowning out genuinely distinct instances). Single-bar patterns (pin bar, engulfing,
// breakout) fire on exactly one bar by construction — no dedup needed, index is already
// a unique key.
function instanceKey(candidate, barIndex) {
  if (Array.isArray(candidate.points) && candidate.points.length) {
    const first = candidate.points[0].index;
    const last = candidate.points[candidate.points.length - 1].index;
    return `${candidate.pattern}|${first}-${last}`;
  }
  return `${candidate.pattern}|bar${barIndex}`;
}

// `win` — the realistic "would a trade with a 2% stop have worked" outcome (adverse-hit
// loses even if price eventually goes the right way afterward — same as real trading).
// `directionHit` — the trader's question: "did the pattern at least call the right
// DIRECTION at some point, ignoring whether a stop would have knocked you out first?"
// Decoupling these tests exactly his hypothesis — a pattern can be directionally correct
// far more often than its tradeable win-rate suggests, if the real problem is timing
// (entering right as the move is exhausted) rather than the directional call itself.
function scoreOutcome(candles, entryIndex, direction) {
  const entryPrice = candles[entryIndex].close;
  const end = Math.min(candles.length - 1, entryIndex + OUTCOME_WINDOW_BARS);
  let win = null;
  let maxFavorablePct = 0;
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = direction === 1
      ? ((bar.high - entryPrice) / entryPrice) * 100
      : ((entryPrice - bar.low) / entryPrice) * 100;
    const adverse = direction === 1
      ? ((entryPrice - bar.low) / entryPrice) * 100
      : ((bar.high - entryPrice) / entryPrice) * 100;
    maxFavorablePct = Math.max(maxFavorablePct, favorable);
    if (win === null) {
      if (favorable >= SUCCESS_THRESHOLD_PCT && adverse >= SUCCESS_THRESHOLD_PCT) win = 0; // ambiguous same-bar — assume worse, same rule the engine uses
      else if (favorable >= SUCCESS_THRESHOLD_PCT) win = 1;
      else if (adverse >= SUCCESS_THRESHOLD_PCT) win = 0;
    }
  }
  if (win === null) {
    const last = candles[end];
    const netReturn = direction === 1
      ? ((last.close - entryPrice) / entryPrice) * 100
      : ((entryPrice - last.close) / entryPrice) * 100;
    win = netReturn > 0 ? 1 : 0;
  }
  // Direction was "right" if price ever moved favorably by the threshold at any point in
  // the window, full stop — no matter what happened to an imaginary stop-loss.
  const directionHit = maxFavorablePct >= SUCCESS_THRESHOLD_PCT ? 1 : 0;
  return { win, directionHit };
}

// --- Прототип "жизненного цикла фигуры" ------------------------------------------
// Вместо жёсткого стопа по цене — выходим, когда движение реально ВЫДОХЛОСЬ: цена
// откатила от своего максимума (в пользу сделки) больше чем на `giveBackFraction` этого
// максимума. Плюс широкий аварийный стоп на случай резкого движения сразу против нас
// (без него риск неограничен). Если вышли именно по "выдыханию" (не по аварийному
// стопу) — отдельно смотрим, что было бы, если тут же открыть сделку в ОБРАТНУЮ сторону.
const LIFECYCLE_MAX_WINDOW = 30;
const LIFECYCLE_GIVEBACK_FRACTION = 0.5; // отдать половину набранного пути — считаем "выдохлась"
const LIFECYCLE_MIN_PEAK_PCT = 1; // не считаем откатом шум до того, как накопилось хоть 1% в нашу пользу
const LIFECYCLE_EMERGENCY_STOP_PCT = 4; // шире обычного 2% стопа — даём сделке "дышать"
const LIFECYCLE_FRACTIONS_TO_TEST = [0.3, 0.5, 0.7]; // "отдать 30/50/70% набранного максимума" — искать оптимум по типам фигур

function lifecycleExit(candles, entryIndex, direction, giveBackFraction = LIFECYCLE_GIVEBACK_FRACTION) {
  const entryPrice = candles[entryIndex].close;
  const end = Math.min(candles.length - 1, entryIndex + LIFECYCLE_MAX_WINDOW);
  let peakFavorablePct = 0;
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorableHigh = direction === 1
      ? ((bar.high - entryPrice) / entryPrice) * 100
      : ((entryPrice - bar.low) / entryPrice) * 100;
    const adverse = direction === 1
      ? ((entryPrice - bar.low) / entryPrice) * 100
      : ((bar.high - entryPrice) / entryPrice) * 100;
    peakFavorablePct = Math.max(peakFavorablePct, favorableHigh);
    const closeReturnPct = direction === 1
      ? ((bar.close - entryPrice) / entryPrice) * 100
      : ((entryPrice - bar.close) / entryPrice) * 100;
    if (adverse >= LIFECYCLE_EMERGENCY_STOP_PCT) {
      return { exitIndex: i, returnPct: -LIFECYCLE_EMERGENCY_STOP_PCT, reason: 'stop' };
    }
    if (peakFavorablePct >= LIFECYCLE_MIN_PEAK_PCT) {
      const giveBackThreshold = peakFavorablePct * (1 - giveBackFraction);
      if (closeReturnPct <= giveBackThreshold) {
        return { exitIndex: i, returnPct: closeReturnPct, reason: 'exhausted' };
      }
    }
  }
  const last = candles[end];
  const finalReturnPct = direction === 1
    ? ((last.close - entryPrice) / entryPrice) * 100
    : ((entryPrice - last.close) / entryPrice) * 100;
  return { exitIndex: end, returnPct: finalReturnPct, reason: 'window_end' };
}

// --- Прицельная проверка для double_top/double_bottom: реальный ориентир фигуры ------
// Трейдер уточнил идею: не "разворачивай, как только движение выдохлось вообще", а
// именно ПО ЛОГИКЕ КОНКРЕТНОЙ ФИГУРЫ — у двойной вершины/дна есть встроенный ориентир,
// "основание" между двумя пиками (точка B). Сначала цена должна дойти туда (это и есть
// то движение, которое обещает фигура), и только ПОСЛЕ этого разворот имеет смысл
// проверять — не раньше и не "когда попало откатило на 50%". Это тот же уровень, что
// уже использует doubleTopBottomTargetReached() в patterns.js для отмены устаревшей
// фигуры — здесь мы используем его как момент для проверки разворота.
const TARGET_SEARCH_WINDOW = 40;
function findTargetReachIndex(candles, fromIndex, targetPrice, originalDirection) {
  const end = Math.min(candles.length - 1, fromIndex + TARGET_SEARCH_WINDOW);
  for (let i = fromIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const reached = originalDirection === -1 ? bar.low <= targetPrice : bar.high >= targetPrice;
    if (reached) return i;
  }
  return null;
}
const targetReverseRows = []; // { pattern, barsToTarget, win, directionHit }

// Separate from `rows` on purpose: `rows` dedupes to the pattern's FIRST appearance
// (needed everywhere else so one instance doesn't get counted dozens of times). But that
// makes "age" trivially small always — we'd never see how it performs once it's been
// sitting there a while. This collection instead samples EVERY day an instance stays
// reported (still capped once per ticker+pattern+day, never per-swing-window artifact),
// specifically to answer "does staying confirmed for a long time hurt the odds?" — the
// same question already answered for double_top/bottom (MAX_DOUBLE_PATTERN_AGE_BARS) but
// never checked for the other pattern types.
const ageRows = []; // { pattern, ageBars, win, directionHit }

// Delayed-entry variants — same pattern instance, but pretend we waited N bars after
// confirmation before actually entering, instead of entering right on the confirmation
// bar. Tests the trader's "maybe the confirmation bar itself is already a bad moment"
// hypothesis directly.
const ENTRY_DELAYS = [0, 3, 5];

const rows = []; // { ticker, pattern, confidence, barsSpan, win, directionHit, delayed: {0:win,3:win,5:win} }

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`Загружаю ${ticker}... `);
  let candles;
  try {
    candles = await fetchDailyCandles({
      ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 1500,
    });
  } catch (e) {
    console.log(`ошибка загрузки: ${e.message}`);
    continue;
  }
  if (!candles?.length) { console.log('нет данных'); continue; }
  console.log(`${candles.length} свечей`);

  const seen = new Set();
  const maxDelay = Math.max(...ENTRY_DELAYS);
  const reserveTail = Math.max(
    OUTCOME_WINDOW_BARS + maxDelay,
    LIFECYCLE_MAX_WINDOW + OUTCOME_WINDOW_BARS,
    TARGET_SEARCH_WINDOW + OUTCOME_WINDOW_BARS,
  );
  const lastUsableIndex = candles.length - 1 - reserveTail;
  for (let i = WARMUP_BARS; i <= lastUsableIndex; i++) {
    const result = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: 1440 });
    if (!result) continue;
    for (const c of result.candidates) {
      if (c.status === 'forming') continue; // not a completed call yet — nothing to score
      const direction = directionOf(c.pattern);
      if (direction === 0) continue; // neutral patterns have no directional call to grade

      // "Актуальность" — сколько свечей прошло от ЗАВЕРШЕНИЯ фигуры (последней точки) до
      // сегодняшнего бара. Замер на КАЖДЫЙ день, пока фигура остаётся в списке — не только
      // на первый — иначе никогда не увидим, что бывает с "постаревшими" инстансами.
      const ageBars = Array.isArray(c.points) && c.points.length
        ? i - c.points[c.points.length - 1].index
        : null;
      if (ageBars != null) {
        const aged = scoreOutcome(candles, i, direction);
        ageRows.push({ pattern: c.pattern, ageBars, win: aged.win, directionHit: aged.directionHit });
      }

      const key = `${ticker}|${instanceKey(c, i)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const barsSpan = Array.isArray(c.points) && c.points.length
        ? c.points[c.points.length - 1].index - c.points[0].index
        : null;
      const { win, directionHit } = scoreOutcome(candles, i, direction);
      const delayed = {};
      for (const d of ENTRY_DELAYS) delayed[d] = scoreOutcome(candles, i + d, direction).win;

      if ((c.pattern === 'double_top' || c.pattern === 'double_bottom') && c.points?.length === 3) {
        const targetPrice = c.points[1].price; // point B — the base/neckline between the two peaks/troughs
        const targetIdx = findTargetReachIndex(candles, i, targetPrice, direction);
        if (targetIdx != null && targetIdx + OUTCOME_WINDOW_BARS <= candles.length - 1) {
          const atTarget = scoreOutcome(candles, targetIdx, -direction);
          targetReverseRows.push({
            pattern: c.pattern, barsToTarget: targetIdx - i, win: atTarget.win, directionHit: atTarget.directionHit,
          });
        }
      }

      const lifecycle = lifecycleExit(candles, i, direction);
      let reverseWin = null;
      if (lifecycle.reason === 'exhausted' && lifecycle.exitIndex + OUTCOME_WINDOW_BARS <= candles.length - 1) {
        reverseWin = scoreOutcome(candles, lifecycle.exitIndex, -direction).win;
      }

      // Трейдер прав, что жизненный цикл, скорее всего, нельзя настраивать ОДНИМ
      // параметром на все фигуры сразу — проверяем 3 варианта "сколько отдать от
      // набранного максимума" на каждой сделке, чтобы увидеть, отличается ли оптимум по
      // типам фигур.
      const lifecycleByFraction = {};
      for (const f of LIFECYCLE_FRACTIONS_TO_TEST) {
        lifecycleByFraction[f] = lifecycleExit(candles, i, direction, f).returnPct;
      }

      rows.push({
        ticker, pattern: c.pattern, confidence: c.confidence, barsSpan, ageBars, win, directionHit, delayed,
        lifecycleReturnPct: lifecycle.returnPct, lifecycleReason: lifecycle.reason, reverseWin, lifecycleByFraction,
      });
    }
  }
}

// --- Report -----------------------------------------------------------------------

function bucketOf(confidence) {
  if (confidence < 60) return '50-59%';
  if (confidence < 70) return '60-69%';
  if (confidence < 80) return '70-79%';
  return '80%+';
}

console.log(`\nВсего размеченных случаев: ${rows.length}\n`);

const buckets = {};
for (const r of rows) {
  const b = bucketOf(r.confidence);
  buckets[b] ??= { n: 0, wins: 0, dirHits: 0 };
  buckets[b].n += 1;
  buckets[b].wins += r.win;
  buckets[b].dirHits += r.directionHit;
}

console.log('Калибровка уверенности (все фигуры вместе):');
console.log('Диапазон уверенности | Случаев | Винрейт (с честным стопом) | Направление угадано хоть раз');
for (const b of ['50-59%', '60-69%', '70-79%', '80%+']) {
  const s = buckets[b];
  if (!s) { console.log(`${b.padEnd(21)} |    0    |   —   |   —`); continue; }
  const wr = ((s.wins / s.n) * 100).toFixed(1);
  const dr = ((s.dirHits / s.n) * 100).toFixed(1);
  console.log(`${b.padEnd(21)} | ${String(s.n).padStart(6)}  | ${wr}%  | ${dr}%`);
}

// Per-pattern-type breakdown — some pattern types may be well-calibrated while others
// aren't; averaging everything together could hide that.
const byPattern = {};
for (const r of rows) {
  byPattern[r.pattern] ??= [];
  byPattern[r.pattern].push(r);
}
console.log('\nПо типам фигур (винрейт с честным стопом vs направление угадано хоть раз):');
for (const [pattern, list] of Object.entries(byPattern).sort((a, b) => b[1].length - a[1].length)) {
  const wins = list.reduce((s, r) => s + r.win, 0);
  const dirHits = list.reduce((s, r) => s + r.directionHit, 0);
  const wr = ((wins / list.length) * 100).toFixed(1);
  const dr = ((dirHits / list.length) * 100).toFixed(1);
  const avgConf = (list.reduce((s, r) => s + r.confidence, 0) / list.length).toFixed(0);
  console.log(`  ${pattern.padEnd(24)} n=${String(list.length).padStart(4)}  ср.увер.=${avgConf}%  винрейт=${wr}%  направление=${dr}%`);
}

// --- Гипотеза 2: размер фигуры (число баров между первой и последней точкой) ---------
console.log('\nРазмер фигуры (баров) → результат (только фигуры с точками — свечные паттерны не считаются):');
const sized = rows.filter((r) => r.barsSpan != null);
const spans = sized.map((r) => r.barsSpan).sort((a, b) => a - b);
const q = (p) => spans[Math.floor(spans.length * p)];
const sizeBuckets = [
  { label: `мелкие (≤${q(0.33)} баров)`, test: (s) => s <= q(0.33) },
  { label: `средние (${q(0.33)}-${q(0.66)} баров)`, test: (s) => s > q(0.33) && s <= q(0.66) },
  { label: `крупные (>${q(0.66)} баров)`, test: (s) => s > q(0.66) },
];
for (const b of sizeBuckets) {
  const list = sized.filter((r) => b.test(r.barsSpan));
  if (!list.length) continue;
  const wr = ((list.reduce((s, r) => s + r.win, 0) / list.length) * 100).toFixed(1);
  const dr = ((list.reduce((s, r) => s + r.directionHit, 0) / list.length) * 100).toFixed(1);
  console.log(`  ${b.label.padEnd(28)} n=${String(list.length).padStart(4)}  винрейт=${wr}%  направление=${dr}%`);
}

// --- «Актуальность» фигуры: сколько свечей прошло с её завершения до входа -----------
// Прямая проверка идеи трейдера "торговать только актуальные фигуры, чьё движение ещё
// не прошло". Важно: у double_top/bottom такой фильтр УЖЕ работает в patterns.js
// (возраст >60 баров и «цель достигнута» отсекаются), у остальных типов — НЕТ. Поэтому
// смотрим отдельно на типы БЕЗ фильтра — там и видно, теряем ли мы на этом деньги.
const FILTERED_TYPES = new Set(['double_top', 'double_bottom']);
const ageBuckets = [
  { label: 'свежие (0-5 баров)', test: (a) => a <= 5 },
  { label: 'недавние (6-15)', test: (a) => a > 5 && a <= 15 },
  { label: 'подстывшие (16-30)', test: (a) => a > 15 && a <= 30 },
  { label: 'старые (>30)', test: (a) => a > 30 },
];
function reportAgeTable(title, list) {
  console.log(`\n${title}`);
  for (const b of ageBuckets) {
    const sub = list.filter((r) => b.test(r.ageBars));
    if (!sub.length) { console.log(`  ${b.label.padEnd(22)} n=   0`); continue; }
    const wr = ((sub.reduce((s, r) => s + r.win, 0) / sub.length) * 100).toFixed(1);
    const dr = ((sub.reduce((s, r) => s + r.directionHit, 0) / sub.length) * 100).toFixed(1);
    console.log(`  ${b.label.padEnd(22)} n=${String(sub.length).padStart(4)}  винрейт=${wr}%  направление=${dr}%`);
  }
}
reportAgeTable(`Актуальность фигуры — все дни, пока фигура остаётся подтверждённой (n=${ageRows.length}):`, ageRows);
reportAgeTable(
  'То же, но ТОЛЬКО типы БЕЗ фильтра актуальности (Г&П, треугольники, клинья, флаги, вымпелы, волны):',
  ageRows.filter((r) => !FILTERED_TYPES.has(r.pattern)),
);

// --- Гипотеза 3: момент входа — сразу на подтверждении или с задержкой --------------
console.log('\nВход сразу vs с задержкой после подтверждения фигуры (в среднем по всем фигурам):');
for (const d of ENTRY_DELAYS) {
  const wr = ((rows.reduce((s, r) => s + r.delayed[d], 0) / rows.length) * 100).toFixed(1);
  console.log(`  задержка ${String(d).padStart(2)} ${d === 1 ? 'свеча' : 'свечей'}: винрейт=${wr}%`);
}

// Разбивка по типам — момент входа может быть важен для одних фигур и не важен для
// других, среднее по всем могло это спрятать.
console.log('\nТо же самое, но отдельно по каждому типу фигуры (n≥30, иначе не показательно):');
console.log('  Тип фигуры                 сразу   +3 свечи  +5 свечей');
for (const [pattern, list] of Object.entries(byPattern).sort((a, b) => b[1].length - a[1].length)) {
  if (list.length < 30) continue;
  const wr = (d) => ((list.reduce((s, r) => s + r.delayed[d], 0) / list.length) * 100).toFixed(1);
  console.log(`  ${pattern.padEnd(24)} n=${String(list.length).padStart(4)}  ${wr(0)}%   ${wr(3)}%    ${wr(5)}%`);
}

// --- Прицельный разворот: double_top/bottom, вход в обратную сторону ИМЕННО когда цена
// дошла до собственного ориентира фигуры (основание между пиками/впадинами) ------------
if (targetReverseRows.length) {
  const wr = ((targetReverseRows.reduce((s, r) => s + r.win, 0) / targetReverseRows.length) * 100).toFixed(1);
  const dr = ((targetReverseRows.reduce((s, r) => s + r.directionHit, 0) / targetReverseRows.length) * 100).toFixed(1);
  const avgBars = (targetReverseRows.reduce((s, r) => s + r.barsToTarget, 0) / targetReverseRows.length).toFixed(1);
  console.log(`\nРазворот ИМЕННО у double_top/double_bottom, вход после того как цена дошла до`
    + ` основания фигуры (n=${targetReverseRows.length}, в среднем ${avgBars} баров до цели):`);
  console.log(`  винрейт=${wr}%  направление=${dr}%  (для сравнения — вход по самой фигуре сразу ~52%)`);
} else {
  console.log('\nРазворот у double_top/double_bottom по достижению основания: не набралось случаев для отчёта.');
}

// --- Гипотеза 4: жизненный цикл фигуры — выход по "выдыханию" вместо жёсткого стопа ---
console.log('\nЖизненный цикл (выход при откате 50% от набранного максимума, аварийный стоп 4%)'
  + ' vs фиксированный стоп 2%:');
const avgLifecycleReturn = (rows.reduce((s, r) => s + r.lifecycleReturnPct, 0) / rows.length).toFixed(2);
const lifecycleWinRate = ((rows.filter((r) => r.lifecycleReturnPct > 0).length / rows.length) * 100).toFixed(1);
const avgFixedReturn = (rows.reduce((s, r) => s + (r.win ? SUCCESS_THRESHOLD_PCT : -SUCCESS_THRESHOLD_PCT), 0) / rows.length).toFixed(2);
console.log(`  Жизненный цикл:   средний результат сделки ${avgLifecycleReturn}%,  доля прибыльных ${lifecycleWinRate}%`);
console.log(`  Фикс. стоп 2%/2%: средний результат сделки ${avgFixedReturn}%,  доля прибыльных ${((rows.filter((r) => r.win).length / rows.length) * 100).toFixed(1)}%`);
const exhaustedCount = rows.filter((r) => r.lifecycleReason === 'exhausted').length;
const stopCount = rows.filter((r) => r.lifecycleReason === 'stop').length;
const windowEndCount = rows.filter((r) => r.lifecycleReason === 'window_end').length;
console.log(`  Причины выхода: "выдохлась" ${exhaustedCount}, аварийный стоп ${stopCount}, конец окна ${windowEndCount}`);

// --- Оптимальная доля отката ПО ТИПАМ фигур ------------------------------------------
// Трейдер попросил: жизненный цикл не одним параметром на всё, а под каждую фигуру
// отдельно. Проверяем 30/50/70% на каждом типе — если оптимум разный, это подтверждает,
// что параметр действительно надо калибровать по типам, а не использовать общий 50%.
console.log('\nОптимальная доля отката (жизненный цикл) — отдельно по типам фигур (n≥30):');
console.log('  Тип фигуры                 откат 30%   откат 50%   откат 70%');
for (const [pattern, list] of Object.entries(byPattern).sort((a, b) => b[1].length - a[1].length)) {
  if (list.length < 30) continue;
  const avgFor = (f) => (list.reduce((s, r) => s + r.lifecycleByFraction[f], 0) / list.length).toFixed(2);
  console.log(`  ${pattern.padEnd(24)} n=${String(list.length).padStart(4)}  ${avgFor(0.3)}%      ${avgFor(0.5)}%      ${avgFor(0.7)}%`);
}

// --- Гипотеза 4b: вход в обратную сторону после того, как движение "выдохлось" -------
const reverseRows = rows.filter((r) => r.reverseWin != null);
if (reverseRows.length) {
  const reverseWinRate = ((reverseRows.reduce((s, r) => s + r.reverseWin, 0) / reverseRows.length) * 100).toFixed(1);
  console.log(`\nВход в ОБРАТНУЮ сторону сразу после "выдыхания" (n=${reverseRows.length}): винрейт=${reverseWinRate}%`
    + ' (для сравнения — винрейт обычного входа по фигуре ~49%)');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
