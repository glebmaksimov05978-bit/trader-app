// src/components/auth/useBackdropCanvas.js
//
// Общая обвязка для фонов, рисуемых на canvas: размер с учётом плотности пикселей, цвета темы
// (перечитываются раз в секунду — тема переключается на лету), цикл анимации, остановка при
// уходе со страницы и один статичный кадр, если в системе включено «меньше движения».
import { useEffect, useRef } from 'react';

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    green: g('--green', '#3fb28a'),
    red: g('--red', '#dc6a66'),
    accent: g('--accent-primary', '#6485d8'),
    text: g('--text-secondary', '#a0a9b8'),
    muted: g('--text-muted', '#7a8494'),
    light: document.documentElement.getAttribute('data-theme') === 'light',
  };
}

// makeDraw({ ctx, size, colors }) вызывается один раз и возвращает функцию кадра draw(dt, now, reduced).
export default function useBackdropCanvas(makeDraw) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const state = { w: 0, h: 0 };
    const colors = readColors();
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      state.w = canvas.clientWidth;
      state.h = canvas.clientHeight;
      canvas.width = Math.round(state.w * dpr);
      canvas.height = Math.round(state.h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const draw = makeDraw({ ctx, size: () => state, colors });
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let last = performance.now();
    let colorTimer = 0;
    const frame = (now) => {
      const dt = Math.min(64, now - last);
      last = now;
      colorTimer += dt;
      if (colorTimer > 1000) { Object.assign(colors, readColors()); colorTimer = 0; }
      draw(dt, now, false);
      raf = requestAnimationFrame(frame);
    };
    if (reduced) {
      for (let i = 0; i < 60; i++) draw(50, i * 50, true);
    } else {
      raf = requestAnimationFrame(frame);
    }
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [makeDraw]);
  return ref;
}
