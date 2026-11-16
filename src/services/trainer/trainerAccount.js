// src/services/trainer/trainerAccount.js
//
// Учебный счёт Тренажёра: стартовый капитал, риск на сделку в % от ТЕКУЩЕГО баланса и баланс в рублях после каждой
// закрытой учебной сделки. Раньше у тренажёра был только «риск 1000 ₽» на каждую сделку — без счёта нельзя было
// почувствовать главное: как просадка съедает баланс и как процент риска меняет размер позиции.
//
// Деньги учебные: результат сделки — её R × риск в рублях на момент входа (pnlVirtual из trainerSim.js), комиссия уже
// внутри R. В реальные деньги, Журнал и отчёты это не попадает.
//
// Порядок сделок на счёте — по моменту, когда сделка доиграна у вас: у переигровки истории это время сохранения
// (рыночные даты там из прошлого), у живых цен — время выхода. Чистые функции.

export const DEFAULT_TRAINER_ACCOUNT = { startCapital: 100000, riskPct: 1, startedAt: null };

const ms = (v) => {
  if (!v) return NaN;
  if (v.seconds != null) return v.seconds * 1000;
  if (v.toDate) return v.toDate().getTime();
  return new Date(v).getTime();
};

/** Настройки счёта из профиля (с подстановкой значений по умолчанию). */
export function getTrainerAccount(profile) {
  const a = profile?.trainerAccount || {};
  const start = Number(a.startCapital);
  const risk = Number(a.riskPct);
  return {
    startCapital: start > 0 ? start : DEFAULT_TRAINER_ACCOUNT.startCapital,
    riskPct: risk > 0 && risk <= 100 ? risk : DEFAULT_TRAINER_ACCOUNT.riskPct,
    startedAt: a.startedAt || null,
  };
}

/** Когда сделка «доиграна» — для порядка на счёте. */
export function doneAt(t) {
  if (t?.dataMode === 'live') return ms(t.exitDate) || ms(t.updatedAt) || ms(t.createdAt);
  return ms(t?.createdAt) || ms(t?.updatedAt) || ms(t?.exitDate);
}

/**
 * @param {Array} trades учебные сделки (trainerTrades)
 * @param {{startCapital:number, riskPct:number, startedAt?:string|null}} account
 */
export function accountState(trades, account) {
  const acc = { ...DEFAULT_TRAINER_ACCOUNT, ...(account || {}) };
  const from = acc.startedAt ? ms(acc.startedAt) : null;
  const closed = (trades || [])
    // Пробные сделки по сигналам системы («Вошёл пробно» в Сопровождении) — про связку «вы + робот», не про учебный счёт.
    .filter((t) => t && !t.fromSignal && t.status === 'closed' && Number.isFinite(Number(t.pnlVirtual)))
    .map((t) => ({ t, at: doneAt(t) }))
    .filter((x) => Number.isFinite(x.at) && (from == null || x.at >= from))
    .sort((a, b) => a.at - b.at);
  let balance = acc.startCapital;
  let peak = balance;
  let maxDd = 0;
  let maxDdPct = 0;
  let wins = 0;
  const curve = [{ at: from, balance }];
  for (const { t, at } of closed) {
    const pnl = Math.round(Number(t.pnlVirtual) * 100) / 100;
    balance = Math.round((balance + pnl) * 100) / 100;
    if (pnl > 0) wins += 1;
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0 ? (dd / peak) * 100 : 0; }
    curve.push({ at, balance, ticker: t.ticker, pnl });
  }
  const pnl = balance - acc.startCapital;
  return {
    startCapital: acc.startCapital,
    riskPct: acc.riskPct,
    balance,
    pnl: Math.round(pnl * 100) / 100,
    returnPct: acc.startCapital > 0 ? (pnl / acc.startCapital) * 100 : 0,
    maxDd: Math.round(maxDd * 100) / 100,
    maxDdPct,
    count: closed.length,
    wins,
    // Риск следующей сделки — от текущего баланса, как на настоящем счёте: в просадке позиция меньше.
    riskNow: Math.max(0, Math.round((balance * acc.riskPct) / 100)),
    curve,
  };
}
