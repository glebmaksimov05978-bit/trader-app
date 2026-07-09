// Golden/regression tests for the Tinkoff report import parsers, run as a plain Node
// script (not Jest) because pdfjs-dist ships ESM-only with no CommonJS build, and CRA's
// Jest config transforms everything to CommonJS — the two don't mix without ejecting.
//
// This script reads the REAL production source files fresh on every run (never a stale
// hand-copied duplicate), rewrites their bare relative import specifiers to include the
// ".js" extension Node's ESM loader requires, and writes the result to a temp folder.
// Run with: npm run test:import
//
// Fixtures are real broker report samples and are gitignored (personal financial data);
// this script skips gracefully with a clear message if they're not present locally.

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const importSrcDir = path.join(repoRoot, 'src', 'services', 'import');
const fixturesDir = path.join(importSrcDir, '__fixtures__');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-golden-'));

function esmify(relSrcPath, extraReplacements = []) {
  const abs = path.join(importSrcDir, relSrcPath);
  let text = fs.readFileSync(abs, 'utf8');
  // Append .js to bare relative import/export specifiers ("./foo", "../foo") that don't
  // already have an extension, so Node's strict ESM resolver can find them.
  text = text.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, spec) => {
    if (/\.[a-z]+$/i.test(spec)) return m;
    return `from ${q}${spec}.js${q}`;
  });
  for (const [find, replace] of extraReplacements) text = text.split(find).join(replace);
  const outPath = path.join(tmpDir, path.basename(relSrcPath));
  fs.writeFileSync(outPath, text, 'utf8');
  return pathToFileURL(outPath).href;
}

// Stub the Firebase- and Tinkoff-API-dependent modules importTrades.js pulls in — golden
// tests only exercise parsing + FIFO matching, never real network/Firestore calls.
fs.writeFileSync(path.join(tmpDir, 'trades.js'), `
export async function addTrade() {}
export async function updateTrade() {}
export async function addTradeHistoryEntry() {}
`);
fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), `
export class TinkoffAPI {}
export function parseFutureInfo() { return null; }
`);

const pdfjsLegacyDir = path.join(repoRoot, 'node_modules', 'pdfjs-dist', 'legacy', 'build');
const pdfjsLib = await import(pathToFileURL(path.join(pdfjsLegacyDir, 'pdf.mjs')).href);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfjsLegacyDir, 'pdf.worker.mjs')).href;
globalThis.__PDFJS_OVERRIDE__ = pdfjsLib;

const xlsxMjsUrl = pathToFileURL(path.join(repoRoot, 'node_modules', 'xlsx', 'xlsx.mjs')).href;

esmify('instrumentResolver.js');
const { parseTinkoffXlsx } = await import(esmify('tinkoffXlsx.js', [["from 'xlsx'", `from '${xlsxMjsUrl}'`]]));
const { parseTinkoffPdfExact } = await import(esmify('tinkoffPdf.js'));
const { matchTransactionsToTrades } = await import(esmify('fifoMatcher.js'));
const { filterAlreadyImportedTransactions } = await import(esmify('importTrades.js', [
  ["from '../trades.js'", "from './trades.js'"],
  ["from '../tinkoff.js'", "from './tinkoff.js'"],
]));

class NodeFile {
  constructor(buf) { this._buf = buf; }
  async arrayBuffer() { return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength); }
}

function loadFixture(name) {
  const p = path.join(fixturesDir, name);
  if (!fs.existsSync(p)) return null;
  return new NodeFile(fs.readFileSync(p));
}

let passed = 0, failed = 0, skipped = 0;

// --- Golden counts, verified against real report samples during the 2026-07 debugging
// session. If a future fix changes these numbers, update them deliberately — don't just
// make the test pass, confirm the new number is actually more correct first. ---

async function run() {
  await runTest('july2025.pdf — 92 transactions, 10 repo legs', ['july2025.pdf'], async () => {
    const r = await parseTinkoffPdfExact(loadFixture('july2025.pdf'));
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.transactions.length, 92);
    assert.strictEqual(r.repoOperations.length, 10);
  });

  await runTest('april2026.pdf — low-volume month, 3 transactions', ['april2026.pdf'], async () => {
    const r = await parseTinkoffPdfExact(loadFixture('april2026.pdf'));
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.transactions.length, 3);
  });

  await runTest('junejuly2025.pdf — 99 transactions, 10 repo legs', ['junejuly2025.pdf'], async () => {
    const r = await parseTinkoffPdfExact(loadFixture('junejuly2025.pdf'));
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.transactions.length, 99);
    assert.strictEqual(r.repoOperations.length, 10);
  });

  await runTest('notrades_june2026.pdf — genuinely empty month parses as ok:true, 0 transactions (not a parse failure)', ['notrades_june2026.pdf'], async () => {
    const r = await parseTinkoffPdfExact(loadFixture('notrades_june2026.pdf'));
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.transactions.length, 0);
  });

  await runTest('fullyear2025.xlsx — 232 raw transactions, all IMOEXF legs correctly tagged as futures', ['fullyear2025.xlsx'], async () => {
    const r = await parseTinkoffXlsx(loadFixture('fullyear2025.xlsx'));
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.transactions.length, 232);
    const imoexf = r.transactions.filter((t) => t.ticker === 'IMOEXF');
    assert.ok(imoexf.length > 0, 'expected some IMOEXF transactions');
    assert.ok(imoexf.every((t) => t.isFuture), 'all IMOEXF transactions must be tagged isFuture');
  });

  await runTest('july2025.pdf — position model groups partial closes/re-opens into one row with a legs history', ['july2025.pdf'], async () => {
    const r = await parseTinkoffPdfExact(loadFixture('july2025.pdf'));
    const { matched, unmatchedClosings } = matchTransactionsToTrades(r.transactions, []);
    assert.strictEqual(matched.length, 16, `expected 16 positions, got ${matched.length}`);
    assert.strictEqual(unmatchedClosings.length, 1, `expected 1 unmatched closing (position opened before the report period), got ${unmatchedClosings.length}`);
    assert.ok(matched.every((p) => Array.isArray(p.legs) && p.legs.length >= 1), 'every position must carry a non-empty legs history');
    // Every leg's quantity must sum to the position's total opened/closed volume — catches
    // silent volume loss during partial closes or reversals.
    for (const p of matched) {
      const openedTotal = p.legs.filter((l) => l.type === 'open').reduce((s, l) => s + l.quantity, 0);
      const closedTotal = p.legs.filter((l) => l.type === 'close').reduce((s, l) => s + l.quantity, 0);
      assert.strictEqual(openedTotal, p.volume, `${p.ticker}: opened legs (${openedTotal}) must sum to volume (${p.volume})`);
      assert.strictEqual(p.volume - closedTotal, p.remainingVolume, `${p.ticker}: volume - closed legs must equal remainingVolume`);
    }
    // The POSI position with 3 buys → partial sell → 4 more buys → 5 sells to fully close —
    // the concrete real-world case this whole rewrite was for.
    const multiLeg = matched.find((p) => p.legs.length >= 13);
    assert.ok(multiLeg, 'expected to find the multi-leg POSI position with 13 legs');
    assert.strictEqual(multiLeg.status, 'closed');
  });

  await runTest('fullyear2025.xlsx — FIFO matching leaves 0 unmatched closings on a fresh account', ['fullyear2025.xlsx'], async () => {
    const r = await parseTinkoffXlsx(loadFixture('fullyear2025.xlsx'));
    const { matched, unmatchedClosings } = matchTransactionsToTrades(r.transactions, []);
    assert.strictEqual(unmatchedClosings.length, 0);
    assert.ok(matched.length > 0);
  });

  await runTest('cross-parser: july2025.pdf and the July slice of fullyear2025.xlsx agree on deal count', ['july2025.pdf', 'fullyear2025.xlsx'], async () => {
    const pdf = await parseTinkoffPdfExact(loadFixture('july2025.pdf'));
    const xlsx = await parseTinkoffXlsx(loadFixture('fullyear2025.xlsx'));
    const julyFromXlsx = xlsx.transactions.filter((t) => {
      const d = new Date(t.timestampUtc);
      return d.getUTCFullYear() === 2025 && d.getUTCMonth() === 6; // July
    });
    // The two parsers read different physical documents (a July-only PDF vs. a full-year
    // Excel export) via completely different code paths — this only checks they don't
    // wildly disagree on how many trades July actually had.
    assert.ok(
      Math.abs(pdf.transactions.length - julyFromXlsx.length) <= 3,
      `PDF saw ${pdf.transactions.length} July transactions, xlsx saw ${julyFromXlsx.length}`
    );
  });

  await runTest('overlap dedup: re-importing july2025.pdf after junejuly2025.pdf is already committed produces zero new trades', ['junejuly2025.pdf', 'july2025.pdf'], async () => {
    const wide = await parseTinkoffPdfExact(loadFixture('junejuly2025.pdf'));
    const { matched: wideMatched } = matchTransactionsToTrades(wide.transactions, []);
    const existingTrades = wideMatched.map((t, i) => ({ ...t, id: 'sim' + i }));

    const narrow = await parseTinkoffPdfExact(loadFixture('july2025.pdf'));
    const filtered = filterAlreadyImportedTransactions(narrow.transactions, existingTrades);
    const { matched: narrowMatched, unmatchedClosings } = matchTransactionsToTrades(filtered, existingTrades);

    assert.strictEqual(narrowMatched.length, 0, `expected 0 new trades from the overlapping re-import, got ${narrowMatched.length}`);
    assert.strictEqual(unmatchedClosings.length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

async function runTest(name, requiredFixtures, fn) {
  const missing = requiredFixtures.filter((f) => !fs.existsSync(path.join(fixturesDir, f)));
  if (missing.length) {
    console.log(`SKIP  ${name} (missing fixture: ${missing.join(', ')} — see src/services/import/__fixtures__/README.md)`);
    skipped++;
    return;
  }
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    failed++;
  }
}

await run();
