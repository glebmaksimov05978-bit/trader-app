// src/components/auth/loginBackdropUtils.js
//
// Общие мелочи для фонов страницы входа: детерминированные «свечи» (чтобы рисунок не менялся
// при каждой перерисовке) и скользящая средняя.

// Простейший детерминированный генератор псевдослучайных чисел (LCG).
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// n свечей, значения нормированы в 0..1 (0 — самый низ, 1 — самый верх).
export function candleSeries(n, seed, { drift = 0, vol = 1 } = {}) {
  const rnd = makeRng(seed);
  let p = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + (rnd() - 0.5) * 1.6 * vol + drift;
    const h = Math.max(o, c) + rnd() * 0.7 * vol;
    const l = Math.min(o, c) - rnd() * 0.7 * vol;
    p = c;
    out.push({ o, h, l, c });
  }
  const min = Math.min(...out.map((x) => x.l));
  const max = Math.max(...out.map((x) => x.h));
  const k = max - min || 1;
  return out.map((x) => ({ o: (x.o - min) / k, h: (x.h - min) / k, l: (x.l - min) / k, c: (x.c - min) / k }));
}

export function sma(values, win) {
  return values.map((_, i) => {
    const from = Math.max(0, i - win + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
