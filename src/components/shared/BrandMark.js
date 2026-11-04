// src/components/shared/BrandMark.js
//
// Знак TraderPro в нескольких вариантах. ВРЕМЕННО: выбор варианта хранится в localStorage
// и переключается маленькой панелью на странице входа (LoginDevSwitcher), чтобы владелец
// увидел знак и в меню приложения, и на входе. Когда вариант выбран насовсем — оставить
// один компонент и убрать панель, хранилище и остальные варианты.
//
// Знак — самостоятельная форма, а не буква на плашке: грани с мягкими переходами света.
// Градиенты здесь допустимы (это логотип, а не интерфейс), но сдержанные: один акцентный
// голубой и графит, без свечения.
import React, { useEffect, useId, useState } from 'react';
import BrandIcon from './BrandIcon';

export const BRAND_VARIANTS = [
  { id: 'old', label: 'Было', hint: 'Прежний знак: линия тренда на акцентной плашке' },
  { id: 'facet', label: 'Грань', hint: 'Кристалл со свечами в тёмном окне' },
  { id: 'window', label: 'Кристалл-окно', hint: 'Огранённый камень с окном-графиком внутри: детальнее и «дороже»' },
  { id: 'tblock', label: 'Т-блок', hint: 'Объёмная буква T — инициал TraderPro, как цельный камень' },
  { id: 'compass', label: 'Курс', hint: 'Стрелка компаса, смотрит вверх-вправо: направление движения' },
];

const KEY = 'brandVariant';
const DEFAULT = 'window';
const listeners = new Set();

function read() {
  // На сайте у всех один знак; выбор из localStorage — только при разработке.
  if (process.env.NODE_ENV === 'production') return DEFAULT;
  try {
    const v = localStorage.getItem(KEY);
    return BRAND_VARIANTS.some((b) => b.id === v) ? v : DEFAULT;
  } catch { return DEFAULT; }
}

let current = read();

export function setBrandVariant(v) {
  current = v;
  try { localStorage.setItem(KEY, v); } catch { /* приватный режим — не страшно */ }
  listeners.forEach((fn) => fn(v));
}

export function useBrandVariant() {
  const [v, setV] = useState(current);
  useEffect(() => {
    listeners.add(setV);
    return () => listeners.delete(setV);
  }, []);
  return [v, setBrandVariant];
}

const EDGE = { stroke: 'rgba(255,255,255,0.32)', strokeWidth: 0.7, strokeLinejoin: 'round' };

function Grad({ id, from, to, x2 = 0, y2 = 1 }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2={x2} y2={y2}>
      <stop offset="0" stopColor={from} />
      <stop offset="1" stopColor={to} />
    </linearGradient>
  );
}

// «Грань»: открытый кристалл — светлые внешние грани, тёмное стекло внутри, в нём свечи и искра.
function Facet({ p }) {
  const g = (n) => `url(#${p}${n})`;
  return (
    <>
      <defs>
        <Grad id={`${p}a`} from="#f7f9ff" to="#9fb4f2" />
        <Grad id={`${p}b`} from="#d3deff" to="#5f7fdc" />
        <Grad id={`${p}c`} from="#0e1529" to="#26376a" />
        <Grad id={`${p}d`} from="#3a52a3" to="#1b2858" />
        <Grad id={`${p}e`} from="#2a3d82" to="#141d45" />
      </defs>
      <polygon points="32,3 57,17.5 57,46.5 32,61 7,46.5 7,17.5" fill={g('c')} />
      <polygon points="7,46.5 14,46.5 32,53.5 32,61" fill={g('d')} {...EDGE} />
      <polygon points="57,46.5 50,46.5 32,53.5 32,61" fill={g('e')} {...EDGE} />
      <polygon points="7,17.5 32,3 32,13 14,46.5 7,46.5" fill={g('a')} {...EDGE} />
      <polygon points="57,17.5 32,3 32,13 50,46.5 57,46.5" fill={g('b')} {...EDGE} />
      <g strokeLinecap="round">
        {[[24, 33, 45, 36.5, 42, '#eef3ff'], [29.2, 28.5, 43, 31.5, 39, '#5fd9ae'], [35, 31.5, 46, 35, 43, '#eef3ff'], [40.2, 36.5, 46, 38.5, 44, '#cfdcff']].map(([x, wt, wb, bt, bb, fill]) => (
          <g key={x}>
            <line x1={x} x2={x} y1={wt} y2={wb} stroke={fill} strokeWidth="1.2" />
            <rect x={x - 2} y={bt} width="4" height={bb - bt} rx="0.8" fill={fill} />
          </g>
        ))}
      </g>
      <g stroke="#ffffff" strokeLinecap="round">
        <line x1="32" y1="16.2" x2="32" y2="23.6" strokeWidth="1" opacity="0.85" />
        <line x1="28.3" y1="19.9" x2="35.7" y2="19.9" strokeWidth="1" opacity="0.85" />
        <circle cx="32" cy="19.9" r="1.5" fill="#ffffff" stroke="none" />
      </g>
      <polygon points="32,3 57,17.5 57,46.5 32,61 7,46.5 7,17.5" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" strokeLinejoin="round" />
    </>
  );
}

// «Кристалл-окно»: огранённый камень сверху — шесть граней с разным светом вокруг шестигранного
// окна, а в окне — график. Детальнее «Грани»: у камня есть ободок, блик и тёмная глубина.
function Window({ p }) {
  const g = (n) => `url(#${p}${n})`;
  const V = [[32, 3], [57, 17.5], [57, 46.5], [32, 61], [7, 46.5], [7, 17.5]];
  const W = V.map(([x, y]) => [32 + (x - 32) * 0.55, 32 + (y - 32) * 0.55]);
  const quad = (i) => [V[i], V[(i + 1) % 6], W[(i + 1) % 6], W[i]].map((q) => q.join(',')).join(' ');
  const fills = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5'];
  return (
    <>
      <defs>
        <Grad id={`${p}q0`} from="#dfe8ff" to="#9db3f4" />
        <Grad id={`${p}q1`} from="#7a96ea" to="#425aae" />
        <Grad id={`${p}q2`} from="#3f57ab" to="#212f6c" />
        <Grad id={`${p}q3`} from="#2c3f8a" to="#17215a" />
        <Grad id={`${p}q4`} from="#6784e0" to="#374c9f" />
        <Grad id={`${p}q5`} from="#f4f7ff" to="#bfcefb" />
        <Grad id={`${p}w`} from="#0a1022" to="#1d2d60" />
      </defs>
      {fills.map((n, i) => <polygon key={n} points={quad(i)} fill={g(n)} {...EDGE} />)}
      <polygon points={W.map((q) => q.join(',')).join(' ')} fill={g('w')} stroke="rgba(255,255,255,0.55)" strokeWidth="0.8" strokeLinejoin="round" />
      <g strokeLinecap="round">
        {[[24, 27, 38, 29.5, 35, '#eef3ff'], [29.5, 22.5, 41, 25.5, 35, '#5fd9ae'], [35, 25.5, 42, 28.5, 38, '#eef3ff'], [40.5, 29.5, 40, 31.5, 37, '#cfdcff']].map(([x, wt, wb, bt, bb, fill]) => (
          <g key={x}>
            <line x1={x} x2={x} y1={wt} y2={wb} stroke={fill} strokeWidth="1.1" />
            <rect x={x - 1.9} y={bt} width="3.8" height={bb - bt} rx="0.7" fill={fill} />
          </g>
        ))}
      </g>
      <polygon points={V.map((q) => q.join(',')).join(' ')} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="0.9" strokeLinejoin="round" />
      <g stroke="#ffffff" strokeLinecap="round" opacity="0.9">
        <line x1="18" y1="8" x2="18" y2="14" strokeWidth="0.9" />
        <line x1="15" y1="11" x2="21" y2="11" strokeWidth="0.9" />
      </g>
    </>
  );
}

// «Т-блок»: объёмная буква T (инициал TraderPro) — как цельный камень с освещением сверху-слева.
function TBlock({ p }) {
  const g = (n) => `url(#${p}${n})`;
  return (
    <>
      <defs>
        <Grad id={`${p}t`} from="#f7f9ff" to="#c3d3fc" x2={1} y2={0} />
        <Grad id={`${p}f`} from="#93acf4" to="#5b7ada" />
        <Grad id={`${p}s`} from="#4a62c4" to="#222f78" />
        <Grad id={`${p}u`} from="#3a50ab" to="#1b2766" />
      </defs>
      <polygon points="33,34 41,27 41,53 33,60" fill={g('u')} {...EDGE} />
      <polygon points="48,22 56,15 56,27 48,34" fill={g('s')} {...EDGE} />
      <polygon points="6,22 14,15 56,15 48,22" fill={g('t')} {...EDGE} />
      <polygon points="6,22 48,22 48,34 33,34 33,60 21,60 21,34 6,34" fill={g('f')} {...EDGE} />
      <line x1="6" y1="22.4" x2="48" y2="22.4" stroke="rgba(255,255,255,0.75)" strokeWidth="0.9" />
    </>
  );
}

// «Курс»: диск компаса и стрелка, которая смотрит вверх-вправо (куда идёт цена).
function Compass({ p }) {
  const g = (n) => `url(#${p}${n})`;
  return (
    <>
      <defs>
        <Grad id={`${p}d`} from="#1d2850" to="#0c1230" />
        <Grad id={`${p}r`} from="#e6ecff" to="#5472d6" x2={1} y2={1} />
        <Grad id={`${p}n1`} from="#ffffff" to="#98b0f4" />
        <Grad id={`${p}n2`} from="#3f55b2" to="#18235d" />
      </defs>
      <circle cx="32" cy="32" r="28.6" fill={g('d')} stroke={g('r')} strokeWidth="2.4" />
      <circle cx="32" cy="32" r="22.5" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.8" />
      <g stroke="rgba(255,255,255,0.4)" strokeWidth="1" strokeLinecap="round">
        <line x1="32" y1="7.2" x2="32" y2="10.6" /><line x1="32" y1="53.4" x2="32" y2="56.8" />
        <line x1="7.2" y1="32" x2="10.6" y2="32" /><line x1="53.4" y1="32" x2="56.8" y2="32" />
      </g>
      <g transform="rotate(45 32 32)">
        <polygon points="32,8.5 39,32 25,32" fill={g('n1')} />
        <polygon points="32,55.5 39,32 25,32" fill={g('n2')} />
      </g>
      <circle cx="32" cy="32" r="2.8" fill="#ffffff" />
      <circle cx="32" cy="32" r="1.1" fill="#24347f" />
    </>
  );
}

const SHAPES = { facet: Facet, window: Window, tblock: TBlock, compass: Compass };

export default function BrandMark({ size = 28, variant }) {
  const [chosen] = useBrandVariant();
  const uid = useId().replace(/:/g, '');
  const v = variant || chosen;
  if (v === 'old') {
    // Прежний знак: белая линия тренда на акцентном квадрате.
    return (
      <span style={{ width: size, height: size, borderRadius: size * 0.28, background: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <BrandIcon size={Math.round(size * 0.6)} />
      </span>
    );
  }
  const Shape = SHAPES[v] || Window;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <Shape p={`bm${uid}`} />
    </svg>
  );
}
