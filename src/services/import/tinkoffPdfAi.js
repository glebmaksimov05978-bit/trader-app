// src/services/import/tinkoffPdfAi.js
import { resolveInstrumentCode, buildIsinTickerMap, isFuturesCode, isCurrencyCode, parseReportPeriod } from './instrumentResolver.js';

// Same lazy-loading contract as tinkoffPdf.js: browser build on demand, or the
// Node-compatible build injected via globalThis.__PDFJS_OVERRIDE__ in tests.
let pdfjsPromise = null;
function getPdfjs() {
  if (globalThis.__PDFJS_OVERRIDE__) return Promise.resolve(globalThis.__PDFJS_OVERRIDE__);
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}

const REQUIRED_FIELDS = [
  'dealNumber', 'date', 'time', 'exchange', 'dealType', 'assetName',
  'code', 'price', 'currency', 'quantity', 'amount', 'commission',
];

async function extractRawText(file) {
  const pdfjsLib = await getPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((i) => i.str).join(' ') + '\n';
  }
  return text;
}

function mskToUtc(dateStr, timeStr) {
  const [d, m, y] = dateStr.split('.').map((x) => parseInt(x, 10));
  const [hh, mm, ss] = (timeStr || '00:00:00').split(':').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d, hh - 3, mm, ss || 0));
}

function validateRow(row) {
  for (const f of REQUIRED_FIELDS) {
    if (row[f] === undefined || row[f] === null || row[f] === '') return `missing field ${f}`;
  }
  if (!['Покупка', 'Продажа', 'РЕПО 1', 'РЕПО 2'].includes(row.dealType)) return `unknown dealType ${row.dealType}`;
  if (Number.isNaN(parseFloat(row.price)) || Number.isNaN(parseFloat(row.quantity))) return 'unparseable numbers';
  return null;
}

export async function parseTinkoffPdfViaAI(file) {
  const rawText = await extractRawText(file);

  const res = await fetch('/api/parse-tinkoff-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawText }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('AI-парсинг не удался: ' + err);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const section41Rows = data.section41 || [];
  const isinTickerMap = buildIsinTickerMap(section41Rows);

  const errors = [];
  const executed = [];
  const unexecuted = data.unexecuted || [];
  const cancelled = data.cancelled || [];

  for (const row of data.transactions || []) {
    const err = validateRow(row);
    if (err) { errors.push({ row, error: err }); continue; }
    if (row.executedFlag) continue;

    const dealType = row.dealType;
    let side;
    if (dealType === 'Покупка' || dealType === 'РЕПО 2') side = 'buy';
    else if (dealType === 'Продажа' || dealType === 'РЕПО 1') side = 'sell';
    else { errors.push({ row, error: 'unhandled dealType' }); continue; }

    const isFuture = isFuturesCode(row.code);
    const resolved = resolveInstrumentCode(row.code, isinTickerMap);

    executed.push({
      dealNumber: String(row.dealNumber),
      dealType,
      isRepo: dealType.startsWith('РЕПО'),
      exchange: row.exchange,
      assetName: row.assetName,
      rawCode: row.code,
      ticker: resolved.ticker,
      isin: resolved.isin || null,
      needsReview: resolved.flagged,
      price: parseFloat(row.price),
      quantity: parseFloat(row.quantity),
      amount: isFuture ? null : parseFloat(row.amount),
      side,
      commission: parseFloat(row.commission) || 0,
      currency: row.currency,
      timestampUtc: mskToUtc(row.date, row.time),
      isFuture,
      instrumentType: isCurrencyCode(resolved.ticker) ? 'currency' : (isFuture ? 'future' : 'stock'),
      tradeMode: row.tradeMode || '',
      parseMethod: 'ai',
    });
  }

  const repoOperations = executed.filter((t) => t.isRepo);
  const transactions = executed.filter((t) => !t.isRepo);

  return {
    ok: true,
    transactions,
    repoOperations,
    reportPeriod: parseReportPeriod(rawText),
    unexecutedCount: unexecuted.length,
    cancelledCount: cancelled.length,
    flaggedForReview: executed.filter((t) => t.needsReview).map((t) => t.dealNumber),
    invalidRows: errors,
    parseMethod: 'ai',
  };
}
