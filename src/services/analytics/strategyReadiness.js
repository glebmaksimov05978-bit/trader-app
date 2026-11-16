// src/services/analytics/strategyReadiness.js
//
// «Готова ли стратегия к Сопровождению»: чего не хватает, чтобы робот вёл её сигналы и Сопровождение показывало по ней
// готовность к входу, сделки системы и правила ведения позиции. Своя стратегия трейдера должна «вписываться» без
// догадок — поэтому каждый шаг говорит, что именно сделать и где (решение владельца, 2026-11-16).
//
// Шаги (по порядку, как стратегия проходит путь от описания до сигналов):
//   1. горизонт и рабочий таймфрейм — по нему робот берёт свечи;
//   2. условия входа, которые проверяются по графику (свои «ручные» условия робот не проверяет);
//   3. стоп — от него считаются объём и риск;
//   4. выход — цель или следящий выход, иначе сделка висит открытой;
//   5. инструменты в радаре для этой стратегии;
//   6. стратегия «на сопровождении» — робот открывает по ней сделки системы;
//   7. есть сделки системы — значит, всё вместе уже работает.
// Чистая функция.
import { CONDITION_CATALOG } from './strategy.js';
import { isFollowed, TF_INFO } from './strategyMeta.js';

const BY_ID = Object.fromEntries(CONDITION_CATALOG.map((c) => [c.id, c]));

/**
 * @param {object} strategy
 * @param {object} [ctx]
 * @param {Array}  [ctx.radarItems]   записи радара пользователя
 * @param {Array}  [ctx.paperTrades]  сделки системы (все)
 * @param {string} [ctx.activeStrategyId] активная стратегия (записи радара без своей стратегии смотрятся ею)
 * @param {Array}  [ctx.paperStrategyIds] явный список стратегий робота из Настроек (alertPrefs.paperStrategyIds)
 * @returns {{steps: Array<{id, ok, title, detail, action?: {label, to}}>, done: number, total: number, ready: boolean, nextStep: object|null}}
 */
export function strategyReadiness(strategy, ctx = {}) {
  const s = strategy || {};
  const rules = s.exitRules || {};
  const market = (s.conditions || []).filter((c) => c.enabled && BY_ID[c.id] && BY_ID[c.id].category === 'market');
  const plan = (s.conditions || []).filter((c) => c.enabled && BY_ID[c.id] && BY_ID[c.id].category === 'plan');
  const custom = s.customConditions || [];
  const radar = (ctx.radarItems || []).filter((it) => it.strategyId === s.id || (!it.strategyId && ctx.activeStrategyId === s.id));
  const paper = (ctx.paperTrades || []).filter((t) => t.entryStrategyId === s.id);
  const openPaper = paper.filter((t) => t.status === 'open' || t.status === 'partial');
  const robotOn = isFollowed(s) || (ctx.paperStrategyIds || []).includes(s.id);
  const hasStop = rules.stopType && rules.stopType !== 'none';
  // Стоп сознательно выключен, но включён следящий выход с порогом «против позиции» — робот считает объём по этому
  // порогу (так устроены некоторые системы владельца). Это не пробел в настройке.
  const trailInsteadOfStop = !hasStop && !!rules.trailEnabled && rules.trailAdverseEnabled !== false;
  const hasExit = (rules.takeType && rules.takeType !== 'none') || !!rules.trailEnabled || !!rules.maxBars || !!rules.onSignalLoss;
  const tf = TF_INFO[s.timeframe] ? s.timeframe : null;

  const steps = [
    {
      id: 'timeframe', ok: !!(s.horizon && tf),
      title: 'Горизонт и рабочий таймфрейм',
      detail: tf ? `Свечи ${TF_INFO[tf].label}` : 'Не задан — робот не знает, по каким свечам смотреть',
      action: { label: 'Задать', to: '/strategies' },
    },
    {
      id: 'entry', ok: market.length > 0,
      title: 'Условия входа по графику',
      detail: market.length
        ? `${market.length} — робот проверяет их сам${custom.length ? `; ещё ${custom.length} своих — их отмечаете вы` : ''}`
        : custom.length
          ? `Только свои условия (${custom.length}) — робот их не проверяет, сигналов не будет`
          : 'Нет ни одного — сигналов не будет',
      action: { label: 'Добавить условия', to: '/strategies' },
    },
    {
      id: 'stop', ok: !!hasStop || trailInsteadOfStop,
      title: 'Стоп',
      detail: hasStop
        ? ({ pct: `${rules.stopPct ?? '—'}% от входа`, atr: `${rules.stopAtrMult ?? '—'} ATR`, level: 'за уровнем' }[rules.stopType] || 'задан')
        : trailInsteadOfStop
          ? 'Выключен намеренно: объём и риск считаются по порогу следящего выхода'
          : 'Выключен — объём считается приблизительно, риск в рублях не виден',
      action: { label: 'Настроить стоп', to: '/strategies' },
    },
    {
      id: 'exit', ok: !!hasExit,
      title: 'Выход из позиции',
      detail: hasExit
        ? [rules.takeType && rules.takeType !== 'none' ? 'цель' : null, rules.trailEnabled ? 'следящий выход' : null, rules.maxBars ? `не дольше ${rules.maxBars} свечей` : null, rules.onSignalLoss ? 'по пропаже сигнала' : null].filter(Boolean).join(', ')
        : 'Нет ни цели, ни следящего выхода — сделка будет висеть открытой',
      action: { label: 'Настроить выход', to: '/strategies' },
    },
    {
      id: 'radar', ok: radar.length > 0,
      title: 'Инструменты в радаре',
      detail: radar.length ? `${radar.length} — робот смотрит их` : 'Пусто — роботу нечего проверять',
      action: { label: 'Добавить в радар', to: '/journal?view=radar' },
    },
    {
      id: 'robot', ok: robotOn,
      title: 'На сопровождении',
      detail: robotOn ? 'Робот открывает по ней сделки системы и присылает сигналы' : 'Выключено — сигналов и сделок системы не будет',
      action: { label: 'Включить', to: '/strategies' },
    },
    {
      id: 'working', ok: paper.length > 0,
      title: 'Работает',
      detail: paper.length ? `Сделок системы: ${paper.length}${openPaper.length ? `, открыто ${openPaper.length}` : ''}` : 'Сделок системы пока не было — ждём первого сигнала',
      action: null,
    },
  ];
  // Последний шаг — следствие остальных, в «чего не хватает» он не попадает.
  const required = steps.slice(0, 6);
  const done = required.filter((x) => x.ok).length;
  return {
    steps,
    done,
    total: required.length,
    ready: done === required.length,
    nextStep: required.find((x) => !x.ok) || null,
    planConditions: plan.length,
  };
}
