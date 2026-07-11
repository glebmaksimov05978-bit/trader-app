// src/services/import/tinkoffXlsx.js
import * as XLSX from 'xlsx';
import { resolveInstrumentCode, buildIsinTickerMap, isFuturesCode, isCurrencyCode, parseReportPeriod } from './instrumentResolver';

function normNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\n/g, '').replace(/\s/g, '').replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// Cell text can contain hard line breaks ("РЕПО 1\nПродажа") — collapse ALL whitespace
// to single spaces rather than deleting it, otherwise adjacent words fuse ("РЕПО 1Продажа")
// and enum matching below silently fails.
function normStr(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function mskToUtc(dateStr, timeStr) {
  // dateStr DD.MM.YYYY, timeStr HH:MM:SS, MSK = UTC+3
  const [d, m, y] = dateStr.split('.').map((x) => parseInt(x, 10));
  const [hh, mm, ss] = (timeStr || '00:00:00').split(':').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d, hh - 3, mm, ss || 0));
}

function sectionHeaderMatch(cell) {
  const s = normStr(cell);
  return s.includes('1.1') && s.toLowerCase().includes('информац');
}

function findSectionBounds(rows, startMarker, endMarkers) {
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    const first = normStr(rows[i]?.[0]);
    if (startMarker(first, rows[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = rows.length;
  for (let i = start + 1; i < rows.length; i++) {
    const first = normStr(rows[i]?.[0]);
    if (endMarkers.some((fn) => fn(first))) { end = i; break; }
  }
  return { start, end };
}

function parseSection41(rows) {
  const bounds = findSectionBounds(
    rows,
    (first) => first.includes('4.1') && first.toLowerCase().includes('информац'),
    [(first) => /^4\.[2-9]/.test(first) || /^5\./.test(first)]
  );
  if (!bounds) return [];
  const dataStart = bounds.start + 2; // skip section title + header row
  const out = [];
  for (let i = dataStart; i < bounds.end; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    // Merged-cell layout: only the top-left cell of each merge range is populated,
    // so these are fixed offsets observed in real report samples, not sequential columns.
    const name = normStr(row[0]);
    const code = normStr(row[16]);
    const isin = normStr(row[22]);
    if (!code && !isin) continue;
    out.push({ name, code, isin, regCode: normStr(row[33]), type: normStr(row[55]), issuer: normStr(row[69]) });
  }
  return out;
}

// Section 4.3 lists every derivative traded this period with its "Код контракта" — the
// authoritative futures-code list, since not every futures ticker follows the standard
// month-letter+year-digit naming (e.g. "IMOEXF" has no trailing digit).
function parseSection43FuturesCodes(rows) {
  const bounds = findSectionBounds(
    rows,
    (first) => first.includes('4.3') && first.toLowerCase().includes('информац'),
    [(first) => /^4\.[4-9]/.test(first) || /^5\./.test(first)]
  );
  if (!bounds) return new Set();
  const dataStart = bounds.start + 2; // skip section title + header row
  const out = new Set();
  for (let i = dataStart; i < bounds.end; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const code = normStr(row[31]);
    if (code) out.add(code);
  }
  return out;
}

// Fixed physical column offsets in the sheet, derived from the section-1.1 header
// row of real report samples (merged cells only populate their top-left cell, so
// these do not line up with the conceptual 1..34 column numbering from the spec).
const COL = {
  dealNumber: 0, order: 3, executedFlag: 6, date: 8, time: 9, exchange: 12,
  dealType: 15, assetName: 17, code: 19, price: 21, priceCcy: 23, quantity: 26,
  amountNoAccrued: 28, accrued: 32, dealAmount: 34, settleCcy: 38,
  brokerComm: 39, exchComm: 45, clearComm: 50, stamp: 57, repoRate: 60,
  tradeMode: 83,
};

function rowToTransaction(row, futuresCodeSet) {
  const executedFlag = normStr(row[COL.executedFlag]);
  if (executedFlag) return null; // non-empty => not executed, skip
  const dealType = normStr(row[COL.dealType]);
  const code = normStr(row[COL.code]).replace(/\s+/g, '');
  const price = normNum(row[COL.price]);
  const quantity = normNum(row[COL.quantity]);
  const amountNoAccrued = normNum(row[COL.amountNoAccrued]);
  const accrued = normNum(row[COL.accrued]) || 0;
  const dealAmount = normNum(row[COL.dealAmount]);
  const brokerComm = normNum(row[COL.brokerComm]) || 0;
  const exchComm = normNum(row[COL.exchComm]) || 0;
  const clearComm = normNum(row[COL.clearComm]) || 0;
  const stamp = normNum(row[COL.stamp]) || 0;

  const isFuture = isFuturesCode(code) || futuresCodeSet.has(code);
  const amount = isFuture ? null : (dealAmount ?? ((amountNoAccrued || 0) + accrued));

  // "Вид сделки" for repo legs is a two-line cell ("РЕПО 1" + "Продажа"), so match by
  // prefix rather than strict equality — РЕПО 1 is always the selling leg, РЕПО 2 the
  // buy-back leg, regardless of the second line.
  let side;
  if (dealType.startsWith('РЕПО 1')) side = 'sell';
  else if (dealType.startsWith('РЕПО 2')) side = 'buy';
  else if (dealType.startsWith('Покупка')) side = 'buy';
  else if (dealType.startsWith('Продажа')) side = 'sell';
  else return null;

  return {
    dealNumber: normStr(row[COL.dealNumber]).replace(/\s+/g, ''),
    dealType,
    isRepo: dealType.startsWith('РЕПО'),
    exchange: normStr(row[COL.exchange]),
    assetName: normStr(row[COL.assetName]),
    rawCode: code,
    price,
    quantity,
    amount,
    amountNoAccrued,
    side,
    commission: brokerComm + exchComm + clearComm + stamp,
    currency: normStr(row[COL.priceCcy]),
    timestampUtc: mskToUtc(normStr(row[COL.date]), normStr(row[COL.time])),
    isFuture,
    tradeMode: normStr(row[COL.tradeMode]),
  };
}

export async function parseTinkoffXlsx(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellText: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (sectionHeaderMatch(rows[i]?.[0])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: 'Не найдена секция 1.1 в отчёте' };
  }

  let reportPeriod = null;
  for (let i = 0; i < Math.min(headerIdx, 10); i++) {
    reportPeriod = parseReportPeriod(normStr(rows[i]?.[0]));
    if (reportPeriod) break;
  }

  const section41Rows = parseSection41(rows);
  const isinTickerMap = buildIsinTickerMap(section41Rows);
  const futuresCodeSet = parseSection43FuturesCodes(rows);

  const dataStart = headerIdx + 2;
  const executed = [];
  const unexecutedRows = [];
  const cancelledRows = [];
  // Rows that look like a real deal (deal-number-shaped, not flagged "unexecuted") but
  // failed to parse into a transaction for some other reason — a parser bug silently
  // dropping a real row, as opposed to legitimately-skipped noise.
  const unparsedDealNumbers = [];
  let currentSection = '1.1';
  let flagged = [];

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const first = normStr(row?.[0]);
    if (first.includes('1.2') && first.toLowerCase().includes('неисполн')) { currentSection = '1.2'; continue; }
    if (first.includes('1.3')) { currentSection = '1.3'; continue; }
    // Top-level section titles are "N. Title" (digit, dot, space — e.g. "2. Операции с
    // денежными средствами"), not "N.M" like sub-sections ("3.1 Движение..."). Match both.
    if (/^[2-9]\./.test(first)) break;
    if (!row || row.length < 30) continue;
    // Deal numbers can be alphanumeric IDs for ВНБ (off-exchange) trades, not just digits,
    // and long IDs can wrap across lines within the cell — strip the normStr()-inserted
    // spaces before checking, same as the value returned from rowToTransaction().
    const dealNumber = normStr(row[0]).replace(/\s+/g, '');
    if (!dealNumber || !/^[A-Za-z0-9]+$/.test(dealNumber)) continue;

    if (currentSection === '1.2') { unexecutedRows.push(row); continue; }
    if (currentSection === '1.3') { cancelledRows.push(row); continue; }

    const tx = rowToTransaction(row, futuresCodeSet);
    if (!tx) {
      if (!normStr(row[COL.executedFlag])) unparsedDealNumbers.push(dealNumber);
      continue;
    }
    const resolved = resolveInstrumentCode(tx.rawCode, isinTickerMap);
    tx.ticker = resolved.ticker;
    tx.isin = resolved.isin || null;
    tx.needsReview = resolved.flagged;
    tx.instrumentType = isCurrencyCode(resolved.ticker) ? 'currency' : (tx.isFuture ? 'future' : 'stock');
    if (resolved.flagged) flagged.push(tx.dealNumber);
    executed.push(tx);
  }

  const repoOperations = executed.filter((t) => t.isRepo);
  const transactions = executed.filter((t) => !t.isRepo);

  return {
    ok: true,
    transactions,
    repoOperations,
    reportPeriod,
    unparsedDealNumbers,
    unexecutedCount: unexecutedRows.length,
    cancelledCount: cancelledRows.length,
    flaggedForReview: flagged,
    parseMethod: 'exact',
  };
}
