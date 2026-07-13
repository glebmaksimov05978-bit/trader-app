// src/services/analytics/insightsEngine.js
//
// Deterministic "conclusions engine" (7.1) + tier-1 habit detectors (7.2) from
// traderpro-architecture-v3.md. Every number here is derived from fields the
// import/journal already writes (openedAt/closedAt, pnl, commission, instrumentType) —
// no manual checkbox from the trader. AI is never involved in this file; it only
// ever gets to phrase a conclusion this engine already produced.
//
// Hard rule: a detector only yields a "confirmed" conclusion at n >= MIN_SAMPLE.
// Below that it's tagged 'hypothesis' and must never be presented as settled fact.
import { resolveOpenedAt, resolveClosedAt } from '../trades';

export const MIN_SAMPLE = 25;

function hasRealizedPnl(t) {
  return (t.status === 'closed' || t.status === 'partial') && t.pnl !== undefined && t.pnl !== null;
}

function durationMinutesOf(t) {
  const opened = resolveOpenedAt(t);
  const closed = resolveClosedAt(t);
  if (!opened || !closed) return null;
  const mins = (closed.getTime() - opened.getTime()) / 60000;
  return mins > 0 ? mins : null;
}

const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

// Median, not mean: one 5-day position among twenty intraday trades drags the mean to
// "2 days" and makes the trader think the numbers are broken (real user report). The
// median is what "your typical trade" actually means.
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// "2864 мин" is unreadable; nobody converts minutes to days in their head.
function fmtDuration(mins) {
  if (mins < 90) return `${Math.round(mins)} мин`;
  if (mins < 48 * 60) {
    const h = mins / 60;
    return `${h < 10 ? h.toFixed(1).replace('.', ',') : Math.round(h)} ч`;
  }
  const d = mins / 1440;
  return `${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} дн`;
}

// --- Detector 1: holding asymmetry (cut winners short, sit on losers) --------------

export function detectHoldingAsymmetry(trades) {
  const eligible = trades.filter(hasRealizedPnl).map((t) => ({ t, dur: durationMinutesOf(t) }))
    .filter((x) => x.dur !== null);

  const wins = eligible.filter((x) => x.t.pnl > 0);
  const losses = eligible.filter((x) => x.t.pnl < 0);
  const sampleSize = eligible.length;

  if (!wins.length || !losses.length) {
    return {
      id: 'holding_asymmetry', title: 'Удержание прибыли и убытка', sampleSize,
      confidence: 'hypothesis', avgWinMinutes: 0, avgLossMinutes: 0, ratio: 0, costRub: 0, triggered: false,
      detail: 'Пока нет и прибыльных, и убыточных закрытых сделок одновременно — сравнивать нечего.',
    };
  }

  const medWinMinutes = median(wins.map((x) => x.dur));
  const medLossMinutes = median(losses.map((x) => x.dur));
  const ratio = medWinMinutes > 0 ? medLossMinutes / medWinMinutes : 0;

  // Money proxy: losses held past your own typical winning hold-time — the cost of
  // "hoping it comes back" instead of cutting at the pace you cut winners.
  const draggedLosses = losses.filter((x) => x.dur > medWinMinutes);
  const costRub = Math.abs(draggedLosses.reduce((s, x) => s + x.t.pnl, 0));

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  const isBadPattern = ratio >= 1.3;
  const triggered = confidence === 'confirmed' && isBadPattern;

  const example = draggedLosses.sort((a, b) => a.t.pnl - b.t.pnl)[0]?.t || null;

  return {
    id: 'holding_asymmetry',
    // Accusatory title only when the habit is actually present — a headline that
    // contradicts its own body text ("всё в порядке") reads like a bug (user feedback).
    title: isBadPattern ? 'Прибыль режете, убыток пересиживаете' : 'Удержание прибыли и убытка: в порядке',
    sampleSize, confidence, triggered,
    avgWinMinutes: medWinMinutes, avgLossMinutes: medLossMinutes, ratio, costRub, example,
    detail: isBadPattern
      ? `Типичную прибыльную сделку вы закрываете за ${fmtDuration(medWinMinutes)}, `
        + `а убыточную держите ${fmtDuration(medLossMinutes)} — в ${ratio.toFixed(1).replace('.', ',')} раза дольше (по медиане, выбросы не искажают).`
      : `Типичная прибыльная сделка держится ${fmtDuration(medWinMinutes)}, убыточная — ${fmtDuration(medLossMinutes)}: `
        + `убытки вы закрываете не дольше прибылей, это здоровый паттерн.`,
  };
}

// --- Detector 2: commission tax on fussing (churn) ----------------------------------

function pluralTrades(n) {
  return n % 10 === 1 && n % 100 !== 11 ? 'ку' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'ки' : 'ок');
}

// Sums commission on opening legs beyond the first per position — i.e. the "докупка"
// legs a trader adds after the initial entry (averaging in, scaling in). Each such leg
// carries its own real commission (from the actual leg record, not an estimate), so
// this is an honest empirical figure, not a projection. Framed carefully in the detail
// text below: whether consolidating into one order would truly have saved this exact
// amount depends on the broker's fee model (works cleanly if there's a per-order
// minimum fee; doesn't if commission is pure percentage-of-value, since splitting one
// order into pieces trades the same total value either way).
function extraEntryCommission(trade) {
  const opens = (trade.legs || []).filter((l) => l.type === 'open');
  if (opens.length < 2) return { count: 0, commission: 0 };
  const extra = opens.slice(1);
  return { count: extra.length, commission: extra.reduce((s, l) => s + (l.commission || 0), 0) };
}

export function detectCommissionTax(trades) {
  const eligible = trades.filter(hasRealizedPnl);
  const sampleSize = eligible.length;

  const totalCommission = eligible.reduce((s, t) => s + (t.commission || 0), 0);
  const grossProfit = eligible.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(eligible.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const grossTurnoverAbs = grossProfit + grossLoss;
  const share = grossTurnoverAbs > 0 ? totalCommission / grossTurnoverAbs : 0;

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  const isHigh = share >= 0.05;
  const triggered = confidence === 'confirmed' && isHigh;

  const byInstrument = {};
  for (const t of eligible) {
    const key = t.instrumentType || 'stock';
    byInstrument[key] = (byInstrument[key] || 0) + (t.commission || 0);
  }

  const avgPerTrade = sampleSize ? totalCommission / sampleSize : 0;

  const extras = eligible.map(extraEntryCommission);
  const extraEntriesCount = extras.reduce((s, x) => s + x.count, 0);
  const extraEntriesCommission = extras.reduce((s, x) => s + x.commission, 0);
  const extraShareOfCommission = totalCommission > 0 ? extraEntriesCommission / totalCommission : 0;

  const positionsWithExtras = extras.filter((x) => x.count > 0).length;

  return {
    id: 'commission_tax',
    title: isHigh ? 'Комиссии съедают результат' : 'Комиссии: в разумных пределах',
    sampleSize, confidence, triggered,
    totalCommission, share, byInstrument,
    extraEntriesCount, extraEntriesCommission, positionsWithExtras,
    costRub: totalCommission,
    // Commissions are unavoidable — the point isn't "you paid the broker", it's how big
    // the toll is relative to what the trades themselves move, and where it comes from
    // (many small trades = many commissions). Give the trader that context.
    detail: `За ${sampleSize} сдел${pluralTrades(sampleSize)} `
      + `брокеру уплачено ${Math.round(totalCommission).toLocaleString('ru-RU')} ₽ (в среднем ${Math.round(avgPerTrade).toLocaleString('ru-RU')} ₽ на сделку) — `
      + `это ${Math.round(share * 100)}% от суммы всех ваших прибылей и убытков. `
      + (isHigh
        ? 'Чем больше мелких сделок и докупок, тем больше комиссий — часть результата уходит брокеру ещё до рынка. '
        : 'Без комиссий торговать невозможно, и ваш уровень не выглядит завышенным. ')
      + (extraEntriesCount > 0
        ? `Из них ${extraEntriesCount} докуп${extraEntriesCount === 1 ? 'ка' : 'ок'} внутри ${positionsWithExtras} позици${positionsWithExtras === 1 ? 'и' : 'й'} — `
          + `на них ушло ${Math.round(extraEntriesCommission).toLocaleString('ru-RU')} ₽ комиссии `
          + `(${Math.round(extraShareOfCommission * 100)}% от всей суммы). Если бы у брокера была минимальная комиссия за сделку, `
          + `вход одним ордером вместо нескольких докупок мог бы сэкономить эту часть — но если комиссия чисто процентная `
          + `от суммы сделки, экономии тут, скорее всего, нет: заплатили бы столько же за тот же объём в одном ордере.`
        : ''),
  };
}

// --- Detector 3: P&L by instrument type — shown as its own dashboard card, not ranked ---

export function detectPnlByInstrumentType(trades) {
  const eligible = trades.filter(hasRealizedPnl);
  const groups = {};
  for (const t of eligible) {
    const key = t.instrumentType || 'stock';
    if (!groups[key]) groups[key] = { instrumentType: key, count: 0, wins: 0, totalPnl: 0 };
    groups[key].count += 1;
    if (t.pnl > 0) groups[key].wins += 1;
    groups[key].totalPnl += t.pnl;
  }
  return Object.values(groups)
    .map((g) => ({ ...g, winrate: g.count ? (g.wins / g.count) * 100 : 0 }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

// --- Detector 4: averaging against the position (adding at a worse price) -----------

// Replays a position's `legs` in order and counts additional 'open' legs whose price
// made the average entry worse (long: bought lower after price fell against you; short:
// sold higher after price rose against you) — the classic "average down and hope" habit.
function countAveragingAgainst(trade) {
  const opens = (trade.legs || []).filter((l) => l.type === 'open')
    .slice().sort((a, b) => new Date(a.timestampUtc) - new Date(b.timestampUtc));
  if (opens.length < 2) return 0;

  let runningAvg = opens[0].price;
  let runningVol = opens[0].quantity;
  let againstCount = 0;
  for (let i = 1; i < opens.length; i++) {
    const leg = opens[i];
    const isAgainst = trade.direction === 'long' ? leg.price < runningAvg : leg.price > runningAvg;
    if (isAgainst) againstCount += 1;
    runningAvg = (runningAvg * runningVol + leg.price * leg.quantity) / (runningVol + leg.quantity);
    runningVol += leg.quantity;
  }
  return againstCount;
}

export function detectAveragingAgainstPosition(trades) {
  const eligible = trades.filter(hasRealizedPnl);
  const sampleSize = eligible.length;

  const averaged = eligible
    .map((t) => ({ t, againstCount: countAveragingAgainst(t) }))
    .filter((x) => x.againstCount > 0);

  const losingAveraged = averaged.filter((x) => x.t.pnl < 0);
  const costRub = Math.abs(losingAveraged.reduce((s, x) => s + x.t.pnl, 0));

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  // Require a handful of occurrences, not one unlucky position, before calling it a habit.
  const triggered = confidence === 'confirmed' && averaged.length >= 3 && losingAveraged.length > 0;

  const example = losingAveraged.sort((a, b) => a.t.pnl - b.t.pnl)[0]?.t || null;

  const hasPattern = averaged.length > 0;
  const lossShare = averaged.length ? Math.round((losingAveraged.length / averaged.length) * 100) : 0;

  return {
    id: 'averaging_against',
    title: hasPattern ? 'Усредняетесь против позиции' : 'Усреднение против позиции: не замечено',
    sampleSize, confidence, triggered,
    averagedCount: averaged.length, losingAveragedCount: losingAveraged.length, costRub, example,
    detail: hasPattern
      ? `В ${averaged.length} позициях вы докупали по цене хуже своей средней — ${lossShare}% из них `
        + `закрылись в минус${costRub > 0 ? `, суммарный убыток этих позиций ${Math.round(costRub).toLocaleString('ru-RU')} ₽` : ''}. `
        + `Докупка против движения увеличивает объём именно там, где рынок идёт не в вашу сторону.`
      : 'Докупок по цене хуже своей средней не найдено.',
  };
}

// --- Detector 5: tilt / revenge trading after a loss ---------------------------------

const REVENGE_WINDOW_MIN = 30;

export function detectRevengeTrading(trades) {
  const eligible = trades.filter(hasRealizedPnl)
    .map((t) => ({ t, opened: resolveOpenedAt(t), closed: resolveClosedAt(t) }))
    .filter((x) => x.opened && x.closed)
    .sort((a, b) => a.opened.getTime() - b.opened.getTime());

  const sampleSize = eligible.length;
  const overallLossRate = sampleSize ? eligible.filter((x) => x.t.pnl < 0).length / sampleSize : 0;

  // A trade counts as "revenge" if it was opened within REVENGE_WINDOW_MIN minutes of the
  // *previous* trade's close, and that previous trade was a loss.
  const revenge = [];
  for (let i = 1; i < eligible.length; i++) {
    const prev = eligible[i - 1];
    const cur = eligible[i];
    if (prev.t.pnl >= 0) continue;
    const gapMin = (cur.opened.getTime() - prev.closed.getTime()) / 60000;
    if (gapMin >= 0 && gapMin <= REVENGE_WINDOW_MIN) revenge.push(cur);
  }

  const revengeLossRate = revenge.length ? revenge.filter((x) => x.t.pnl < 0).length / revenge.length : 0;
  const costRub = Math.abs(revenge.filter((x) => x.t.pnl < 0).reduce((s, x) => s + x.t.pnl, 0));

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  const isWorse = revenge.length > 0 && revengeLossRate >= overallLossRate + 0.15;
  const triggered = confidence === 'confirmed' && revenge.length >= 5 && isWorse;

  const example = revenge.filter((x) => x.t.pnl < 0).sort((a, b) => a.t.pnl - b.t.pnl)[0]?.t || null;

  // Three genuinely different findings deserve three different sentences: no re-entries
  // after a loss at all / re-entries exist but aren't worse / re-entries lose more often.
  // The old single template ("0% против 79%") read as gibberish when the pattern was
  // actually absent (real user report).
  let detail;
  if (!revenge.length) {
    detail = `Ни одной сделки, открытой в первые ${REVENGE_WINDOW_MIN} мин после убыточной, не найдено — эмоциональных перезаходов нет.`;
  } else if (!isWorse) {
    detail = `После убытка вы заходили в рынок в течение ${REVENGE_WINDOW_MIN} мин ${revenge.length} раз, `
      + `но эти сделки не хуже обычных (убыточных ${Math.round(revengeLossRate * 100)}% против ${Math.round(overallLossRate * 100)}% в среднем) — на отыгрыш не похоже.`;
  } else {
    detail = `После убытка вы заходили в рынок в течение ${REVENGE_WINDOW_MIN} мин ${revenge.length} раз — `
      + `и такие сделки убыточны в ${Math.round(revengeLossRate * 100)}% случаев против ${Math.round(overallLossRate * 100)}% у остальных. `
      + `Похоже на попытку отыграться на эмоциях${costRub > 0 ? `, это стоило ${Math.round(costRub).toLocaleString('ru-RU')} ₽` : ''}.`;
  }

  return {
    id: 'revenge_trading',
    title: isWorse ? 'Отыгрываетесь сразу после убытка' : 'Отыгрыш после убытка: не замечен',
    sampleSize, confidence, triggered,
    revengeCount: revenge.length, revengeLossRate, overallLossRate, costRub, example,
    detail,
  };
}

// --- Detector 6: daily limit — kept trading after your own rules said stop ----------

// This constant is deliberately NOT a user-facing setting (unlike dailyLossLimit in the
// Capital tab, which the trader configures themselves). It's the engine's own trigger for
// "you were clearly on tilt" — three losses in a row in one day — independent of whether
// money-wise you'd technically stayed under your loss limit.
const MAX_CONSECUTIVE_LOSSES = 3;

export function detectDailyLimitBreach(trades, profile = {}) {
  const eligible = trades.filter(hasRealizedPnl)
    .map((t) => ({ t, opened: resolveOpenedAt(t) }))
    .filter((x) => x.opened)
    .sort((a, b) => a.opened.getTime() - b.opened.getTime());

  const sampleSize = eligible.length;

  const depositSize = profile.depositSize || 0;
  const dailyLossLimitPct = profile.dailyLossLimit || 3;
  const dailyLossLimitRub = depositSize > 0 ? (depositSize * dailyLossLimitPct) / 100 : null;

  // Bucket by MSK calendar date (openedAt is stored/resolved in UTC).
  const byDay = new Map();
  for (const x of eligible) {
    const mskDate = new Date(x.opened.getTime() + 3 * 3600 * 1000);
    const key = mskDate.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(x);
  }

  const overLimitTrades = [];
  const overStreakTrades = [];
  for (const dayTrades of byDay.values()) {
    let cumPnl = 0;
    let streak = 0;
    let limitBreached = false;
    for (const x of dayTrades) {
      if (limitBreached) overLimitTrades.push(x);
      if (streak >= MAX_CONSECUTIVE_LOSSES) overStreakTrades.push(x);
      cumPnl += x.t.pnl;
      streak = x.t.pnl < 0 ? streak + 1 : 0;
      if (dailyLossLimitRub != null && cumPnl <= -dailyLossLimitRub) limitBreached = true;
    }
  }

  const overAll = Array.from(new Set([...overLimitTrades, ...overStreakTrades]));
  const costRub = Math.abs(overAll.filter((x) => x.t.pnl < 0).reduce((s, x) => s + x.t.pnl, 0));

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  const triggered = confidence === 'confirmed' && overAll.length >= 2 && costRub > 0;

  const example = overAll.filter((x) => x.t.pnl < 0).sort((a, b) => a.t.pnl - b.t.pnl)[0]?.t || null;

  const detailParts = [];
  if (dailyLossLimitRub != null && overLimitTrades.length) {
    detailParts.push(`после превышения дневного лимита убытка (${Math.round(dailyLossLimitRub).toLocaleString('ru-RU')} ₽) `
      + `вы всё равно открывали новые сделки — ${overLimitTrades.length} раз`);
  }
  if (overStreakTrades.length) {
    detailParts.push(`после ${MAX_CONSECUTIVE_LOSSES} убытков подряд за день вы продолжали торговать — ${overStreakTrades.length} раз`);
  }

  return {
    id: 'daily_limit_breach',
    title: overAll.length ? 'Торгуете после дневного лимита' : 'Дневной лимит: не нарушался',
    sampleSize, confidence, triggered,
    overLimitCount: overLimitTrades.length, overStreakCount: overStreakTrades.length, costRub, example,
    detail: detailParts.length
      ? detailParts.join('; ') + '.'
      : (dailyLossLimitRub == null
        ? `Дневной лимит убытка в рублях не задан (укажите депозит в «Капитале», чтобы он считался) — но и ${MAX_CONSECUTIVE_LOSSES} убытков подряд за день с продолжением торговли не было.`
        : 'После достижения дневного лимита убытка вы не продолжали торговать.'),
  };
}

// --- Detector 7: futures held to expiry (never closed, settled by the exchange) ------

export function detectExpiredFutures(trades) {
  // Deliberately NOT filtered by hasRealizedPnl: an expired-unclosed position is still
  // status 'open' with pnl null — that's exactly the situation this detector exists for.
  const futures = trades.filter((t) => t.instrumentType === 'future' || t.isFuture);
  const sampleSize = futures.length;
  const expired = futures.filter((t) => t.expiredUnclosed === true);

  // Money cost is only knowable where pnl was realized before expiry — for a position
  // settled by the exchange the journal has no exit price, so costRub understates reality.
  const costRub = Math.abs(expired.reduce((s, t) => s + Math.min(t.pnl ?? 0, 0), 0));

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  // Expiry is a rare, discrete event — a single confirmed occurrence is already worth
  // surfacing (unlike behavioural detectors that need repetition to be called a habit).
  const triggered = confidence === 'confirmed' && expired.length >= 1;

  const example = expired[0] || null;

  return {
    id: 'expired_futures',
    title: expired.length ? 'Пересиживаете фьючерс до экспирации' : 'Экспирация фьючерсов: под контролем',
    sampleSize, confidence, triggered,
    expiredCount: expired.length, costRub, example,
    detail: expired.length
      ? `${expired.length} ваш${expired.length === 1 ? 'а позиция дожила' : 'и позиции дожили'} до экспирации без закрытия — `
        + `биржа закрыла их принудительно по расчётной цене, без вашего участия.`
      : 'Все фьючерсные позиции вы закрывали сами до экспирации — так и нужно.',
  };
}

// --- Detector 8: time map — worst hour / day of week / first 30 min of session -------

function bucketBy(eligible, keyFn) {
  const buckets = new Map();
  for (const x of eligible) {
    const key = keyFn(x.opened);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(x);
  }
  return buckets;
}

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function detectTimeMap(trades) {
  const eligible = trades.filter(hasRealizedPnl)
    .map((t) => ({ t, opened: resolveOpenedAt(t) }))
    .filter((x) => x.opened);

  const sampleSize = eligible.length;
  const overallAvgPnl = sampleSize ? avg(eligible.map((x) => x.t.pnl)) : 0;

  // MSK hour/day — openedAt is resolved as a UTC Date, shift by +3h.
  const mskHour = (d) => new Date(d.getTime() + 3 * 3600 * 1000).getUTCHours();
  const mskDay = (d) => new Date(d.getTime() + 3 * 3600 * 1000).getUTCDay();

  const byHour = bucketBy(eligible, mskHour);
  const byDay = bucketBy(eligible, mskDay);

  // First 30 minutes of the main session: futures open 09:00 MSK, stocks/currency 10:00.
  const mskMinutes = (d) => {
    const m = new Date(d.getTime() + 3 * 3600 * 1000);
    return m.getUTCHours() * 60 + m.getUTCMinutes();
  };
  const isFirst30 = (x) => {
    const sessionOpen = (x.t.instrumentType === 'future' || x.t.isFuture) ? 9 * 60 : 10 * 60;
    const mins = mskMinutes(x.opened);
    return mins >= sessionOpen && mins < sessionOpen + 30;
  };
  const first30Trades = eligible.filter(isFirst30);

  const evalBucket = (bucketTrades, label, key) => {
    if (bucketTrades.length < MIN_SAMPLE) return null;
    const bucketAvg = avg(bucketTrades.map((x) => x.t.pnl));
    if (bucketAvg < 0 && bucketAvg < overallAvgPnl) {
      return { key, label, bucketAvg, count: bucketTrades.length, trades: bucketTrades };
    }
    return null;
  };

  const worstOf = (buckets, labelFn) => {
    let worst = null;
    for (const [key, bucketTrades] of buckets) {
      const cand = evalBucket(bucketTrades, labelFn(key), key);
      if (cand && (!worst || cand.bucketAvg < worst.bucketAvg)) worst = cand;
    }
    return worst;
  };

  const worstHour = worstOf(byHour, (h) => `${h}:00–${h + 1}:00 (МСК)`);
  const worstDay = worstOf(byDay, (d) => DAY_NAMES[d]);
  const worstFirst30 = evalBucket(first30Trades, 'первые 30 минут сессии', 'first30');

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  const candidates = [worstHour, worstDay, worstFirst30].filter(Boolean);
  const triggered = confidence === 'confirmed' && candidates.length > 0;

  const worst = candidates.sort((a, b) => a.bucketAvg - b.bucketAvg)[0] || null;
  const costRub = worst ? Math.abs(worst.trades.filter((x) => x.t.pnl < 0).reduce((s, x) => s + x.t.pnl, 0)) : 0;
  const example = worst ? worst.trades.filter((x) => x.t.pnl < 0).sort((a, b) => a.t.pnl - b.t.pnl)[0]?.t || null : null;

  const detailParts = [];
  if (worstHour) detailParts.push(`час ${worstHour.label}: средний P&L ${Math.round(worstHour.bucketAvg).toLocaleString('ru-RU')} ₽ на ${worstHour.count} сделках`);
  if (worstDay) detailParts.push(`день недели «${worstDay.label}»: средний P&L ${Math.round(worstDay.bucketAvg).toLocaleString('ru-RU')} ₽ на ${worstDay.count} сделках`);
  if (worstFirst30) detailParts.push(`${worstFirst30.label}: средний P&L ${Math.round(worstFirst30.bucketAvg).toLocaleString('ru-RU')} ₽ на ${worstFirst30.count} сделках`);

  return {
    id: 'time_map',
    title: candidates.length ? 'Есть невыгодное время для торговли' : 'Невыгодное время торговли: не выявлено',
    sampleSize, confidence, triggered,
    worstHour, worstDay, worstFirst30, costRub, example,
    detail: detailParts.length ? detailParts.join('; ') + '.' : `Пока недостаточно сделок в каком-то одном часе/дне (нужно от ${MIN_SAMPLE} на срез).`,
  };
}

// --- Detector 9: market context — losing more in sideways/high-volatility conditions ---

// Unlike every other detector here, this one can't read a field straight off the trade
// doc — trend/volatility are computed from candle history, not stored at import time.
// It only sees trades where the trader has already opened the "Технический анализ"
// panel at least once (module 4), which caches `technicalAnalysis.marketContext` onto
// the trade. That's a real limitation, not an oversight: computing this from scratch
// for every trade here would mean fetching candles inside a supposedly pure, synchronous
// engine — a much bigger architectural change. Sample sizes stay honestly small until
// the trader has looked at enough trades, and the existing n>=25 gate handles that
// gracefully (falls back to "hypothesis") rather than needing special-case logic.
function marketContextEvalBucket(bucketTrades, label, overallAvgPnl) {
  if (bucketTrades.length < MIN_SAMPLE) return null;
  const bucketAvg = avg(bucketTrades.map((t) => t.pnl));
  if (bucketAvg < 0 && bucketAvg < overallAvgPnl) {
    return { label, bucketAvg, count: bucketTrades.length, trades: bucketTrades };
  }
  return null;
}

export function detectMarketContextLosses(trades) {
  const eligible = trades.filter(hasRealizedPnl).filter((t) => t.technicalAnalysis?.marketContext);
  const sampleSize = eligible.length;
  const overallAvgPnl = sampleSize ? avg(eligible.map((t) => t.pnl)) : 0;

  const byTrend = { up: [], down: [], sideways: [] };
  const byVolatility = { high: [], normal: [], low: [] };
  for (const t of eligible) {
    const trendLabel = t.technicalAnalysis.marketContext.trend?.label;
    const volLabel = t.technicalAnalysis.marketContext.volatility?.label;
    if (trendLabel && byTrend[trendLabel]) byTrend[trendLabel].push(t);
    if (volLabel && byVolatility[volLabel]) byVolatility[volLabel].push(t);
  }

  const worstTrend = marketContextEvalBucket(byTrend.sideways, 'боковике', overallAvgPnl);
  const worstVol = marketContextEvalBucket(byVolatility.high, 'повышенной волатильности', overallAvgPnl);
  const candidates = [worstTrend, worstVol].filter(Boolean);

  const confidence = sampleSize >= MIN_SAMPLE ? 'confirmed' : 'hypothesis';
  const triggered = confidence === 'confirmed' && candidates.length > 0;

  const worst = candidates.sort((a, b) => a.bucketAvg - b.bucketAvg)[0] || null;
  const costRub = worst ? Math.abs(worst.trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0)) : 0;
  const example = worst ? worst.trades.filter((t) => t.pnl < 0).sort((a, b) => a.pnl - b.pnl)[0] || null : null;

  const detailParts = candidates.map((c) => `в ${c.label}: средний P&L ${Math.round(c.bucketAvg).toLocaleString('ru-RU')} ₽ на ${c.count} сделках`);

  return {
    id: 'market_context_losses',
    title: candidates.length ? 'Есть невыгодный рыночный режим для вас' : 'Невыгодный рыночный режим: не выявлен',
    sampleSize, confidence, triggered,
    worstTrend, worstVol, costRub, example,
    detail: detailParts.length
      ? detailParts.join('; ') + '.'
      : `Пока недостаточно сделок с посчитанным рыночным контекстом — откройте «Технический анализ» у сделок в Журнале, чтобы накопить данные (нужно от ${MIN_SAMPLE} на срез).`,
  };
}

// --- Engine (7.1): rank triggered conclusions by money impact, cap the dashboard view ---

export const WEEKLY_HABITS_LIMIT = 3;
export const HABITS_WINDOW_DAYS = 30;

function runAllDetectors(trades, profile) {
  return [
    detectHoldingAsymmetry(trades),
    detectCommissionTax(trades),
    detectAveragingAgainstPosition(trades),
    detectRevengeTrading(trades),
    detectDailyLimitBreach(trades, profile),
    detectExpiredFutures(trades),
    detectTimeMap(trades),
    detectMarketContextLosses(trades),
  ];
}

// Habits are computed over a rolling 30-day window so a habit the trader has already
// fixed doesn't dominate the top-3 forever on accumulated old losses. If the window
// holds fewer than MIN_SAMPLE realized trades the engine falls back to full history
// (windowUsed: 'all') — a confident answer on 8 trades would violate the n>=25 rule.
// When the window applies, each detector also gets `previous` — the same detector run
// on everything before the window, so the UI can show "а раньше было так".
export function computeWeeklyHabits(trades, profile = {}) {
  const windowStart = Date.now() - HABITS_WINDOW_DAYS * 86400 * 1000;
  const dated = trades.map((t) => ({ t, opened: resolveOpenedAt(t) }));
  const recent = dated.filter((x) => x.opened && x.opened.getTime() >= windowStart).map((x) => x.t);
  const older = dated.filter((x) => !x.opened || x.opened.getTime() < windowStart).map((x) => x.t);

  const useWindow = recent.filter(hasRealizedPnl).length >= MIN_SAMPLE;
  const all = runAllDetectors(useWindow ? recent : trades, profile);

  if (useWindow && older.length) {
    const previous = runAllDetectors(older, profile);
    for (const d of all) {
      const p = previous.find((x) => x.id === d.id);
      if (p) d.previous = { costRub: p.costRub, triggered: p.triggered, sampleSize: p.sampleSize, confidence: p.confidence };
    }
  }

  const triggered = all.filter((d) => d.triggered).sort((a, b) => b.costRub - a.costRub);
  return {
    top: triggered.slice(0, WEEKLY_HABITS_LIMIT),
    all,
    windowUsed: useWindow ? '30d' : 'all',
    windowDays: HABITS_WINDOW_DAYS,
  };
}
