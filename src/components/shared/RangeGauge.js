// src/components/shared/RangeGauge.js
//
// Horizontal gauge with a pointer — for continuous values that got bucketed into a
// label (trend, volatility) but where the trader asked to see *how far* into that
// bucket the value actually sits, not just the label. E.g. volatility can be "выше
// среднего" without being anywhere near maximum — a flat "высокая/низкая" badge hides
// that nuance, a gauge doesn't.
import React from 'react';

// `percent`: 0-100 position of the pointer. `leftLabel`/`midLabel`/`rightLabel`: text
// under the three reference points. `color`: pointer + fill color (caller decides,
// since "high volatility" and "strong uptrend" don't share one color meaning).
export default function RangeGauge({ percent, leftLabel, midLabel, rightLabel, color = 'var(--accent-primary)' }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div style={{minWidth:140}}>
      <div style={{position:'relative', height:6, borderRadius:4, background:'linear-gradient(90deg, var(--bg-surface-3), var(--bg-surface-3))', marginBottom:4}}>
        <div style={{position:'absolute', top:0, left:'50%', width:1, height:6, background:'var(--border-medium)'}} />
        <div style={{
          position:'absolute', top:-3, left:`calc(${clamped}% - 5px)`,
          width:10, height:10, borderRadius:'50%', background:color,
          boxShadow:'0 0 0 2px var(--bg-surface-2)', transition:'left 0.2s',
        }} />
      </div>
      <div style={{display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--text-muted)'}}>
        <span>{leftLabel}</span>
        <span>{midLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}
