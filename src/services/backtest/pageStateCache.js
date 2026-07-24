// src/services/backtest/pageStateCache.js
//
// Survives the Бэктест page unmounting when the trader navigates away (e.g. to Капитал to
// check what a strategy's conditions actually are, then back) — real user report: results
// disappeared on every tab switch, forcing a full re-run just to glance at something else.
// Plain module-level object OUTSIDE React, not sessionStorage: `result`/`holdoutResult` can
// hold thousands of candle objects plus every trade, and JSON round-tripping that on every
// keystroke would be wasteful for no benefit (this only needs to survive within the same
// browser tab session, not a reload). Cleared only by an actual page reload — same lifetime
// as everything else client-side here.
export const backtestPageCache = {};
