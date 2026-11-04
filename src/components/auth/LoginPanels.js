// src/components/auth/LoginPanels.js
//
// Фон «Панели»: два графика по бокам стоят под углом (как экраны в перспективе), середина
// чистая — там форма. Свечи, две скользящие средние, объёмы и пометки входов нарисованы
// кодом из цветов темы, поэтому работают и в светлой, и в тёмной теме. Цен на картинке нет.
import React from 'react';
import { candleSeries, sma } from './loginBackdropUtils';

const W = 800;
const H = 520;
const N = 44;
const STEP = 17.5;
const TOP = 40;
const BASE = 400;

const COLUMNS = {
  left: [
    { seed: 41, label: 'SBER · H1', tags: [[9, 'buy'], [21, 'sell'], [33, 'buy']] },
    { seed: 43, label: 'GAZP · D1', tags: [[14, 'buy'], [29, 'sell']] },
  ],
  right: [
    { seed: 77, label: 'Si · M15', tags: [[12, 'sell'], [26, 'buy'], [38, 'buy']] },
    { seed: 79, label: 'BR · H1', tags: [[10, 'buy'], [31, 'sell']] },
  ],
};

function Panel({ cfg }) {
  const data = candleSeries(N, cfg.seed, { drift: 0.05 });
  const y = (v) => BASE - v * (BASE - TOP);
  const x = (i) => 28 + i * STEP;
  const closes = data.map((c) => c.c);
  const line = (arr) => arr.map((v, i) => `${x(i) + 4},${y(v).toFixed(1)}`).join(' ');
  return (
    <div className="lp-panel">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%">
        <g className="lp-grid">
          {[0, 1, 2, 3, 4, 5].map((i) => <line key={`h${i}`} x1="0" x2={W} y1={TOP + i * 72} y2={TOP + i * 72} />)}
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => <line key={`v${i}`} y1="0" y2={H} x1={i * 88} x2={i * 88} />)}
        </g>
        <text className="lp-label" x="28" y="26">{cfg.label}</text>
        {data.map((c, i) => {
          const up = c.c >= c.o;
          const top = y(Math.max(c.o, c.c));
          const bodyH = Math.max(2, Math.abs(y(c.o) - y(c.c)));
          const vol = 10 + ((i * 37) % 29) * 2.4;
          return (
            <g key={i} className={`lp-candle ${up ? 'up' : 'down'}`} style={{ animationDelay: `${i * 22}ms` }}>
              <line x1={x(i) + 4} x2={x(i) + 4} y1={y(c.h)} y2={y(c.l)} />
              <rect x={x(i)} y={top} width="8" height={bodyH} />
              <rect className="lp-vol" x={x(i)} y={H - 20 - vol} width="8" height={vol} />
            </g>
          );
        })}
        <polyline className="lp-ma lp-ma-fast" points={line(sma(closes, 7))} fill="none" />
        <polyline className="lp-ma lp-ma-slow" points={line(sma(closes, 20))} fill="none" />
        {cfg.tags.map(([i, kind]) => {
          const buy = kind === 'buy';
          const cy = buy ? y(data[i].l) + 22 : y(data[i].h) - 26;
          return (
            <g key={i} className={`lp-tag ${buy ? 'buy' : 'sell'}`} style={{ animationDelay: `${900 + i * 40}ms` }}>
              <rect x={x(i) - 34} y={cy - 11} width="76" height="22" rx="5" />
              <text x={x(i) + 4} y={cy + 4} textAnchor="middle">{buy ? '▲ ВХОД' : '▼ ВЫХОД'}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function PanelsLayer({ dim = false }) {
  return (
    <div className={`lp-layer ${dim ? 'dim' : ''}`}>
      {['left', 'right'].map((side) => (
        <div key={side} className={`lp-col lp-col-${side}`}>
          {COLUMNS[side].map((cfg) => <Panel key={cfg.label} cfg={cfg} />)}
        </div>
      ))}
    </div>
  );
}
