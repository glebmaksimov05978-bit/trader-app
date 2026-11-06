// Слой рисунков (DrawingsPrimitive): перевод время ↔ координата справа от последней свечи (прогноз), стрелка, попадание кликом.
// Сам график lightweight-charts здесь подменён: x = логический номер бара × 10, y = 500 − цена × 2.
import { DrawingsPrimitive } from './chartDrawingsPrimitive';

const DAY = 86400;
// 30 торговых дней (пн–пт) подряд, начиная с понедельника 5 октября 2026 (UTC)
function tradingDays(n) {
  const out = [];
  let t = Date.UTC(2026, 9, 5) / 1000;
  while (out.length < n) {
    const dow = new Date(t * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
    t += DAY;
  }
  return out;
}

function make(times) {
  const prim = new DrawingsPrimitive();
  const chart = { timeScale: () => ({ logicalToCoordinate: (l) => l * 10, coordinateToLogical: (x) => x / 10 }) };
  const series = { priceToCoordinate: (p) => 500 - p * 2, coordinateToPrice: (y) => (500 - y) / 2 };
  prim.attached({ chart, series, requestUpdate: () => {} });
  prim.setState({ times, barSec: DAY });
  return prim;
}

test('справа от последней свечи точка переводится в время и обратно (прогноз можно рисовать)', () => {
  const times = tradingDays(30);
  const prim = make(times);
  const last = times[times.length - 1];
  const x = (times.length - 1 + 8) * 10; // 8 баров правее последней свечи
  const pt = prim.pointAt(x, 300);
  expect(pt).not.toBeNull();
  expect(pt.time).toBeGreaterThan(last);
  expect(prim.timeToX(pt.time)).toBeCloseTo(x, 5);
  const inside = times[12] + 3600;
  expect(prim.timeToX(prim.xToTime(prim.timeToX(inside)))).toBeCloseTo(prim.timeToX(inside), 5);
});

test('шаг справа считается средним (с учётом выходных), а не последним', () => {
  const times = tradingDays(30);
  const prim = make(times);
  const avg = prim._avgStep();
  // 30 торговых дней ≈ 6 недель → средний шаг заметно больше суток (выходные), но меньше двух суток
  expect(avg).toBeGreaterThan(DAY * 1.2);
  expect(avg).toBeLessThan(DAY * 1.6);
  const last = times[times.length - 1];
  expect(prim._logicalOfTime(last + avg * 10)).toBeCloseTo(times.length - 1 + 10, 6);
});

test('стрелка: древко и два крыла наконечника, две ручки; клик по древку находит её', () => {
  const times = tradingDays(30);
  const prim = make(times);
  const last = times[times.length - 1];
  const arrow = { id: 'a1', type: 'arrow', color: '#e0584f', width: 1, p1: { time: times[25], price: 100 }, p2: { time: last + prim._avgStep() * 6, price: 120 } };
  prim.setState({ drawings: [arrow], selectedId: 'a1' });
  const sh = prim._shapes(arrow, 800, 500);
  expect(sh.segs.length).toBe(3);
  expect(sh.handles.length).toBe(2);
  expect(sh.segs[0].dash).toBeTruthy();
  // середина древка
  const mid = { x: (sh.segs[0].x1 + sh.segs[0].x2) / 2, y: (sh.segs[0].y1 + sh.segs[0].y2) / 2 };
  prim._width = 800; prim._height = 500;
  expect(prim.hitTest(mid.x, mid.y)).toBe('a1');
  expect(prim.hitTest(mid.x, mid.y + 60)).toBeNull();
  // ручка второй точки находится
  const h2 = sh.handles[1];
  expect(prim.hitHandle(h2.x + 3, h2.y - 2)).toEqual({ id: 'a1', which: 'p2' });
});

test('луч: клик по линии рядом с курсором находит её, в стороне — нет', () => {
  const times = tradingDays(30);
  const prim = make(times);
  const ray = { id: 'r1', type: 'ray', color: '#6485d8', width: 1, p1: { time: times[10], price: 100 }, p2: { time: times[20], price: 110 } };
  prim.setState({ drawings: [ray], selectedId: null });
  prim._width = 800; prim._height = 500;
  const sh = prim._shapes(ray, 800, 500);
  const s = sh.segs[0];
  const along = { x: s.x1 + (s.x2 - s.x1) * 0.5, y: s.y1 + (s.y2 - s.y1) * 0.5 };
  expect(prim.hitTest(along.x, along.y + 3)).toBe('r1');
  expect(prim.hitTest(along.x, along.y + 30)).toBeNull();
});
