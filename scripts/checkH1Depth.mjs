import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-h1depth-'));

function esmify(srcAbsPath, extraReplacements = []) {
  let text = fs.readFileSync(srcAbsPath, 'utf8');
  text = text.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, spec) => {
    if (/\.[a-z]+$/i.test(spec)) return m;
    return `from ${q}${spec}.js${q}`;
  });
  for (const [find, replace] of extraReplacements) text = text.split(find).join(replace);
  const outPath = path.join(tmpDir, path.basename(srcAbsPath));
  fs.writeFileSync(outPath, text, 'utf8');
  return pathToFileURL(outPath).href;
}

fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), `
export class TinkoffAPI {}
export function moneyToFloat() { return 0; }
`);

const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

console.log('Запрашиваю H1 IMOEXF с lookbackDays=3000 (много больше, чем 135)...\n');
const t0 = Date.now();
const candles = await fetchDailyCandles({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'H1', lookbackDays: 3000 });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`Получено ${candles.length} часовых баров за ${seconds}с`);
console.log(`Первая свеча: ${new Date(candles[0].date).toISOString()}`);
console.log(`Последняя свеча: ${new Date(candles[candles.length - 1].date).toISOString()}`);
const spanDays = (candles[candles.length - 1].date - candles[0].date) / 86400000;
console.log(`Реальная глубина истории: ~${Math.round(spanDays)} календарных дней`);

fs.rmSync(tmpDir, { recursive: true, force: true });
