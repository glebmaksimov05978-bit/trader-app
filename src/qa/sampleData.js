// Примерные данные для визуальной проверки страниц (src/qa/pages.qa.test.js). Не настоящие сделки.
// Числа подобраны так, чтобы их можно было проверить в уме.
const day = (s) => new Date(s).toISOString();
const now = new Date();
const daysAgo = (n, h = 10) => { const d = new Date(now); d.setDate(d.getDate() - n); d.setHours(h, 0, 0, 0); return d.toISOString(); };

const exitRulesBase = { trailEnabled: true, trailGivebackPct: 50, trailMinPeakAtr: 1, stopMode: 'none', takeMode: 'none' };

export const SAMPLE = {
  profile: {
    displayName: 'QA', depositSize: 100000, depositSetAt: day('2026-09-01T00:00:00Z'),
    maxRiskPerTrade: 1, dailyLossLimit: 3, maxDrawdownStop: 10, maxDailyTrades: 10,
    brokerTariff: undefined, askJournalExtra: false, decisionPrompt: true,
    activeStrategyId: 'A',
    strategies: [
      {
        id: 'A', name: 'Пробой', horizon: 'short', timeframe: 'H1', followed: true, readinessThreshold: 80,
        conditions: [
          { id: 'near_resistance', enabled: true, param: 1, direction: 'long' },
          { id: 'volume_above_avg', enabled: true, param: 1.5, direction: 'both' },
          { id: 'rsi_above', enabled: true, param: 55, direction: 'long' },
        ],
        customConditions: [], exitRules: exitRulesBase,
      },
      {
        id: 'B', name: 'Откат к уровню', horizon: 'medium', timeframe: 'D1', followed: true, observe: true, readinessThreshold: 75,
        conditions: [
          { id: 'near_support', enabled: true, param: 1, direction: 'long' },
          { id: 'rsi_below', enabled: true, param: 35, direction: 'long' },
        ],
        customConditions: [], exitRules: exitRulesBase,
      },
    ],
    alertPrefs: { paperDecisionButtons: true, morningDigest: true, digestHour: 8 },
    taPrefs: { fibonacci: true },
    chartDrawings: {},
  },

  // Реальные сделки. pnl уже с комиссией (как пишет приложение при закрытии).
  trades: [
    { id: 't1', ticker: 'SBER', direction: 'long', status: 'closed', instrumentType: 'stock', entryPrice: 300, exitPrice: 306, stopLoss: 294, volume: 10, remainingVolume: 0, lot: 10, pnl: 570, commission: 30, openedAt: daysAgo(12), date: daysAgo(12).slice(0, 10), closedAt: daysAgo(10), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1' },
    { id: 't2', ticker: 'GAZP', direction: 'short', status: 'closed', instrumentType: 'stock', entryPrice: 150, exitPrice: 153, stopLoss: 154, volume: 20, remainingVolume: 0, lot: 10, pnl: -630, commission: 30, openedAt: daysAgo(9), date: daysAgo(9).slice(0, 10), closedAt: daysAgo(8), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1' },
    { id: 't3', ticker: 'MGNT', direction: 'long', status: 'closed', instrumentType: 'stock', entryPrice: 5000, exitPrice: 5000, volume: 1, remainingVolume: 0, lot: 1, pnl: -1, commission: 1, openedAt: daysAgo(6), date: daysAgo(6).slice(0, 10), closedAt: daysAgo(6, 15) },
    { id: 't4', ticker: 'BRX6', direction: 'short', status: 'closed', instrumentType: 'future', entryPrice: 80, exitPrice: 78, stopLoss: 81, volume: 2, remainingVolume: 0, lot: 1, minStep: 0.01, minStepAmount: 7.5, pnl: 2990, commission: 10, openedAt: daysAgo(5), date: daysAgo(5).slice(0, 10), closedAt: daysAgo(3), entryStrategyId: 'B', entryStrategyName: 'Откат к уровню', entryTimeframe: 'D1' },
    { id: 't5', ticker: 'LKOH', direction: 'long', status: 'partial', instrumentType: 'stock', entryPrice: 7000, stopLoss: 6900, volume: 4, remainingVolume: 2, lot: 1, pnl: 190, commission: 10,
      legs: [{ type: 'open', side: 'buy', price: 7000, quantity: 4, timestampUtc: daysAgo(2) }, { type: 'close', side: 'sell', price: 7100, quantity: 2, timestampUtc: daysAgo(1) }],
      openedAt: daysAgo(2), date: daysAgo(2).slice(0, 10), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1' },
    { id: 't6', ticker: 'VTBR', direction: 'long', status: 'open', instrumentType: 'stock', entryPrice: 70, stopLoss: 68, takeProfit: 76, volume: 100, remainingVolume: 100, lot: 1, pnl: null, openedAt: daysAgo(0, 9), date: daysAgo(0).slice(0, 10), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1' },
  ],

  paper: [
    { id: 'p1', paper: true, ticker: 'ROSN', direction: 'long', status: 'open', instrumentType: 'stock', entryPrice: 540, stopLoss: null, volume: 15, remainingVolume: 15, lot: 1, openedAt: daysAgo(1), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1', entryPassed: 3, entryTotal: 3 },
    { id: 'p2', paper: true, ticker: 'NVTK', direction: 'long', status: 'open', instrumentType: 'stock', entryPrice: 1100, stopLoss: 1060, volume: 5, remainingVolume: 5, lot: 1, openedAt: daysAgo(3), entryStrategyId: 'B', entryStrategyName: 'Откат к уровню', entryTimeframe: 'D1',
      decisions: [{ at: daysAgo(3, 11), action: 'entered', via: 'broker', qty: 5 }] },
    { id: 'p3', paper: true, ticker: 'SBER', direction: 'long', status: 'closed', instrumentType: 'stock', entryPrice: 290, exitPrice: 300, volume: 10, lot: 10, pnl: 990, openedAt: daysAgo(15), closedAt: daysAgo(12), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1', maxFavorablePct: 5,
      decisions: [{ at: daysAgo(15, 11), action: 'entered', via: 'telegram' }] },
    { id: 'p4', paper: true, ticker: 'GAZP', direction: 'long', status: 'closed', instrumentType: 'stock', entryPrice: 160, exitPrice: 156, volume: 10, lot: 10, pnl: -410, openedAt: daysAgo(14), closedAt: daysAgo(11), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1', maxFavorablePct: 1.2,
      decisions: [{ at: daysAgo(14, 11), action: 'skipped', reason: 'Новости', via: 'app' }] },
    { id: 'p5', paper: true, ticker: 'LKOH', direction: 'long', status: 'closed', instrumentType: 'stock', entryPrice: 6800, exitPrice: 7000, volume: 2, lot: 1, pnl: 395, openedAt: daysAgo(13), closedAt: daysAgo(9), entryStrategyId: 'A', entryStrategyName: 'Пробой', entryTimeframe: 'H1', maxFavorablePct: 4 },
    { id: 'p6', paper: true, ticker: 'PLZL', direction: 'long', status: 'closed', instrumentType: 'stock', entryPrice: 12000, exitPrice: 12600, volume: 1, lot: 1, pnl: 590, openedAt: daysAgo(20), closedAt: daysAgo(7), entryStrategyId: 'B', entryStrategyName: 'Откат к уровню', entryTimeframe: 'D1', maxFavorablePct: 7 },
  ],

  radar: [
    { id: 'r1', ticker: 'SBER', instrumentType: 'stock', strategyId: 'A', timeframe: 'H1', robotCheck: { at: daysAgo(0), text: 'условия не сошлись на закрытой свече: лонг 2/3 (67%), шорт 0/3 (0%), нужно 80%' } },
    { id: 'r2', ticker: 'GAZP', instrumentType: 'stock', strategyId: 'B', timeframe: 'D1' },
    { id: 'r3', ticker: 'LKOH', instrumentType: 'stock', strategyId: 'A', timeframe: 'H1' },
    { id: 'r4', ticker: 'BR', instrumentType: 'future', strategyId: 'B', timeframe: 'D1' },
  ],

  // 300 дневных свечей до сегодняшнего дня — спокойный тренд с колебаниями.
  candles() {
    const out = [];
    let p = 280;
    for (let i = 299; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      const o = p;
      const c = o * (1 + Math.sin(i / 7) * 0.006 + 0.0007);
      const h = Math.max(o, c) * 1.006, l = Math.min(o, c) * 0.994;
      out.push({ date: d, open: o, high: h, low: l, close: c, volume: 1e6 + (i % 13) * 1e5 });
      p = c;
    }
    return out;
  },
};
