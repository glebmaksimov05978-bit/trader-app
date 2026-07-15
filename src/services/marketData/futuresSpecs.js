// src/services/marketData/futuresSpecs.js
//
// Resolves a futures contract's tick size and ruble value of that tick (needed to turn
// a price-point P&L into rubles) when Tinkoff's API doesn't have it — typically because
// the contract isn't API-tradeable (e.g. mini contracts like MXI don't return
// minPriceIncrementAmount even though the instrument itself resolves fine).
//
// MOEX ISS only publishes MINSTEP/STEPPRICE for currently-listed (non-expired)
// contracts, so an expired ticker like "MMU5" can't be looked up directly. But tick
// size/value is a property of the contract *type* (its ASSETCODE, e.g. "MXI"), not of
// a specific expiry — MOEX doesn't change it between series of the same product. So we
// resolve the ticker's ASSETCODE via the free securities lookup (works for expired
// tickers too), then read the spec off any currently-active contract sharing that
// ASSETCODE.
const ISS_BASE = 'https://iss.moex.com/iss';

async function resolveAssetCode(ticker) {
  const resp = await fetch(`${ISS_BASE}/securities/${encodeURIComponent(ticker)}.json?iss.meta=off`);
  if (!resp.ok) return null;
  const json = await resp.json();
  const cols = json.description?.columns || [];
  const rows = json.description?.data || [];
  const nameIdx = cols.indexOf('name');
  const valueIdx = cols.indexOf('value');
  const row = rows.find((r) => r[nameIdx] === 'ASSETCODE');
  return row ? row[valueIdx] : null;
}

async function specFromActiveContract(assetCode) {
  const resp = await fetch(
    `${ISS_BASE}/engines/futures/markets/forts/securities.json?iss.meta=off`
    + `&securities.columns=SECID,ASSETCODE,MINSTEP,STEPPRICE`
  );
  if (!resp.ok) return null;
  const json = await resp.json();
  const cols = json.securities?.columns || [];
  const rows = json.securities?.data || [];
  const iAsset = cols.indexOf('ASSETCODE'), iStep = cols.indexOf('MINSTEP'), iStepPrice = cols.indexOf('STEPPRICE');
  const match = rows.find((r) => r[iAsset] === assetCode && r[iStep] && r[iStepPrice]);
  if (!match) return null;
  return { minPriceIncrement: match[iStep], minPriceIncrementAmount: match[iStepPrice] };
}

// Best-effort, free-of-charge fallback for when Tinkoff's API resolves the instrument
// but omits tick value (apiTradeAvailableFlag: false contracts, mostly mini futures).
// Returns null if the contract's type has no currently-active sibling to read specs
// from (e.g. a discontinued product) — caller should fall back to asking the user.
export async function resolveFuturesSpecFromMoex(ticker) {
  try {
    const assetCode = await resolveAssetCode(ticker);
    if (!assetCode) return null;
    return await specFromActiveContract(assetCode);
  } catch {
    return null;
  }
}

// Human-readable identity of an instrument (full name + expiry for futures) from the
// free MOEX securities lookup — works for stocks and futures, listed or expired. The
// Calculator's MOEX source uses it to show the same "what exactly am I trading" badge
// the Tinkoff source shows (real user report: MOEX mode felt blind without it).
export async function fetchMoexSecurityInfo(ticker) {
  try {
    const resp = await fetch(`${ISS_BASE}/securities/${encodeURIComponent(ticker)}.json?iss.meta=off`);
    if (!resp.ok) return null;
    const json = await resp.json();
    const cols = json.description?.columns || [];
    const rows = json.description?.data || [];
    if (!rows.length) return null;
    const nameIdx = cols.indexOf('name');
    const valueIdx = cols.indexOf('value');
    const get = (key) => rows.find((r) => r[nameIdx] === key)?.[valueIdx] ?? null;
    const type = get('TYPE');
    // Perpetual futures carry a formal far-future expiry (2100-01-01) — MOEX
    // publishes it openly on the exchange itself, so it's passed through as-is
    // rather than hidden; Calculator.js formats it without a timezone-shift bug.
    const expirationDate = get('LSTDELDATE') || get('LSTTRADE');
    return {
      ticker: get('SECID') || ticker,
      name: get('CONTRACTNAME') || get('NAME') || get('SHORTNAME') || ticker,
      shortName: get('SHORTNAME'),
      expirationDate,
      isShare: type ? !String(type).includes('futures') : null,
    };
  } catch {
    return null;
  }
}

// Full contract card (tick size, tick value, margin requirement, lot) for a ticker
// that's currently traded — used by the Calculator's MOEX price source (no Tinkoff
// token) so ГО/шаг цены don't have to be typed in by hand. Unlike
// resolveFuturesSpecFromMoex above, this queries the ticker directly rather than
// going through an ASSETCODE lookup — MOEX only carries INITIALMARGIN on the live
// contract itself, not on sibling series, so this has no meaningful fallback for an
// expired ticker (the Journal's use case) and isn't meant for that.
export async function fetchActiveFutureCard(ticker) {
  try {
    const resp = await fetch(
      `${ISS_BASE}/engines/futures/markets/forts/securities/${encodeURIComponent(ticker)}.json?iss.meta=off`
      + `&securities.columns=SECID,MINSTEP,STEPPRICE,INITIALMARGIN,LOTVOLUME`
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const cols = json.securities?.columns || [];
    const row = json.securities?.data?.[0];
    if (!row) return null;
    const at = (name) => row[cols.indexOf(name)];
    const minStep = at('MINSTEP'), stepPrice = at('STEPPRICE');
    if (!minStep || !stepPrice) return null;
    return {
      minPriceIncrement: minStep,
      minPriceIncrementAmount: stepPrice,
      initialMargin: at('INITIALMARGIN') || null,
      lot: at('LOTVOLUME') || 1,
    };
  } catch {
    return null;
  }
}
