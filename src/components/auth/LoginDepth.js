// src/components/auth/LoginDepth.js
//
// Фон «Стакан»: глубина рынка — накопленные заявки на покупку (зелёная гора слева) и на
// продажу (красная справа) по ступенькам цены. Ступени дышат каждая в своём ритме, от
// середины время от времени поднимаются точки — «сделки». Данные случайные, рисуется на canvas.
import React from 'react';
import useBackdropCanvas from './useBackdropCanvas';
import { makeRng } from './loginBackdropUtils';

const LEVELS = 80;
const MID = 0.62; // где на экране «цена»: правее — продавцы, левее — покупатели

function makeDraw({ ctx, size, colors }) {
  const rnd = makeRng(5150);
  const sides = ['bid', 'ask'].map(() => Array.from({ length: LEVELS }, (_, k) => ({
    base: 0.35 + Math.pow((k + 1) / LEVELS, 1.35) * 1.4,
    speed: 0.0004 + rnd() * 0.0012,
    phase: rnd() * Math.PI * 2,
    depth: 0.12 + rnd() * 0.3,
  })));
  const prints = [];
  let spawnT = 0;

  const profile = (arr, now) => {
    let sum = 0;
    return arr.map((l) => {
      sum += l.base * (1 + Math.sin(now * l.speed + l.phase) * l.depth);
      return sum;
    });
  };

  return (dt, now, reduced) => {
    const { w, h } = size();
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const mid = w * MID;
    const bottom = h * 0.96;
    const maxH = h * 0.78;
    const bid = profile(sides[0], now);
    const ask = profile(sides[1], now);
    const norm = Math.max(bid[LEVELS - 1], ask[LEVELS - 1]);
    const bidStep = mid / LEVELS;
    const askStep = (w - mid) / LEVELS;
    const hy = (v) => bottom - (v / norm) * maxH;

    // Сетка
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 5; i++) {
      const gy = bottom - (maxH * i) / 5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    const drawSide = (arr, dir, step, color) => {
      const path = new Path2D();
      path.moveTo(mid, bottom);
      let px = mid;
      let py = bottom;
      for (let k = 0; k < LEVELS; k++) {
        const nx = mid + dir * (k + 1) * step;
        const ny = hy(arr[k]);
        path.lineTo(px, ny);
        path.lineTo(nx, ny);
        px = nx; py = ny;
      }
      const stroke = new Path2D(path);
      path.lineTo(px, bottom);
      path.closePath();
      const g = ctx.createLinearGradient(0, bottom - maxH, 0, bottom);
      g.addColorStop(0, color);
      g.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = g;
      ctx.fill(path);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'miter';
      ctx.stroke(stroke);
      return py;
    };
    drawSide(bid, -1, bidStep, colors.green);
    drawSide(ask, 1, askStep, colors.red);

    // Линия цены
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = colors.accent;
    ctx.setLineDash([3, 7]);
    ctx.beginPath(); ctx.moveTo(mid, h * 0.1); ctx.lineTo(mid, bottom); ctx.stroke();
    ctx.setLineDash([]);

    // «Сделки»: точки поднимаются от середины и гаснут
    spawnT += dt;
    if (!reduced && spawnT > 260) {
      spawnT = 0;
      const buy = rnd() > 0.5;
      prints.push({ x: mid + (rnd() - 0.5) * 70, y: bottom - rnd() * maxH * 0.25, life: 0, buy, r: 2 + rnd() * 2.5 });
    }
    for (let i = prints.length - 1; i >= 0; i--) {
      const p = prints[i];
      p.life += dt;
      p.y -= dt * 0.03;
      const a = 1 - p.life / 2600;
      if (a <= 0) { prints.splice(i, 1); continue; }
      ctx.globalAlpha = a * 0.8;
      ctx.fillStyle = p.buy ? colors.green : colors.red;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
}

export default function DepthChart() {
  const ref = useBackdropCanvas(makeDraw);
  return <canvas ref={ref} className="login-canvas dim-left" />;
}
