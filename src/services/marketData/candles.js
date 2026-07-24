// src/services/marketData/candles.js
//
// OHLCV history for pattern/indicator detectors (module 4 of the architecture).
// Source is chosen per user, not hardcoded: if they've connected a Tinkoff Invest token
// (Settings), we use it — same account, same data the broker itself trades on. Without a
// token we fall back to the MOEX ISS API, which is free and needs no auth at all, so the
// feature still works for anyone who only uses the calculator/journal.
//
// Timeframe support: MOEX ISS's free candles endpoint only has 1/10/60/24 (minutes/
// day) — no 5 or 15 minute bars. Tinkoff's API has 5/15/60/day. So M5 and M15 are
// gated behind a connected token; M10/H1/D1 work for everyone. See TIMEFRAMES below —
// this is the single source of truth the UI reads to decide which buttons to show.
import { TinkoffAPI, moneyToFloat } from '../tinkoff';

const ISS_BASE = 'https://iss.moex.com/iss';

// lookbackDays tripled from the original values (real user report: wanted swing levels
// from further back — e.g. a sharp reversal ~a year ago — to actually show up instead of
// falling outside the fetch window on D1).
export const TIMEFRAMES = {
  M5:  { minutes: 5,    label: 'М5',  requiresToken: true,  moexInterval: null, tinkoffInterval: 'CANDLE_INTERVAL_5_MIN',  lookbackDays: 15 },
  M10: { minutes: 10,   label: 'М10', requiresToken: false, moexInterval: 10,   tinkoffInterval: null,                     lookbackDays: 27 },
  M15: { minutes: 15,   label: 'М15', requiresToken: true,  moexInterval: null, tinkoffInterval: 'CANDLE_INTERVAL_15_MIN', lookbackDays: 36 },
  H1:  { minutes: 60,   label: 'Ч1',  requiresToken: false, moexInterval: 60,   tinkoffInterval: 'CANDLE_INTERVAL_HOUR',   lookbackDays: 135 },
  D1:  { minutes: 1440, label: 'Д1',  requiresToken: false, moexInterval: 24,   tinkoffInterval: 'CANDLE_INTERVAL_DAY',    lookbackDays: 960 },
};

export const DEFAULT_TIMEFRAME = 'D1';

// Which timeframes a trader can actually pick, given whether they've connected a token.
export function availableTimeframes(hasToken) {
  return Object.entries(TIMEFRAMES)
    .filter(([, tf]) => hasToken || !tf.requiresToken)
    .map(([key, tf]) => ({ key, ...tf }));
}

// Picks a timeframe that roughly matches how long a trade was actually held — showing
// daily-candle S/R and Bollinger bands for a trade held 20 minutes puts levels a whole
// market's worth of history away from the entry price, which is unreadable without a
// chart (real user report: "я торгую на одном таймфрейме, а информация на другом").
// Buckets are deliberately coarse (order-of-magnitude, not precise) — this picks a
// *starting point* for the analysis panel, not a claim about the trader's exact style;
// the caller always lets them override it by hand afterward.
export function recommendTimeframe(durationMinutes, hasToken) {
  if (durationMinutes == null || !Number.isFinite(durationMinutes)) return DEFAULT_TIMEFRAME;
  if (durationMinutes <= 90) return hasToken ? 'M5' : 'M10';
  if (durationMinutes <= 8 * 60) return hasToken ? 'M15' : 'H1';
  if (durationMinutes <= 3 * 1440) return 'H1';
  return 'D1';
}

// MOEX ISS groups securities by engine+market — this mapping is a simplification and
// won't resolve every exotic instrument (e.g. some FORTS futures codes differ between
// Tinkoff's ticker and MOEX's SECID), but covers the common stock/future/currency cases.
const ISS_ENGINE_MARKET = {
  stock: { engine: 'stock', market: 'shares' },
  future: { engine: 'futures', market: 'forts' },
  currency: { engine: 'currency', market: 'selt' },
};

function pad(n) { return String(n).padStart(2, '0'); }
function toIsoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// MOEX ISS candles.json caps every response at 500 rows and returns the OLDEST 500
// from `from` — with no cursor in the payload when iss.meta=off. A single request was
// therefore silently truncating any window longer than ~500 bars: a 3-year D1 request
// (~750 trading days) came back with only the first ~2 years and dropped the most recent
// year entirely (confirmed live against SBER). That's invisible in the UI — the backtest
// just runs on a short, stale slice — and gets worse the more history you ask for. So we
// page with &start=N (500 at a time, ascending) until a page comes back short, then stop.
const MOEX_PAGE_SIZE = 500;
const MOEX_MAX_PAGES = 60; // safety cap: 30k daily bars (~120 years) — we'll never hit it

async function fetchCandlesFromMoex(ticker, instrumentType, from, to, moexInterval) {
  const em = ISS_ENGINE_MARKET[instrumentType] || ISS_ENGINE_MARKET.stock;
  const base = `${ISS_BASE}/engines/${em.engine}/markets/${em.market}/securities/${encodeURIComponent(ticker)}/candles.json`
    + `?from=${toIsoDate(from)}&till=${toIsoDate(to)}&interval=${moexInterval}&iss.meta=off`;

  const out = [];
  for (let page = 0; page < MOEX_MAX_PAGES; page++) {
    const resp = await fetch(`${base}&start=${page * MOEX_PAGE_SIZE}`);
    if (!resp.ok) throw new Error(`MOEX ISS error ${resp.status}`);
    const json = await resp.json();
    const cols = json.candles?.columns || [];
    const rows = json.candles?.data || [];
    const idx = (name) => cols.indexOf(name);
    const iOpen = idx('open'), iClose = idx('close'), iHigh = idx('high'), iLow = idx('low'),
      iVolume = idx('volume'), iBegin = idx('begin');

    for (const r of rows) {
      const close = r[iClose];
      if (!Number.isFinite(close)) continue;
      out.push({
        date: new Date(r[iBegin]),
        open: r[iOpen], high: r[iHigh], low: r[iLow], close, volume: r[iVolume],
      });
    }
    // A short page means we've reached the end of available history — stop before firing
    // an extra empty request.
    if (rows.length < MOEX_PAGE_SIZE) break;
  }
  return out;
}

// Tinkoff's GetCandles rejects a single request spanning more than this many days for
// a given interval (documented API limit, not a guess) — a real bug when lookbackDays
// was tripled without checking it: requesting 36 days of 15-minute candles in one call
// got silently rejected, and the caller's catch-and-fall-back-to-MOEX swallowed the
// error, but MOEX has no M5/M15 data at all, so it surfaced as "M15 doesn't work even
// with a token" (real user report). Chunk the request into windows within these caps
// instead of capping lookbackDays itself, which would have thrown away the extra
// history that was the whole point of tripling it.
const TINKOFF_MAX_SPAN_DAYS = {
  CANDLE_INTERVAL_1_MIN: 1, CANDLE_INTERVAL_5_MIN: 1, CANDLE_INTERVAL_15_MIN: 1,
  CANDLE_INTERVAL_HOUR: 7, CANDLE_INTERVAL_DAY: 360,
};

async function fetchCandlesFromTinkoff(ticker, instrumentType, from, to, token, tinkoffInterval) {
  const api = new TinkoffAPI(token);
  const instrument = instrumentType === 'future'
    ? await api.getFutureByTicker(ticker)
    : await api.getShareByTicker(ticker);
  if (!instrument?.figi) throw new Error('instrument not found on Tinkoff');

  const maxSpanMs = (TINKOFF_MAX_SPAN_DAYS[tinkoffInterval] || 1) * 86400 * 1000;
  const windows = [];
  for (let windowEnd = to.getTime(); windowEnd > from.getTime(); windowEnd -= maxSpanMs) {
    const windowStart = Math.max(from.getTime(), windowEnd - maxSpanMs);
    windows.push([new Date(windowStart), new Date(windowEnd)]);
  }

  const allCandles = [];
  for (const [wFrom, wTo] of windows) {
    const data = await api.request('/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles', {
      figi: instrument.figi,
      from: wFrom.toISOString(),
      to: wTo.toISOString(),
      interval: tinkoffInterval,
    });
    allCandles.push(...(data.candles || []));
  }

  // Adjacent windows share their boundary instant, which can hand back the same candle
  // twice — dedupe by timestamp before returning.
  const seen = new Set();
  const out = [];
  for (const c of allCandles) {
    if (c.isComplete === false || seen.has(c.time)) continue;
    seen.add(c.time);
    out.push({
      date: new Date(c.time),
      open: moneyToFloat(c.open), high: moneyToFloat(c.high),
      low: moneyToFloat(c.low), close: moneyToFloat(c.close),
      volume: Number(c.volume) || 0,
    });
  }
  return out;
}

// Returns candles at the requested timeframe, ending at `toDate`, going back far enough
// for a 200-bar SMA/EMA at that granularity. Ascending by date. Currency pairs always go
// through MOEX — the Tinkoff wrapper here has no currency-instrument lookup yet. M5/M15
// silently fall back to D1 without a token rather than erroring, since the caller (UI)
// is expected to not offer those buttons in the first place — this is a safety net, not
// the primary gate.
export async function fetchDailyCandles({ ticker, instrumentType, toDate, tinkoffToken, timeframe = DEFAULT_TIMEFRAME, lookbackDays }) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES[DEFAULT_TIMEFRAME];
  const effectiveTf = (tf.requiresToken && !tinkoffToken) ? TIMEFRAMES[DEFAULT_TIMEFRAME] : tf;

  const to = new Date(toDate);
  const from = new Date(to.getTime() - (lookbackDays ?? effectiveTf.lookbackDays) * 86400 * 1000);

  const canUseTinkoff = tinkoffToken && effectiveTf.tinkoffInterval && (instrumentType === 'stock' || instrumentType === 'future');
  if (canUseTinkoff) {
    try {
      const candles = await fetchCandlesFromTinkoff(ticker, instrumentType, from, to, tinkoffToken, effectiveTf.tinkoffInterval);
      if (candles.length) return candles.sort((a, b) => a.date - b.date);
    } catch {
      // Falls through to MOEX — e.g. instrument not resolvable via this Tinkoff account.
    }
  }
  if (!effectiveTf.moexInterval) {
    // Timeframe has no MOEX equivalent (M5/M15) and no usable token — nothing to fetch.
    throw new Error(`Таймфрейм ${effectiveTf.label} доступен только с токеном Т-Инвестиций`);
  }
  const candles = await fetchCandlesFromMoex(ticker, instrumentType, from, to, effectiveTf.moexInterval);
  return candles.sort((a, b) => a.date - b.date);
}
