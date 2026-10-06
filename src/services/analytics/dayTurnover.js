// src/services/analytics/dayTurnover.js
//
// Оборот по фьючерсам за календарный день и положение на лестнице комиссии тарифа.
//
// Зачем: на «Трейдере» и «Премиуме» комиссия по фьючерсам снижается с ростом оборота ЗА ДЕНЬ
// по всему счёту (commission.js, лестница rates.future). Приложение считало комиссию каждой
// сделки отдельно и всегда брало первую, самую дорогую ступень. Здесь оборот считается по
// журналу, чтобы трейдер видел, на какой ступени он сегодня и сколько осталось до следующей.
//
// Это ОЦЕНКА по записям журнала, а не отчёт брокера: сделки, не внесённые в журнал, сюда не
// попадают; стоимость контракта считается по цене и шагу/стоимости шага, если они известны.
// Чистые функции без зависимостей — чтобы проверяться тестом без Firebase.
import { TARIFFS, DEFAULT_TARIFF } from './commission.js';

const MSK_OFFSET_MS = 3 * 3600 * 1000;
const mskDay = (d) => new Date(d.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v.seconds != null) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Стоимость одной операции в рублях: цена контракта в пунктах → рубли через шаг цены.
function notional(trade, price, qty) {
  const p = Number(price), q = Number(qty);
  if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q <= 0) return 0;
  const step = parseFloat(trade.minStep) || 0;
  const stepAmt = parseFloat(trade.minStepAmount) || 0;
  if (step && stepAmt) return (p / step) * stepAmt * q;
  return p * q * (parseFloat(trade.lot) || 1);
}

/** Операции сделки: ступени (legs), а если их нет (ручная сделка) — вход и выход целиком. */
function operationsOf(t) {
  if (Array.isArray(t.legs) && t.legs.length) {
    return t.legs.map((l) => ({ at: toDate(l.timestampUtc), price: l.price, qty: l.quantity }));
  }
  const ops = [{ at: toDate(t.openedAt || t.openDate || t.date), price: t.entryPrice, qty: t.volume }];
  if (t.status === 'closed' && t.exitPrice != null) {
    ops.push({ at: toDate(t.closedAt || t.closeDate), price: t.exitPrice, qty: t.volume });
  }
  return ops;
}

/** Оборот по фьючерсам за календарный день (по Москве), ₽. */
export function futuresTurnoverRub(trades, now = new Date()) {
  const today = mskDay(now);
  let sum = 0;
  for (const t of trades || []) {
    if ((t.instrumentType || '') !== 'future') continue;
    for (const op of operationsOf(t)) {
      if (op.at && mskDay(op.at) === today) sum += notional(t, op.price, op.qty);
    }
  }
  return Math.round(sum);
}

/**
 * Где трейдер на лестнице комиссии сегодня.
 * @returns {null | { turnover, ratePct, ladder: boolean, nextAtRub, toNextRub, nextRatePct }}
 *   null — у тарифа для фьючерсов нет лестницы по обороту («Инвестор»).
 */
export function turnoverStatus(tariffId, turnoverRub) {
  const tariff = TARIFFS[tariffId] || TARIFFS[DEFAULT_TARIFF];
  const ladder = tariff.rates.future;
  if (!Array.isArray(ladder)) return null;
  const idx = ladder.findIndex((r) => r.uptoRub == null || turnoverRub <= r.uptoRub);
  const i = idx < 0 ? ladder.length - 1 : idx;
  const rung = ladder[i];
  const next = ladder[i + 1] || null;
  return {
    turnover: turnoverRub,
    ratePct: rung.rate * 100,
    nextAtRub: rung.uptoRub,                                   // граница текущей ступени (null — последняя)
    toNextRub: rung.uptoRub != null ? Math.max(0, rung.uptoRub - turnoverRub) : null,
    nextRatePct: next ? next.rate * 100 : null,
  };
}
