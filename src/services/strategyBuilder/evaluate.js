// src/services/strategyBuilder/evaluate.js
//
// Проверка правил стратегии на баре: каждое условие получает состояние
//   'exact' — выполнено, 'near' — не выполнено, но в пределах допуска, 'fail' — нет, 'na' — данных не хватает.
// Сигнал целиком: 'exact' (все условия / набраны баллы), 'near' (набрано только с учётом «почти»), 'none', 'na'.
//
// «Почти» — не поблажка, а проверка на подгонку: если у сделок «почти по правилу» результат такой же, как у «точно»,
// правило устойчивое; если «точно» прибыльные, а «почти» убыточные — порог подогнан под историю.
//
// Сигнал считается по ЗАКРЫТОЙ свече i: используются только значения на барах ≤ i (признаки причинные, см. features.js),
// а условия со старшего таймфрейма берут последнюю старшую свечу, закрывшуюся не позже закрытия свечи i.
import { FEATURES, TIMEFRAME_MINUTES } from './ruleSpec';
import { featureSeries } from './features';

const MIN = 60000;
const tOf = (c) => (c.date instanceof Date ? c.date.getTime() : new Date(c.date).getTime());

/**
 * Данные для проверки: свечи таймфрейма стратегии + (по желанию) свечи старших таймфреймов.
 * @param {{timeframe: string, candles: Array, htf?: Object<string, Array>}} a
 */
export function prepareData({ timeframe, candles, htf = {} }) {
  return { timeframe, tfMinutes: TIMEFRAME_MINUTES[timeframe], candles: candles || [], htf, align: {} };
}

// Для каждой свечи стратегии — индекс последней свечи старшего таймфрейма, которая к этому моменту уже закрылась.
function alignment(data, tf) {
  if (data.align[tf]) return data.align[tf];
  const base = data.candles;
  const hc = data.htf[tf] || [];
  const hMin = TIMEFRAME_MINUTES[tf];
  const out = new Array(base.length).fill(-1);
  let j = -1;
  for (let i = 0; i < base.length; i++) {
    const baseClose = tOf(base[i]) + data.tfMinutes * MIN;
    while (j + 1 < hc.length && tOf(hc[j + 1]) + hMin * MIN <= baseClose) j++;
    out[i] = j;
  }
  data.align[tf] = out;
  return out;
}

// Значение признака на баре i (с учётом «N свечей назад» и старшего таймфрейма).
function valueAt(data, ref, i) {
  if (i < 0) return null;
  if (ref.tf && ref.tf !== data.timeframe) {
    const hc = data.htf[ref.tf];
    if (!hc?.length) return null;
    const j = alignment(data, ref.tf)[i];
    if (j < 0) return null;
    const s = featureSeries(hc, ref, TIMEFRAME_MINUTES[ref.tf]);
    return s ? s[j] ?? null : null;
  }
  const s = featureSeries(data.candles, ref, data.tfMinutes);
  return s ? s[i] ?? null : null;
}

// Ширина допуска вокруг порога: tol% от порога, а если порог около нуля — tol% от типичного масштаба признака.
function bandFor(featureId, threshold, tolPct) {
  const f = FEATURES[featureId];
  if (!f || f.scale == null || !tolPct) return 0;
  const base = Math.abs(threshold) > 1e-9 ? Math.abs(threshold) : f.scale;
  return (tolPct / 100) * base;
}

const RANK = { exact: 3, near: 2, fail: 1, na: 0 };

/** Одно условие на баре i. Возвращает { state, value, threshold }. */
export function evaluateCondition(data, cond, i, tolPct) {
  const f = FEATURES[cond?.feature?.id];
  if (!f) return { state: 'na', reason: 'unknown' };
  if (f.historical === false) return { state: 'na', reason: 'paperOnly' };
  const at = i - (cond.ago || 0);
  const tol = cond.tolerancePct ?? tolPct ?? 0;
  const L = (k) => valueAt(data, cond.feature, at - k);
  const R = (k) => (cond.right ? valueAt(data, cond.right, at - k) : cond.value);
  const l0 = L(0);
  if (l0 == null) return { state: 'na', reason: 'noData' };

  if (cond.op === 'rising' || cond.op === 'falling') {
    let ok = 0;
    for (let k = 0; k < cond.n; k++) {
      const a = L(k);
      const b = L(k + 1);
      if (a == null || b == null) return { state: 'na', reason: 'noData', value: l0 };
      if (cond.op === 'rising' ? a > b : a < b) ok++;
    }
    if (ok === cond.n) return { state: 'exact', value: l0 };
    if (cond.n >= 2 && ok === cond.n - 1) return { state: 'near', value: l0 };
    return { state: 'fail', value: l0 };
  }

  if (cond.op === 'between') {
    const [a, b] = cond.value;
    if (l0 >= a && l0 <= b) return { state: 'exact', value: l0, threshold: cond.value };
    const edge = l0 < a ? a : b;
    const near = Math.abs(l0 - edge) <= bandFor(cond.feature.id, edge, tol);
    return { state: near ? 'near' : 'fail', value: l0, threshold: cond.value };
  }

  const r0 = R(0);
  if (r0 == null) return { state: 'na', reason: 'noData', value: l0 };
  const band = bandFor(cond.feature.id, r0, tol);

  if (cond.op === '>' || cond.op === '<') {
    const exact = cond.op === '>' ? l0 > r0 : l0 < r0;
    if (exact) return { state: 'exact', value: l0, threshold: r0 };
    return { state: Math.abs(l0 - r0) <= band ? 'near' : 'fail', value: l0, threshold: r0 };
  }

  if (cond.op === 'crossAbove' || cond.op === 'crossBelow') {
    const up = cond.op === 'crossAbove';
    const l1 = L(1);
    const r1 = R(1);
    if (l1 == null || r1 == null) return { state: 'na', reason: 'noData', value: l0 };
    const beyond = (l, r) => (up ? l > r : l < r);
    if (!beyond(l1, r1) && beyond(l0, r0)) return { state: 'exact', value: l0, threshold: r0 };
    // «Почти»: подошёл вплотную, но ещё не пересёк — или пересёк свечой раньше (вход запоздал на свечу).
    if (!beyond(l1, r1) && !beyond(l0, r0) && Math.abs(l0 - r0) <= band) return { state: 'near', value: l0, threshold: r0 };
    const l2 = L(2);
    const r2 = R(2);
    if (l2 != null && r2 != null && !beyond(l2, r2) && beyond(l1, r1) && beyond(l0, r0)) return { state: 'near', value: l0, threshold: r0, late: true };
    return { state: 'fail', value: l0, threshold: r0 };
  }
  return { state: 'na', reason: 'unknownOp' };
}

/**
 * Сигнал стратегии на закрытой свече i для стороны side ('long' | 'short').
 * @returns {{state, score, nearScore, maxScore, results, partial}}
 *   partial — в стратегии есть условия без истории (стакан, новости): на истории они не участвуют.
 */
export function evaluateAt(spec, data, i, side) {
  const conds = (spec.entry?.conditions || []).filter((c) => !c.side || c.side === 'both' || c.side === side);
  const results = conds.map((c) => ({ condId: c.id, required: !!c.required, weight: c.weight ?? 1, ...evaluateCondition(data, c, i, spec.tolerancePct) }));
  const live = results.filter((r) => r.reason !== 'paperOnly');
  const partial = live.length < results.length;
  const maxScore = live.reduce((s, r) => s + r.weight, 0);
  if (!live.length) return { state: 'na', score: 0, nearScore: 0, maxScore, results, partial };
  const score = live.filter((r) => r.state === 'exact').reduce((s, r) => s + r.weight, 0);
  const nearScore = score + live.filter((r) => r.state === 'near').reduce((s, r) => s + r.weight, 0);

  let state;
  if (spec.entry?.mode === 'score') {
    const req = live.filter((r) => r.required);
    if (req.some((r) => r.state === 'na')) state = 'na';
    else {
      const min = spec.entry.minScore;
      const reqExact = req.every((r) => r.state === 'exact');
      const reqNear = req.every((r) => r.state === 'exact' || r.state === 'near');
      if (score >= min && reqExact) state = 'exact';
      else if (nearScore >= min && reqNear) state = 'near';
      else if (live.some((r) => r.state === 'na') && nearScore + live.filter((r) => r.state === 'na').reduce((s, r) => s + r.weight, 0) >= min) state = 'na';
      else state = 'none';
    }
  } else {
    const worst = Math.min(...live.map((r) => RANK[r.state]));
    if (live.some((r) => r.state === 'fail')) state = 'none';
    else if (worst === RANK.na) state = 'na';
    else state = worst === RANK.exact ? 'exact' : 'near';
  }
  return { state, score, nearScore, maxScore, results, partial };
}

const sidesOf = (spec) => (spec.direction === 'both' ? ['long', 'short'] : [spec.direction]);

/**
 * Все сигналы на истории. Подряд идущие свечи с одним и тем же сигналом — это один сигнал (первая свеча),
 * иначе «RSI ниже 30» восемь свечей подряд превратился бы в восемь входов.
 * @returns {Array<{i, date, side, state}>}
 */
export function scanSignals(spec, data, { from = 0, to = data.candles.length - 1, includeNear = true } = {}) {
  const out = [];
  for (const side of sidesOf(spec)) {
    let prev = 'none';
    for (let i = from; i <= to; i++) {
      const { state } = evaluateAt(spec, data, i, side);
      const on = state === 'exact' || (includeNear && state === 'near');
      if (on && !(prev === 'exact' || (includeNear && prev === 'near'))) out.push({ i, date: data.candles[i].date, side, state });
      prev = state;
    }
  }
  return out.sort((a, b) => a.i - b.i);
}

/** Индекс последней свечи, ЗАКРЫВШЕЙСЯ не позже момента t (по ней и решаем, был ли сигнал перед входом). */
export function lastClosedIndex(data, t) {
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  const c = data.candles;
  let lo = 0;
  let hi = c.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tOf(c[mid]) + data.tfMinutes * MIN <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
