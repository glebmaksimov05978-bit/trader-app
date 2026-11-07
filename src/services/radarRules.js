// src/services/radarRules.js
//
// Правила радара без базы и сети — чтобы их можно было проверять тестом.

/**
 * Тот же тикер в радаре той же стратегии — дубль. Радар у каждой стратегии свой: один инструмент можно смотреть по двум
 * стратегиям сразу (реальная жалоба: «у моей стратегии радар пуст, а добавить нельзя — пишет, что тикер уже в радаре»).
 * Запись без стратегии (`strategyId: null`) относится к активной стратегии профиля — так её и показывает приложение.
 */
export function isRadarDuplicate(existing, ticker, strategyId, activeStrategyId = null) {
  const upper = String(ticker || '').toUpperCase();
  const eff = (id) => id || activeStrategyId || null;
  const want = eff(strategyId);
  return (existing || []).some((i) => String(i.ticker || '').toUpperCase() === upper && eff(i.strategyId) === want);
}
