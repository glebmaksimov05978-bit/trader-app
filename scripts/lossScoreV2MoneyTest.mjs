// Повторная денежная проверка усиленного loss-сигнала (2026-08-17) + идея трейдера:
// период "охлаждения" — не пускать новую сделку на ТОТ ЖЕ инструмент сразу после
// закрытия, чтобы не было мгновенного чуринга (закрыли -> тут же открыли новую похуже).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-lossv2-'));

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
const { rsi, ema, sma, bollingerSeries } = await import(indicatorsUrl);

// Портфель С поддержкой периода охлаждения — модификация portfolio.js "на месте", не
// трогаем оригинальный файл (не проверено вживую, только для этого исследования).
function runPortfolioWithCooldown(perTicker, options = {}) {
  const { startingCapital = 100000, riskPerTradePct = 10, maxConcurrentPositions = 8, cooldownBars = 0 } = options;
  const events = [];
  for (const { ticker, trades } of perTicker) {
    for (const t of trades) {
      if (!t.entryDate) continue;
      const exitDate = t.status === 'closed' ? t.exitDate : null;
      events.push({ type: 'entry', date: new Date(t.entryDate), ticker, trade: t });
      if (exitDate) events.push({ type: 'exit', date: new Date(exitDate), ticker, trade: t });
    }
  }
  events.sort((a, b) => a.date - b.date || (a.type === 'exit' ? -1 : 1));

  let equity = startingCapital, peak = equity, maxDrawdownPct = 0;
  const open = new Map();
  const lastExitByTicker = new Map(); // ticker -> Date последнего закрытия
  let closedTrades = 0, skippedSignals = 0, skippedCooldown = 0, worstTrade = 0;

  for (const ev of events) {
    if (ev.type === 'exit') {
      const allocated = open.get(ev.trade);
      if (allocated == null) continue;
      open.delete(ev.trade);
      equity += allocated * (ev.trade.pnlPct / 100);
      closedTrades += 1;
      worstTrade = Math.min(worstTrade, ev.trade.pnlPct);
      peak = Math.max(peak, equity);
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
      lastExitByTicker.set(ev.ticker, ev.date);
    } else {
      if (open.size >= maxConcurrentPositions) { skippedSignals += 1; continue; }
      if (cooldownBars > 0) {
        const lastExit = lastExitByTicker.get(ev.ticker);
        if (lastExit) {
          const barsSince = (ev.date - lastExit) / 86400000; // календарные дни ~ бары на Д1
          if (barsSince < cooldownBars) { skippedCooldown += 1; continue; }
        }
      }
      const allocated = equity * (riskPerTradePct / 100);
      open.set(ev.trade, allocated);
    }
  }
  let mtmEquity = equity;
  for (const [trade, allocated] of open) { mtmEquity += allocated * (trade.pnlPct / 100); worstTrade = Math.min(worstTrade, trade.pnlPct); }
  return {
    finalEquity: mtmEquity, totalReturnPct: ((mtmEquity - startingCapital) / startingCapital) * 100,
    maxDrawdownPct, closedTrades, openTrades: open.size, skippedSignals, skippedCooldown, worstTrade,
  };
}

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

console.log('Загружаю индекс для фильтра рынка...');
const indexCandles = await fetchWithRetry({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
const indexCloses = indexCandles.map((c) => c.close);
const indexSma50 = sma(indexCloses, 50);
function indexBelowSma50(date) {
  let idx = -1;
  for (let i = 0; i < indexCandles.length; i++) { if (new Date(indexCandles[i].date) <= date) idx = i; else break; }
  if (idx < 0 || indexSma50[idx] == null) return null;
  return indexCloses[idx] < indexSma50[idx];
}

// Усиленный score из полного перебора (2026-08-17): топ-комбо было "RSI21 экстремум +
// RSI14 валится Δ<=-10 + держим15+" (64.6%). Строим шкалу вокруг этих трёх + пару похожих.
function cutScoreV2(f) {
  let s = 0;
  if (f.rsi21Extreme) s += 2; // сильнейший одиночный признак — вес 2
  if (f.rsi14ChangeArm != null && f.rsi14ChangeArm <= -10) s += 2; // тоже сильный — вес 2
  if (f.barsFromArm >= 15) s += 1;
  if (f.ema13Side != null && f.ema13Side < -4) s += 1;
  if (f.currentAdvPct > 8) s += 1;
  return s;
}

const MAX_WINDOW = 120;
function simulate(candles, series, entryIndex, dir, entryPrice, atr, useScore, cutThreshold) {
  const { closes, rsi14S, rsi21S, ema13S } = series;
  const minPeakPct = (atr * 1.0 / entryPrice) * 100;
  const adverseThresholdPct = minPeakPct * 2;
  let peak = 0, armIndex = null, armRsi14 = null;
  const end = Math.min(candles.length - 1, entryIndex + MAX_WINDOW);
  for (let i = entryIndex + 1; i <= end; i++) {
    const bar = candles[i];
    const favorable = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
    peak = Math.max(peak, favorable);
    const ret = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
    const barsHeld = i - entryIndex;

    if (armIndex == null && -ret >= minPeakPct) { armIndex = i; armRsi14 = rsi14S[i] ?? null; }

    if (useScore && armIndex != null && ret < 0 && rsi21S[i] != null) {
      const barsFromArm = i - armIndex;
      const rsi21Extreme = dir === 1 ? rsi21S[i] < 35 : rsi21S[i] > 65;
      const rsi14ChangeArm = armRsi14 != null && rsi14S[i] != null ? (rsi14S[i] - armRsi14) * dir : null;
      const ema13Side = ema13S[i] != null ? ((closes[i] - ema13S[i]) / ema13S[i]) * 100 * dir : null;
      const score = cutScoreV2({ rsi21Extreme, rsi14ChangeArm, barsFromArm, ema13Side, currentAdvPct: -ret });
      if (score >= cutThreshold) return { pnlPct: ret, barsHeld, reason: 'loss_score_v2' };
    }
    if (-ret >= adverseThresholdPct) return { pnlPct: ret, barsHeld, reason: 'trail_adverse' };
    if (peak >= minPeakPct && ret <= peak * 0.5) return { pnlPct: ret, barsHeld, reason: 'trail_giveback' };
  }
  const last = candles[end];
  const finalPct = dir === 1 ? ((last.close - entryPrice) / entryPrice) * 100 : ((entryPrice - last.close) / entryPrice) * 100;
  return { pnlPct: finalPct, barsHeld: end - entryIndex, stillOpen: true, reason: 'end_of_data' };
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

const HOLDOUT_FRACTION = 0.2;
const allEntries = [];
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
  const series = { closes, rsi14S: rsi(closes, 14), rsi21S: rsi(closes, 21), ema13S: ema(closes, 13) };
  const atrS = atrSeries(candles, 14);
  const harvest = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, exitRules: ENTRY_HARVEST_RULES });
  for (const t of harvest.trades) {
    if (t.entryIndex == null || t.entryIndex < splitIndex) continue;
    const dir = t.direction === 'long' ? 1 : -1;
    const atr = atrS[t.entryIndex - 1] ?? atrS[t.entryIndex];
    if (!atr) continue;
    allEntries.push({ ticker, candles, series, entryIndex: t.entryIndex, dir, entryPrice: t.entryPrice, atr, entryDate: t.entryDate, marketDown: indexBelowSma50(new Date(t.entryDate)) === true });
  }
}

console.log(`\n${'='.repeat(120)}`);
console.log('ЧАСТЬ 1: усиленный loss-score деньгами (та же ошибка ожидается?) + разные пороги охлаждения');
console.log(`${'='.repeat(120)}\n`);
console.log('Вариант                          | Охлажд. | Доходность | Просадка | Пропущ.слот | Пропущ.охлажд.');
console.log('-'.repeat(120));
for (const [scoreLabel, useScore, threshold] of [['Базовое (только ×2)', false, null], ['Loss score v2, порог>=3', true, 3], ['Loss score v2, порог>=4', true, 4]]) {
  const results = allEntries.map((e) => ({ ...simulate(e.candles, e.series, e.entryIndex, e.dir, e.entryPrice, e.atr, useScore, threshold), ticker: e.ticker, entryDate: e.entryDate, dir: e.dir, marketDown: e.marketDown }));
  const filtered = results.filter((r) => !(r.dir === 1 && r.marketDown));
  const portfolioInput = toPortfolio(filtered);
  for (const cooldown of [0, 3, 7, 15]) {
    const p = runPortfolioWithCooldown(portfolioInput, { startingCapital: 100000, riskPerTradePct: 10, maxConcurrentPositions: 8, cooldownBars: cooldown });
    console.log(
      `${scoreLabel.padEnd(33)} | ${String(cooldown).padStart(3)}дн  | ${((p.totalReturnPct >= 0 ? '+' : '') + p.totalReturnPct.toFixed(1)).padStart(6)}% | ${p.maxDrawdownPct.toFixed(1).padStart(5)}% | `
      + `${String(p.skippedSignals).padStart(11)} | ${String(p.skippedCooldown).padStart(14)}`
    );
  }
  console.log('-'.repeat(120));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
