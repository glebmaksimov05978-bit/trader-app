// src/qa/ChartHarness.js
//
// Тестовая страница ТОЛЬКО для разработки (npm start → /__harness): настоящий CandleChart с рисованием на выдуманных
// свечах, без входа в аккаунт и без базы. Нужна, чтобы проверять поведение графика мышью в настоящем браузере
// (прокрутка, рисование, панель) — в jsdom холста нет. В боевую сборку не попадает (см. src/index.js).
import React, { useMemo, useState } from 'react';
import CandleChart from '../components/shared/CandleChart';
import { AuthProvider } from '../context/AuthContext';
import Trainer from '../components/trainer/Trainer';

function fakeCandles(n = 300, seed = 7) {
  let p = 100; let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i += 1) {
    const o = p;
    const c = o + Math.sin(i / 9) * 2 + (rnd() - 0.5) * 3;
    out.push({ date: new Date(t0 + i * 86400000), open: o, high: Math.max(o, c) + rnd(), low: Math.min(o, c) - rnd(), close: c, volume: 1000 + rnd() * 500 });
    p = c;
  }
  return out;
}

function ChartView() {
  const [theme, setTheme] = useState('dark');
  const [ticker, setTicker] = useState('TEST');
  const candles = useMemo(() => fakeCandles(300, ticker === 'TEST' ? 7 : 11), [ticker]);
  document.documentElement.setAttribute('data-theme', theme);
  return (
    <AuthProvider>
      <div style={{ padding: 16, background: 'var(--bg-primary)', minHeight: '100vh', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button className="btn btn-ghost btn-sm" id="h-theme" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>тема: {theme}</button>
          <button className="btn btn-ghost btn-sm" id="h-ticker" onClick={() => setTicker((t) => (t === 'TEST' ? 'OTHER' : 'TEST'))}>тикер: {ticker}</button>
        </div>
        <div className="card" style={{ padding: 12, maxWidth: 900 }} id="h-chart">
          <CandleChart drawingTools candles={candles} ticker={ticker} timeframe="D1" height={390} />
        </div>
        <div style={{ height: 800 }}>страница ниже графика</div>
      </div>
    </AuthProvider>
  );
}

// ?view=trainer — страница тренажёра целиком (без входа в аккаунт): проверить игру глазами
export default function ChartHarness() {
  if (new URLSearchParams(window.location.search).get('view') === 'trainer') {
    return <AuthProvider><div style={{ background: 'var(--bg-primary)', minHeight: '100vh' }}><Trainer /></div></AuthProvider>;
  }
  return <ChartView />;
}
