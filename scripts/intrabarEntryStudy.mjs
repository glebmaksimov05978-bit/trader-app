// scripts/intrabarEntryStudy.mjs (2026-09-19, вторая версия)
//
// Вопрос трейдера: «условия входа сейчас сошлись, а к закрытию свечи их уже не будет — мы
// упускаем правильный вход? Ориентироваться только на закрытие свечи или ещё смотреть в
// моменте?»
//
// Как отвечаем. Робот и бэктест решают ТОЛЬКО по закрытой дневной свече (сигнал на закрытии
// дня, вход по открытию следующего). Экран показывает условия по ещё формирующейся свече.
// Здесь для каждого торгового дня восстанавливаем «недозакрытую» дневную свечу на каждый
// час по часовым данным и смотрим, когда условия стратегии впервые сходятся ВНУТРИ дня.
//
// ⚠️ Что было не так в первой версии (и почему её цифры выброшены):
//   1. Время. MOEX отдаёт время строкой «по Москве» без пояса, а candles.js разбирает её по
//      поясу МАШИНЫ. На этой машине пояс UTC+4, на сервере GitHub — UTC. Дату суток я считал
//      через «UTC + 3 часа», и дневная свеча склеивалась с часами СОСЕДНЕГО дня: реконструкция
//      совпадала с настоящей свечой в 7% дней. Теперь дата и час берутся локальными геттерами —
//      ровно теми, которыми строка была разобрана, поэтому они равны настенным часам биржи при
//      любом поясе машины (у России нет перехода на летнее время).
//   2. Состав сессий. Дневная свеча акций у MOEX включает утро, основную и вечернюю сессии
//      (06:00–24:00, проверено: 200 из 200 дней совпало по open/high/low/close). У фьючерсов
//      окно другое и менялось со временем, поэтому для КАЖДОГО дня перебираем несколько
//      кандидатов и берём тот, что воспроизводит настоящую свечу; день без совпадения
//      пропускаем и честно считаем.
//   3. Знание будущего. Деление сигналов на «удержался до закрытия» и «мигнул» опирается на
//      то, что в момент сигнала знать нельзя: доходность у удержавшихся выходила +1,5%, у
//      мигнувших −1,4% — это механика (остаток дня уже в этой цифре), а не свойство стратегии.
//      Теперь все срезы делаются только по тому, что известно В МОМЕНТ касания: сколько
//      часов осталось до закрытия и какая стратегия.
//
// Конфигурация — та же эталонная, что у exportBacktestDataset.mjs: 3 стратегии, фильтр
// импульса mom3>1, режим рынка по IMOEXF. Иначе сравнение было бы про другую систему.
//
// Метрика — доходность до закрытия через 1/3/5/10 дней в сторону сделки; она не зависит от
// правил выхода, поэтому отвечает именно на вопрос о МОМЕНТЕ ВХОДА, а не о выходе.
//
// Запуск: node scripts/intrabarEntryStudy.mjs [--quick] [--shard=k/N]
//   --quick     — 4 тикера, для проверки скорости и здравого смысла;
//   --shard=k/N — только k-я из N частей списка тикеров (для параллельного запуска);
//   --step=2    — проверять условия раз в 2 часа вместо каждого (вдвое быстрее).
// Сырые данные пишутся по тикеру в scripts/_intrabar_t_<ТИКЕР>.json (возобновляется с места обрыва), отчёт собирает
// scripts/intrabarEntryReport.mjs (в репозиторий выводы не коммитятся).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-intrabar-'));
function esmify(p_, extra = []) {
  let t = fs.readFileSync(p_, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const o = path.join(tmpDir, path.basename(p_));
  fs.writeFileSync(o, t, 'utf8');
  return pathToFileURL(o).href;
}
fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat() { return 0; }\n');
for (const f of ['indicators', 'candlestickPatterns', 'patterns', 'marketContext', 'strategy', 'exitRules']) esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
const { buildCtx, readinessPercent, buildMarketRegimeFilter } = await import(esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
  ["from '../analytics/", "from './"], ["from '../../utils/calculator.js'", "from './calculator.js'"]]));
const { fetchDailyCandles } = await import(esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]));

const QUICK = process.argv.includes('--quick');

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

const ALL_TICKERS = [
  ['SBER','stock'],['GAZP','stock'],['LKOH','stock'],['GMKN','stock'],['MTSS','stock'],['ROSN','stock'],['NVTK','stock'],['TATN','stock'],
  ['CHMF','stock'],['MGNT','stock'],['PLZL','stock'],['RUAL','stock'],['VTBR','stock'],['ALRS','stock'],['SNGS','stock'],['MOEX','stock'],
  ['PHOR','stock'],['AFLT','stock'],['IRAO','stock'],['HYDR','stock'],['IMOEXF','future'],['GAZPF','future'],['SBERF','future'],['USDRUBF','future'],
  ['MAGN','stock'],['NLMK','stock'],['SIBN','stock'],['TRNFP','stock'],['FEES','stock'],['RTKM','stock'],['AFKS','stock'],['PIKK','stock'],
  ['BANE','stock'],['UPRO','stock'],['MSNG','stock'],['LSRG','stock'],
];
const shardArg = process.argv.find((a) => a.startsWith('--shard='));
const [SHARD_K, SHARD_N] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const BASE_TICKERS = QUICK ? ALL_TICKERS.filter(([t]) => ['SBER', 'GAZP', 'LKOH', 'IMOEXF'].includes(t)) : ALL_TICKERS;
// Часть тикеров на процесс: одна проверка занимает ~3,5 минуты на тикер, 36 тикеров в один поток — около двух часов.
const TICKERS = BASE_TICKERS.filter((_, n) => n % SHARD_N === SHARD_K);
const stepArg = process.argv.find((a) => a.startsWith('--step='));
const STEP = stepArg ? Math.max(1, Number(stepArg.slice(7))) : 1; // проверять условия раз в STEP часов (2 — вдвое быстрее)
const D1_LOOKBACK = 2200;
const H1_LOOKBACK = 3000;   // фактическая глубина часовых данных у MOEX ~1040 дней
const CTX_WINDOW = 420;     // сколько дневных баров подаём индикаторам: EMA200 + прогрев с запасом
const WARMUP = 220;
const HORIZONS = [1, 3, 5, 10];
const TOL = 0.0005;         // допуск совпадения реконструкции с настоящей свечой: 0,05%

// Настенные дата и час биржи — локальными геттерами, теми же, которыми строка была разобрана
// (см. заголовок: пояс машины не совпадает с московским, и любая арифметика через UTC врёт).
const pad = (n) => String(n).padStart(2, '0');
const wallKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const wallHour = (d) => d.getHours();

async function fetchRetry(a, n = 4) { let e; for (let i = 0; i < n; i++) { try { return await fetchDailyCandles(a); } catch (x) { e = x; await new Promise((r) => setTimeout(r, 2000)); } } throw e; }

console.log(`Тикеров: ${TICKERS.length}${QUICK ? ' (быстрый режим)' : ''}. Загружаю индекс для режима рынка...`);
const idx = await fetchRetry({ ticker: 'IMOEXF', instrumentType: 'future', toDate: new Date(), timeframe: 'D1', lookbackDays: D1_LOOKBACK });
const marketFilter = buildMarketRegimeFilter(idx);

const events = [];       // одна запись на (тикер, стратегия, направление, день) с ≥1 сигналом
const days = [];         // все проанализированные дни — для безусловного дрейфа
const validation = { days: 0, matched: 0, unmatched: 0, noH1: 0, byWindow: {} };
let ctxCalls = 0;
const tStart = Date.now();

for (const [ticker, instrumentType] of TICKERS) {
  const tickerFile = path.join(repoRoot, 'scripts', `_intrabar_t_${ticker}.json`);
  if (fs.existsSync(tickerFile)) { console.log(`${ticker}: уже посчитан, пропускаю`); continue; }
  const evStart = events.length, dayStart = days.length;
  const vBefore = JSON.stringify(validation);
  let d1, h1;
  try {
    d1 = await fetchRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: D1_LOOKBACK });
    h1 = await fetchRetry({ ticker, instrumentType, toDate: new Date(), timeframe: 'H1', lookbackDays: H1_LOOKBACK });
  } catch (e) { console.log(`${ticker}: ошибка загрузки (${e.message})`); continue; }
  if (!d1 || d1.length < 300 || !h1 || h1.length < 100) { console.log(`${ticker}: мало данных (D1 ${d1?.length}, H1 ${h1?.length})`); continue; }

  const h1ByDate = new Map();
  for (const b of h1) {
    const k = wallKey(b.date);
    if (!h1ByDate.has(k)) h1ByDate.set(k, []);
    h1ByDate.get(k).push(b);
  }
  const keys = [...h1ByDate.keys()].sort();
  const firstH1Key = keys[0];
  const prevKey = (k) => { let r = null; for (const x of keys) { if (x < k) r = x; else break; } return r; };
  const inHours = (arr, from, to) => (arr || []).filter((b) => wallHour(b.date) >= from && wallHour(b.date) < to);

  // Кандидаты окна суток. Для акций подходит «весь день 06–24»; у фьючерсов торговые сутки
  // могут начинаться с вечерней сессии предыдущего дня — берём то, что воспроизводит свечу.
  const candidates = {
    'день 06-24': (k) => inHours(h1ByDate.get(k), 6, 24),
    'вечер вчера + день до 19': (k) => [...inHours(h1ByDate.get(prevKey(k)), 19, 24), ...inHours(h1ByDate.get(k), 6, 19)],
    'вечер вчера + день до 24': (k) => [...inHours(h1ByDate.get(prevKey(k)), 19, 24), ...inHours(h1ByDate.get(k), 6, 24)],
    'день 09-19': (k) => inHours(h1ByDate.get(k), 9, 19),
  };
  const near = (a, b) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b)) < TOL;
  const matchWindow = (bar, k) => {
    for (const [name, get] of Object.entries(candidates)) {
      const w = get(k).sort((a, b) => a.date - b.date);
      if (w.length < 4) continue;
      const hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
      if (near(w[0].open, bar.open) && near(hi, bar.high) && near(lo, bar.low) && near(w[w.length - 1].close, bar.close)) return { name, w };
    }
    return null;
  };

  let evBefore = events.length;
  const t0 = Date.now();

  for (let i = WARMUP; i < d1.length - 1; i++) {
    const bar = d1[i];
    const dk = wallKey(bar.date);
    if (dk <= firstH1Key) continue;
    validation.days += 1;
    if (!h1ByDate.get(dk)) { validation.noH1 += 1; continue; }
    const m = matchWindow(bar, dk);
    if (!m) { validation.unmatched += 1; continue; }
    validation.matched += 1;
    validation.byWindow[m.name] = (validation.byWindow[m.name] || 0) + 1;
    const hb = m.w;

    const totalVol = hb.reduce((s, b) => s + (b.volume || 0), 0) || 1;
    const hist = d1.slice(Math.max(0, i - CTX_WINDOW), i);
    const close3ago = d1[i - 3].close;
    // Проверка одного среза недозакрытой свечи: {long,short} × стратегии
    const evalAt = (partial) => {
      ctxCalls += 1;
      const series = [...hist, partial];
      const base = buildCtx(series, partial.date, undefined, 1440);
      if (!base.indicators) return null;
      const bearish = marketFilter(partial.date) === true;
      const out = {};
      for (const [sName, S] of Object.entries(STRATEGIES)) {
        const thr = S.readinessThreshold ?? 60;
        for (const dir of ['long', 'short']) {
          const r = readinessPercent(S, { ...base, direction: dir });
          const mom = ((partial.close - close3ago) / close3ago) * 100 * (dir === 'long' ? 1 : -1);
          out[`${sName}|${dir}`] = r.total > 0 && r.pct >= thr && mom > 1 && !(dir === 'long' && bearish);
        }
      }
      return out;
    };

    // Срезы по часам: все, кроме последнего (последний = закрытие = обычный сигнал робота)
    let runHigh = -Infinity, runLow = Infinity, cumVol = 0;
    const firstIntra = {};   // ключ → индекс часа, когда условия сошлись впервые
    for (let j = 0; j < hb.length - 1; j++) {
      runHigh = Math.max(runHigh, hb[j].high); runLow = Math.min(runLow, hb[j].low); cumVol += hb[j].volume || 0;
      if ((j + 1) % STEP !== 0) continue;   // накапливаем экстремумы каждый час, а условия проверяем раз в STEP часов
      const partial = {
        date: bar.date, open: bar.open,
        high: Math.max(bar.open, Math.min(bar.high, runHigh)),
        low: Math.min(bar.open, Math.max(bar.low, runLow)),
        close: hb[j].close,
        volume: bar.volume * (cumVol / totalVol),
      };
      const res = evalAt(partial);
      if (!res) continue;
      for (const k of Object.keys(res)) if (res[k] && firstIntra[k] === undefined) firstIntra[k] = j;
    }
    const atClose = evalAt(bar) || {};  // закрытая свеча — как решает робот

    // Безусловный дрейф для сравнения: от открытия следующего дня
    const nextOpen = d1[i + 1].open;
    const drift = {};
    for (const h of HORIZONS) if (i + h < d1.length) drift[h] = ((d1[i + h].close - nextOpen) / nextOpen) * 100;
    days.push({ t: ticker, drift });

    for (const k of new Set([...Object.keys(firstIntra), ...Object.keys(atClose).filter((x) => atClose[x])])) {
      const [sName, dir] = k.split('|');
      const sign = dir === 'long' ? 1 : -1;
      const inClose = !!atClose[k];
      const jIntra = firstIntra[k];
      const hasIntra = jIntra !== undefined;
      if (!hasIntra && !inClose) continue;
      // Цена входа «по касанию»: следующий час после часа, где условия сошлись (увидели по
      // закрытию часа, исполнились по открытию следующего).
      const intraEntry = hasIntra ? (hb[jIntra + 1] || hb[jIntra]).open : null;
      const ret = (entry) => {
        const o = {};
        for (const h of HORIZONS) if (i + h < d1.length) o[h] = sign * ((d1[i + h].close - entry) / entry) * 100;
        return o;
      };
      events.push({
        t: ticker, s: sName, dir,
        persist: hasIntra ? inClose : null,           // ЗНАНИЕ ЗАДНИМ ЧИСЛОМ — только для описания частоты
        hasIntra, inClose,
        left: hasIntra ? hb.length - 1 - jIntra : null, // сколько часовых баров осталось ДО закрытия — известно в момент касания
        total: hb.length,
        intra: hasIntra ? ret(intraEntry) : null,
        close: inClose ? ret(nextOpen) : null,
      });
    }
  }
  // Результат тикера — на диск сразу: раньше всё копилось в памяти до конца, и при обрыве
  // процесса терялись все уже посчитанные тикеры.
  const vNow = JSON.parse(JSON.stringify(validation)), vPrev = JSON.parse(vBefore);
  const vDelta = { days: vNow.days - vPrev.days, matched: vNow.matched - vPrev.matched, unmatched: vNow.unmatched - vPrev.unmatched, noH1: vNow.noH1 - vPrev.noH1, byWindow: {} };
  for (const [k, v] of Object.entries(vNow.byWindow)) vDelta.byWindow[k] = v - (vPrev.byWindow[k] || 0);
  fs.writeFileSync(tickerFile, JSON.stringify({ ticker, step: STEP, events: events.slice(evStart), days: days.slice(dayStart), validation: vDelta }));
  console.log(`${ticker.padEnd(7)} событий ${String(events.length - evBefore).padStart(4)}  (${((Date.now() - t0) / 1000).toFixed(0)}с, срезов всего ${ctxCalls}, дней с совпавшей свечой ${validation.matched}/${validation.days})`);
}

console.log(`\nВсего: ${events.length} событий, ${days.length} дней, ${((Date.now() - tStart) / 60000).toFixed(1)} мин`);
console.log(`Сверка реконструкции: свеча воспроизведена в ${(validation.matched / Math.max(1, validation.days) * 100).toFixed(0)}% дней (${validation.matched}/${validation.days}); без часовых данных ${validation.noH1}; не совпало ${validation.unmatched}`);
console.log('Какое окно подошло:', JSON.stringify(validation.byWindow));

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('Готово: результаты по тикерам лежат в scripts/_intrabar_t_*.json');
