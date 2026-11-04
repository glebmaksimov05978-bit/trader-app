// src/components/auth/LoginLive.js
//
// Фон «Живой график»: бесконечно идущий свечной график с двумя скользящими средними, объёмами
// и пульсирующей точкой на текущей цене. Новая свеча рождается справа и «рисуется» на глазах:
// цена внутри неё плавно ходит туда-сюда и приходит к закрытию, а тени (шипы) появляются
// сами из этих колебаний. Весь график плывёт влево. Данные случайные (рынок не показывает).
//
// Цена живёт «режимами»: боковик (топчется на месте — самый частый), небольшой рост или падение
// и редкие короткие всплески. Ход каждой свечи ограничен, а мягкая «резинка» не даёт цене
// уходить далеко — обвалов нет. Масштаб по вертикали расширяется сразу под любую свечу и медленно
// сжимается обратно, поэтому график не вылезает за экран.
import React from 'react';
import useBackdropCanvas from './useBackdropCanvas';
import { makeRng, clamp } from './loginBackdropUtils';

const SLOT = 14;       // ширина слота свечи, px
const PERIOD = 1800;   // сколько мс «рисуется» одна свеча
const BODY = 8;

// drift — смещение цены за свечу (в долях «обычного хода»), vol — размах шума,
// min/max — сколько свечей длится режим, weight — как часто выпадает.
const REGIMES = [
  { name: 'range', drift: 0, vol: 0.55, min: 22, max: 60, weight: 3.2 },
  { name: 'up', drift: 0.15, vol: 0.75, min: 8, max: 22, weight: 1.6 },
  { name: 'down', drift: -0.15, vol: 0.75, min: 8, max: 22, weight: 1.6 },
  { name: 'burst', drift: 0, vol: 1.3, min: 3, max: 6, weight: 0.8 },
];

function makeDraw({ ctx, size, colors }) {
  const rnd = makeRng(8128);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };

  let regime = REGIMES[0];
  let regimeLeft = 30;
  let burstDir = 1;
  const pickRegime = () => {
    const total = REGIMES.reduce((s, r) => s + r.weight, 0);
    let x = rnd() * total;
    for (const r of REGIMES) { x -= r.weight; if (x <= 0) return r; }
    return REGIMES[0];
  };

  // Путь цены внутри свечи: плавный ход от открытия к плану + «мостик» из трёх синусоид
  // (в начале и в конце равен нулю, а посередине даёт колебания туда-сюда и тени).
  const pathAt = (c, t) => {
    const base = c.o + (c.f - c.o) * (t * t * (3 - 2 * t));
    let n = 0;
    for (const k of c.osc) n += k.a * Math.sin(2 * Math.PI * k.fr * t + k.ph);
    return base + c.amp * Math.sin(Math.PI * t) * n;
  };

  const plan = (o) => {
    if (regimeLeft <= 0) {
      regime = pickRegime();
      regimeLeft = Math.round(regime.min + rnd() * (regime.max - regime.min));
      burstDir = rnd() > 0.5 ? 1 : -1;
    }
    regimeLeft -= 1;
    const unit = o * 0.011;
    const heavy = Math.min(2.2, Math.exp(gauss() * 0.4));
    const drift = regime.name === 'burst' ? burstDir * 0.3 : regime.drift;
    // Мягкая «резинка» к исходному уровню: тренды живут, но цена не уходит далеко от центра.
    const pull = -((o - 100) / 100) * 4.5;
    const raw = (drift + pull + gauss() * regime.vol * 0.9) * unit * heavy;
    const step = clamp(raw, -3.2 * unit, 3.2 * unit);
    const amp = (unit * regime.vol * 0.22 + Math.abs(step) * 0.3) * (0.7 + rnd() * 0.6);
    const osc = [
      { a: 1, fr: 0.8 + rnd() * 0.8, ph: rnd() * 6.28 },
      { a: 0.6, fr: 1.8 + rnd() * 1.0, ph: rnd() * 6.28 },
      { a: 0.35, fr: 3.0 + rnd() * 1.2, ph: rnd() * 6.28 },
    ];
    const v = clamp(
      0.16 + 0.55 * Math.min(1, Math.abs(step) / (unit * 2.2)) + (regime.name === 'burst' ? 0.2 : 0) + rnd() * 0.22,
      0.12, 1,
    );
    return { o, f: o + step, amp, osc, v, c: o, h: o, l: o };
  };
  const finalize = (c) => {
    let hi = c.o;
    let lo = c.o;
    for (let i = 0; i <= 48; i++) {
      const p = pathAt(c, i / 48);
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    c.c = c.f;
    c.h = Math.max(hi, c.f);
    c.l = Math.min(lo, c.f);
  };

  const candles = [];
  let price = 100;
  for (let i = 0; i < 160; i++) {
    const c = plan(price);
    finalize(c);
    price = c.c;
    candles.push(c);
  }
  let cur = plan(price);
  candles.push(cur);
  let prog = 0;
  let lo = 95;
  let hi = 105;

  const ema = (len) => {
    const k = 2 / (len + 1);
    let e = candles[0].c;
    return candles.map((c) => { e = c.c * k + e * (1 - k); return e; });
  };

  return (dt, now, reduced) => {
    const { w, h } = size();
    if (!w || !h) return;
    prog += dt / PERIOD;
    if (prog >= 1) {
      finalize(cur);
      price = cur.c;
      prog = 0;
      cur = plan(price);
      candles.push(cur);
      if (candles.length > Math.ceil(w / SLOT) + 6) candles.shift();
    }
    // Растущая свеча: цена идёт по своему пути, тени — это реально достигнутые крайние точки.
    const p = pathAt(cur, prog);
    cur.c = p;
    cur.h = Math.max(cur.h, p);
    cur.l = Math.min(cur.l, p);

    const light = colors.light;
    const top = h * 0.36;
    const bottom = h * 0.84;
    const visible = Math.ceil(w / SLOT) + 2;
    const part = candles.slice(-visible);
    const pMin = Math.min(...part.map((c) => c.l));
    const pMax = Math.max(...part.map((c) => c.h));
    // Расширяемся сразу, сжимаемся медленно — свеча никогда не уходит за край.
    lo = pMin < lo ? pMin : lo + (pMin - lo) * 0.025;
    hi = pMax > hi ? pMax : hi + (pMax - hi) * 0.025;
    const pad = (hi - lo) * 0.1 || 1;
    const y = (v) => bottom - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (bottom - top);
    const xr = w - 70;
    const x = (j) => xr - (candles.length - 1 - j) * SLOT - prog * SLOT;

    ctx.clearRect(0, 0, w, h);

    // Сетка
    ctx.globalAlpha = light ? 0.12 : 0.07;
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
      const gy = top + ((bottom - top) * i) / 6;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // Объёмы
    for (let j = 0; j < candles.length; j++) {
      const c = candles[j];
      const cx = x(j);
      if (cx < -SLOT || cx > w + SLOT) continue;
      ctx.globalAlpha = light ? 0.34 : 0.17;
      ctx.fillStyle = c.c >= c.o ? colors.green : colors.red;
      const vh = c.v * h * 0.14;
      ctx.fillRect(cx - BODY / 2, h * 0.97 - vh, BODY, vh);
    }

    // Свечи: тень рисуется двумя кусками — над телом и под ним, чтобы не просвечивать сквозь него.
    for (let j = 0; j < candles.length; j++) {
      const c = candles[j];
      const cx = x(j);
      if (cx < -SLOT || cx > w + SLOT) continue;
      const col = c.c >= c.o ? colors.green : colors.red;
      const bodyTop = y(Math.max(c.o, c.c));
      const bodyBottom = Math.max(bodyTop + 2, y(Math.min(c.o, c.c)));
      ctx.globalAlpha = light ? 0.92 : 0.6;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, bodyTop);
      ctx.moveTo(cx, bodyBottom); ctx.lineTo(cx, y(c.l));
      ctx.stroke();
      ctx.fillRect(cx - BODY / 2, bodyTop, BODY, bodyBottom - bodyTop);
    }

    // Скользящие средние
    const drawLine = (arr, color, alpha, lw) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (let j = 0; j < arr.length; j++) {
        const cx = x(j);
        if (cx < -SLOT) continue;
        const cy = y(arr[j]);
        if (!started) { ctx.moveTo(cx, cy); started = true; } else ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    };
    drawLine(ema(9), colors.accent, light ? 1 : 0.8, 1.7);
    drawLine(ema(26), colors.text, light ? 0.7 : 0.45, 1.3);

    // Линия текущей цены и пульсирующая точка
    const ly = y(cur.c);
    ctx.globalAlpha = light ? 0.55 : 0.35;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke();
    ctx.setLineDash([]);
    const pulse = reduced ? 0 : (Math.sin(now / 380) + 1) / 2;
    const dx = x(candles.length - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.accent;
    ctx.beginPath(); ctx.arc(dx, ly, 3.6, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = clamp(0.5 - pulse * 0.5, 0, 0.5);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(dx, ly, 5 + pulse * 11, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  };
}

export default function LiveChart() {
  const ref = useBackdropCanvas(makeDraw);
  return <canvas ref={ref} className="login-canvas dim-left" />;
}
