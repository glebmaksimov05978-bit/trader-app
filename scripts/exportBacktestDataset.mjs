// scripts/exportBacktestDataset.mjs (2026-09-07)
//
// Экспортирует стандартный дневной бэктест (те же 36 тикеров, 3 стратегии, вход mom3>1,
// EXIT_RULES — конфигурация, устоявшаяся за эту сессию и давшая эталонные +1.26-1.29
// матожид/+88-100% медиану) в файл, который умеет читать РАБОТАЮЩЕЕ приложение.
//
// Раньше эти ~2500 сделок существовали только как разовый вывод скриптов в чате — этого
// хватало для исследования, но не для честного блока «что было дальше в похожих
// ситуациях» в «Сопровождении», потому что браузер не может прочитать вывод терминала.
// Теперь то же самое сохраняется в public/data/backtestSample.json — статический файл,
// который клиентский код читает через fetch(), без сервера и без Firestore.
//
// Хранятся только поля, нужные для честного поиска «похожих сделок»: тикер, направление,
// когорта (число срабатываний профит-системы), причина выхода, итоговый %, пик, срок
// удержания. Ни цен, ни дат входа — этого для сравнения по стадии сделки не нужно, а файл
// остаётся маленьким.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-export-'));
function esmify(p_, extra = []) {
  let t = fs.readFileSync(p_, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const o = path.join(tmpDir, path.basename(p_));
  fs.writeFileSync(o, t, 'utf8');
  return pathToFileURL(o).href;
}
fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), `export class TinkoffAPI {}\nexport function moneyToFloat() { return 0; }\n`);
for (const f of ['indicators', 'candlestickPatterns', 'patterns', 'marketContext', 'strategy']) esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
const exitRulesUrl = esmify(path.join(repoRoot, 'src/services/analytics/exitRules.js'));
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
const { runBacktest, buildMarketRegimeFilter } = await import(esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
  ["from '../analytics/", "from './"], ["from '../../utils/calculator.js'", "from './calculator.js'"]]));
const { fetchDailyCandles } = await import(esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]));
const { DEFAULT_PROFIT_CAPTURE_SCORE_THRESHOLD } = await import(exitRulesUrl);

const RISK = [{ id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' }, { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' }];
const STRATEGIES = {
  'Фигуры+уровень': { id: 'patterns_levels', readinessThreshold: 75, customConditions: [], conditions: [
    { id: 'pattern_confirmed', enabled: true, param: 75, direction: 'both' },
    { id: 'near_support', enabled: true, param: 1, direction: 'long' },
    { id: 'near_resistance', enabled: true, param: 1, direction: 'short' }, ...RISK] },
  'RSI+Боллинджер': { id: 'rsi_bollinger', readinessThreshold: 66, customConditions: [], conditions: [
    { id: 'rsi_below', enabled: true, param: 35, direction: 'long' },
    { id: 'rsi_above', enabled: true, param: 65, direction: 'short' },
    { id: 'bollinger_lower', enabled: true, param: null, direction: 'long' },
    { id: 'bollinger_upper', enabled: true, param: null, direction: 'short' }, ...RISK] },
  'EMA200+MACD': { id: 'ema_macd_trend', readinessThreshold: 66, customConditions: [], conditions: [
    { id: 'price_above_ema200', enabled: true, param: null, direction: 'long' },
    { id: 'price_below_ema200', enabled: true, param: null, direction: 'short' },
    { id: 'macd_positive', enabled: true, param: null, direction: 'long' },
    { id: 'macd_negative', enabled: true, param: null, direction: 'short' }, ...RISK] },
};
const EXIT_RULES = { stopType: 'none', takeType: 'none', onSignalLoss: false, maxBars: null, trailEnabled: true, trailGiveBackPct: 50, trailPerPattern: false, trailMinPeakMode: 'atr', trailMinPeakAtrMult: 1.0, trailAdverseEnabled: true, trailAdverseMult: 2, profitCaptureEnabled: true, profitCaptureThreshold: DEFAULT_PROFIT_CAPTURE_SCORE_THRESHOLD, trailLossRule: 'score', lossScoreMode: 'nearBottom', lossScoreThreshold: 2,
  profitCutByScore: { 4: 0.25, 5: 0.34, 6: 0.5, 7: 1, 8: 1 }, profitCutMaxTimes: 4,
  lossCutByScore: { 2: 0.34, 3: 0.5, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }, lossCutMaxTimes: 3,
  peakConfirmCloseFraction: 0.5 };

const ALL_TICKERS = [
  ['SBER','stock'],['GAZP','stock'],['LKOH','stock'],['GMKN','stock'],['MTSS','stock'],['ROSN','stock'],['NVTK','stock'],['TATN','stock'],
  ['CHMF','stock'],['MGNT','stock'],['PLZL','stock'],['RUAL','stock'],['VTBR','stock'],['ALRS','stock'],['SNGS','stock'],['MOEX','stock'],
  ['PHOR','stock'],['AFLT','stock'],['IRAO','stock'],['HYDR','stock'],['IMOEXF','future'],['GAZPF','future'],['SBERF','future'],['USDRUBF','future'],
  ['MAGN','stock'],['NLMK','stock'],['SIBN','stock'],['TRNFP','stock'],['FEES','stock'],['RTKM','stock'],['AFKS','stock'],['PIKK','stock'],
  ['BANE','stock'],['UPRO','stock'],['MSNG','stock'],['LSRG','stock'],
];
const LOOKBACK_DAYS = 2200; // канон этой сессии — тот самый эталонный дневной прогон

async function fetchWithRetry(a, n = 4) { let e; for (let i = 0; i < n; i++) { try { return await fetchDailyCandles(a); } catch (x) { e = x; await new Promise(r => setTimeout(r, 2000)); } } throw e; }

console.log('Загружаю индекс (D1)...');
const t0 = Date.now();
const idxC = await fetchWithRetry({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'D1', lookbackDays: LOOKBACK_DAYS });
console.log(`Индекс: ${idxC.length} баров (${((Date.now() - t0) / 1000).toFixed(1)}с)`);
const marketFilter = buildMarketRegimeFilter(idxC);
function makeFeat(candles) {
  return (i, direction) => { if (i < 60) return null; const sign = direction === 'long' ? 1 : -1; return { mom3: ((candles[i].close - candles[i - 3].close) / candles[i - 3].close) * 100 * sign }; };
}

const dataset = [];
console.log('\nСчитаю (36 тикеров, 3 стратегии, D1)...');
for (const [ticker, instrumentType] of ALL_TICKERS) {
  process.stdout.write(ticker + ' ');
  let candles;
  try { candles = await fetchWithRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: LOOKBACK_DAYS }); } catch (e) { console.log(`(ош: ${e.message})`); continue; }
  if (!candles || candles.length < 300) { console.log(`(мало: ${candles?.length ?? 0})`); continue; }
  const feat = makeFeat(candles);
  const momFilter = ({ index, direction }) => { const f = feat(index, direction); return f ? f.mom3 > 1 : false; };
  for (const [sName, STRATEGY] of Object.entries(STRATEGIES)) {
    const res = runBacktest({ candles, strategy: STRATEGY, timeframeMinutes: 1440, warmupBars: 220, marketRegimeFilter: marketFilter, exitRules: EXIT_RULES, entryFilter: momFilter });
    for (const t of res.trades) if (t.status === 'closed') {
      const fires = (t.fills ?? []).filter((f) => String(f.reason ?? '').startsWith('profit_score')).length;
      dataset.push({
        t: ticker, s: sName, dir: t.direction,
        cohort: fires >= 2 ? '2+' : String(fires),
        reason: t.exitReason,
        pnl: Math.round(t.pnlPct * 100) / 100,
        peak: Math.round((t.peakFavorablePct ?? 0) * 100) / 100,
        bars: t.barsHeld,
      });
    }
  }
}
console.log(`\n\nСделок в датасете: ${dataset.length}`);

const outDir = path.join(repoRoot, 'public', 'data');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'backtestSample.json');
fs.writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  timeframe: 'D1',
  lookbackDays: LOOKBACK_DAYS,
  tickers: ALL_TICKERS.length,
  note: 'Эталонный дневной бэктест этой сессии: 36 тикеров MOEX, 3 стратегии, вход mom3>1, market-regime фильтр. Используется вкладкой «Сопровождение» для честного показа похожих исторических ситуаций — без выдумывания чисел.',
  trades: dataset,
}));
console.log('Записано:', outPath, `(${(fs.statSync(outPath).size / 1024).toFixed(0)} КБ)`);

// Быстрая сверка с эталонными цифрами сессии — если разошлось намного, что-то не так.
const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
console.log('Матожид (сверка с эталоном +1.26..+1.29):', avg(dataset.map((d) => d.pnl))?.toFixed(2));
for (const c of ['0', '1', '2+']) {
  const l = dataset.filter((d) => d.cohort === c);
  console.log(`Когорта ${c}: ${l.length} сделок, средний итог ${avg(l.map((d) => d.pnl))?.toFixed(2)}%`);
}
