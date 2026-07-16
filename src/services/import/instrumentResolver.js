// src/services/import/instrumentResolver.js
// Resolves ВНБ (off-exchange) "Код актива" values, which can be an ISIN instead
// of the normal exchange ticker, back to the real ticker using report section
// "4.1 Информация о ценных бумагах" (Наименование актива, Код актива, ISIN, ...).

const FUTURES_MONTH_CODE = {
  F: 0, G: 1, H: 2, J: 3, K: 4, M: 5,
  N: 6, Q: 7, U: 8, V: 9, X: 10, Z: 11,
};

const FUTURES_TICKER_RE = /^[A-Z]{2,6}([FGHJKMNQUVXZ])(\d)$/;

// MOEX perpetual ("вечные") futures have no month+digit expiry code — the ticker is
// just the asset code plus an F suffix: IMOEXF, USDRUBF, CNYRUBF, SBERF, GAZPF, ...
// Minimum 5 chars total so a hypothetical 4-letter stock ticker can't be swallowed
// (all MOEX perpetuals are asset code (≥4 chars) + F). Real user report: typing
// IMOEXF into the Radar auto-detected it as a stock because only the classic
// month+digit pattern was recognized.
const PERPETUAL_FUTURES_RE = /^[A-Z]{4,6}F$/;

export function isFuturesCode(code) {
  const c = String(code || '').toUpperCase();
  return FUTURES_TICKER_RE.test(c) || PERPETUAL_FUTURES_RE.test(c);
}

// Currency spot pairs (CNYRUB_TOM, USDRUB_TOM, EURRUB_TOM, ...) are real speculative
// trades that stay in the journal — this just tags them so they can be filtered
// separately from stocks/futures.
const CURRENCY_PAIR_RE = /^[A-Z]{6}_TOM$/;

export function isCurrencyCode(code) {
  return CURRENCY_PAIR_RE.test(String(code || '').toUpperCase());
}

const PERIOD_RE = /за период\s+(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/;

// Parses "Отчет о сделках и операциях за период DD.MM.YYYY - DD.MM.YYYY" (identical
// wording in both the PDF and xlsx report) into UTC bounds — 00:00 MSK on the start day
// through 23:59:59 MSK on the end day — so a sanity check can flag a transaction whose
// date falls outside the very report it was parsed from (a sign of a parser mis-read).
export function parseReportPeriod(text) {
  const m = PERIOD_RE.exec(text || '');
  if (!m) return null;
  const [, d1, mo1, y1, d2, mo2, y2] = m.map((v, i) => (i === 0 ? v : parseInt(v, 10)));
  return {
    start: new Date(Date.UTC(y1, mo1 - 1, d1, -3, 0, 0)),
    end: new Date(Date.UTC(y2, mo2 - 1, d2, 20, 59, 59)),
  };
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
