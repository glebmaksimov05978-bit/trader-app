// src/services/trainer/trainerStats.js
//
// Разбор бумажных сделок тренажёра: сводка в R и поведенческие наблюдения («что не так, где не получается»).
// Принципы те же, что у движка привычек в журнале: считает детерминированный код, а не ИИ; выводы только при достаточном
// числе сделок (порог MIN_N = 25, как в журнале); текст — наблюдение и вопрос к себе, не совет вкладывать деньги.
//
// Разделение бумаги и реальности: функции принимают ТОЛЬКО сделки тренажёра (`kind: 'trainer'`). Реальные сделки
// (коллекция trades) и бумажные сделки робота (paperTrades) сюда не попадают и не должны — `onlyTrainer` отсеивает всё
// остальное на входе, а результат всегда помечен `scope: 'trainer'`.

export const MIN_N = 25;       // меньше — только цифры, без выводов
const MIN_SUBSET = 5;          // для сравнения двух групп внутри выборки нужно хотя бы по 5 сделок в каждой

export const isTrainerTrade = (t) => !!t && t.kind === 'trainer';
export const onlyTrainer = (trades) => (trades || []).filter(isTrainerTrade);
const closed = (trades) => onlyTrainer(trades).filter((t) => t.status === 'closed' && Number.isFinite(t.r));

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const fmtR = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2).replace('.', ',')}R`;
const pct = (x) => `${Math.round(x * 100)} %`;
const ms = (v) => { if (!v) return 0; if (v.seconds) return v.seconds * 1000; const n = new Date(v).getTime(); return Number.isFinite(n) ? n : 0; };

export function summarize(trades) {
  const cl = closed(trades);
  const n = cl.length;
  if (!n) return { n: 0, winRate: null, avgR: null, totalR: 0, profitFactor: null, avgWinR: null, avgLossR: null, maxLossStreak: 0, avgBars: null };
  const wins = cl.filter((t) => t.r > 0), losses = cl.filter((t) => t.r <= 0);
  const grossWin = wins.reduce((s, t) => s + t.r, 0), grossLoss = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  let streak = 0, maxLossStreak = 0;
  for (const t of cl.slice().sort((a, b) => ms(a.exitDate) - ms(b.exitDate))) { streak = t.r <= 0 ? streak + 1 : 0; maxLossStreak = Math.max(maxLossStreak, streak); }
  return {
    n, winRate: wins.length / n, avgR: mean(cl.map((t) => t.r)), totalR: cl.reduce((s, t) => s + t.r, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWinR: wins.length ? mean(wins.map((t) => t.r)) : null, avgLossR: losses.length ? mean(losses.map((t) => t.r)) : null,
    maxLossStreak, avgBars: mean(cl.map((t) => t.barsHeld || 0)),
  };
}

/** Вердикт по стратегии, проверяемой на бумаге: никогда не «работает», только «пока по бумаге…». */
export function strategyVerdict(trades) {
  const s = summarize(trades);
  if (s.n < MIN_N) return { code: 'few', label: `Мало данных (${s.n} из ${MIN_N})`, ...s };
  if (s.avgR > 0.1 && (s.profitFactor == null || s.profitFactor > 1.1)) return { code: 'positive', label: 'Пока по бумаге в плюсе', ...s };
  if (s.avgR < 0) return { code: 'negative', label: 'По бумаге не подтвердилась', ...s };
  return { code: 'flat', label: 'По бумаге около нуля', ...s };
}

/** Разбор по стратегиям (по `strategyId`; сделки без стратегии — «Без стратегии»). */
export function byStrategy(trades) {
  const groups = new Map();
  for (const t of closed(trades)) {
    const key = t.strategyId || '—';
    if (!groups.has(key)) groups.set(key, { id: key === '—' ? null : key, name: t.strategyName || (key === '—' ? 'Без стратегии' : key), trades: [] });
    groups.get(key).trades.push(t);
  }
  return [...groups.values()].map((g) => ({ id: g.id, name: g.name, ...strategyVerdict(g.trades) })).sort((a, b) => b.n - a.n);
}

/** Сравнение исторических и живых бумажных сделок. */
export function byDataMode(trades) {
  const out = {};
  for (const mode of ['history', 'live']) out[mode] = summarize(closed(trades).filter((t) => (t.dataMode || 'history') === mode));
  return out;
}

/**
 * Поведенческие наблюдения. Каждое — {id, level:'warn'|'info', text, n}. Пустой список при n < MIN_N,
 * кроме одной строки «пока мало сделок».
 */
export function findings(trades, { minN = MIN_N } = {}) {
  const cl = closed(trades).slice().sort((a, b) => ms(a.entryDate) - ms(b.entryDate));
  const out = [];
  if (cl.length < minN) {
    out.push({ id: 'sample', level: 'info', n: cl.length, text: `Пока ${cl.length} из ${minN} сделок — выводы о ваших привычках появятся, когда наберётся ${minN}: на меньшем числе случайность важнее закономерности.` });
    return out;
  }

  // 1. Отодвигали стоп от цены.
  const widened = cl.filter((t) => (t.stopMoves || []).some((m) => m.direction === 'widen'));
  const rest = cl.filter((t) => !widened.includes(t));
  if (widened.length >= MIN_SUBSET && rest.length >= MIN_SUBSET) {
    const a = mean(widened.map((t) => t.r)), b = mean(rest.map((t) => t.r));
    if (a < b - 0.2) out.push({ id: 'stop_widened', level: 'warn', n: widened.length, text: `В ${widened.length} сделках вы отодвигали стоп от цены. Средний результат таких сделок ${fmtR(a)}, у остальных ${fmtR(b)}. Стоп, который двигают назад, перестаёт быть стопом — стоит заранее решить, что делать, когда цена к нему подходит.` });
  }

  // 2. Убытки больше запланированного.
  const deep = cl.filter((t) => t.r < -1.3);
  if (deep.length / cl.length >= 0.1) {
    const gaps = deep.filter((t) => t.gap).length;
    out.push({ id: 'loss_beyond_plan', level: 'warn', n: deep.length, text: `${pct(deep.length / cl.length)} сделок (${deep.length}) закрылись убытком больше −1,3R, хотя риск задавался в 1R.${gaps ? ` В ${gaps} из них свеча открылась за стопом (гэп) — это риск инструмента, а не ошибка.` : ''}${deep.length - gaps ? ' Остальные — выход не по стопу: проверьте, не закрывали ли вы вручную позже плана.' : ''}` });
  }

  // 3. Прибыль фиксируется слишком рано.
  const manualWins = cl.filter((t) => t.exitReason === 'manual' && t.r > 0 && t.mfeR > 0);
  if (manualWins.length >= MIN_SUBSET) {
    const early = manualWins.filter((t) => t.r < 0.5 * t.mfeR);
    const captured = mean(manualWins.map((t) => t.r / t.mfeR));
    if (early.length / manualWins.length >= 0.4) out.push({ id: 'early_exit', level: 'warn', n: early.length, text: `В ${early.length} из ${manualWins.length} прибыльных сделок, закрытых вручную, вы вышли, забрав меньше половины хода, который цена успела дать (в среднем ${pct(captured)} от максимума). Проверьте: вы фиксируете по плану или из страха отдать прибыль?` });
  }

  // 4. Убыточные держим дольше прибыльных.
  const w = cl.filter((t) => t.r > 0 && (t.barsHeld || 0) > 0), l = cl.filter((t) => t.r <= 0 && (t.barsHeld || 0) > 0);
  if (w.length >= MIN_SUBSET && l.length >= MIN_SUBSET) {
    const bw = mean(w.map((t) => t.barsHeld)), bl = mean(l.map((t) => t.barsHeld));
    if (bl > bw * 1.5) out.push({ id: 'losers_held_longer', level: 'warn', n: l.length, text: `Убыточные сделки вы держите в среднем ${bl.toFixed(1).replace('.', ',')} свечи, прибыльные — ${bw.toFixed(1).replace('.', ',')}. Классическая привычка — надеяться на возврат в убыточной и спешить закрыть прибыльную.` });
  }

  // 5. Быстрый вход после убытка.
  const afterLoss = [], other = [];
  for (const t of cl) {
    // последняя закрытая ДО этого входа сделка по тому же инструменту
    const prev = cl.filter((p) => p !== t && p.ticker === t.ticker && ms(p.exitDate) <= ms(t.entryDate))
      .sort((a, b) => ms(b.exitDate) - ms(a.exitDate))[0];
    const quick = prev && prev.r <= 0 && prev.exitBar != null && t.entryBar != null && t.entryBar >= prev.exitBar && t.entryBar - prev.exitBar <= 3;
    (quick ? afterLoss : other).push(t);
  }
  if (afterLoss.length >= MIN_SUBSET && other.length >= MIN_SUBSET) {
    const a = mean(afterLoss.map((t) => t.r)), b = mean(other.map((t) => t.r));
    if (a < b - 0.2) out.push({ id: 'quick_reentry', level: 'warn', n: afterLoss.length, text: `Сделки, открытые в течение 3 свечей после убытка по тому же инструменту (${afterLoss.length}), дали в среднем ${fmtR(a)}, остальные — ${fmtR(b)}. Похоже на попытку сразу отыграться.` });
  }

  // 6. Мало прибыли на единицу риска в плане.
  const planned = cl.filter((t) => t.plannedRR != null);
  if (planned.length >= MIN_SUBSET) {
    const rr = mean(planned.map((t) => t.plannedRR)), wr = cl.filter((t) => t.r > 0).length / cl.length;
    if (rr < 1 && wr < 0.6) out.push({ id: 'low_rr', level: 'info', n: planned.length, text: `Планируемая прибыль к риску в среднем ${rr.toFixed(2).replace('.', ',')}:1 при доле прибыльных сделок ${pct(wr)}. При такой комбинации выход «в ноль» требует заметно больше половины верных сделок.` });
  }

  // 7. Бумага и «живое» заметно расходятся.
  const modes = byDataMode(cl);
  if (modes.history.n >= MIN_SUBSET && modes.live.n >= MIN_SUBSET && Math.abs(modes.history.avgR - modes.live.avgR) > 0.3) {
    out.push({ id: 'history_vs_live', level: 'info', n: modes.live.n, text: `На истории средний результат ${fmtR(modes.history.avgR)}, на живых ценах ${fmtR(modes.live.avgR)}. Когда на истории лучше, чем вживую, это часто значит, что на истории «подсматриваешь» итог — слепой режим и ограничение числа попыток снижают этот эффект.` });
  }

  return out;
}

/** Всё для экрана «Разбор» одним объектом. */
export function analyze(trades) {
  const cl = closed(trades);
  return {
    scope: 'trainer',
    summary: summarize(cl),
    strategies: byStrategy(cl),
    modes: byDataMode(cl),
    findings: findings(cl),
  };
}
