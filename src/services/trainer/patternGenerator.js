// src/services/trainer/patternGenerator.js
//
// Генератор учебных графиков для тренажёра «Тренд»: в процедурно сгенерированный, но реалистично «шумный» ряд цен
// вкладывается настоящая фигура технического анализа, а ответ известен заранее. Чистый модуль без зависимостей:
// одни и те же (тип, семя, шум) всегда дают один и тот же график — поэтому игру, тесты и сравнение с детекторами
// приложения можно воспроизвести.
//
// Принцип (как в ТЗ тренажёра): фигура — это последовательность опорных точек (время, уровень цены); между ними
// строится ломаная с «броуновским мостом» шума, затем ряд превращается в свечи. Параметры меняются случайно:
// высота фигуры, положение точек, степень шума. Продолжение графика после фигуры идёт по логике фигуры
// (разворот/пробой) — но это ТОЛЬКО учебная модель: на реальном рынке фигуры не гарантируют продолжения.

// ---------- случайные числа (mulberry32) ----------
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rng) => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng());
const lerp = (a, b, k) => a + (b - a) * k;
const rand = (rng, a, b) => a + (b - a) * rng();

// ---------- описание фигур ----------
// Каждая фабрика возвращает опорные точки [{t, p}] (t — от 0 до 1 по длине фигуры, p — цена в % от 100), момент
// «определения» фигуры (доля длины, когда она уже видна целиком) и направление продолжения.

// Зигзаг между верхней и нижней границами: n разворотов, highAt(i)/lowAt(i) — уровни i-го максимума/минимума.
function zigzag({ t0, t1, n, firstHigh, highAt, lowAt }) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = lerp(t0, t1, n === 1 ? 0 : i / (n - 1));
    const isHigh = firstHigh ? i % 2 === 0 : i % 2 === 1;
    const k = Math.floor(i / 2);
    pts.push({ t, p: isHigh ? highAt(k) : lowAt(k) });
  }
  return pts;
}

export const PATTERN_SPECS = {
  double_top: {
    label: 'Двойная вершина', direction: 'down',
    points: (rng, H) => {
      const peak = H;
      return [{ t: 0, p: 0 }, { t: 0.3, p: peak }, { t: 0.5, p: H * 0.42 }, { t: 0.72, p: peak * (1 + rand(rng, -0.04, 0.04)) }, { t: 0.9, p: H * 0.2 }, { t: 1, p: H * 0.1 }];
    },
    detectAt: 0.78,
  },
  double_bottom: {
    label: 'Двойное дно', direction: 'up',
    points: (rng, H) => {
      const low = -H;
      return [{ t: 0, p: 0 }, { t: 0.3, p: low }, { t: 0.5, p: -H * 0.42 }, { t: 0.72, p: low * (1 + rand(rng, -0.04, 0.04)) }, { t: 0.9, p: -H * 0.2 }, { t: 1, p: -H * 0.1 }];
    },
    detectAt: 0.78,
  },
  head_shoulders_top: {
    label: 'Голова и плечи', direction: 'down',
    points: (rng, H) => [{ t: 0, p: 0 }, { t: 0.2, p: H * 0.7 }, { t: 0.34, p: H * 0.28 }, { t: 0.5, p: H }, { t: 0.65, p: H * 0.3 }, { t: 0.8, p: H * 0.7 * (1 + rand(rng, -0.08, 0.08)) }, { t: 0.95, p: H * 0.1 }, { t: 1, p: 0 }],
    detectAt: 0.86,
  },
  head_shoulders_bottom: {
    label: 'Перевёрнутые голова и плечи', direction: 'up',
    points: (rng, H) => [{ t: 0, p: 0 }, { t: 0.2, p: -H * 0.7 }, { t: 0.34, p: -H * 0.28 }, { t: 0.5, p: -H }, { t: 0.65, p: -H * 0.3 }, { t: 0.8, p: -H * 0.7 * (1 + rand(rng, -0.08, 0.08)) }, { t: 0.95, p: -H * 0.1 }, { t: 1, p: 0 }],
    detectAt: 0.86,
  },
  triangle_ascending: {
    label: 'Восходящий треугольник', direction: 'up',
    points: (rng, H) => [{ t: 0, p: 0 }, ...zigzag({ t0: 0.12, t1: 0.88, n: 8, firstHigh: true, highAt: () => H * (1 + rand(rng, -0.015, 0.015)), lowAt: (k) => H * (0.15 + k * 0.22) }), { t: 1, p: H * 1.2 }],
    detectAt: 0.9,
  },
  triangle_descending: {
    label: 'Нисходящий треугольник', direction: 'down',
    points: (rng, H) => [{ t: 0, p: 0 }, ...zigzag({ t0: 0.12, t1: 0.88, n: 8, firstHigh: false, highAt: (k) => -H * (0.15 + k * 0.22), lowAt: () => -H * (1 + rand(rng, -0.015, 0.015)) }), { t: 1, p: -H * 1.2 }],
    detectAt: 0.9,
  },
  triangle_symmetric: {
    label: 'Симметричный треугольник', direction: 'up',
    points: (rng, H) => [{ t: 0, p: 0 }, ...zigzag({ t0: 0.12, t1: 0.88, n: 8, firstHigh: true, highAt: (k) => H * (1 - k * 0.14), lowAt: (k) => H * (0.05 + k * 0.14) }), { t: 1, p: H * 1.1 }],
    detectAt: 0.9,
  },
  wedge_rising: {
    label: 'Восходящий клин', direction: 'down',
    points: (rng, H) => [{ t: 0, p: 0 }, ...zigzag({ t0: 0.12, t1: 0.88, n: 8, firstHigh: true, highAt: (k) => H * (0.7 + k * 0.095), lowAt: (k) => H * (0.02 + k * 0.29) }), { t: 1, p: H * 0.5 }],
    detectAt: 0.9,
  },
  wedge_falling: {
    label: 'Нисходящий клин', direction: 'up',
    points: (rng, H) => [{ t: 0, p: 0 }, ...zigzag({ t0: 0.12, t1: 0.88, n: 8, firstHigh: false, highAt: (k) => -H * (0.02 + k * 0.29), lowAt: (k) => -H * (0.7 + k * 0.095) }), { t: 1, p: -H * 0.5 }],
    detectAt: 0.9,
  },
  flag_bull: {
    label: 'Флаг (после роста)', direction: 'up',
    points: (rng, H) => [{ t: 0, p: H * 0.5 }, { t: 0.08, p: 0 }, { t: 0.24, p: H * 1.3 }, ...zigzag({ t0: 0.3, t1: 0.88, n: 8, firstHigh: true, highAt: (k) => H * (1.3 - k * 0.16), lowAt: (k) => H * (1.05 - k * 0.16) }), { t: 1, p: H * 1.2 }],
    detectAt: 0.9,
  },
  flag_bear: {
    label: 'Флаг (после падения)', direction: 'down',
    points: (rng, H) => [{ t: 0, p: -H * 0.5 }, { t: 0.08, p: 0 }, { t: 0.24, p: -H * 1.3 }, ...zigzag({ t0: 0.3, t1: 0.88, n: 8, firstHigh: false, highAt: (k) => -H * (1.05 - k * 0.16), lowAt: (k) => -H * (1.3 - k * 0.16) }), { t: 1, p: -H * 1.2 }],
    detectAt: 0.9,
  },
};
export const PATTERN_IDS = Object.keys(PATTERN_SPECS);

// ---------- построение ряда ----------
function buildCloses(points, n, noise, H, rng) {
  const closes = new Array(n);
  const sigma = noise * H * 0.07; // «неровность» линии: шум растёт вместе с высотой фигуры и параметром шума
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    while (seg < points.length - 2 && t > points[seg + 1].t) seg++;
    const a = points[seg], b = points[seg + 1];
    const k = b.t === a.t ? 1 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    // «мост»: шум обнуляется в опорных точках, чтобы сама фигура не искажалась
    const bridge = Math.sin(Math.PI * k);
    closes[i] = lerp(a.p, b.p, k) + gauss(rng) * sigma * bridge;
  }
  return closes;
}

function toCandles(closes, base, noise, H, rng, startDate) {
  const out = [];
  let prev = base;
  const day = 86400000;
  for (let i = 0; i < closes.length; i++) {
    const close = base * (1 + closes[i] / 100);
    const open = i === 0 ? base : prev * (1 + gauss(rng) * 0.0008);
    const wick = base * (Math.abs(gauss(rng)) * (0.0012 + noise * H * 0.00035));
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - base * (Math.abs(gauss(rng)) * (0.0012 + noise * H * 0.00035));
    out.push({
      date: new Date(startDate.getTime() + i * day),
      open, high, low, close,
      volume: Math.round(10000 * (0.7 + rng() * 0.6)),
    });
    prev = close;
  }
  return out;
}

/**
 * Один учебный график с фигурой.
 * @param {string} pattern — ключ из PATTERN_SPECS, либо 'none' (случайное блуждание без фигуры)
 * @param {{seed?:number, noise?:number, bars?:number, after?:number}} o
 *   noise — «неровность» 0.3…0.7 (как в ТЗ); bars — длина фигуры; after — сколько свечей продолжения показать после неё
 * @returns {{candles, cut:number, truth:{pattern, direction, label}, height:number}}
 *   candles — вся последовательность (фигура + продолжение); cut — индекс последней свечи, ВИДИМОЙ игроку
 *   перед вопросом «куда дальше?» (фигура уже видна, продолжение скрыто).
 */
export function generatePattern(pattern, { seed = 1, noise = 0.5, bars = 56, after = 12 } = {}) {
  const rng = makeRng(seed * 2654435761);
  const H = rand(rng, 8, 14); // высота фигуры, % цены
  const startDate = new Date(Date.UTC(2024, 0, 2));
  const base = 100;

  if (pattern === 'none') {
    const total = bars + after;
    const closes = [];
    let v = 0;
    for (let i = 0; i < total; i++) { v += gauss(rng) * H * 0.07; closes.push(v); }
    return { candles: toCandles(closes, base, noise, H, rng, startDate), cut: bars - 1, truth: { pattern: 'none', direction: null, label: 'Без фигуры' }, height: H };
  }

  const spec = PATTERN_SPECS[pattern];
  if (!spec) throw new Error(`Неизвестная фигура: ${pattern}`);
  const pts = spec.points(rng, H);
  const closes = buildCloses(pts, bars, noise, H, rng);
  // Продолжение: движение в сторону логики фигуры, затем топтание (учебная модель, не рыночный факт).
  const last = closes[closes.length - 1];
  const dir = spec.direction === 'up' ? 1 : -1;
  for (let i = 1; i <= after; i++) closes.push(last + dir * H * 0.09 * i * (1 + gauss(rng) * 0.2) + gauss(rng) * H * 0.04);
  return {
    candles: toCandles(closes, base, noise, H, rng, startDate),
    cut: Math.round(bars * spec.detectAt) - 1,
    truth: { pattern, direction: spec.direction, label: spec.label },
    height: H,
  };
}
