// src/services/chartDrawings.js
//
// Свои инструменты рисования на графике: горизонтальная и вертикальная линии, трендовая линия,
// луч, прямоугольник, уровни Фибоначчи, текстовая метка и линейка. Здесь — только модель и
// математика (без React и без графика): как хранить, проверять, считать и превращать в «уровни»,
// по которым стратегия может проверить условие «цена у моей линии».
//
// Хранение: в профиле пользователя, ключ `chartDrawings[<ТИКЕР>_<ТАЙМФРЕЙМ>]` — массив рисунков.
// Не отдельная коллекция: ей понадобились бы свои правила доступа в Firestore, а на одного
// трейдера рисунков немного. Рисунки привязаны к паре «инструмент + таймфрейм»: линия, проведённая
// на часовом графике, на дневном выглядела бы случайной (цены те же, а масштаб времени другой).
//
// Чистые функции без зависимостей — подключаются и в приложение, и в робота.

export const DRAWING_TYPES = ['hline', 'vline', 'trend', 'ray', 'rect', 'fib', 'text'];
export const TWO_POINT = new Set(['trend', 'ray', 'rect', 'fib']);
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export const MAX_PER_CHART = 60;
export const MAX_CHARTS = 120;

export const TOOL_LABELS = {
  hline: 'Горизонтальная линия',
  vline: 'Вертикальная линия',
  trend: 'Трендовая линия',
  ray: 'Луч',
  rect: 'Прямоугольник',
  fib: 'Уровни Фибоначчи',
  text: 'Метка',
  ruler: 'Линейка',
};

export const PALETTE = ['#6485d8', '#e0b341', '#3fb68b', '#e0584f', '#a07be0', '#8892a6'];
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Ключ хранения: «SBER_H1». Всё, кроме букв/цифр, заменяется на «_» — безопасно для поля Firestore. */
export function chartKey(ticker, timeframe) {
  const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9А-Я]+/g, '_');
  return `${clean(ticker)}_${clean(timeframe || 'D1')}`;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p) => p && finite(p.time) && finite(p.price);

/** Привести сохранённое к проверенному виду: чужие типы, мусорные числа и цвета отбрасываются. */
export function normalizeDrawings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw) {
    if (!d || !DRAWING_TYPES.includes(d.type)) continue;
    if (!isPoint(d.p1)) continue;
    if (TWO_POINT.has(d.type) && !isPoint(d.p2)) continue;
    out.push({
      id: typeof d.id === 'string' && d.id ? d.id.slice(0, 40) : `d_${out.length}_${Math.round(d.p1.time)}`,
      type: d.type,
      p1: { time: d.p1.time, price: d.p1.price },
      ...(TWO_POINT.has(d.type) ? { p2: { time: d.p2.time, price: d.p2.price } } : {}),
      color: HEX.test(d.color) ? d.color : PALETTE[0],
      width: finite(d.width) ? Math.min(4, Math.max(1, Math.round(d.width))) : 1,
      ...(d.type === 'text' ? { label: String(d.label || '').slice(0, 40) } : {}),
    });
    if (out.length >= MAX_PER_CHART) break;
  }
  return out;
}

let seq = 0;
/** Новый рисунок. `idSeed` нужен только тестам. */
export function newDrawing({ type, p1, p2 = null, color = PALETTE[0], width = 1, label = '', idSeed = null }) {
  if (!DRAWING_TYPES.includes(type)) throw new Error(`Неизвестный инструмент: ${type}`);
  if (!isPoint(p1)) throw new Error('Не задана первая точка');
  if (TWO_POINT.has(type) && !isPoint(p2)) throw new Error('Не задана вторая точка');
  seq += 1;
  return normalizeDrawings([{
    id: idSeed || `d${Date.now().toString(36)}${seq}`, type, p1, p2, color, width, label,
  }])[0];
}

/**
 * Добавить рисунок в список с лимитом: при переполнении самые старые вытесняются.
 * @returns {Array} новый массив
 */
export function addDrawing(list, d) {
  const next = [...(Array.isArray(list) ? list : []), d];
  return next.length > MAX_PER_CHART ? next.slice(next.length - MAX_PER_CHART) : next;
}

export const removeDrawing = (list, id) => (Array.isArray(list) ? list.filter((d) => d.id !== id) : []);

/** Рисунки одного графика из профиля. */
export function drawingsFor(profile, ticker, timeframe) {
  return normalizeDrawings(profile?.chartDrawings?.[chartKey(ticker, timeframe)]);
}

/**
 * Профиль с обновлённым списком одного графика — для updateUserProfile({ chartDrawings }).
 * Пустой список ключ удаляет; графиков больше MAX_CHARTS — самые «пустые» вытесняются не будут,
 * вместо этого новый не сохраняется (возвращается null).
 */
export function withDrawings(profile, ticker, timeframe, list) {
  const cur = { ...(profile?.chartDrawings || {}) };
  const key = chartKey(ticker, timeframe);
  const clean = normalizeDrawings(list);
  // Пустой список сохраняется как [] (а не удаляется): профиль пишется «со слиянием», и пропавший
  // ключ в базе остался бы — стёртые линии вернулись бы при следующем открытии.
  if (clean.length) {
    const used = Object.values(cur).filter((v) => Array.isArray(v) && v.length).length;
    const had = Array.isArray(cur[key]) && cur[key].length > 0;
    if (!had && used >= MAX_CHARTS) return null;
  }
  cur[key] = clean;
  return cur;
}

// ---------------------------------------------------------------------------------------------
// Математика
// ---------------------------------------------------------------------------------------------

/** Уровни Фибоначчи между двумя точками: 0% — цена первой точки, 100% — второй. */
export function fibLevels(p1, p2) {
  return FIB_RATIOS.map((ratio) => ({ ratio, price: p1.price + (p2.price - p1.price) * ratio }));
}

/**
 * Линейка: что «стоит» ход между двумя точками.
 * @param {object} a { p1, p2, atr?, barSeconds? }
 */
export function rulerStats({ p1, p2, atr = null, barSeconds = null }) {
  const delta = p2.price - p1.price;
  const pct = p1.price !== 0 ? (delta / p1.price) * 100 : null;
  const seconds = Math.abs(p2.time - p1.time);
  const bars = barSeconds && barSeconds > 0 ? Math.round(seconds / barSeconds) : null;
  const atrMult = atr && atr > 0 ? delta / atr : null;
  return { delta, pct, bars, seconds, days: seconds / 86400, atrMult, direction: delta >= 0 ? 'up' : 'down' };
}

/** Подпись линейки одной строкой, по-русски. */
export function rulerText(stats, { priceDigits = 2 } = {}) {
  const sign = stats.delta >= 0 ? '+' : '−';
  const num = (v, d) => Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: d });
  const parts = [`${sign}${num(stats.delta, priceDigits)}`];
  if (stats.pct != null) parts.push(`${sign}${num(stats.pct, 2)}%`);
  if (stats.bars != null) parts.push(`${stats.bars} бар.`);
  else if (stats.days >= 1) parts.push(`${num(stats.days, 1)} дн.`);
  if (stats.atrMult != null) parts.push(`${num(stats.atrMult, 1)} ATR`);
  return parts.join(' · ');
}

/**
 * «Магнит»: прижать цену к ближайшей из O/H/L/C свечи, если она ближе порога.
 * @param {number} price
 * @param {{open,high,low,close}|null} candle
 * @param {number} threshold — в единицах цены (вызывающий переводит пиксели в цену)
 */
export function snapPrice(price, candle, threshold) {
  if (!candle || !finite(price) || !(threshold > 0)) return price;
  let best = price;
  let bestDist = threshold;
  for (const v of [candle.open, candle.high, candle.low, candle.close]) {
    if (!finite(v)) continue;
    const d = Math.abs(v - price);
    if (d <= bestDist) { best = v; bestDist = d; }
  }
  return best;
}

/** Цена прямой, проведённой через p1 и p2, в момент time (секунды). Вертикальная прямая — null. */
export function lineValueAt(p1, p2, time) {
  const dt = p2.time - p1.time;
  if (dt === 0) return null;
  return p1.price + ((p2.price - p1.price) * (time - p1.time)) / dt;
}

/**
 * Свои линии как «уровни» на момент atTime — то, что проверяет условие стратегии «цена у моей линии».
 *  • горизонтальная → её цена;
 *  • луч → значение на момент atTime;
 *  • трендовая линия → значение, пока atTime не ушёл за её правый край больше чем на barSeconds×2;
 *  • прямоугольник → верхняя и нижняя границы;
 *  • Фибоначчи → все уровни;
 *  • вертикальные линии и метки уровнями не являются.
 * @returns {Array<{price:number, kind:string, label:string, drawingId:string}>}
 */
export function userLevelsFrom(drawings, atTime, { barSeconds = 0 } = {}) {
  const out = [];
  for (const d of normalizeDrawings(drawings)) {
    if (d.type === 'hline') out.push({ price: d.p1.price, kind: 'hline', label: 'горизонталь', drawingId: d.id });
    else if (d.type === 'ray') {
      const v = lineValueAt(d.p1, d.p2, atTime);
      if (v != null && atTime >= Math.min(d.p1.time, d.p2.time)) out.push({ price: v, kind: 'ray', label: 'луч', drawingId: d.id });
    } else if (d.type === 'trend') {
      const right = Math.max(d.p1.time, d.p2.time);
      const left = Math.min(d.p1.time, d.p2.time);
      if (atTime >= left && atTime <= right + (barSeconds || 0) * 2) {
        const v = lineValueAt(d.p1, d.p2, atTime);
        if (v != null) out.push({ price: v, kind: 'trend', label: 'трендовая линия', drawingId: d.id });
      }
    } else if (d.type === 'rect') {
      out.push({ price: Math.max(d.p1.price, d.p2.price), kind: 'rect', label: 'верх зоны', drawingId: d.id });
      out.push({ price: Math.min(d.p1.price, d.p2.price), kind: 'rect', label: 'низ зоны', drawingId: d.id });
    } else if (d.type === 'fib') {
      for (const lv of fibLevels(d.p1, d.p2)) {
        out.push({ price: lv.price, kind: 'fib', label: `Фибо ${Math.round(lv.ratio * 1000) / 10}%`, drawingId: d.id });
      }
    }
  }
  return out.filter((l) => finite(l.price) && l.price > 0);
}

/** Ближайший уровень к цене. */
export function nearestLevel(levels, price) {
  if (!Array.isArray(levels) || !levels.length || !finite(price) || price === 0) return null;
  let best = null;
  for (const l of levels) {
    const dist = Math.abs(l.price - price);
    if (!best || dist < best.dist) best = { ...l, dist };
  }
  return best ? { ...best, distancePct: (best.dist / price) * 100 } : null;
}

/** Расстояние от точки (px,py) до отрезка (x1,y1)-(x2,y2) в пикселях — для выбора рисунка кликом. */
export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * ATR (средний истинный диапазон) по свечам, метод Уайлдера. Нужен линейке, чтобы выражать ход в ATR.
 * @param {Array<{high:number, low:number, close:number}>} candles
 * @returns {number|null}
 */
export function atrOf(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const v = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (!Number.isFinite(v)) return null;
    tr.push(v);
  }
  let atr = tr.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

/**
 * Свои линии как уровни на момент ПОСЛЕДНЕЙ свечи — готовый список для контекста стратегии
 * (`ctx.userLevels`). Один вызов для приложения и роботов: профиль + тикер + таймфрейм + свечи.
 * @param {object} profile — профиль пользователя (chartDrawings)
 * @param {Array<{date: Date|string|number}>} candles
 * @returns {Array} пусто, если у инструмента нет рисунков или свечей
 */
export function userLevelsForChart(profile, ticker, timeframe, candles) {
  const list = drawingsFor(profile, ticker, timeframe);
  if (!list.length || !Array.isArray(candles) || !candles.length) return [];
  const sec = (c) => Math.floor(new Date(c.date).getTime() / 1000);
  const last = sec(candles[candles.length - 1]);
  if (!Number.isFinite(last)) return [];
  const prev = candles.length > 1 ? sec(candles[candles.length - 2]) : null;
  const barSeconds = prev != null && Number.isFinite(prev) && last > prev ? last - prev : 0;
  return userLevelsFrom(list, last, { barSeconds });
}

/**
 * Сдвинуть рисунок целиком на dt секунд и dp по цене. Горизонталь двигается только по цене,
 * вертикаль — только по времени (иначе линия «уезжала» бы в сторону, где у неё нет смысла).
 */
export function moveDrawing(d, dt, dp) {
  const shift = (p) => ({
    time: d.type === 'hline' ? p.time : p.time + dt,
    price: d.type === 'vline' ? p.price : p.price + dp,
  });
  return { ...d, p1: shift(d.p1), ...(d.p2 ? { p2: shift(d.p2) } : {}) };
}

/** Переставить одну из двух точек (p1/p2) в новое место. Для линий с одной точкой — единственную. */
export function movePoint(d, which, pt) {
  const key = which === 'p2' && d.p2 ? 'p2' : 'p1';
  const cur = d[key];
  const next = {
    time: d.type === 'hline' ? cur.time : pt.time,
    price: d.type === 'vline' ? cur.price : pt.price,
  };
  return { ...d, [key]: next };
}
