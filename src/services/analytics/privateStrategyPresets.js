// src/services/analytics/privateStrategyPresets.js
//
// Три готовых стратегии — ровно то, что считалось в эталонном дневном прогоне
// (scripts/exportBacktestDataset.mjs, тот самый, что дал матожид +1.26 и лежит в основе
// public/data/backtestSample.json). Условия входа и правила выхода здесь — не
// приблизительная реконструкция, а буквально те же значения, что в скрипте, чтобы
// стратегия в профиле вела себя так же, как на 2502 сделках, которые её проверяли.
//
// НЕ экспортируется в STRATEGY_TEMPLATES (общий список шаблонов для всех аккаунтов) —
// это чужая наработка, которую владелец решил не выкладывать в открытый доступ (см.
// память project-private-strategy-boundary). Кнопка загрузки этих пресетов в Capital.js
// показывается только для TRUSTED_UIDS; дальше трейдер сохраняет стратегию сам обычной
// кнопкой «Сохранить стратегии» — файл ничего не пишет в профиль напрямую.
import { DEFAULT_PROFIT_CAPTURE_SCORE_THRESHOLD } from './exitRules';

// Общие для всех трёх — профит-/лосс-система, откалиброванная в этой сессии. Именно
// её нельзя собрать через чекбоксы конструктора (там нет тумблера лосс-системы и её
// порогов по количеству фиксаций) — отсюда и жалоба «конструктор не может».
const PRIVATE_EXIT_RULES = {
  stopType: 'none', takeType: 'none', onSignalLoss: false, maxBars: null,
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0,
  trailAdverseEnabled: true, trailAdverseMult: 2,
  profitCaptureEnabled: true, profitCaptureThreshold: DEFAULT_PROFIT_CAPTURE_SCORE_THRESHOLD,
  trailLossRule: 'score', lossScoreMode: 'nearBottom', lossScoreThreshold: 2,
  profitCutByScore: { 4: 0.25, 5: 0.34, 6: 0.5, 7: 1, 8: 1 }, profitCutMaxTimes: 4,
  lossCutByScore: { 2: 0.34, 3: 0.5, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }, lossCutMaxTimes: 3,
  peakConfirmCloseFraction: 0.5,
};

// Импульс за 3 бара > 1% в сторону сделки — тот самый входной фильтр (`momFilter` в
// скрипте), просто выраженный уже существующим условием конструктора вместо отдельного
// кода. Direction 'both': сам расчёт условия учитывает знак по стороне сделки.
const MOMENTUM = { id: 'momentum_favor', enabled: true, param: 1, direction: 'both' };
const RISK = [
  { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
  { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
];

export const PRIVATE_STRATEGY_PRESETS = [
  {
    id: 'private_patterns_levels',
    name: 'Фигуры+уровень (эталон)',
    readinessThreshold: 100, // все включённые рыночные условия — одновременно, как в прогоне
    customConditions: [],
    conditions: [
      { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
      { id: 'near_support', enabled: true, param: 1, direction: 'long' },
      { id: 'near_resistance', enabled: true, param: 1, direction: 'short' },
      MOMENTUM, ...RISK,
    ],
    exitRules: PRIVATE_EXIT_RULES,
  },
  {
    id: 'private_rsi_bollinger',
    name: 'RSI+Боллинджер (эталон)',
    readinessThreshold: 100,
    customConditions: [],
    conditions: [
      { id: 'rsi_below', enabled: true, param: 35, direction: 'long' },
      { id: 'rsi_above', enabled: true, param: 65, direction: 'short' },
      { id: 'bollinger_lower', enabled: true, param: null, direction: 'long' },
      { id: 'bollinger_upper', enabled: true, param: null, direction: 'short' },
      MOMENTUM, ...RISK,
    ],
    exitRules: PRIVATE_EXIT_RULES,
  },
  {
    id: 'private_ema_macd',
    name: 'EMA200+MACD (эталон)',
    readinessThreshold: 100,
    customConditions: [],
    conditions: [
      { id: 'price_above_ema200', enabled: true, param: null, direction: 'long' },
      { id: 'price_below_ema200', enabled: true, param: null, direction: 'short' },
      { id: 'macd_positive', enabled: true, param: null, direction: 'long' },
      { id: 'macd_negative', enabled: true, param: null, direction: 'short' },
      MOMENTUM, ...RISK,
    ],
    exitRules: PRIVATE_EXIT_RULES,
  },
];
