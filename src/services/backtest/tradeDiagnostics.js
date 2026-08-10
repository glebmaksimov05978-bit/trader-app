// src/services/backtest/tradeDiagnostics.js
//
// Real trader request (2026-08-10, same session as the 2026-08 calibration work): don't
// just show the trader the trade list and numbers — look at HOW trades actually ended
// (stop/take/trail/time) and tell them, in plain language, what that pattern suggests
// trying differently. Explicitly "algorithm-based, not AI" (his words) — every rule here
// is a simple threshold check over the trades the engine already produced, no model, no
// guessing. An AI-based version is a later, separate idea (see project-backtest-lab-
// roadmap.md item #8/#9 — "auto-improver"), not this.
//
// Deliberately conservative: only fires when a pattern is common enough (decent sample,
// clear majority) to be worth mentioning — a single anecdote isn't a finding.

const MIN_SAMPLE = 8; // below this, percentages are too noisy to act on

function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

/**
 * @param {object[]} trades - closed trades from runBacktest() (status: 'closed')
 * @param {object} exitRules - the rules this run actually used
 * @returns {{icon: string, title: string, text: string}[]}
 */
export function diagnoseTrades(trades, exitRules) {
  const closed = (trades || []).filter((t) => t.status === 'closed');
  const total = closed.length;
  if (total < MIN_SAMPLE) return [];

  const byReason = {};
  for (const t of closed) byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;
  const stopCount = byReason.stop || 0;
  const takeCount = byReason.take || 0;
  const trailCount = byReason.trail || 0;
  const timeCount = byReason.time || 0;
  const stopPct = pct(stopCount, total);
  const takePct = pct(takeCount, total);

  const avgBarsHeld = (list) => list.length
    ? Math.round((list.reduce((s, t) => s + (t.barsHeld || 0), 0) / list.length) * 10) / 10
    : null;
  const stopTrades = closed.filter((t) => t.exitReason === 'stop');
  const takeTrades = closed.filter((t) => t.exitReason === 'take');
  const avgStopBars = avgBarsHeld(stopTrades);
  const avgTakeBars = avgBarsHeld(takeTrades);

  const findings = [];

  // Stop dominates AND the stop isn't already the widest reasonable option — the classic
  // "direction was probably fine, distance was too tight" pattern this whole calibration
  // pass was built around.
  if (stopPct >= 45 && !exitRules?.trailEnabled) {
    const stopDesc = exitRules?.stopType === 'pct' ? `фиксированный ${exitRules.stopPct ?? '?'}%`
      : exitRules?.stopType === 'level' ? '«У уровня»'
      : exitRules?.stopType === 'atr' ? `×ATR (${exitRules.stopAtrMult ?? '?'})`
      : exitRules?.stopType;
    findings.push({
      icon: '🛑',
      title: `Стоп срабатывает часто — ${stopPct}% сделок (${stopCount} из ${total})`,
      text: `Сейчас стоп — ${stopDesc}. Когда стоп срабатывает настолько часто, обычно дело не `
        + `в том, что направление было выбрано неверно, а в том, что цене не хватает места на `
        + `обычный шум перед движением. Варианты: расширить стоп (в %/×ATR), поставить стоп `
        + `«У уровня» — за структурой фигуры, а не на произвольном расстоянии, или включить `
        + `следящий выход «Движение выдохлось» ниже.`,
    });
  }

  // Stops that hit almost immediately (1-2 bars) are a stronger, more specific version of
  // the same signal — that's not "the trade played out and lost", that's "the stop was
  // basically inside the entry-day noise".
  if (stopCount >= MIN_SAMPLE && avgStopBars != null && avgStopBars <= 2) {
    findings.push({
      icon: '⚡',
      title: `Стопы срабатывают почти сразу — в среднем через ${avgStopBars} ${avgStopBars < 2 ? 'день' : 'дня'}`,
      text: `Это больше похоже на обычный шум прямо у входа, чем на то, что сделка пошла `
        + `по-настоящему против вас. Признак, что стоп стоит слишком близко к цене входа.`,
    });
  }

  // Trail is on but stop still dominates — the trail literally can't fire if the stop
  // fires first (engine checks stop/take before the trail on the same bar), so this means
  // the stop is too tight to let the trail do its job at all.
  if (exitRules?.trailEnabled && stopPct >= 40) {
    findings.push({
      icon: '🌊',
      title: `Следящий выход включён, но стоп всё равно срабатывает в ${stopPct}% сделок`,
      text: `Следящий выход не успевает подключиться, если жёсткий стоп срабатывает раньше — `
        + `а при близком стопе он срабатывает почти всегда первым. Чтобы следящий выход `
        + `реально работал, стоп должен быть заметно шире, чем обычно (3-4%+ или «У уровня»), `
        + `иначе эта галочка почти ничего не меняет.`,
    });
  }

  // Take almost never reached, while stop isn't already dominating the picture — the take
  // target is plausibly just too far away to matter in practice.
  if (takePct <= 15 && stopPct < 45 && exitRules?.takeType && exitRules.takeType !== 'none') {
    const takeDesc = exitRules.takeType === 'pct' ? `${exitRules.takePct ?? '?'}%` : exitRules.takeType;
    findings.push({
      icon: '🎯',
      title: `Тейк достигается редко — всего ${takePct}% сделок (${takeCount} из ${total})`,
      text: `Текущая цель тейка — ${takeDesc}. Если он достигается настолько редко, возможно, `
        + `он стоит слишком далеко для того, как реально ведёт себя цена. Попробуйте цель ближе, `
        + `или включите следящий выход — тогда сделка закрывается по факту остановки движения, `
        + `а не ждёт одну далёкую фиксированную цену.`,
    });
  }

  // Take reached notably faster than stop would-be-hit trades — a loose signal that the
  // take target might be leaving profit on the table (reached quickly, every time).
  if (takeCount >= MIN_SAMPLE && avgTakeBars != null && avgStopBars != null && avgTakeBars <= avgStopBars * 0.5 && takePct >= 30) {
    findings.push({
      icon: '📈',
      title: `Тейк обычно достигается быстро — в среднем через ${avgTakeBars} дн., заметно быстрее стопа (${avgStopBars} дн.)`,
      text: `Возможно, цель тейка стоит слишком близко и сделка закрывается раньше, чем движение `
        + `могло бы дать больше. Стоит проверить более далёкую цель или следящий выход вместо `
        + `фиксированного тейка — сравните обе версии на holdout-периоде.`,
    });
  }

  // A large share of trades never reach either price target and get cut by the time limit
  // — the limit itself may be starving trades that would have worked given more room.
  if (timeCount >= MIN_SAMPLE && pct(timeCount, total) >= 30) {
    findings.push({
      icon: '⏱',
      title: `${pct(timeCount, total)}% сделок закрылись по лимиту времени, не дойдя ни до стопа, ни до тейка`,
      text: `Лимит «макс. дней в сделке» может быть тесноват для того, как реально раскрываются `
        + `движения по этой стратегии — стоит попробовать увеличить его или снять совсем.`,
    });
  }

  return findings;
}
