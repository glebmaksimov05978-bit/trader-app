// Диагностика (2026-08-13): трейдер не понимает, ПОЧЕМУ стоп ухудшает результат и почему
// без стопа худшая закрытая сделка всего -2.2%, хотя он живьём видит сделку на -18%.
//
// Гипотеза, которую проверяем: в режиме "без стопа + следящий выход" убытки не
// ОТСУТСТВУЮТ, а НЕ ФИКСИРУЮТСЯ. Следящий выход включается только после того, как цена
// прошла в НАШУ пользу хотя бы trailMinPeak. Если после входа цена сразу пошла против —
// порог никогда не достигается, выхода нет вообще, позиция висит до конца истории и
// попадает в status:'open', то есть ИСКЛЮЧАЕТСЯ из винрейта/доходности. Значит красивый
// винрейт 87-90% может быть артефактом: закрываются только выигрышные сделки.
//
// Печатаем по одному инструменту: все сделки (закрытые + открытые) с тем, что было с
// ценой после входа — насколько ушла против, насколько в плюс, чем закончилось.
//
// Run: node scripts/trailDiagnostics.mjs [TICKER] [D1|H1]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-traildiag-'));

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

esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
esmify(path.join(repoRoot, 'src/services/analytics/candlestickPatterns.js'));
esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'));
esmify(path.join(repoRoot, 'src/services/analytics/marketContext.js'));
esmify(path.join(repoRoot, 'src/services/analytics/exitRules.js'));
esmify(path.join(repoRoot, 'src/services/analytics/strategy.js'));
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
const { runBacktest } = await import(
  esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
    ["from '../analytics/", "from './"],
    ["from '../../utils/calculator.js'", "from './calculator.js'"],
  ])
);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

const TICKER = process.argv[2] || 'IMOEXF';
const TF = process.argv[3] || 'D1';
const INSTRUMENT_TYPE = TICKER === 'IMOEXF' ? 'future' : 'stock';

const STRATEGY = {
  id: 'patterns_levels', name: 'Фигуры разворота + уровень', readinessThreshold: 75,
  conditions: [
    { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
    { id: 'near_support', enabled: true, param: 1, direction: 'long' },
    { id: 'near_resistance', enabled: true, param: 1, direction: 'short' },
    { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
    { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
  ],
  customConditions: [],
};

const RULES = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null,
  stopType: 'none', takeType: 'none',
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
};

const candles = await fetchDailyCandles({
  ticker: TICKER, instrumentType: INSTRUMENT_TYPE, toDate: new Date(),
  timeframe: TF, lookbackDays: TF === 'D1' ? 2200 : 135,
});
console.log(`${TICKER} ${TF}: ${candles.length} свечей\n`);

const run = runBacktest({
  candles, strategy: STRATEGY,
  timeframeMinutes: TF === 'D1' ? 1440 : 60, exitRules: RULES,
});

// Для каждой сделки восстанавливаем, что было с ценой ПОСЛЕ входа: максимум в свою
// пользу (MFE) и максимум против (MAE). Это и есть прямой ответ на вопрос трейдера
// "уходит ли график после входа в противоположную сторону".
function excursions(trade) {
  const iEntry = candles.findIndex((c) => +new Date(c.time ?? c.date ?? c.timestamp) >= +new Date(trade.entryDate));
  if (iEntry < 0) return null;
  const iExit = trade.exitDate
    ? candles.findIndex((c) => +new Date(c.time ?? c.date ?? c.timestamp) >= +new Date(trade.exitDate))
    : candles.length - 1;
  const end = iExit < 0 ? candles.length - 1 : iExit;
  const sign = trade.direction === 'long' ? 1 : -1;
  let mfe = 0, mae = 0;
  for (let i = iEntry; i <= end; i++) {
    const favor = ((candles[i].high - trade.entryPrice) / trade.entryPrice) * 100 * sign;
    const against = ((candles[i].low - trade.entryPrice) / trade.entryPrice) * 100 * sign;
    mfe = Math.max(mfe, trade.direction === 'long' ? favor : -(((candles[i].low - trade.entryPrice) / trade.entryPrice) * 100));
    mae = Math.min(mae, trade.direction === 'long' ? against : -(((candles[i].high - trade.entryPrice) / trade.entryPrice) * 100));
  }
  return { mfe, mae };
}

const closed = run.trades.filter((t) => t.status === 'closed');
const open = run.trades.filter((t) => t.status !== 'closed');

console.log(`ЗАКРЫТЫЕ сделки: ${closed.length}   |   ОТКРЫТЫЕ (не попадают в статистику!): ${open.length}\n`);

function row(t, i) {
  const ex = excursions(t) || { mfe: NaN, mae: NaN };
  const d = new Date(t.entryDate).toISOString().slice(0, 10);
  return `${String(i + 1).padStart(3)} | ${d} | ${(t.direction === 'long' ? 'ЛОНГ ' : 'ШОРТ ')} | `
    + `${(t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2)}%`.padStart(8) + ` | `
    + `макс.в плюс ${ex.mfe.toFixed(1).padStart(6)}% | макс.в минус ${ex.mae.toFixed(1).padStart(7)}% | `
    + `${String(t.barsHeld ?? '?').padStart(5)} бар | ${t.exitReason ?? '—'}`;
}

console.log('--- ЗАКРЫТЫЕ (последние 25) ---');
console.log('  # | Дата входа | Напр. |    P&L   | Макс. в плюс | Макс. в минус  | Держал  | Причина выхода');
for (const [i, t] of closed.slice(-25).entries()) console.log(row(t, i));

console.log('\n--- ОТКРЫТЫЕ (ВСЕ) — вот где прячутся убытки ---');
console.log('  # | Дата входа | Напр. |  MTM P&L | Макс. в плюс | Макс. в минус  | Держит  | Статус');
for (const [i, t] of open.entries()) console.log(row(t, i));

// Сводка: сравниваем распределение MAE у закрытых и открытых. Если у открытых MAE
// систематически хуже — гипотеза "убытки не фиксируются, а прячутся" подтверждена.
function avg(list, f) { return list.length ? list.reduce((s, x) => s + f(x), 0) / list.length : NaN; }
const closedEx = closed.map(excursions).filter(Boolean);
const openEx = open.map(excursions).filter(Boolean);
console.log('\n=== СВОДКА ===');
console.log(`Закрытые (${closed.length}): ср. P&L ${avg(closed, (t) => t.pnlPct).toFixed(2)}%, `
  + `ср. макс.в минус ${avg(closedEx, (e) => e.mae).toFixed(2)}%, ср. макс.в плюс ${avg(closedEx, (e) => e.mfe).toFixed(2)}%`);
if (open.length) {
  console.log(`Открытые (${open.length}): ср. MTM ${avg(open, (t) => t.pnlPct).toFixed(2)}%, `
    + `ср. макс.в минус ${avg(openEx, (e) => e.mae).toFixed(2)}%, ср. макс.в плюс ${avg(openEx, (e) => e.mfe).toFixed(2)}%`);
  const allPnl = [...closed.map((t) => t.pnlPct), ...open.map((t) => t.pnlPct)];
  const winsAll = allPnl.filter((p) => p > 0).length;
  console.log(`\n⚠️ Винрейт ТОЛЬКО по закрытым: ${((closed.filter((t) => t.pnlPct > 0).length / closed.length) * 100).toFixed(1)}%`);
  console.log(`⚠️ Винрейт, если засчитать открытые по текущей цене: ${((winsAll / allPnl.length) * 100).toFixed(1)}%`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
