// src/services/import/tinkoffPdf.js
import { resolveInstrumentCode, buildIsinTickerMap, isFuturesCode, isCurrencyCode, parseReportPeriod } from './instrumentResolver.js';

// pdfjs is loaded lazily: the ~400KB library only downloads when the user actually
// imports a report (smaller main bundle), and tests running under plain Node can inject
// the Node-compatible legacy build via globalThis.__PDFJS_OVERRIDE__ instead of the
// browser build. CRA can't bundle the pdf.js worker without ejecting, so in the browser
// the worker comes from a CDN pinned to the installed pdfjs-dist version.
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

// Tinkoff renders section 1.1 as a TRANSPOSED table: the 34 field labels run down a
// fixed header column (one per page, page 1 only), and each trade is a narrow vertical
// strip to the right of it, growing wider as needed. Short adjacent field values often
// get fused into a single PDF text run by the renderer (e.g. date+time+exchange+dealtype
// all become one string) — that's handled by splitMergedFields() below, calibrated
// against real report samples.
const FIELD_KEYS = [
  'dealNumber', 'orderNumber', 'executedFlag', 'date', 'time', 'exchange', 'dealType',
  'assetName', 'code', 'price', 'priceCcy', 'quantity', 'amountNoAccrued', 'accrued',
  'dealAmount', 'settleCcy', 'commBroker', 'commBrokerCcy', 'commExch', 'commExchCcy',
  'commClear', 'commClearCcy', 'stamp', 'stampCcy', 'repoRate', 'settleDate', 'deliveryDate',
  'brokerStatus', 'contractType', 'contractNumber', 'contractDate', 'settleType', 'tradeMode', 'counterparty',
];
const IDX = Object.fromEntries(FIELD_KEYS.map((k, i) => [k, i]));

const HEADER_MERGE_Y_GAP = 9.0; // max y-gap between two lines of the same wrapped header label
const COLUMN_GAP_THRESHOLD = 12; // min x-gap that separates two different trade columns
const FIELD_MATCH_TOLERANCE = 15; // max y-distance for a data item to "belong" to a field

const SECTION_BOUNDARY_PATTERNS = [
  /^1\.2\s|неисполненных/i,
  /^1\.3\s/,
  /2\.\s*Операции с денежными/i,
];

function normNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/\n/g, '').replace(/\s/g, '').replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

function mskToUtc(dateStr, timeStr) {
  if (!dateStr) return null;
  const [d, m, y] = dateStr.split('.').map((x) => parseInt(x, 10));
  const [hh, mm, ss] = (timeStr || '00:00:00').split(':').map((x) => parseInt(x, 10));
  if (!d || !m || !y) return null;
  return new Date(Date.UTC(y, m - 1, d, hh - 3, mm, ss || 0));
}

async function extractPageItems(page) {
  const content = await page.getTextContent();
  return content.items
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
    .filter((it) => it.str.trim() !== '');
}

// Glue a continuation text fragment onto the field value built so far. Numeric and
// Latin/digit ID fragments (prices split across a decimal point, alphanumeric deal IDs
// wrapped mid-token) glue with no space; natural-language word wraps (Cyrillic asset
// names) get a space.
function glue(acc, next) {
  if (!acc) return next;
  if (/^\d+(\.\d+)?$/.test(next) && /[\d.,]$/.test(acc)) return acc + next;
  if (/^[A-Za-z0-9]+$/.test(next) && /[A-Za-z0-9]$/.test(acc)) return acc + next;
  return acc + ' ' + next;
}

function buildFieldList(page1Items) {
  const xCounts = new Map();
  for (const it of page1Items) {
    const key = Math.round(it.x);
    xCounts.set(key, (xCounts.get(key) || 0) + 1);
  }
  let headerX = null, best = 0;
  for (const [x, c] of xCounts) if (c > best) { best = c; headerX = x; }
  if (headerX === null) return { headerX: null, fieldYs: [] };

  const headerItems = page1Items.filter((it) => Math.abs(it.x - headerX) < 2).sort((a, b) => a.y - b.y);
  const fieldYs = [];
  for (const it of headerItems) {
    if (fieldYs.length && (it.y - fieldYs[fieldYs.length - 1]) <= HEADER_MERGE_Y_GAP) continue;
    fieldYs.push(it.y);
  }
  return { headerX, fieldYs };
}

function clusterColumns(items) {
  const uniqXs = [...new Set(items.map((i) => Math.round(i.x * 100) / 100))].sort((a, b) => a - b);
  const clusters = [];
  for (const x of uniqXs) {
    if (clusters.length && x - clusters[clusters.length - 1].maxX <= COLUMN_GAP_THRESHOLD) {
      clusters[clusters.length - 1].maxX = x;
    } else {
      clusters.push({ minX: x, maxX: x });
    }
  }
  return clusters.map((c) => ({
    baseX: c.minX,
    items: items.filter((i) => i.x >= c.minX - 0.5 && i.x <= c.maxX + 0.5).sort((a, b) => a.y - b.y || a.x - b.x),
  }));
}

// Assigns each transaction column's items to the 34 logical fields. "Primary" items sit
// at the column's base x (one per non-empty field, in top-to-bottom / field order);
// "continuation" items (indented sub-lines from wrapped cell content) glue onto whichever
// field the nearest preceding primary item claimed.
function alignColumnToFields(column, fieldYs) {
  const primary = column.items.filter((it) => Math.abs(it.x - column.baseX) < 1.5);
  const cols = new Array(fieldYs.length).fill('');
  let fieldPtr = 0;
  const claims = new Map();
  for (const p of primary) {
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = fieldPtr; i < fieldYs.length; i++) {
      if (fieldYs[i] > p.y + FIELD_MATCH_TOLERANCE) break;
      const diff = Math.abs(fieldYs[i] - p.y);
      if (diff <= FIELD_MATCH_TOLERANCE && diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      claims.set(p, bestIdx);
      fieldPtr = bestIdx + 1;
    }
  }
  let currentField = -1;
  for (const it of column.items) {
    if (claims.has(it)) {
      currentField = claims.get(it);
      cols[currentField] = it.str;
    } else if (currentField >= 0) {
      cols[currentField] = glue(cols[currentField], it.str);
    }
  }
  return cols;
}

// Some short adjacent fields get fused by the PDF renderer into a single text run.
// Redistribute the known cases back into their own columns.
function splitMergedFields(cols) {
  const dateBlob = cols[IDX.date] || '';
  const m = dateBlob.match(/^(\d{2}\.\d{2}\.\d{4})\s*(\d{2}:\d{2}:\d{2})?\s*(ММВБ|ВНБ)?\s*(Покупка|Продаж\s*а|Продажа|РЕПО\s*1|РЕПО\s*2)?\s*(.*)$/);
  if (m) {
    const [, date, time, exch, dealtype, rest] = m;
    cols[IDX.date] = date;
    if (time) cols[IDX.time] = time;
    if (exch) cols[IDX.exchange] = exch;
    if (dealtype) cols[IDX.dealType] = dealtype;
    if (rest && rest.trim()) {
      cols[IDX.assetName] = (rest.trim() + (cols[IDX.assetName] ? ' ' + cols[IDX.assetName] : '')).trim();
    }
  }
  // Short asset names ("Мечел ао MTLR") fit on the same line as the merged date blob
  // above, with the ticker as the trailing token — split it into its own field if the
  // code column didn't get a separate primary item of its own.
  if (!cols[IDX.code] && cols[IDX.assetName]) {
    const codeMatch = cols[IDX.assetName].match(/\s([A-Z][A-Z0-9]{2,11})$/);
    if (codeMatch) {
      cols[IDX.code] = codeMatch[1];
      cols[IDX.assetName] = cols[IDX.assetName].slice(0, codeMatch.index).trim();
    }
  }
  const mQty = (cols[IDX.quantity] || '').match(/^([\d,]+\.\d+)\s+([\d,]+\.\d+)$/);
  if (mQty) {
    cols[IDX.quantity] = mQty[1];
    if (!cols[IDX.amountNoAccrued]) cols[IDX.amountNoAccrued] = mQty[2];
  }
  const mAccrued = (cols[IDX.accrued] || '').match(/^([\d,]+\.\d+)\s+([\d,]+\.\d+)(?:\s+(RUB))?$/);
  if (mAccrued) {
    cols[IDX.accrued] = mAccrued[1];
    if (!cols[IDX.dealAmount]) cols[IDX.dealAmount] = mAccrued[2];
    if (mAccrued[3] && !cols[IDX.settleCcy]) cols[IDX.settleCcy] = mAccrued[3];
  }
  return cols;
}

function rowToTransaction(cols, isinTickerMap, futuresCodeSet) {
  const dealNumber = cols[IDX.dealNumber];
  if (!dealNumber || !/^[A-Za-z0-9]+$/.test(dealNumber) || dealNumber.length < 4) return null;
  const executedFlag = cols[IDX.executedFlag];
  if (executedFlag) return null;

  const dealTypeRaw = (cols[IDX.dealType] || '').replace(/\s+/g, '');
  let side;
  if (dealTypeRaw.startsWith('Покупка')) side = 'buy';
  else if (dealTypeRaw.startsWith('Продажа')) side = 'sell';
  else if (dealTypeRaw.startsWith('РЕПО1')) side = 'sell';
  else if (dealTypeRaw.startsWith('РЕПО2')) side = 'buy';
  else return null;
  const isRepo = dealTypeRaw.startsWith('РЕПО');

  const code = (cols[IDX.code] || '').replace(/\s+/g, '');
  if (!code) return null;
  const isFuture = isFuturesCode(code) || futuresCodeSet.has(code);
  const price = normNum(cols[IDX.price]);
  const quantity = normNum(cols[IDX.quantity]);
  const dealAmount = normNum(cols[IDX.dealAmount]);
  const brokerComm = normNum(cols[IDX.commBroker]) || 0;
  const exchComm = normNum(cols[IDX.commExch]) || 0;
  const clearComm = normNum(cols[IDX.commClear]) || 0;
  const stamp = normNum(cols[IDX.stamp]) || 0;

  if (price === null || quantity === null) return null;
  const timestampUtc = mskToUtc(cols[IDX.date], cols[IDX.time]);
  if (!timestampUtc || Number.isNaN(timestampUtc.getTime())) return null;

  const resolved = resolveInstrumentCode(code, isinTickerMap);

  return {
    dealNumber,
    dealType: dealTypeRaw,
    isRepo,
    exchange: cols[IDX.exchange],
    assetName: (cols[IDX.assetName] || '').replace(/\s+/g, ' ').trim(),
    rawCode: code,
    ticker: resolved.ticker,
    isin: resolved.isin || null,
    needsReview: resolved.flagged,
    price,
    quantity,
    amount: isFuture ? null : dealAmount,
    side,
    commission: brokerComm + exchComm + clearComm + stamp,
    currency: cols[IDX.priceCcy],
    timestampUtc,
    isFuture,
    instrumentType: isCurrencyCode(code) ? 'currency' : (isFuture ? 'future' : 'stock'),
    tradeMode: (cols[IDX.tradeMode] || '').replace(/\s+/g, ''),
    parseMethod: 'exact',
  };
}

// Sections 4.1/4.3 use the SAME transposed layout as section 1.1 (fixed header column,
// one instrument per rightward column), just laid out as adjacent horizontal bands that
// can share a page with neighboring sections (e.g. "4.1 ... 4.2 ... 4.3 ... 4.4" side by
// side). Locate a section by its title marker and the next section's title marker (which
// bounds its x-range), then reuse the same field-alignment machinery as section 1.1.
function findMarkerItem(pages, re) {
  for (let pi = 0; pi < pages.length; pi++) {
    const item = pages[pi].items.find((it) => re.test(it.str));
    if (item) return { pageIdx: pi, x: item.x };
  }
  return null;
}

function extractTransposedSection(pages, markerRe, nextMarkerRe) {
  const start = findMarkerItem(pages, markerRe);
  if (!start) return { fieldYs: [], columns: [] };
  const next = findMarkerItem(pages, nextMarkerRe);
  const endPageIdx = next ? next.pageIdx : pages.length - 1;

  const sectionItems = [];
  for (let pi = start.pageIdx; pi <= endPageIdx; pi++) {
    // Only the start page needs a lower x-bound (to skip whatever precedes the marker on
    // that page); a page the section continues onto restarts flush-left, same as section
    // 1.1's trade columns across pages. Only the page holding the NEXT marker needs an
    // upper x-bound (to stop before that section's own content).
    const minX = pi === start.pageIdx ? start.x + 1 : -Infinity;
    const maxX = (next && next.pageIdx === pi) ? next.x : Infinity;
    for (const it of pages[pi].items) {
      if (it.x > minX && it.x < maxX) sectionItems.push(it);
    }
  }
  if (sectionItems.length === 0) return { fieldYs: [], columns: [] };

  const headerX = Math.min(...sectionItems.map((it) => it.x));
  const headerItems = sectionItems.filter((it) => Math.abs(it.x - headerX) < 2).sort((a, b) => a.y - b.y);
  const fieldYs = [];
  for (const it of headerItems) {
    if (fieldYs.length && (it.y - fieldYs[fieldYs.length - 1]) <= HEADER_MERGE_Y_GAP) continue;
    fieldYs.push(it.y);
  }
  const dataItems = sectionItems.filter((it) => it.x > headerX + 2);
  const columns = clusterColumns(dataItems).map((col) => alignColumnToFields(col, fieldYs));
  return { fieldYs, columns };
}

// Sections 1.2 (unexecuted orders) and 1.3 (deals cancelled other than by execution) use
// the same transposed per-column layout as 1.1, but usually have zero data columns (just
// the header) when nothing happened that period — count real order columns, ignoring the
// page-footer "N из M" pagination marker, which can land in the same x-range as a column.
function extractSectionRowCount(pages, markerRe, nextMarkerRe) {
  const start = findMarkerItem(pages, markerRe);
  if (!start) return 0;
  const next = findMarkerItem(pages, nextMarkerRe);
  const endPageIdx = next ? next.pageIdx : pages.length - 1;

  const sectionItems = [];
  for (let pi = start.pageIdx; pi <= endPageIdx; pi++) {
    const minX = pi === start.pageIdx ? start.x + 1 : -Infinity;
    const maxX = (next && next.pageIdx === pi) ? next.x : Infinity;
    for (const it of pages[pi].items) {
      if (it.x > minX && it.x < maxX && !/^\d+\s*из\s*\d+$/.test(it.str.trim())) sectionItems.push(it);
    }
  }
  if (sectionItems.length === 0) return 0;

  const headerX = Math.min(...sectionItems.map((it) => it.x));
  const dataItems = sectionItems.filter((it) => it.x > headerX + 2);
  if (dataItems.length === 0) return 0;
  return clusterColumns(dataItems).length;
}

function extractSection41(pages) {
  const { columns } = extractTransposedSection(
    pages, /4\.1\s*Информация о ценных бумагах/, /4\.2\s*Информация/
  );
  // field order: Наименование актива, Код актива, ISIN, Код гос. регистрации, Тип, Наименование эмитента
  return columns
    .map((c) => ({ name: c[0], code: (c[1] || '').replace(/\s+/g, ''), isin: (c[2] || '').replace(/\s+/g, '') }))
    .filter((r) => r.code);
}

function extractSection43FuturesCodes(pages) {
  const { columns } = extractTransposedSection(
    pages, /4\.3\s*Информация о производных/, /4\.4\s*Информация/
  );
  // field order: Вид контракта, Наименование контракта, Код контракта, ...
  return new Set(columns.map((c) => (c[2] || '').replace(/\s+/g, '')).filter(Boolean));
}

export async function parseTinkoffPdfExact(file) {
  try {
    const pdfjsLib = await getPdfjs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;

    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const items = await extractPageItems(page);
      pages.push({ pageNum: p, items });
    }

    let reportPeriod = null;
    for (const it of pages[0]?.items || []) {
      reportPeriod = parseReportPeriod(it.str);
      if (reportPeriod) break;
    }

    const section41Rows = extractSection41(pages);
    const isinTickerMap = buildIsinTickerMap(section41Rows);
    const futuresCodeSet = extractSection43FuturesCodes(pages);

    const { headerX, fieldYs } = buildFieldList(pages[0]?.items || []);
    if (!headerX || fieldYs.length < 30) {
      return { ok: false, reason: 'Не удалось найти заголовок таблицы 1.1 в PDF' };
    }

    const executed = [];
    // Columns that look like a real deal (a deal-number-shaped first field, not flagged
    // "unexecuted") but failed to parse into a transaction for some other reason — a
    // parser bug losing a real row silently, as opposed to legitimately-skipped noise.
    const unparsedDealNumbers = [];
    let columnsAttempted = 0;
    let done = false;

    for (const page of pages) {
      if (done) break;

      // Section 1.2 (and later sections) don't always start on a fresh page — Tinkoff
      // can pack section 1.1's tail and 1.2's header side by side as horizontal bands
      // on the SAME page (same trick as 4.1/4.2/4.3/4.4 sharing a page). So the section
      // boundary must be found by x-position of the marker item, not by page text alone.
      const boundaryItem = page.items.find((it) => SECTION_BOUNDARY_PATTERNS.some((re) => re.test(it.str)));
      const maxX = boundaryItem ? boundaryItem.x : Infinity;
      if (boundaryItem) done = true;

      // Only page 1 carries the letterhead (Брокер/Дата расчета/Инвестор block, all at
      // x < headerX) and the header column itself — both need excluding there. On later
      // pages trade columns restart flush left with no letterhead, so neither exclusion
      // applies (a real column can otherwise coincidentally land near headerX there).
      const dataItems = page.items.filter((it) =>
        (page.pageNum !== 1 || (it.x > headerX - 5 && Math.abs(it.x - headerX) > 2)) &&
        it.x < maxX &&
        it.y < 815 &&
        !/^\d+\s*из\s*\d+$/.test(it.str.trim())
      );
      if (dataItems.length === 0) continue;

      for (const column of clusterColumns(dataItems)) {
        columnsAttempted++;
        const cols = splitMergedFields(alignColumnToFields(column, fieldYs));
        const tx = rowToTransaction(cols, isinTickerMap, futuresCodeSet);
        if (tx) { executed.push(tx); continue; }
        const dealNumber = cols[IDX.dealNumber];
        const looksLikeDeal = dealNumber && /^[A-Za-z0-9]+$/.test(dealNumber) && dealNumber.length >= 4;
        if (looksLikeDeal && !cols[IDX.executedFlag]) unparsedDealNumbers.push(dealNumber);
      }
    }

    // A genuinely trade-free period (section 1.2's header sits immediately after 1.1's
    // with no columns in between) is a valid result, not a parse failure — only bail to
    // the AI fallback if we saw column-shaped data that failed to parse into a transaction.
    if (executed.length === 0 && columnsAttempted > 0) {
      return { ok: false, reason: 'В отчёте не найдено ни одной строки сделки' };
    }

    const repoOperations = executed.filter((t) => t.isRepo);
    const transactions = executed.filter((t) => !t.isRepo);

    const unexecutedCount = extractSectionRowCount(
      pages, /^1\.2\s*Информация о неисполненных/, /^1\.3\s*Сделки за расчетный период/
    );
    const cancelledCount = extractSectionRowCount(
      pages, /^1\.3\s*Сделки за расчетный период/, /^2\.\s*Операции с денежными/
    );

    return {
      ok: true,
      transactions,
      repoOperations,
      reportPeriod,
      unparsedDealNumbers,
      unexecutedCount,
      cancelledCount,
      flaggedForReview: executed.filter((t) => t.needsReview).map((t) => t.dealNumber),
      parseMethod: 'exact',
    };
  } catch (e) {
    return { ok: false, reason: 'Ошибка детерминированного парсинга PDF: ' + e.message };
  }
}
