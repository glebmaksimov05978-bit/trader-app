// Денежная проверка лучших ПОДТВЕРЖДЁННЫХ комбинаций (2026-08-14, после полного перебора
// ~4000 сочетаний в scripts/reversalPairsAnalysis.mjs). Берём непересекающиеся по смыслу
// варианты, а не 8 клонов одного и того же костяка, и гоняем на ОДНИХ И ТЕХ ЖЕ входах.
//
// Проверяем ДВА принципиально разных способа применения:
//   A) СИГНАЛ РАЗВОРОТА -> выходим раньше обычного трейла (как раньше).
//   B) СИГНАЛ ОТКАТА -> НАОБОРОТ, ЗАПРЕЩАЕМ выход по обычному трейлу (держим дальше).
//      Это моя идея — раньше не пробовали ни разу: у нас есть подтверждённые сигналы
//      "это откат" (K+L: 76.6% возврата на holdout), но мы их никак не использовали.
//      Возможно, польза не в том, чтобы резать раньше, а в том, чтобы НЕ резать зря.
//   C) Обе логики вместе.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-combomoney-'));

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

const indicatorsUrl = esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
esmify(path.join(repoRoot, 'src/services/analytics/candlestickPatterns.js'));
esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'));
esmify(path.join(repoRoot, 'src/services/analytics/marketContext.js'));
esmify(path.join(repoRoot, 'src/services/analytics/exitRules.js'));
esmify(path.join(repoRoot, 'src/services/analytics/strategy.js'));
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
esmify(path.join(repoRoot, 'src/services/backtest/portfolio.js'));
const { runBacktest } = await import(
  esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
    ["from '../analytics/", "from './"],
    ["from '../../utils/calculator.js'", "from './calculator.js'"],
  ])
);
const { runPortfolioBacktest } = await import(pathToFileURL(path.join(tmpDir, 'portfolio.js')).href);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);
const { rsi, ema, bollingerSeries } = await import(indicatorsUrl);

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
const ENTRY_HARVEST_RULES = {
  stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
  takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
  onSignalLoss: false, maxBars: null,
  stopType: 'pct', stopPct: 2, takeType: 'pct', takePct: 4, trailEnabled: false,
};

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
function atrSeries(candles, period = 14) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i >= period) sum -= trs[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function lastSwingBefore(candles, index, dir, span = 3, lookback = 60) {
  for (let i = index - span - 1; i >= Math.max(span, index - lookback); i--) {
    let isSwing = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i || j < 0 || j >= candles.length) continue;
      if (dir === 1 ? candles[j].low < candles[i].low : candles[j].high > candles[i].high) { isSwing = false; break; }
    }
    if (isSwing) return dir === 1 ? candles[i].low : candles[i].high;
  }
  return null;
}

// Признаки, вычисляемые в момент первого пересечения шумового порога
function featuresAt(candles, series, entryIndex, k, dir, entryPrice, atrEntry) {
  const { closes, rsiS, bbS, ema200S } = series;
  if (rsiS[entryIndex] == null || rsiS[k] == null || !bbS[k] || ema200S[k] == null) return null;
  let closesOutsideBand = 0;
  for (let m = entryIndex + 1; m <= k; m++) {
    const b = bbS[m];
    if (!b) continue;
    if (dir === 1 ? closes[m] < b.lower : closes[m] > b.upper) closesOutsideBand += 1;
  }
  const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
  const volRatio = volAvg.length && Number.isFinite(candles[k].volume)
    ? candles[k].volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
  const swing = lastSwingBefore(candles, entryIndex, dir);
  const barK = candles[k];
  const range = barK.high - barK.low;
  return {
    rsiChange: (rsiS[k] - rsiS[entryIndex]) * dir,
    rsiLevel: rsiS[k],
    closesOutsideBand, volRatio,
    structureBroken: swing != null ? (dir === 1 ? closes[k] < swing : closes[k] > swing) : false,
    ema200Side: ((closes[k] - ema200S[k]) / ema200S[k]) * 100 * dir,
    adverseAtr: atrEntry > 0 ? (dir === 1 ? (entryPrice - barK.low) : (barK.high - entryPrice)) / atrEntry : null,
    bodyRatio: range > 0 ? Math.abs(barK.close - barK.open) / range : null,
    bodyAgainst: dir === 1 ? barK.close < barK.open : barK.close > barK.open,
  };
}

// Подтверждённые на holdout правила (непересекающиеся по смыслу)
const REVERSAL_RULES = {
  'D+G+М* (Болл.1выход + RSI>10 + слом структуры)': (f) => f.closesOutsideBand === 1 && f.rsiChange <= -10 && f.structureBroken,
  'G+М*+С* (RSI>10 + слом структуры + >1.5ATR)': (f) => f.rsiChange <= -10 && f.structureBroken && f.adverseAtr > 1.5,
  'D+E+G+М* (4 признака, самый строгий)': (f) => f.closesOutsideBand === 1 && f.volRatio > 2 && f.rsiChange <= -10 && f.structureBroken,
  'C+С* (RSI>15 + >1.5ATR, простой)': (f) => f.rsiChange <= -15 && f.adverseAtr > 1.5,
};

// СЧЁТ ОЧКОВ вместо жёсткого И (по просьбе трейдера — срабатывает чаще): 6 самых сильных
// одиночных признаков разворота из перебора, +1 очко каждый, порог >=2 и >=3 (не строгое
// пересечение конкретных 3-4, а "любые 2 из 6" / "любые 3 из 6" — гораздо мягче и должно
// срабатывать заметно чаще, ценой части точности).
function reversalScore(f) {
  let s = 0;
  if (f.rsiChange <= -10) s += 1;                 // G
  if (f.structureBroken) s += 1;                   // М*
  if (f.adverseAtr != null && f.adverseAtr > 1.5) s += 1; // С*
  if (f.closesOutsideBand === 1) s += 1;            // D
  if (f.volRatio != null && f.volRatio > 2) s += 1; // E
  if (f.bodyAgainst && f.bodyRatio != null && f.bodyRatio > 0.6) s += 1; // П*
  return s;
}
REVERSAL_RULES['СЧЁТ >=2 из 6 (мягкий порог)'] = (f) => reversalScore(f) >= 2;
REVERSAL_RULES['СЧЁТ >=3 из 6 (средний порог)'] = (f) => reversalScore(f) >= 3;
const PULLBACK_RULES = {
  'K+L (RSI без изменений + выше EMA200)': (f) => Math.abs(f.rsiChange) <= 3 && f.ema200Side > 0,
  'K+L+Р* (те же + мелкое тело с тенью)': (f) => Math.abs(f.rsiChange) <= 3 && f.ema200Side > 0 && f.bodyRatio != null && f.bodyRatio < 0.3,
};

const MAX_WINDOW = 120;
function simulate(candles, series, entryIndex, dir, entryPrice, atr, reversalPred, pullbackPred) {
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 3;
  let peak = 0, evaluated = false, holdOverride = false;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;

    if (!evaluated && -ret >= minPeakPct) {
      evaluated = true;
      const f = featuresAt(candles, series, entryIndex, i, dir, entryPrice, atr);
      if (f) {
        if (reversalPred && reversalPred(f)) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'reversal_signal' };
        if (pullbackPred && pullbackPred(f)) holdOverride = true; // сигнал "это откат" — не режем по блант-трейлу
      }
    }
    // Блант-подстраховка ×3 действует ВСЕГДА (даже при holdOverride) — иначе позиция снова
    // может зависнуть навсегда, тот самый баг, который чинили в начале сессии.
    if (-ret >= adverseThresholdPct) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail_adverse' };
    if (!holdOverride && peak >= minPeakPct && ret <= peak * 0.5) return { pnlPct: ret, barsHeld: i - entryIndex, reason: 'trail' };
  }
  const last = candles[end];
  const finalPct = dir === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data' };
}

const HOLDOUT_FRACTION = 0.2;
const VARIANTS = [
  { name: 'Базовый трейл (эталон)', rev: null, pull: null },
];
for (const [name, pred] of Object.entries(REVERSAL_RULES)) VARIANTS.push({ name: `A) выход: ${name}`, rev: pred, pull: null });
for (const [name, pred] of Object.entries(PULLBACK_RULES)) VARIANTS.push({ name: `B) держать: ${name}`, rev: null, pull: pred });
VARIANTS.push({
  name: 'C) обе: выход D+G+М*, держать K+L',
  rev: REVERSAL_RULES['D+G+М* (Болл.1выход + RSI>10 + слом структуры)'],
  pull: PULLBACK_RULES['K+L (RSI без изменений + выше EMA200)'],
});

const results = {};
for (const v of VARIANTS) results[v.name] = { train: [], test: [], reasons: {} };

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);
  const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_FRACTION));
  const closes = candles.map((c) => c.close);
  const series = { closes, rsiS: rsi(closes, 14), bbS: bollingerSeries(closes, 20, 2), ema200S: ema(closes, 200) };
  const atrS = atrSeries(candles, 14);

  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;
    const isTest = t.entryIndex >= splitIndex;
    for (const v of VARIANTS) {
      const r = simulate(candles, series, t.entryIndex, dir, t.entryPrice, atr, v.rev, v.pull);
      results[v.name][isTest ? 'test' : 'train'].push({ ...r, ticker, entryDate: t.entryDate });
      if (isTest) results[v.name].reasons[r.reason] = (results[v.name].reasons[r.reason] || 0) + 1;
    }
  }
}

function summarize(list) {
  const n = list.length;
  if (!n) return null;
  return {
    n, winRate: (list.filter((r) => r.pnlPct > 0).length / n) * 100,
    avg: list.reduce((s, r) => s + r.pnlPct, 0) / n,
    worst: Math.min(...list.map((r) => r.pnlPct)),
  };
}
function toPortfolio(list) {
  const byTicker = new Map();
  for (const r of list) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push({
      status: r.stillOpen ? 'open' : 'closed', pnlPct: r.pnlPct,
      entryDate: r.entryDate, exitDate: new Date(new Date(r.entryDate).getTime() + r.barsHeld * 86400000),
    });
  }
  return [...byTicker.entries()].map(([ticker, trades]) => ({ ticker, trades }));
}

console.log(`\n${'='.repeat(125)}`);
console.log('ДЕНЬГИ: лучшие подтверждённые комбинации (портфель риск10%/8 слотов) — на одних и тех же входах');
console.log(`${'='.repeat(125)}\n`);
console.log('Вариант                                          | Ср.сделка обуч | Ср.сделка ОТЛОЖ | Худшая | Портфель ОТЛОЖ | Просадка');
console.log('-'.repeat(125));
for (const v of VARIANTS) {
  const tr = summarize(results[v.name].train), te = summarize(results[v.name].test);
  if (!tr || !te) { console.log(`${v.name.padEnd(48)} | нет данных`); continue; }
  const p = runPortfolioBacktest(toPortfolio(results[v.name].test), { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8 });
  console.log(
    `${v.name.padEnd(48)} | ${((tr.avg >= 0 ? '+' : '') + tr.avg.toFixed(3)).padStart(8)}%      | ${((te.avg >= 0 ? '+' : '') + te.avg.toFixed(3)).padStart(8)}%       | `
    + `${te.worst.toFixed(1).padStart(6)}% | ${((p.totalReturnPct >= 0 ? '+' : '') + p.totalReturnPct.toFixed(1)).padStart(7)}%       | ${p.maxDrawdownPct.toFixed(1)}%`
  );
}
console.log('\nПричины закрытия (отложенный период):');
for (const v of VARIANTS) console.log(`  ${v.name.padEnd(48)} ${JSON.stringify(results[v.name].reasons)}`);

fs.rmSync(tmpDir, { recursive: true, force: true });
