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

export const TIMEFRAMES = {
  M5:  { minutes: 5,    label: 'М5',  requiresToken: true,  moexInterval: null, tinkoffInterval: 'CANDLE_INTERVAL_5_MIN',  lookbackDays: 5 },
  M10: { minutes: 10,   label: 'М10', requiresToken: false, moexInterval: 10,   tinkoffInterval: null,                     lookbackDays: 9 },
  M15: { minutes: 15,   label: 'М15', requiresToken: true,  moexInterval: null, tinkoffInterval: 'CANDLE_INTERVAL_15_MIN', lookbackDays: 12 },
  H1:  { minutes: 60,   label: 'Н1',  requiresToken: false, moexInterval: 60,   tinkoffInterval: 'CANDLE_INTERVAL_HOUR',   lookbackDays: 45 },
  D1:  { minutes: 1440, label: 'Д1',  requiresToken: false, moexInterval: 24,   tinkoffInterval: 'CANDLE_INTERVAL_DAY',    lookbackDays: 320 },
};

export const DEFAULT_TIMEFRAME = 'D1';

// Which timeframes a trader can actually pick, given whether they've connected a token.
export function availableTimeframes(hasToken) {
  return Object.entries(TIMEFRAMES)
    .filter(([, tf]) => hasToken || !tf.requiresToken)
    .map(([key, tf]) => ({ key, ...tf }));
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

async function fetchCandlesFromMoex(ticker, instrumentType, from, to, moexInterval) {
  const em = ISS_ENGINE_MARKET[instrumentType] || ISS_ENGINE_MARKET.stock;
  const url = `${ISS_BASE}/engines/${em.engine}/markets/${em.market}/securities/${encodeURIComponent(ticker)}/candles.json`
    + `?from=${toIsoDate(from)}&till=${toIsoDate(to)}&interval=${moexInterval}&iss.meta=off`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`MOEX ISS error ${resp.status}`);
  const json = await resp.json();
  const cols = json.candles?.columns || [];
  const rows = json.candles?.data || [];
  const idx = (name) => cols.indexOf(name);
  const iOpen = idx('open'), iClose = idx('close'), iHigh = idx('high'), iLow = idx('low'),
    iVolume = idx('volume'), iBegin = idx('begin');

  return rows.map((r) => ({
    date: new Date(r[iBegin]),
    open: r[iOpen], high: r[iHigh], low: r[iLow], close: r[iClose], volume: r[iVolume],
  })).filter((c) => Number.isFinite(c.close));
}

async function fetchCandlesFromTinkoff(ticker, instrumentType, from, to, token, tinkoffInterval) {
  const api = new TinkoffAPI(token);
  const instrument = instrumentType === 'future'
    ? await api.getFutureByTicker(ticker)
    : await api.getShareByTicker(ticker);
  if (!instrument?.figi) throw new Error('instrument not found on Tinkoff');

  const data = await api.request('/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles', {
    figi: instrument.figi,
    from: from.toISOString(),
    to: to.toISOString(),
    interval: tinkoffInterval,
  });

  return (data.candles || [])
    .filter((c) => c.isComplete !== false)
    .map((c) => ({
      date: new Date(c.time),
      open: moneyToFloat(c.open), high: moneyToFloat(c.high),
      low: moneyToFloat(c.low), close: moneyToFloat(c.close),
      volume: Number(c.volume) || 0,
    }));
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
