// src/services/import/varMargin.js
//
// Сверка результата фьючерсных сделок с вариационной маржой брокера.
//
// Приложение считает результат фьючерса как «ход цены × стоимость пункта». Биржа считает иначе: каждый день на клиринге
// начисляет или списывает вариационную маржу. Итог за сделку совпадает с «ходом цены» только у обычных рублёвых
// контрактов. Расходится в двух случаях:
//   • вечные фьючерсы (IMOEXF, USDRUBF, …) — в маржу каждый день входит фандинг, которого в ценах сделок нет
//     (на дивидендном разрыве это тысячи рублей на позицию);
//   • контракты с ценой в долларах (нефть, газ, золото, RTS) — стоимость шага в рублях биржа меняет каждый клиринг.
// В отчёте брокера (раздел 3.3) вариационная маржа дана по каждому контракту за каждый день — это и есть настоящие
// деньги. Здесь разница между ней и «ходом цены» находится и добавляется к результату сделок как «поправка брокера».
//
// Что точно, а что нет (ничего не угадываем молча):
//   • «Связка» — подряд идущие дни по одному контракту, от нулевой позиции до нулевой. Сумма результатов сделок связки
//     после поправки равна марже брокера за эти дни до копейки.
//   • Если в связке одна сделка — её результат точный. Если несколько (закрыл шорт и в тот же день открыл лонг) —
//     поправка делится между ними по «контракто-ночам» (сколько контрактов сколько ночей держали), у сделок внутри дня —
//     по размеру хода. Такое деление приблизительное и помечается brokerVmShared.
//   • Связки, где позиция пришла из прошлого отчёта или ушла в следующий, не трогаются (нечем проверить).
//
// Модуль чистый: без сети и базы.

const r2 = (v) => (Math.round(v * 100) / 100) || 0; // «|| 0» убирает минус у нуля
const MSK = 3 * 3600 * 1000;
// Вечерняя сессия срочного рынка (с 19:05 мск) относится уже к следующему торговому дню.
const EVENING_FROM_MIN = 18 * 60 + 50;

/** Календарный день «сессии» ноги в мск: сделки вечерней сессии — следующим днём. Строка 'YYYY-MM-DD'. */
export function sessionDay(timestampUtc) {
  const t = new Date(timestampUtc).getTime();
  if (!Number.isFinite(t)) return null;
  const msk = new Date(t + MSK);
  const minutes = msk.getUTCHours() * 60 + msk.getUTCMinutes();
  const day = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + (minutes >= EVENING_FROM_MIN ? 1 : 0)));
  return day.toISOString().slice(0, 10);
}

/** Связки дней по одному контракту: от нулевой позиции до нулевой. */
export function vmClusters(rows) {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const clusters = [];
  let cur = null;
  for (const row of sorted) {
    if (!cur) cur = { rows: [], complete: row.posStart === 0 };
    cur.rows.push(row);
    if (row.posEnd === 0) { clusters.push(cur); cur = null; }
  }
  if (cur) { cur.complete = false; clusters.push(cur); }
  return clusters.map((c) => ({
    ...c, from: c.rows[0].date, to: c.rows[c.rows.length - 1].date,
    total: r2(c.rows.reduce((s, r) => s + r.amount, 0)),
  }));
}

// Строка маржи, к которой относится нога. Отчёты датируют строки по-разному: в 2025 году — днём торгов, в 2026-м —
// следующим рабочим днём («дата расчёта»). Поэтому есть сдвиг lag: 0 — первая строка с датой не раньше дня сессии,
// 1 — строго позже. Выходные и праздники биржа относит к следующему клирингу — это покрывает поиск «первой строки».
function tradingDay(leg, dates, lag) {
  const day = sessionDay(leg.timestampUtc);
  if (!day) return null;
  return dates.find((d) => (lag ? d > day : d >= day)) || null;
}

// Какой сдвиг дат у этого отчёта: тот, при котором позиция на конец дня, собранная из сделок, чаще совпадает с
// позицией из отчёта брокера. Ничего не угадываем: если не совпало ни разу ни так, ни так — вернётся null.
function detectLag(rows, dates, trades) {
  let best = null;
  for (const lag of [0, 1]) {
    const change = new Map();
    for (const t of trades) {
      const sign = t.direction === 'long' ? 1 : -1;
      for (const l of t.legs) {
        const d = tradingDay(l, dates, lag);
        if (d) change.set(d, (change.get(d) || 0) + sign * (l.type === 'open' ? 1 : -1) * (Number(l.quantity) || 0));
      }
    }
    const hits = rows.filter((r) => r.posStart + (change.get(r.date) || 0) === r.posEnd && change.has(r.date)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { lag, hits };
  }
  return best ? best.lag : null;
}

// Сколько «контракто-ночей» у сделки внутри связки: объём в рынке на конец каждого торгового дня, кроме последнего.
function contractNights(trade, legDays, clusterDates) {
  let nights = 0;
  for (const d of clusterDates.slice(0, -1)) {
    let held = 0;
    trade.legs.forEach((l, i) => {
      if (legDays[i] && legDays[i] <= d) held += (l.type === 'open' ? 1 : -1) * (Number(l.quantity) || 0);
    });
    nights += Math.max(0, held);
  }
  return nights;
}

/**
 * @param {Array} trades   позиции после enrichPnl (фьючерсные: pnl в рублях, pnlPoints, legs, commission, …)
 * @param {Array<{date:string, code:string, posStart:number, posEnd:number, amount:number}>} vmRows  раздел 3.3 отчёта
 * @param {(trade)=>number|null} rubPerPointOf  рубли за пункт, которыми считался pnl сделки (чтобы восстановить «ход»)
 * @returns {{trades:Array, report:Array}} те же сделки (фьючерсы связок — с поправкой) и отчёт по связкам
 */
export function applyBrokerVarMargin(trades, vmRows, rubPerPointOf) {
  const report = [];
  if (!Array.isArray(vmRows) || !vmRows.length) return { trades, report };
  const byCode = new Map();
  for (const r of vmRows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  const patch = new Map(); // индекс сделки → { adjustment, shared }

  for (const [code, rows] of byCode) {
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const mine = trades.map((t, i) => ({ t, i })).filter(({ t }) => t.isFuture && t.ticker === code && Array.isArray(t.legs));
    const lag = detectLag(rows, dates, mine.map((x) => x.t));
    if (lag == null) {
      if (mine.length) report.push({ code, from: dates[0], to: dates[dates.length - 1], brokerVm: r2(rows.reduce((s2, r) => s2 + r.amount, 0)), trades: mine.length, applied: false, reason: 'позиции из сделок не совпали с позициями в отчёте брокера' });
      continue;
    }
    for (const cluster of vmClusters(rows)) {
      const cDates = cluster.rows.map((r) => r.date);
      const inCluster = [];
      let clean = cluster.complete;
      let why = cluster.complete ? '' : 'позиция пришла из прошлого периода или не закрыта к концу отчёта';
      for (const { t, i } of mine) {
        const legDays = t.legs.map((l) => tradingDay(l, dates, lag));
        const touches = legDays.some((d) => d && d >= cluster.from && d <= cluster.to);
        if (!touches) continue;
        const whole = legDays.every((d) => d && d >= cluster.from && d <= cluster.to);
        const gross = rubPerPointOf(t);
        if (!whole || t.status !== 'closed' || t.existingTradeId) {
          clean = false;
          why = why || (!whole || t.existingTradeId ? 'часть операций сделки вне этого отчёта' : 'сделка закрыта не полностью');
        }
        inCluster.push({ t, i, legDays, known: gross > 0, grossRub: gross > 0 ? (Number(t.pnlPoints) || 0) * gross : 0 });
      }
      const entry = { code, from: cluster.from, to: cluster.to, brokerVm: cluster.total, trades: inCluster.length };
      if (!inCluster.length) {
        // Маржа есть, а сделок по контракту в отчёте нет — показать, но трогать нечего.
        report.push({ ...entry, applied: false, reason: Math.abs(cluster.total) > 0.005 ? 'в отчёте нет сделок по этому контракту за эти дни' : '' });
        continue;
      }
      // Стоимость пункта неизвестна (нет токена, биржа недоступна). Если сделка в связке одна, она и не нужна:
      // результат = маржа брокера − комиссия. Если сделок несколько — делить нечем, связка остаётся несверенной.
      if (clean && inCluster.some((x) => !x.known)) {
        if (inCluster.length === 1) {
          patch.set(inCluster[0].i, { fromVm: cluster.total });
          report.push({ ...entry, applied: true, byPrices: null, residual: 0, shared: false, fromVm: true });
        } else {
          report.push({ ...entry, applied: false, reason: 'неизвестна стоимость пункта, а сделок в эти дни несколько' });
        }
        continue;
      }
      const grossSum = inCluster.reduce((s, x) => s + x.grossRub, 0);
      const residual = r2(cluster.total - grossSum);
      if (!clean) { report.push({ ...entry, applied: false, byPrices: r2(grossSum), residual, reason: why }); continue; }

      // Делим поправку: по контракто-ночам, а если ночей нет (всё внутри дня) — по размеру хода.
      let weights = inCluster.map((x) => contractNights(x.t, x.legDays, cDates));
      if (!(weights.reduce((s, w) => s + w, 0) > 0)) weights = inCluster.map((x) => Math.abs(x.grossRub));
      if (!(weights.reduce((s, w) => s + w, 0) > 0)) weights = inCluster.map((_, k) => (k === inCluster.length - 1 ? 1 : 0));
      const wSum = weights.reduce((s, w) => s + w, 0);
      const parts = weights.map((w) => r2(residual * (w / wSum)));
      // Копейки округления — самой «тяжёлой» сделке, чтобы сумма по связке сошлась с брокером точно.
      const drift = r2(residual - parts.reduce((s, p) => s + p, 0));
      if (drift) parts[weights.indexOf(Math.max(...weights))] = r2(parts[weights.indexOf(Math.max(...weights))] + drift);
      // «Поделено приблизительно» — только когда было что делить: поправка не нулевая и сделок в связке больше одной.
      const shared = inCluster.length > 1 && residual !== 0;
      inCluster.forEach((x, k) => patch.set(x.i, { adjustment: parts[k], shared }));
      report.push({ ...entry, applied: true, byPrices: r2(grossSum), residual, shared });
    }
  }

  const out = trades.map((t, i) => {
    const p = patch.get(i);
    if (!p) return t;
    if (p.fromVm != null) {
      return {
        ...t, pnl: r2(p.fromVm - (Number(t.commission) || 0)), pnlNeedsSpecs: false,
        brokerAdjustment: 0, brokerVmChecked: true, brokerVmShared: false,
      };
    }
    return {
      ...t,
      pnl: t.pnl != null ? r2(t.pnl + p.adjustment) : t.pnl,
      brokerAdjustment: p.adjustment,
      brokerVmChecked: true,
      brokerVmShared: p.shared,
    };
  });
  return { trades: out, report };
}
