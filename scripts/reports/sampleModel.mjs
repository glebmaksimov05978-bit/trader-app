// scripts/reports/sampleModel.mjs — примерные сделки и модель отчёта для проверки оформления (без базы и сети).
import { resolvePeriod, buildExportReport, SECTIONS } from '../../src/services/report/exportReport.js';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function sampleTrades({ seed = 7, n = 64, year = 2026, month = 9 } = {}) {
  const r = rng(seed);
  const tickers = ['SBER', 'GAZP', 'LKOH', 'GMKN', 'MGNT', 'SiZ6', 'BRX6', 'NLMK'];
  const strategies = ['Пробой уровня', 'Отскок от EMA', 'Тренд H1', 'Вручную'];
  const real = [], paper = [];
  for (let i = 0; i < n; i++) {
    const day = 1 + Math.floor(r() * 30);
    const hour = 10 + Math.floor(r() * 8);
    const win = r() < 0.55;
    const base = 800 + r() * 2600;
    const pnl = Math.round(win ? base * (0.8 + r()) : -base * (0.6 + r() * 0.8));
    const t = {
      status: 'closed', pnl, ticker: tickers[Math.floor(r() * tickers.length)], direction: r() < 0.65 ? 'long' : 'short',
      entryStrategyName: strategies[Math.floor(r() * strategies.length)],
      closedAt: new Date(Date.UTC(year, month, day, hour - 3, 20)).toISOString(),
    };
    (i % 5 === 0 ? paper : real).push(t);
  }
  // немного данных предыдущего месяца — чтобы было сравнение
  for (let i = 0; i < 40; i++) {
    const day = 1 + Math.floor(r() * 28);
    const win = r() < 0.5;
    const base = 700 + r() * 2200;
    real.push({ status: 'closed', pnl: Math.round(win ? base : -base * 0.9), ticker: tickers[Math.floor(r() * tickers.length)], direction: 'long', entryStrategyName: strategies[Math.floor(r() * strategies.length)], closedAt: new Date(Date.UTC(year, month - 1, day, 9, 0)).toISOString() });
  }
  return { real, paper };
}

export function sampleReport({ preset = 'last_month', now = Date.UTC(2026, 10, 5, 12, 0), sections = SECTIONS.map((s) => s.id), scope = 'real', strategyNames = [], withHabits = true } = {}) {
  const { real, paper } = sampleTrades();
  const habitsFn = () => ({
    triggered: [
      { title: 'Отыгрываетесь сразу после убытка', costRub: 14200, confidence: 'confirmed', sampleSize: 38, detail: 'После убытка вы открываете следующую сделку в течение 15 минут в 41% случаев; такие сделки закрываются в минус чаще обычных (63% против 44%).' },
      { title: 'Убыточные позиции держите дольше прибыльных', costRub: 6800, confidence: 'hypothesis', sampleSize: 18, detail: 'Среднее удержание убыточной сделки — 3,1 дня, прибыльной — 1,4 дня.' },
    ],
  });
  const period = resolvePeriod({ preset, now });
  return buildExportReport({ realTrades: real, paperTrades: paper, scope, strategyNames, period, sections, habitsFn: withHabits ? habitsFn : null, userName: 'Глеб', now });
}
