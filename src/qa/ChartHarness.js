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

// ?view=marks — метки сделки на графике во всех вариантах: полная история операций, сделка системы (в операциях только
// закрытия), открытый шорт без операций, вход и выход внутри одной свечи.
function MarksView() {
  const candles = useMemo(() => fakeCandles(300, 7), []);
  document.documentElement.setAttribute('data-theme', 'dark');
  const at = (i, h = 10) => new Date(candles[i].date.getTime() + h * 3600000).toISOString();
  const px = (i) => Number(candles[i].close.toFixed(2));
  const cases = [
    { title: 'Реальная: вход, докупка, две фиксации, выход', props: {
      direction: 'long', entryPrice: px(240), exitPrice: px(275),
      legs: [
        { type: 'open', quantity: 10, price: px(240), timestampUtc: at(240) },
        { type: 'open', quantity: 5, price: px(246), timestampUtc: at(246) },
        { type: 'close', quantity: 5, price: px(255), timestampUtc: at(255) },
        { type: 'close', quantity: 5, price: px(263), timestampUtc: at(263) },
        { type: 'close', quantity: 5, price: px(275), timestampUtc: at(275) },
      ] } },
    { title: 'Сделка системы: в операциях только закрытия, сделка ещё открыта', props: {
      direction: 'long', entryPrice: px(262),
      entryMarker: { date: at(262), price: px(262), direction: 'long', quantity: 10 },
      legs: [{ type: 'close', quantity: 4, price: px(280), timestampUtc: at(280) }],
      planLines: { entry: px(262), stop: px(262) - 6, take: px(262) + 14 } } },
    { title: 'Шорт без истории операций, закрыт', props: {
      direction: 'short', entryPrice: px(200), exitPrice: px(215),
      entryMarker: { date: at(200), price: px(200), direction: 'short', quantity: 3 },
      exitMarker: { date: at(215), price: px(215) } } },
    { title: 'Вход и выход внутри одной свечи', props: {
      direction: 'long', entryPrice: px(150), exitPrice: px(150) + 1,
      legs: [
        { type: 'open', quantity: 2, price: px(150), timestampUtc: at(150, 8) },
        { type: 'close', quantity: 2, price: px(150) + 1, timestampUtc: at(150, 14) },
      ] } },
  ];
  return (
    <AuthProvider>
      <div style={{ padding: 16, background: 'var(--bg-primary)', minHeight: '100vh', color: 'var(--text-primary)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {cases.map((c) => (
          <div className="card" style={{ padding: 12 }} key={c.title}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>{c.title}</div>
            <CandleChart candles={candles} ticker="TEST" timeframe="D1" height={300} {...c.props} />
          </div>
        ))}
      </div>
    </AuthProvider>
  );
}

// ?view=trainer — страница тренажёра целиком (без входа в аккаунт): проверить игру глазами
export default function ChartHarness() {
  if (new URLSearchParams(window.location.search).get('view') === 'trainer') {
    return <AuthProvider><div style={{ background: 'var(--bg-primary)', minHeight: '100vh' }}><Trainer /></div></AuthProvider>;
  }
  if (new URLSearchParams(window.location.search).get('view') === 'marks') return <MarksView />;
  return <ChartView />;
}
