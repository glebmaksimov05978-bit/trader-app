// src/services/analytics/commission.js
//
// Реальные ставки комиссии Т-Банка по тарифам — вместо 0.0006 (0.06%), которая была
// зашита как заглушка в пяти разных местах приложения (Калькулятор, Журнал, Кабина,
// Бэктест) и не совпадала ни с одним настоящим тарифом брокера. Ставки подтверждены
// перепиской с поддержкой Т-Банка (2026-09), одно место — не пять расходящихся копий.
//
// Всё, что ниже, — ставка ЗА ОДНУ СТОРОНУ сделки (открытие или закрытие). Приложение
// само умножает на 2 там, где считает круг «вход + выход» — так было и раньше, здесь
// это не меняется, чтобы не задвоить комиссию задним числом на уже введённых сделках.
export const TARIFFS = {
  investor: {
    id: 'investor',
    label: 'Инвестор',
    monthlyFee: 0,
    rates: {
      stock: 0.003,       // 0.3% от суммы сделки
      currency: 0.009,    // 0.9% от суммы сделки
      future: 0.001,      // 0.1% от стоимости фьючерсного контракта, фиксированно
    },
  },
  trader: {
    id: 'trader',
    label: 'Трейдер',
    monthlyFee: 390, // бесплатно при остатке от 1 500 000 ₽ или обороте сделок от 5 млн ₽
    freeAboveBalance: 1_500_000,
    freeAbovePeriodTurnover: 5_000_000,
    rates: {
      stock: 0.0005,      // п.1.1 — 0.05% от суммы сделки
      currency: 0.005,    // п.1.3 — 0.5% от суммы сделки
      // п.2.1 — лестница по ОБОРОТУ ЗА КАЛЕНДАРНЫЙ ДЕНЬ (сумме всех фьючерсных сделок
      // за день по всему счёту, а не по одной позиции).
      future: [
        { uptoRub: 5_000_000, rate: 0.00040 },   // 0.040%
        { uptoRub: 10_000_000, rate: 0.0003 },   // 0.03%
        { uptoRub: null, rate: 0.00025 },        // 0.025% — свыше 10 млн ₽/день
      ],
    },
    // п.2.2 — фьючерсы из «Дополнительного списка базовых активов» стоят 0.08% и от
    // оборота НЕ зависят вообще. Какие именно контракты туда входят, знает только сам
    // брокер (список по ссылке в тарифе), поэтому приложение не угадывает — ставка
    // берётся только если вызывающий явно скажет extraList: true.
    futureExtraListRate: 0.0008,
  },
  premium: {
    id: 'premium',
    label: 'Инвестиции Премиум',
    monthlyFee: 2990, // бесплатно при остатке от 3 000 000 ₽
    freeAboveBalance: 3_000_000,
    rates: {
      stock: 0.0004,      // 0.04% от суммы сделки
      currency: 0.004,    // 0.4% от суммы сделки
      future: [
        { uptoRub: 12_000_000, rate: 0.00025 },  // 0.025%
        { uptoRub: 17_000_000, rate: 0.0002 },   // 0.02%
        { uptoRub: null, rate: 0.00015 },        // 0.015% — свыше 17 млн ₽/день
      ],
    },
  },
};

// Ступень лестницы по обороту за день. Оборот неизвестен — берём ПЕРВУЮ ступень, самую
// дорогую: при малом обороте это точное число, при большом реальная комиссия окажется
// ниже. Ошибка в безопасную сторону — трейдер не примет решение на цифре лучше, чем
// будет на самом деле.
function pickRung(ladder, dayTurnoverRub) {
  if (dayTurnoverRub == null) return { rung: ladder[0], exact: false };
  const rung = ladder.find((r) => r.uptoRub == null || dayTurnoverRub <= r.uptoRub);
  return { rung: rung || ladder[ladder.length - 1], exact: true };
}

function fmtRub(v) {
  return `${(v / 1_000_000).toLocaleString('ru-RU')} млн ₽`;
}

export const DEFAULT_TARIFF = 'trader';

/**
 * Ставка комиссии за одну сторону сделки для конкретного тарифа и типа инструмента.
 * Если для тарифа ставка неизвестна (не подтверждена поддержкой), честно откатывается
 * на «Инвестор» — единственный тариф, где сейчас известны все три типа инструментов, —
 * и это отмечается в approx: true, чтобы интерфейс мог сказать об этом трейдеру, а не
 * молча показать число как точное.
 *
 * @param {string} tariffId       - 'investor' | 'trader' | 'premium'
 * @param {string} instrumentType - 'stock' | 'future' | 'currency'
 * @param {object} [opts]
 * @param {number} [opts.dayTurnoverRub] - оборот по фьючерсам за календарный день. Не
 *   задан — берётся первая (самая дорогая) ступень лестницы как оценка сверху.
 * @param {boolean} [opts.extraList] - фьючерс из «Дополнительного списка» брокера: своя
 *   фиксированная ставка, от оборота не зависит.
 * @returns {{ rate: number, approx: boolean, note: string|null, ladder: Array|null }}
 *   approx — ставка НЕ подтверждена тарифом (взята чужая). Неизвестный оборот сюда не
 *   относится: сама ставка там подтверждённая, просто выбрана верхняя ступень.
 */
export function commissionRateFor(tariffId, instrumentType, opts = {}) {
  const { dayTurnoverRub = null, extraList = false } = opts;
  const tariff = TARIFFS[tariffId] || TARIFFS[DEFAULT_TARIFF];

  if (instrumentType === 'future' && extraList && tariff.futureExtraListRate != null) {
    return {
      rate: tariff.futureExtraListRate,
      approx: false,
      note: 'фьючерс из «Дополнительного списка» — ставка фиксированная, от оборота не зависит',
      ladder: null,
    };
  }

  const own = tariff.rates[instrumentType];

  if (Array.isArray(own)) {
    const { rung, exact } = pickRung(own, dayTurnoverRub);
    const note = exact
      ? `по обороту за день${rung.uptoRub == null ? ' свыше ' + fmtRub(own[own.length - 2].uptoRub) : ' до ' + fmtRub(rung.uptoRub)}`
      : `по лестнице оборота, здесь — ставка до ${fmtRub(own[0].uptoRub)}/день; при бОльшем обороте реальная комиссия ниже`;
    return { rate: rung.rate, approx: false, note, ladder: own };
  }

  if (own != null) return { rate: own, approx: false, note: null, ladder: null };

  const fallback = TARIFFS.investor.rates[instrumentType];
  return {
    rate: Array.isArray(fallback) ? fallback[0].rate : (fallback ?? 0.0006),
    approx: true,
    note: `ставка тарифа «${tariff.label}» для этого типа инструмента не подтверждена — взята ставка «Инвестора»`,
    ladder: null,
  };
}

/** Список тарифов для выпадающего списка в Настройках. */
export const TARIFF_OPTIONS = Object.values(TARIFFS).map((t) => ({ id: t.id, label: t.label }));
