// src/services/strategyBuilder/features.js
//
// Признаки для языка правил: каждая функция строит СЕРИЮ значений по всем свечам, и значение на баре i зависит только
// от баров 0…i. Это главная защита от заглядывания в будущее «по построению»: правило физически не может увидеть свечу
// после сигнала, сколько бы его ни крутили. Тест features.test.js проверяет это для каждого признака: значение на баре
// i одинаково, считали ли мы по всей истории или по истории, обрезанной на i.
//
// Все значения нормированы (%, ATR, 0–100, разы) — сырых цен наружу не отдаём, см. ruleSpec.FEATURES.
// Время — московское (UTC+3, без перехода на летнее время, как на Мосбирже с 2014 года).
import { sma, ema, rsi, macd, bollingerSeries, adxLite, atr } from '../analytics/indicators';
import { swingsUpTo, findSupportResistance, rawSwingsOf } from '../analytics/patterns';
import { FEATURES } from './ruleSpec';

const MSK_MS = 3 * 3600000;
const tOf = (c) => (c.date instanceof Date ? c.date.getTime() : new Date(c.date).getTime());
export const mskDayKey = (c) => new Date(tOf(c) + MSK_MS).toISOString().slice(0, 10);

// Скользящее среднее, которое честно отдаёт null, пока в окне есть пропуск (у sma из indicators.js пропусков не бывает).
function rollingMean(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] == null) { ok = false; break; }
      s += values[j];
    }
    if (ok) out[i] = s / period;
  }
  return out;
}

function stochastic(candles, period, smooth, signal) {
  const raw = candles.map((_, i) => {
    if (i < period - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    return hh > ll ? ((candles[i].close - ll) / (hh - ll)) * 100 : 50;
  });
  const k = smooth > 1 ? rollingMean(raw, smooth) : raw;
  const d = rollingMean(k, signal);
  return { k, d };
}

// Supertrend: классическая формула (полосы hl2 ± mult·ATR, «залипание» полос, смена направления на пробое полосы).
export function supertrend(candles, period = 10, mult = 3) {
  const a = atr(candles, period);
  const n = candles.length;
  const dir = new Array(n).fill(null);
  const line = new Array(n).fill(null);
  let fu = null;
  let fl = null;
  let d = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    fu = fu == null || bu < fu || prevClose > fu ? bu : fu;
    fl = fl == null || bl > fl || prevClose < fl ? bl : fl;
    const c = candles[i].close;
    if (d === 1 && c < fl) d = -1;
    else if (d === -1 && c > fu) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? fl : fu;
  }
  return { dir, line };
}

// Границы дней по МСК: dayStart[i] — индекс первой свечи того же дня, prevDay[i] — {high, low, close} ПРОШЛОГО
// (полностью закрытого) дня. Для дневных свечей «прошлый день» — просто прошлая свеча.
function dayInfo(candles, tfMinutes) {
  const n = candles.length;
  const dayStart = new Array(n).fill(0);
  const prevDay = new Array(n).fill(null);
  if (tfMinutes >= 1440) {
    for (let i = 0; i < n; i++) {
      dayStart[i] = i;
      if (i > 0) prevDay[i] = { high: candles[i - 1].high, low: candles[i - 1].low, close: candles[i - 1].close };
    }
    return { dayStart, prevDay };
  }
  let curKey = null;
  let start = 0;
  let cur = null; // агрегат текущего дня
  let last = null; // агрегат прошлого дня
  for (let i = 0; i < n; i++) {
    const key = mskDayKey(candles[i]);
    if (key !== curKey) {
      if (cur) last = cur;
      curKey = key;
      start = i;
      cur = { high: candles[i].high, low: candles[i].low, close: candles[i].close };
    } else {
      cur.high = Math.max(cur.high, candles[i].high);
      cur.low = Math.min(cur.low, candles[i].low);
      cur.close = candles[i].close;
    }
    dayStart[i] = start;
    prevDay[i] = last ? { ...last } : null;
  }
  return { dayStart, prevDay };
}

function pivotLevel(d, level) {
  if (!d) return null;
  const P = (d.high + d.low + d.close) / 3;
  const r = d.high - d.low;
  switch (level) {
    case 'P': return P;
    case 'R1': return 2 * P - d.low;
    case 'S1': return 2 * P - d.high;
    case 'R2': return P + r;
    case 'S2': return P - r;
    case 'R3': return d.high + 2 * (P - d.low);
    case 'S3': return d.low - 2 * (d.high - P);
    default: return null;
  }
}

// Ближайшие поддержка/сопротивление на каждом баре — тем же алгоритмом, что рисует уровни на графике в приложении
// (кластеры точек разворота), только «видимые» на баре i: swingsUpTo не отдаёт разворот, пока он не подтверждён
// следующими свечами. Берём последние 120 разворотов — старше для ближайшего уровня почти не нужны.
//
// Быстрый проход: видимые развороты копим по ходу истории (ровно то же схлопывание, что в swingsUpTo), а набор
// уровней пересчитываем только когда появился новый разворот — между ними меняется лишь цена, а от неё зависит
// только «какой уровень ближайший снизу/сверху». Результат тот же, что у findSupportResistance(swingsUpTo(i), цена),
// но на 14 000 часовых свечей — доли секунды вместо ~8 секунд.
const LEVEL_LOOKBACK = 3;
function nearestLevels(candles) {
  const n = candles.length;
  const support = new Array(n).fill(null);
  const resistance = new Array(n).fill(null);
  const raw = rawSwingsOf(candles, LEVEL_LOOKBACK);
  const visible = [];
  let k = 0;
  let prices = null; // цены уровней (кластеры ≥ 2 касаний) по возрастанию; null — разворотов ещё мало
  for (let i = 0; i < n; i++) {
    let changed = false;
    while (k < raw.length && raw[k].index <= i - LEVEL_LOOKBACK) {
      const p = raw[k++];
      const last = visible[visible.length - 1];
      if (last && last.type === p.type) {
        if ((p.type === 'high' && p.price > last.price) || (p.type === 'low' && p.price < last.price)) visible[visible.length - 1] = p;
      } else visible.push(p);
      changed = true;
    }
    if (changed) prices = visible.length < 4 ? null : findSupportResistance(visible.slice(-120), 0).map((l) => l.price).sort((a, b) => a - b);
    if (!prices) continue; // разворотов ещё мало — данных нет
    const price = candles[i].close;
    // Уровня с этой стороны нет вовсе — это не «нет данных», а «до уровня бесконечно далеко»: условие «до поддержки
    // меньше 1%» честно не выполнено, а «дальше 3%» — выполнено.
    let s = -Infinity;
    let r = Infinity;
    for (const lp of prices) {
      if (lp <= price) s = lp;
      else { r = lp; break; }
    }
    support[i] = s;
    resistance[i] = r;
  }
  return { support, resistance };
}

// Для проверки быстрого прохода в тестах: прежний медленный способ, бар за баром.
export function nearestLevelsSlow(candles, i) {
  const swings = swingsUpTo(candles, i, LEVEL_LOOKBACK);
  if (swings.length < 4) return { support: null, resistance: null };
  const levels = findSupportResistance(swings.slice(-120), candles[i].close);
  return {
    support: levels.find((l) => l.type === 'support')?.price ?? -Infinity,
    resistance: levels.find((l) => l.type === 'resistance')?.price ?? Infinity,
  };
}

const cache = new WeakMap(); // candles → Map(key → series)

function cached(candles, key, build) {
  let m = cache.get(candles);
  if (!m || m.__len !== candles.length) {
    m = new Map();
    m.__len = candles.length;
    cache.set(candles, m);
  }
  if (!m.has(key)) m.set(key, build());
  return m.get(key);
}

const closesOf = (candles) => cached(candles, 'closes', () => candles.map((c) => c.close));
const atr14Of = (candles) => cached(candles, 'atr14', () => atr(candles, 14));

// Сырые «уровни» для расстояний: серия цен, до которых меряем (средняя, уровень, максимум…).
function referenceSeries(candles, id, p, tfMinutes) {
  const closes = closesOf(candles);
  switch (id) {
    case 'dist_ma': return cached(candles, `ma:${p.type}:${p.period}`, () => (p.type === 'sma' ? sma(closes, p.period) : ema(closes, p.period)));
    case 'dist_support': return cached(candles, 'levels', () => nearestLevels(candles)).support;
    case 'dist_resistance': return cached(candles, 'levels', () => nearestLevels(candles)).resistance;
    case 'dist_high_n': return cached(candles, `hh:${p.bars}`, () => candles.map((_, i) => {
      if (i < p.bars) return null;
      let m = -Infinity;
      for (let j = i - p.bars; j < i; j++) m = Math.max(m, candles[j].high);
      return m;
    }));
    case 'dist_low_n': return cached(candles, `ll:${p.bars}`, () => candles.map((_, i) => {
      if (i < p.bars) return null;
      let m = Infinity;
      for (let j = i - p.bars; j < i; j++) m = Math.min(m, candles[j].low);
      return m;
    }));
    case 'dist_vwap': return cached(candles, `vwap:${tfMinutes}`, () => {
      if (tfMinutes >= 1440) return candles.map(() => null);
      const { dayStart } = dayInfo(candles, tfMinutes);
      const out = new Array(candles.length).fill(null);
      let pv = 0;
      let v = 0;
      for (let i = 0; i < candles.length; i++) {
        if (dayStart[i] === i) { pv = 0; v = 0; }
        const c = candles[i];
        pv += ((c.high + c.low + c.close) / 3) * (c.volume || 0);
        v += c.volume || 0;
        out[i] = v > 0 ? pv / v : null;
      }
      return out;
    });
    case 'dist_pivot': return cached(candles, `pivot:${p.level}:${tfMinutes}`, () => {
      const { prevDay } = dayInfo(candles, tfMinutes);
      return prevDay.map((d) => pivotLevel(d, p.level));
    });
    case 'dist_supertrend': return cached(candles, `st:${p.period}:${p.mult}`, () => supertrend(candles, p.period, p.mult)).line;
    default: return null;
  }
}

function valueSeries(candles, id, p, tfMinutes) {
  const closes = closesOf(candles);
  switch (id) {
    case 'rsi': return rsi(closes, p.period);
    case 'stoch_k': return stochastic(candles, p.period, p.smooth, 3).k;
    case 'stoch_d': return stochastic(candles, p.period, p.smooth, p.signal).d;
    case 'macd_hist': {
      const h = macd(closes, p.fast, p.slow, p.signal).histogram;
      return h.map((v, i) => (v == null || !closes[i] ? null : (v / closes[i]) * 100));
    }
    case 'bb_pos': return bollingerSeries(closes, p.period, p.k).map((b) => (b ? b.percentB : null));
    case 'adx': return adxLite(candles, p.period);
    case 'supertrend_dir': return cached(candles, `st:${p.period}:${p.mult}`, () => supertrend(candles, p.period, p.mult)).dir;
    case 'atr_pct': {
      const a = p.period === 14 ? atr14Of(candles) : atr(candles, p.period);
      return a.map((v, i) => (v == null || !closes[i] ? null : (v / closes[i]) * 100));
    }
    case 'volume_ratio': return candles.map((_, i) => {
      if (i < p.period) return null;
      let s = 0;
      for (let j = i - p.period; j < i; j++) s += candles[j].volume || 0;
      const avg = s / p.period;
      return avg > 0 ? (candles[i].volume || 0) / avg : null;
    });
    case 'change_pct': return closes.map((c, i) => (i < p.bars || !closes[i - p.bars] ? null : ((c - closes[i - p.bars]) / closes[i - p.bars]) * 100));
    case 'gap_pct': {
      if (tfMinutes >= 1440) return candles.map((c, i) => (i === 0 || !closes[i - 1] ? null : ((c.open - closes[i - 1]) / closes[i - 1]) * 100));
      const { dayStart } = dayInfo(candles, tfMinutes);
      return candles.map((_, i) => {
        const s = dayStart[i];
        if (s === 0) return null;
        const prevClose = closes[s - 1];
        return prevClose ? ((candles[s].open - prevClose) / prevClose) * 100 : null;
      });
    }
    case 'hour': return candles.map((c) => new Date(tOf(c) + MSK_MS).getUTCHours());
    case 'weekday': return candles.map((c) => {
      const d = new Date(tOf(c) + MSK_MS).getUTCDay();
      return d === 0 ? 7 : d;
    });
    case 'orderbook':
    case 'news':
      return candles.map(() => null); // истории нет — эти признаки работают только вживую (бумага)
    default: return null;
  }
}

/**
 * Серия значений признака по свечам. ref = { id, params, unit } (unit для расстояний: 'pct' | 'atr').
 * Расстояние со знаком: «+» — цена выше уровня. В ATR — делим на ATR(14) того же бара.
 * @returns {Array<number|null>|null} null — неизвестный признак
 */
export function featureSeries(candles, ref, tfMinutes) {
  const f = FEATURES[ref?.id];
  if (!f || !candles?.length) return null;
  const p = { ...f.params, ...(ref.params || {}) };
  const key = `${ref.id}|${JSON.stringify(p)}|${ref.unit || ''}|${tfMinutes}`;
  return cached(candles, key, () => {
    if (f.kind !== 'distance') return valueSeries(candles, ref.id, p, tfMinutes);
    const refs = referenceSeries(candles, ref.id, p, tfMinutes);
    if (!refs) return null;
    const closes = closesOf(candles);
    const a = atr14Of(candles);
    return closes.map((c, i) => {
      const r = refs[i];
      if (r === -Infinity) return Infinity; // уровня снизу нет — цена «бесконечно выше» него
      if (r === Infinity) return -Infinity; // уровня сверху нет
      if (r == null || !Number.isFinite(r) || r === 0) return null;
      if (ref.unit === 'atr') return a[i] ? (c - r) / a[i] : null;
      return ((c - r) / r) * 100;
    });
  });
}
