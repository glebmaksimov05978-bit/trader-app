// src/components/auth/LoginBackground.js
//
// Фоны страницы входа. ВРЕМЕННО их несколько — выбираются маленькой панелью (LoginDevSwitcher),
// чтобы владелец сравнил вживую. Когда вариант выбран — оставить один, остальные файлы
// (LoginPanels, LoginPrism, LoginLive, LoginDepth) и панель убрать.
//
// Общее правило: надписи слева (о продукте) не должны перечёркиваться графиком. Поэтому линия
// роста идёт низко под текстом и поднимается только правее его, а тяжёлые фоны слева
// приглушены маской (см. .dim-left в LoginBackdrops.css).
import React, { Suspense, lazy } from 'react';
import './LoginBackdrops.css';
import LiveChart from './LoginLive';
import { makeRng, clamp, smoothstep } from './loginBackdropUtils';

// На сайте у всех один фон — «Живой график». Остальные нужны только для сравнения в режиме
// разработки, поэтому грузятся лениво и в обычную загрузку страницы не попадают.
const PanelsLayer = lazy(() => import('./LoginPanels'));
const PrismLayer = lazy(() => import('./LoginPrism'));
const DepthChart = lazy(() => import('./LoginDepth'));

export const BG_VARIANTS = [
  { id: 'growth', label: 'Рост' },
  { id: 'panels', label: 'Панели' },
  { id: 'prism', label: 'Призма' },
  { id: 'panels-growth', label: 'Панели + рост' },
  { id: 'prism-growth', label: 'Призма + рост' },
  { id: 'live', label: 'Живой график' },
  { id: 'depth', label: 'Стакан' },
];

const W = 1440;
const H = 900;
const N = 84;

// Ряд цен: слева почти ровно и низко (под текстом), рост начинается примерно с трети экрана
// и ускоряется к правому краю; поверх — небольшой шум с откатами.
function buildGrowth() {
  const rnd = makeRng(20260817);
  const top = H * 0.1;
  const bottom = H * 0.93;
  let walk = 0;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    walk = walk * 0.62 + (rnd() - 0.5) * 0.06;
    const trend = 0.03 + 0.92 * Math.pow(smoothstep(0.24, 1, x), 1.3);
    const v = clamp(trend + walk * (0.35 + x * 0.9), 0.02, 1);
    pts.push({ x: x * W, y: bottom - v * (bottom - top) });
  }
  return pts;
}

const movingAverage = (points, win) => points.map((p, i) => {
  const slice = points.slice(Math.max(0, i - win + 1), i + 1);
  return { x: p.x, y: slice.reduce((s, q) => s + q.y, 0) / slice.length };
});
const toPath = (pts) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

const GROWTH = buildGrowth();
const LINE = toPath(GROWTH);
const AREA = `${LINE} L${W},${H} L0,${H} Z`;
const AVG = toPath(movingAverage(GROWTH, 9));

function GrowthLine() {
  return (
    <svg className="login-backdrop-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="loginAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--accent-primary)', stopOpacity: 0.16 }} />
          <stop offset="100%" style={{ stopColor: 'var(--accent-primary)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path className="login-backdrop-area" d={AREA} fill="url(#loginAreaFill)" />
      <path className="login-backdrop-avg" d={AVG} fill="none" pathLength="1" />
      <path className="login-backdrop-line" d={LINE} fill="none" pathLength="1" />
    </svg>
  );
}

export default function LoginBackdrop({ variant = 'growth' }) {
  const withGrid = !['live', 'depth'].includes(variant);
  return (
    <div className="login-backdrop" aria-hidden="true">
      <Suspense fallback={null}>
        {withGrid && <div className="login-backdrop-grid" />}
        {variant === 'growth' && <GrowthLine />}
        {variant === 'panels' && <PanelsLayer />}
        {variant === 'prism' && <PrismLayer />}
        {variant === 'panels-growth' && <><PanelsLayer dim /><GrowthLine /></>}
        {variant === 'prism-growth' && <><PrismLayer /><GrowthLine /></>}
        {variant === 'live' && <LiveChart />}
        {variant === 'depth' && <DepthChart />}
      </Suspense>
    </div>
  );
}
