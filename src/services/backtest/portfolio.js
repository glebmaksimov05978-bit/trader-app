// src/services/backtest/portfolio.js
//
// Portfolio-level simulation layer on top of the existing single-instrument runBacktest()
// (engine.js) — real architectural fix for a problem found 2026-08-13 diagnosing scary H1
// mark-to-market losses: the single-instrument backtest puts the WHOLE deposit into one
// trade at a time (one "slot" per instrument, full reinvestment). That made every exit-rule
// experiment (wide stops, symmetric trail) look worse than doing nothing, even when the
// average trade itself was fine — one bad trade compounds away the whole base before good
// trades can recover it. This is the standard fund/bank fix: size each position as a SMALL
// FRACTION of total capital, and let several positions (across instruments) run at once, so
// no single trade can sink the account and idle capital isn't wasted waiting on one slot.
//
// Deliberately does NOT touch signal generation — each ticker's entries/exits still come
// from the unmodified runBacktest() (same evaluateStrategy/exitRules everyone else uses).
// This only decides HOW MUCH capital each of those already-decided trades gets, and how
// many can run at once. Two orthogonal problems (when to enter/exit vs how much to risk)
// solved by two separate, composable layers — not tangled into engine.js.

/**
 * @param {Array<{ticker:string, trades:object[]}>} perTicker - runBacktest() output per
 *   instrument (trades include status 'closed'|'open', entryDate, exitDate, pnlPct).
 * @param {object} options
 * @param {number} [options.startingCapital=100000]
 * @param {number} [options.riskPerTradePct=10] - % of CURRENT total capital committed to
 *   each new position at the moment it opens (not the starting capital — so the portfolio
 *   still compounds, just never with more than this fraction in any one trade).
 * @param {number} [options.maxConcurrentPositions=8] - hard cap on simultaneously open
 *   positions across ALL instruments. A signal that fires when the cap is already full is
 *   SKIPPED (real capacity constraint, not a soft suggestion) — surfaced in `skippedSignals`
 *   so this isn't silent.
 * @returns {{
 *   equityCurve: {date:Date, equity:number}[],
 *   finalEquity: number, totalReturnPct: number,
 *   maxDrawdownPct: number,
 *   closedTrades: number, openTrades: number, skippedSignals: number,
 *   worstTrade: number,
 * }}
 */
export function runPortfolioBacktest(perTicker, options = {}) {
  const {
    startingCapital = 100000,
    riskPerTradePct = 10,
    maxConcurrentPositions = 8,
  } = options;

  // Flatten into one chronological event stream. Exits before entries on the same instant
  // free capacity before new signals compete for it — matches how a real trader closing a
  // position frees margin before opening the next one, not an arbitrary tie-break.
  const events = [];
  for (const { ticker, trades } of perTicker) {
    for (const t of trades) {
      if (!t.entryDate) continue;
      const exitDate = t.status === 'closed' ? t.exitDate : null; // 'open' trades never exit within this run
      events.push({ type: 'entry', date: new Date(t.entryDate), ticker, trade: t });
      if (exitDate) events.push({ type: 'exit', date: new Date(exitDate), ticker, trade: t });
    }
  }
  events.sort((a, b) => a.date - b.date || (a.type === 'exit' ? -1 : 1));

  let equity = startingCapital;
  let peak = equity;
  let maxDrawdownPct = 0;
  const open = new Map(); // trade -> allocatedCapital
  const equityCurve = [{ date: events[0]?.date ?? new Date(), equity }];
  let closedTrades = 0, skippedSignals = 0, worstTrade = 0;

  for (const ev of events) {
    if (ev.type === 'exit') {
      const allocated = open.get(ev.trade);
      if (allocated == null) continue; // shouldn't happen, but never let a stray exit crash the run
      open.delete(ev.trade);
      equity += allocated * (ev.trade.pnlPct / 100);
      closedTrades += 1;
      worstTrade = Math.min(worstTrade, ev.trade.pnlPct);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
      equityCurve.push({ date: ev.date, equity });
    } else {
      if (open.size >= maxConcurrentPositions) { skippedSignals += 1; continue; }
      const allocated = equity * (riskPerTradePct / 100);
      open.set(ev.trade, allocated);
    }
  }

  // Whatever's still open at the end of history is honest mark-to-market, same principle
  // as the single-instrument engine's own 'open' trades — included in the final number
  // rather than silently dropped, so this portfolio view can't repeat the exact bug it was
  // built to fix (hiding unrealized losses from the headline number).
  let mtmEquity = equity;
  for (const [trade, allocated] of open) {
    mtmEquity += allocated * (trade.pnlPct / 100);
    worstTrade = Math.min(worstTrade, trade.pnlPct);
  }

  return {
    equityCurve,
    finalEquity: mtmEquity,
    totalReturnPct: ((mtmEquity - startingCapital) / startingCapital) * 100,
    maxDrawdownPct,
    closedTrades, openTrades: open.size, skippedSignals,
    worstTrade,
  };
}
