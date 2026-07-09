// src/services/import/instrumentResolver.js
// Resolves ВНБ (off-exchange) "Код актива" values, which can be an ISIN instead
// of the normal exchange ticker, back to the real ticker using report section
// "4.1 Информация о ценных бумагах" (Наименование актива, Код актива, ISIN, ...).

const FUTURES_MONTH_CODE = {
  F: 0, G: 1, H: 2, J: 3, K: 4, M: 5,
  N: 6, Q: 7, U: 8, V: 9, X: 10, Z: 11,
};

const FUTURES_TICKER_RE = /^[A-Z]{2,6}([FGHJKMNQUVXZ])(\d)$/;

export function isFuturesCode(code) {
  return FUTURES_TICKER_RE.test(String(code || '').toUpperCase());
}

// Standard MOEX month-letter+year-digit coding, e.g. GZU5 -> September 2025.
// Year digit is the last digit of the year; we assume the nearest such year
// to "now" (or to an optional referenceDate) to disambiguate the decade.
export function decodeFuturesExpiry(code, referenceDate = new Date()) {
  const m = String(code || '').toUpperCase().match(FUTURES_TICKER_RE);
  if (!m) return null;
  const monthIdx = FUTURES_MONTH_CODE[m[1]];
  const yearDigit = parseInt(m[2], 10);
  const refYear = referenceDate.getFullYear();
  let candidate = Math.floor(refYear / 10) * 10 + yearDigit;
  if (candidate < refYear - 5) candidate += 10;
  if (candidate > refYear + 5) candidate -= 10;
  // Expiry ~= 3rd Thursday-ish of the given month; we don't know the exact day
  // from the code alone, so use the last day of the month as a safe upper bound.
  return new Date(Date.UTC(candidate, monthIdx + 1, 0, 23, 59, 59));
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

export function looksLikeIsin(code) {
  return ISIN_RE.test(String(code || '').toUpperCase());
}

// Build an ISIN -> ticker map from section 4.1 rows.
// rows: [{ name, code, isin, regCode, type, issuer }]
export function buildIsinTickerMap(section41Rows) {
  const map = new Map();
  const byIsin = new Map();
  for (const row of section41Rows) {
    if (!row.isin) continue;
    if (!byIsin.has(row.isin)) byIsin.set(row.isin, []);
    byIsin.get(row.isin).push(row);
  }
  for (const [isin, rows] of byIsin) {
    const tickerRow = rows.find((r) => r.code && !looksLikeIsin(r.code));
    if (tickerRow) map.set(isin, tickerRow.code);
  }
  return map;
}

// Resolves a raw "Код актива" value to a canonical ticker.
// Returns { ticker, resolved, flagged } — flagged=true means "keep the ISIN as
// the grouping key but surface it for manual review" per spec.
export function resolveInstrumentCode(rawCode, isinTickerMap) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!looksLikeIsin(code)) {
    return { ticker: code, resolved: true, flagged: false };
  }
  const ticker = isinTickerMap.get(code);
  if (ticker) {
    return { ticker, resolved: true, flagged: false, isin: code };
  }
  return { ticker: code, resolved: false, flagged: true, isin: code };
}
