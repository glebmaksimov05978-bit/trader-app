// src/services/trainer/realPatterns.js
//
// Режим тренажёра «Фигуры на реальных графиках»: готовые примеры из public/trainer/real_patterns.json (их собирает
// scripts/trainerRealPatterns.mjs: фигуру нашёл алгоритм приложения на настоящей истории Мосбиржи, и после неё цена прошла
// заметное расстояние). Здесь — чистые функции без сети и React: разбор файла, выбор следующего примера, согласие игрока
// с алгоритмом, сводка. Тестируется в Jest (realPatterns.test.js).
//
// Важно: «правильный ответ» тут — название от АЛГОРИТМА, не проверенная истина. Поэтому игра считает не очки за «верно»,
// а СОГЛАСИЕ игрока с алгоритмом: где расходитесь — либо ошибка человека, либо слабое место детектора, и это видно в сводке.
import { PATTERN_NAMES, NONE_ID } from './patternQuiz.js';

const DAY_MS = 86400000;

/** Свернутый пример из файла → пример с настоящими датами и свечами. */
export function decodeExample(it) {
  if (!it || !Array.isArray(it.b) || !it.b.length) return null;
  let day = it.d0;
  const dates = it.b.map((_, i) => { if (i > 0) day += it.dd[i - 1] || 1; return new Date(day * DAY_MS); });
  const candles = it.b.map(([open, high, low, close], i) => ({ date: dates[i], open, high, low, close, volume: 0 }));
  const points = (it.pts || [])
    .filter((p) => p[0] >= 0 && p[0] < candles.length)
    .map(([index, price, type]) => ({ index, price, type, date: dates[index] }));
  return {
    id: it.id, ticker: it.t, truth: it.truth, detector: it.det, confidence: it.conf, cut: it.cut,
    candles, points, up: it.up, down: it.down,
  };
}

/** Видимая часть (до момента находки) и скрытое продолжение. */
export function splitExample(ex) {
  return { visible: ex.candles.slice(0, ex.cut + 1), hidden: ex.candles.slice(ex.cut + 1) };
}

/**
 * Следующий пример: ещё не виденный, не та же фигура, что только что была (если есть выбор). Когда все примеры показаны —
 * начинаем круг заново. `rng` подменяется в тестах.
 */
export function pickNext(items, { seen = [], lastTruth = null, rng = Math.random, only = null } = {}) {
  const pool = (items || []).filter((x) => !only || x.truth === only);
  if (!pool.length) return null;
  const seenSet = new Set(seen);
  let fresh = pool.filter((x) => !seenSet.has(x.id));
  if (!fresh.length) fresh = pool;
  const other = fresh.filter((x) => x.truth !== lastTruth);
  const from = other.length ? other : fresh;
  return from[Math.floor(rng() * from.length)];
}

/** Варианты ответа: фигура от алгоритма, несколько других и «фигуры нет» — алгоритм мог ошибиться. */
export function buildOptions(truth, { rng = Math.random, count = 5 } = {}) {
  const others = Object.keys(PATTERN_NAMES).filter((id) => id !== truth && id !== NONE_ID);
  for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
  const opts = [truth, ...others.slice(0, Math.max(1, count - 2)), NONE_ID];
  for (let i = opts.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [opts[i], opts[j]] = [opts[j], opts[i]]; }
  return opts;
}

// ---------- согласие игрока с алгоритмом ----------
export const emptyRealProgress = () => ({ n: 0, agree: 0, byPattern: {}, confusions: {}, updatedAt: null });

/** Новый прогресс после ответа (исходный объект не меняется). */
export function applyVerdict(progress, example, answerId) {
  const p = JSON.parse(JSON.stringify(progress || emptyRealProgress()));
  const agree = answerId === example.truth;
  p.n += 1;
  if (agree) p.agree += 1;
  const slot = p.byPattern[example.truth] || { n: 0, agree: 0 };
  slot.n += 1;
  if (agree) slot.agree += 1;
  p.byPattern[example.truth] = slot;
  if (!agree) {
    const k = `${example.truth}>${answerId}`;
    p.confusions[k] = (p.confusions[k] || 0) + 1;
  }
  p.updatedAt = new Date().toISOString();
  return { progress: p, agree };
}

/**
 * Сводка: общее согласие и по фигурам. «Спорные» — фигуры, по которым игрок согласился с алгоритмом реже половины
 * (при 4+ ответах): там либо игрок ошибается, либо алгоритм зовёт фигурой то, что ей не является.
 */
export function realSummary(progress) {
  const p = progress || emptyRealProgress();
  const rows = Object.entries(p.byPattern)
    .map(([id, v]) => ({ id, n: v.n, agree: v.agree, share: v.n ? v.agree / v.n : 0 }))
    .sort((a, b) => b.n - a.n);
  const disputed = rows.filter((r) => r.n >= 4 && r.share < 0.5).sort((a, b) => a.share - b.share);
  return { n: p.n, agreement: p.n ? p.agree / p.n : null, rows, disputed };
}

/** «Что было дальше» словами: куда и насколько ушла цена за горизонт, в ATR. */
export function movementText(ex, horizon = 20) {
  const f = (v) => String(Math.round(v * 10) / 10).replace('.', ',');
  const main = ex.up >= ex.down ? 'вверх' : 'вниз';
  return `За ${horizon} свечей после находки цена максимально прошла ${main} на ${f(Math.max(ex.up, ex.down))} ATR`
    + ` (вверх до ${f(ex.up)}, вниз до ${f(ex.down)} ATR).`;
}
