// Проверка слоя рисунков на графике без браузера: геометрия, перевод время↔координата, попадание
// клика и отрисовка на «поддельном» холсте (npm run test:primitive).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-prim-'));
fs.mkdirSync(path.join(tmp, 'services'));
fs.mkdirSync(path.join(tmp, 'components'));
// модуль рисунков (без импортов) и примитив с поправленным путём импорта
fs.copyFileSync(path.join(__dirname, '../src/services/chartDrawings.js'), path.join(tmp, 'services/chartDrawings.js'));
let prim = fs.readFileSync(path.join(__dirname, '../src/components/shared/chartDrawingsPrimitive.js'), 'utf8');
prim = prim.replace("'../../services/chartDrawings'", "'../services/chartDrawings.js'");
fs.writeFileSync(path.join(tmp, 'components/chartDrawingsPrimitive.js'), prim, 'utf8');
const { DrawingsPrimitive } = await import(pathToFileURL(path.join(tmp, 'components/chartDrawingsPrimitive.js')).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// 20 баров с шагом 1000 с, начиная с 1000; x = 10 + индекс*10; y = 500 − цена*2
const times = Array.from({ length: 20 }, (_, i) => 1000 * (i + 1));
const chart = { timeScale: () => ({ logicalToCoordinate: (l) => 10 + l * 10, coordinateToLogical: (x) => (x - 10) / 10 }) };
const series = { priceToCoordinate: (p) => 500 - p * 2, coordinateToPrice: (y) => (500 - y) / 2 };
const W = 400, H = 500;

const p = new DrawingsPrimitive();
p.attached({ chart, series, requestUpdate: () => {} });
p.setState({ times, barSec: 1000 });
p._width = W; p._height = H;

// ---- время ↔ координата ----
ok('время бара → x', p.timeToX(1000) === 10 && p.timeToX(3000) === 30);
ok('между барами — линейно', p.timeToX(1500) === 15);
ok('правее последнего бара — экстраполяция по шагу', p.timeToX(22000) === 10 + 21 * 10);
ok('левее первого бара — экстраполяция', p.timeToX(0) === 0);
ok('x → время обратно', p.xToTime(30) === 3000 && p.xToTime(35) === 3500);
ok('x правее последнего бара → время в будущем', p.xToTime(220) === 22000);
ok('цена ↔ y', p.priceToY(100) === 300 && p.yToPrice(300) === 100);
const pt = p.pointAt(50, 200);
ok('точка экрана → время и цена', pt.time === 5000 && pt.price === 150);
ok('пустые времена — null', (() => { const q = new DrawingsPrimitive(); q.attached({ chart, series, requestUpdate: () => {} }); return q.timeToX(5) === null; })());

// ---- геометрия и попадание ----
const D = (type, p1, p2, extra = {}) => ({ id: `${type}1`, type, p1, p2, color: '#6485d8', width: 1, ...extra });
const hline = D('hline', { time: 3000, price: 100 });
const trend = D('trend', { time: 2000, price: 100 }, { time: 12000, price: 150 }); // (20,300) → (120,200)
const ray = D('ray', { time: 2000, price: 100 }, { time: 4000, price: 110 });      // (20,300) → (40,280) → до края
const rect = D('rect', { time: 5000, price: 100 }, { time: 9000, price: 120 });     // x 50..90, y 260..300
const fib = D('fib', { time: 5000, price: 100 }, { time: 10000, price: 200 });
const vline = D('vline', { time: 8000, price: 1 });
const text = D('text', { time: 15000, price: 120 }, null, { label: 'Тест' });
p.setState({ drawings: [hline, trend, ray, rect, fib, vline, text] });

const sh = (d) => p._shapes(d, W, H);
ok('горизонталь: один отрезок на всю ширину на y=300', sh(hline).segs.length === 1 && sh(hline).segs[0].x1 === 0 && sh(hline).segs[0].x2 === W && sh(hline).segs[0].y1 === 300);
ok('горизонталь: подпись с ценой', /100/.test(sh(hline).labels[0].text));
ok('трендовая: отрезок между точками', (() => { const s = sh(trend).segs[0]; return s.x1 === 20 && s.y1 === 300 && s.x2 === 120 && s.y2 === 200; })());
ok('луч: продолжен до правого края', (() => { const s = sh(ray).segs[0]; return s.x1 === 20 && s.x2 > W; })());
ok('луч: наклон сохранён', (() => { const s = sh(ray).segs[0]; return near((s.y2 - s.y1) / (s.x2 - s.x1), (280 - 300) / (40 - 20)); })());
ok('прямоугольник: заливка и четыре стороны', sh(rect).fills.length === 1 && sh(rect).segs.length === 4 && sh(rect).fills[0].w === 40 && sh(rect).fills[0].h === 40);
ok('Фибоначчи: 7 уровней и 7 подписей', sh(fib).segs.filter((s) => s.y1 === s.y2).length === 7 && sh(fib).labels.length === 7);
ok('Фибоначчи: уровень 61,8% на нужной высоте', sh(fib).labels.some((l) => /61,8%/.test(l.text) && near(l.y + 8, 500 - (100 + 100 * 0.618) * 2)));
ok('вертикаль: на x бара 8000 = 80', sh(vline).segs[0].x1 === 80 && sh(vline).segs[0].y2 === H);
ok('метка: подпись и рамка', sh(text).labels[0].text === 'Тест' && sh(text).labels[0].box === true);

ok('клик по горизонтали выбирает её', p.hitTest(250, 300) === 'hline1');
ok('клик в 20 px от горизонтали — мимо', p.hitTest(250, 280) !== 'hline1');
ok('клик у середины трендовой линии', p.hitTest(70, 250) === 'trend1');
ok('клик внутри прямоугольника выбирает его', p.hitTest(70, 280) === 'rect1');
ok('клик по метке', p.hitTest(160, 260) === 'text1');
ok('клик по пустому месту — null', p.hitTest(350, 50) === null);

// ---- отрисовка на поддельном холсте ----
const calls = [];
const ctx = new Proxy({}, {
  get: (_, k) => {
    if (k === 'measureText') return (t) => ({ width: String(t).length * 6 });
    return (...a) => { calls.push(k); return undefined; };
  },
  set: () => true,
});
const target = { useMediaCoordinateSpace: (cb) => cb({ context: ctx, mediaSize: { width: W, height: H } }) };
let drew = true;
try {
  p.setState({ selectedId: 'trend1', preview: { id: '__p', type: 'trend', p1: { time: 2000, price: 100 }, p2: { time: 9000, price: 130 }, color: '#e0584f', width: 1 },
    ruler: { p1: { time: 2000, price: 100 }, p2: { time: 9000, price: 130 }, up: true, text: '+30 · +30%' } });
  p._renderer.draw(target);
} catch (e) { drew = false; console.log(e); }
ok('отрисовка выполняется без ошибок', drew);
ok('нарисованы линии, заливки и подписи', calls.includes('stroke') && calls.includes('fillRect') && calls.includes('fillText'));
ok('у выбранного рисунка есть «ручки» (круги)', calls.includes('arc'));

// рисунок за пределами видимого диапазона не ломает отрисовку
p.setState({ drawings: [D('hline', { time: 999999999, price: 1e9 })], selectedId: null, preview: null, ruler: null });
let ok2 = true;
try { p._renderer.draw(target); } catch { ok2 = false; }
ok('экстремальные координаты не роняют отрисовку', ok2);
// пока график не подключён (null) — тихо
const detached = new DrawingsPrimitive();
detached.setState({ times, drawings: [hline] });
let ok3 = true;
try { detached._renderer.draw(target); } catch { ok3 = false; }
ok('без графика отрисовка тихо ничего не делает', ok3);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки слоя рисунков прошли ✓');
