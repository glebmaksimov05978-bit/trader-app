// src/services/analytics/portfolio.js
//
// Портфельный режим: несколько стратегий работают одновременно, у каждой — своя корзина
// капитала.
//
// Зачем корзины, а не один общий депозит. Без них две стратегии в одном счёте неотличимы:
// пробойная унесла 40 тысяч, откатная вернула 45, итог «+5» — и по нему нельзя решить
// ничего. Хуже того, риск «1% от депозита» на самом деле означает разный риск: пока одна
// стратегия в просадке, вторая продолжает считать процент от всего счёта, включая деньги,
// которые уже проиграны первой.
//
// С корзинами каждая стратегия торгует своей долей: риск считается от НЕЁ, результат
// виден отдельно, и появляется главное — можно честно сказать, какая часть счёта работает,
// а какая проедает. Это по-прежнему один брокерский счёт: корзины — управленческий учёт,
// а не отдельные счета у брокера.
//
// Сознательно НЕ делается: автоматическая ребалансировка и автоматический перевод денег
// между корзинами. Приложение показывает расхождение с целевыми долями, решение остаётся
// за трейдером.

/** Пустой портфель — режим выключен. */
export function emptyPortfolio() {
  return { enabled: false, baskets: [] };
}

export function getPortfolio(userProfile) {
  const p = userProfile?.portfolio;
  if (!p || !Array.isArray(p.baskets)) return emptyPortfolio();
  return { enabled: !!p.enabled, baskets: p.baskets.filter((b) => b && b.strategyId) };
}

/**
 * Корзины, приведённые к реальности: выкинуты удалённые стратегии, доли — числа.
 * Доли НЕ нормализуются молча: если они не дают 100%, это должно быть видно трейдеру,
 * а не тихо исправлено (иначе он введёт 50/40 и никогда не узнает, что 10% счёта
 * остались вне обеих стратегий).
 */
export function resolveBaskets(portfolio, strategies) {
  const byId = new Map((strategies || []).map((s) => [s.id, s]));
  return (portfolio?.baskets || [])
    .filter((b) => byId.has(b.strategyId))
    .map((b) => ({
      strategyId: b.strategyId,
      name: byId.get(b.strategyId).name || 'Без названия',
      sharePct: Number(b.sharePct) || 0,
      strategy: byId.get(b.strategyId),
    }));
}

export function totalShare(baskets) {
  return (baskets || []).reduce((s, b) => s + (Number(b.sharePct) || 0), 0);
}

function hasRealizedPnl(t) {
  return (t.status === 'closed' || t.status === 'partial') && t.pnl !== undefined && t.pnl !== null;
}

// Тот же якорь, что у computeLiveBalance: депозит — это «сегодня», и на баланс влияют
// только сделки, закрытые после того, как трейдер последний раз менял цифру депозита.
function isOnOrAfter(trade, anchorMs) {
  if (anchorMs == null) return true;
  const d = trade.date?.seconds ? trade.date.seconds * 1000 : new Date(trade.date).getTime();
  return Number.isFinite(d) && d >= anchorMs;
}

function basketKeyOf(trade, byId, byName) {
  if (trade.entryStrategyId && byId.has(trade.entryStrategyId)) return trade.entryStrategyId;
  if (trade.entryStrategyName && byName.has(trade.entryStrategyName)) return byName.get(trade.entryStrategyName);
  return null;
}

/**
 * Состояние корзин на сейчас.
 *
 * @returns {{
 *   enabled: boolean, deposit: number, balance: number, shareTotal: number,
 *   baskets: Array<{strategyId, name, sharePct, allocated, pnl, balance,
 *                   tradeCount, currentSharePct, driftPct}>,
 *   unassigned: {pnl: number, tradeCount: number},
 * }}
 */
export function computeBaskets({ userProfile, strategies, trades }) {
  const portfolio = getPortfolio(userProfile);
  const baskets = resolveBaskets(portfolio, strategies);
  const deposit = Number(userProfile?.depositSize) || 0;
  const anchorMs = userProfile?.depositSetAt ? new Date(userProfile.depositSetAt).getTime() : null;

  const byId = new Map(baskets.map((b) => [b.strategyId, b]));
  const byName = new Map(baskets.map((b) => [b.name, b.strategyId]));

  const acc = new Map(baskets.map((b) => [b.strategyId, { pnl: 0, tradeCount: 0 }]));
  let unassignedPnl = 0;
  let unassignedCount = 0;

  for (const t of (trades || [])) {
    if (!hasRealizedPnl(t) || !isOnOrAfter(t, anchorMs)) continue;
    const key = basketKeyOf(t, byId, byName);
    if (key) {
      const a = acc.get(key);
      a.pnl += t.pnl;
      a.tradeCount += 1;
    } else {
      // Сделка не отнесена ни к одной корзине: заведена руками, импортирована или
      // открыта по стратегии, которой в портфеле нет. В корзины она не попадает —
      // приписать её удобно и неверно, поэтому она идёт отдельной строкой.
      unassignedPnl += t.pnl;
      unassignedCount += 1;
    }
  }

  const rows = baskets.map((b) => {
    const a = acc.get(b.strategyId) || { pnl: 0, tradeCount: 0 };
    const allocated = deposit * (b.sharePct / 100);
    return {
      strategyId: b.strategyId,
      name: b.name,
      sharePct: b.sharePct,
      allocated,
      pnl: a.pnl,
      balance: allocated + a.pnl,
      tradeCount: a.tradeCount,
    };
  });

  const basketsBalance = rows.reduce((s, r) => s + r.balance, 0);
  for (const r of rows) {
    // Доля считается внутри корзин, а не от всего счёта: нераспределённая часть депозита
    // и результат сделок вне корзин к работе стратегий отношения не имеют.
    r.currentSharePct = basketsBalance > 0 ? (r.balance / basketsBalance) * 100 : 0;
    const targetOfBaskets = totalShare(baskets) > 0 ? (r.sharePct / totalShare(baskets)) * 100 : 0;
    r.driftPct = r.currentSharePct - targetOfBaskets;
  }

  return {
    enabled: portfolio.enabled && rows.length > 0,
    deposit,
    balance: deposit + rows.reduce((s, r) => s + r.pnl, 0) + unassignedPnl,
    shareTotal: totalShare(baskets),
    baskets: rows,
    unassigned: { pnl: unassignedPnl, tradeCount: unassignedCount },
  };
}

/**
 * Капитал, от которого считать риск для конкретной стратегии.
 * Портфельный режим выключен или стратегии нет в портфеле — весь счёт, как раньше.
 * Это единственное место, где режим влияет на РАСЧЁТ, а не на отображение.
 */
export function capitalForStrategy({ strategyId, computed, fallbackBalance }) {
  if (!computed?.enabled || !strategyId) return fallbackBalance;
  const row = computed.baskets.find((b) => b.strategyId === strategyId);
  return row ? row.balance : fallbackBalance;
}
