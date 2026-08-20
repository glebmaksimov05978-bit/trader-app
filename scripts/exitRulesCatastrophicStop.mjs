// Тест конкретной идеи трейдера (2026-08-13): убрать пугающие "хвостовые" сделки
// (позиция открыта сотнями баров, честная переоценка mark-to-market уходит в -15%/-18%,
// потому что следящий выход ни разу не включился) БЕЗ порчи общего результата.
//
// Прошлый раунд (см. HANDOFF, "Три доп. проверки следящего выхода") тестировал УЗКИЕ
// страховочные стопы (2/4/6/8%) — они монотонно портили результат, потому что мешали
// следящему выходу работать вообще (закрывали сделку раньше, чем движение вообще
// началось). Это другая гипотеза: ШИРОКИЙ стоп (10/15/20%), который почти никогда не
// должен срабатывать на нормальной сделке — нужен только как потолок для хвостового
// риска, не как обычный механизм выхода. Смотрим именно на худшую сделку/просадку, а не
// только на среднюю доходность.
//
// Run: node scripts/exitRulesCatastrophicStop.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-catastrophic-'));

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

const base = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null,
  trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false,
  trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailMinPeakPct: 1,
  takeType: 'none',
};

const CONFIGS = [
  { name: 'Е. Без стопа (эталон)', rules: { ...base, stopType: 'none' } },
  { name: 'К10. + аварийный стоп 10%', rules: { ...base, stopType: 'pct', stopPct: 10 } },
  { name: 'К15. + аварийный стоп 15%', rules: { ...base, stopType: 'pct', stopPct: 15 } },
  { name: 'К20. + аварийный стоп 20%', rules: { ...base, stopType: 'pct', stopPct: 20 } },
  { name: 'К30. + аварийный стоп 30%', rules: { ...base, stopType: 'pct', stopPct: 30 } },
];

const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' }, { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' }, { ticker: 'ROSN', instrumentType: 'stock' },
  { ticker: 'NVTK', instrumentType: 'stock' }, { ticker: 'TATN', instrumentType: 'stock' },
  { ticker: 'CHMF', instrumentType: 'stock' }, { ticker: 'MGNT', instrumentType: 'stock' },
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'RUAL', instrumentType: 'stock' },
  { ticker: 'VTBR', instrumentType: 'stock' }, { ticker: 'ALRS', instrumentType: 'stock' },
  { ticker: 'SNGS', instrumentType: 'stock' }, { ticker: 'MOEX', instrumentType: 'stock' },
  { ticker: 'PHOR', instrumentType: 'stock' }, { ticker: 'AFLT', instrumentType: 'stock' },
  { ticker: 'IRAO', instrumentType: 'stock' }, { ticker: 'HYDR', instrumentType: 'stock' },
  { ticker: 'IMOEXF', instrumentType: 'future' },
];

async function fetchWithRetry(args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchDailyCandles(args); }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw lastErr;
}

const HOLDOUT_FRACTION = 0.2;

function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'closed').sort((a, b) => a.exitDate - b.exitDate);
  const open = trades.filter((t) => t.status === 'open');
  if (!closed.length) return null;
  let equity = 100, peak = 100, maxDrawdownPct = 0;
  let wins = 0, grossWin = 0, grossLoss = 0, worst = 0, catastrophicN = 0;
  let totalBars = 0;
  for (const t of closed) {
    equity *= 1 + t.pnlPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    if (t.pnlPct > 0) { wins += 1; grossWin += t.pnlPct; } else { grossLoss += Math.abs(t.pnlPct); }
    worst = Math.min(worst, t.pnlPct);
    totalBars += t.barsHeld || 0;
    if (t.pnlPct < -8) catastrophicN += 1; // сделка хуже -8% (то, чего трейдер боится в открытых позициях)
  }
  const worstOpenMTM = open.length ? Math.min(...open.map((t) => t.pnlPct ?? 0)) : null;
  return {
    n: closed.length, returnPct: equity - 100, winRate: (wins / closed.length) * 100,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity, worst, maxDrawdownPct,
    avgHoldDays: totalBars / closed.length, catastrophicN,
    openN: open.length, worstOpenMTM,
  };
}

const results = {};
for (const cfg of CONFIGS) results[cfg.name] = { train: [], test: [] };

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка после 3 попыток: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  console.log(`${candles.length} свечей`);

  for (const cfg of CONFIGS) {
    const train = runBacktest({ candles: candles.slice(0, splitIndex), strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules });
    const test = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: cfg.rules, warmupBars: splitIndex });
    const trainSum = summarize(train.trades);
    const testSum = summarize(test.trades);
    if (trainSum) results[cfg.name].train.push({ ticker, ...trainSum });
    if (testSum) results[cfg.name].test.push({ ticker, ...testSum });
  }
}

function aggregate(list) {
  if (!list.length) return null;
  const n = list.reduce((s, r) => s + r.n, 0);
  const wins = list.reduce((s, r) => s + (r.winRate / 100) * r.n, 0);
  const avgReturn = list.reduce((s, r) => s + r.returnPct, 0) / list.length;
  const positive = list.filter((r) => r.returnPct > 0).length;
  const worst = Math.min(...list.map((r) => r.worst));
  const avgDrawdown = list.reduce((s, r) => s + r.maxDrawdownPct, 0) / list.length;
  const catastrophicN = list.reduce((s, r) => s + r.catastrophicN, 0);
  const openN = list.reduce((s, r) => s + r.openN, 0);
  const worstOpenMTM = list.some((r) => r.worstOpenMTM != null)
    ? Math.min(...list.filter((r) => r.worstOpenMTM != null).map((r) => r.worstOpenMTM)) : null;
  return { n, winRate: (wins / n) * 100, avgReturn, positive, tickers: list.length, worst, avgDrawdown, catastrophicN, openN, worstOpenMTM };
}

console.log(`\n${'='.repeat(120)}`);
console.log(`Идея: широкий "аварийный" стоп поверх следящего выхода — режет ли хвостовой риск, не портя средний результат?`);
console.log(`Д1, ${TICKERS.length} инструментов, holdout ${HOLDOUT_FRACTION * 100}%`);
console.log(`"Катастрофических" = закрытых сделок хуже -8% (то, чего трейдер боится в открытых позициях)`);
console.log(`${'='.repeat(120)}\n`);
console.log('Вариант                          | Период | Сделок | Винрейт | Ср.дох. | В плюсе | Худшая | Просадка | Катастр. | Откр.(худш. MTM)');
console.log('-'.repeat(140));
for (const cfg of CONFIGS) {
  for (const period of ['train', 'test']) {
    const agg = aggregate(results[cfg.name][period]);
    const label = period === 'train' ? 'обучен' : 'ОТЛОЖ.';
    if (!agg) { console.log(`${cfg.name.padEnd(33)} | ${label} | нет сделок`); continue; }
    console.log(
      `${(period === 'train' ? cfg.name : '').padEnd(33)} | ${label} | ${String(agg.n).padStart(6)} | `
      + `${agg.winRate.toFixed(1).padStart(6)}% | ${(agg.avgReturn >= 0 ? '+' : '') + agg.avgReturn.toFixed(1).padStart(6)}% | `
      + `${agg.positive}/${agg.tickers}`.padStart(7) + ` | ${agg.worst.toFixed(1).padStart(6)}% | ${agg.avgDrawdown.toFixed(1).padStart(6)}% | `
      + `${String(agg.catastrophicN).padStart(8)} | ${agg.openN} (${agg.worstOpenMTM != null ? agg.worstOpenMTM.toFixed(1) + '%' : '—'})`
    );
  }
  console.log('-'.repeat(140));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
