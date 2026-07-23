// src/components/backtest/EquityCurve.js
//
// Simple inline-SVG line — no need for a full Lightweight Charts instance for a curve
// this small (a handful to a few hundred points), and the page already has one heavy
// candle chart on it. `points` are cumulative % return values (100 = start, compounding
// each trade's % onto the running total) — see Backtest.js for how they're built.
import React from 'react';

export default function EquityCurve({ points, height = 140 }) {
  if (!points?.length) return null;
  const width = 760;
  const pad = 8;
  const ys = points.map((p) => p.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const range = maxY - minY || 1;
  const toX = (i) => pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
  const toY = (y) => height - pad - ((y - minY) / range) * (height - pad * 2);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.y).toFixed(1)}`).join(' ');
  const areaPath = `${path} L${toX(points.length - 1).toFixed(1)},${height - pad} L${toX(0).toFixed(1)},${height - pad} Z`;
  const up = points[points.length - 1].y >= points[0].y;
  const color = up ? 'var(--green)' : 'var(--red)';
  const zeroY = minY < 100 && maxY > 100 ? toY(100) : null;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height, display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {zeroY != null && (
        <line x1={pad} y1={zeroY} x2={width - pad} y2={zeroY} stroke="var(--border-subtle)" strokeWidth="1" strokeDasharray="4 4" />
      )}
      <path d={areaPath} fill="url(#equityFill)" stroke="none" />
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}
