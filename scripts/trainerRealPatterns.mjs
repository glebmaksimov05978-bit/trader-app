// Набор РЕАЛЬНЫХ примеров для тренажёра «Тренд» (режим «Фигуры на реальных графиках»).
//
// Что делает: берёт дневную историю ликвидных акций Мосбиржи, прогоняет по ней те же детекторы фигур, что работают в приложении
// (src/services/analytics/patterns.js), и сохраняет в public/trainer/real_patterns.json примеры, где алгоритм нашёл фигуру
// (уверенность не ниже порога) И после неё цена прошла заметное расстояние — «нормальное движение», а не топтание на месте.
// Игрок в тренажёре видит график ДО момента находки, отвечает, затем видит реальное продолжение и то, что сказал алгоритм.
// Так проверяется и сам игрок, и алгоритм: где они расходятся — там либо ошибка человека, либо слабое место детектора.
//
// Честность выборки (решения записаны в файл и показываются игроку):
//  • «Правильный ответ» здесь — ТО, ЧТО НАЗВАЛ АЛГОРИТМ, а не истина: человека никто не проверял. Поэтому игра считает не очки,
//    а согласие игрока с алгоритмом.
//  • Движение после находки — любое (вверх или вниз) не меньше MIN_MOVE_ATR за HORIZON баров; направление фигуры при отборе не
//    учитывается. Иначе в наборе остались бы только «сработавшие» фигуры и тренажёр врал бы, что фигуры работают всегда.
//  • Отбор по уверенности и разнообразию (не больше PER_TICKER на фигуру и тикер), порядок в игре случайный.
// Запуск: node scripts/trainerRealPatterns.mjs  (нужен доступ к iss.moex.com; ~5–10 минут)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-trainerreal-'));
function esmify(p_, extra = []) {
  let t = fs.readFileSync(p_, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const o = path.join(tmpDir, path.basename(p_));
  fs.writeFileSync(o, t, 'utf8');
  return pathToFileURL(o).href;
}
fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat() { return 0; }\n');
for (const f of ['indicators', 'candlestickPatterns', 'patterns']) esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
const { fetchDailyCandles } = await import(esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]));
const { computePatternsAtEntry, MIN_DISPLAY_CONFIDENCE } = await import(pathToFileURL(path.join(tmpDir, 'patterns.js')).href);

const TICKERS = ['SBER', 'GAZP', 'LKOH', 'GMKN', 'MTSS', 'ROSN', 'NVTK', 'TATN', 'CHMF', 'MGNT', 'PLZL', 'RUAL',
  'VTBR', 'ALRS', 'SNGS', 'MOEX', 'PHOR', 'AFLT', 'IRAO', 'HYDR', 'MAGN', 'NLMK', 'SIBN', 'TRNFP'];
const MIN_CONF = Math.max(60, MIN_DISPLAY_CONFIDENCE);
const STRIDE = 3, HORIZON = 20, FUTURE_SHOW = 25, MIN_MOVE_ATR = 2.5, START_IDX = 150;
const PER_TICKER = 2, PER_PATTERN = 14, BEFORE = 12, MAX_VISIBLE = 90;

// Названия детектора → фигура игры. Флаги у детектора названы по наклону канала (как в services/trainer/patternQuiz.js DETECTOR_ACCEPT).
// Горизонтальный флаг не берём: из названия не ясно, «после роста» он или «после падения».
const QUIZ_OF = {
  double_top: 'double_top', double_bottom: 'double_bottom',
  head_shoulders_top: 'head_shoulders_top', head_shoulders_bottom: 'head_shoulders_bottom',
  triangle_ascending: 'triangle_ascending', triangle_descending: 'triangle_descending', triangle_symmetric: 'triangle_symmetric',
  pennant_bullish: 'triangle_symmetric', pennant_bearish: 'triangle_symmetric',
  wedge_rising: 'wedge_rising', wedge_falling: 'wedge_falling',
  flag_descending: 'flag_bull', flag_ascending: 'flag_bear',
};

function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  let prevClose = null, prevAtr = null; const buf = [];
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const tr = prevClose == null ? high - low : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    prevClose = close;
    if (prevAtr == null) { buf.push(tr); if (buf.length === period) { prevAtr = buf.reduce((s, v) => s + v, 0) / period; out[i] = prevAtr; } }
    else { prevAtr = (prevAtr * (period - 1) + tr) / period; out[i] = prevAtr; }
  }
  return out;
}
async function load(ticker) {
  for (let k = 0; k < 3; k++) {
    try { return await fetchDailyCandles({ ticker, instrumentType: 'stock', toDate: new Date(), timeframe: 'D1', lookbackDays: 365 * 12 }); }
    catch (e) { await new Promise((r) => setTimeout(r, 1500)); if (k === 2) throw e; }
  }
  return [];
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const round = (v) => Math.round(v * 1e4) / 1e4;
const dayOf = (d) => Math.floor(new Date(d).getTime() / 86400000);

const found = []; // все находки до отбора
for (const ticker of TICKERS) {
  let candles;
  try { candles = await load(ticker); } catch (e) { console.log(`${ticker}: не загрузилось (${e.message})`); continue; }
  if (candles.length < START_IDX + HORIZON + 20) { console.log(`${ticker}: мало данных`); continue; }
  const atr = atrSeries(candles);
  const seen = new Set();
  let n = 0;
  for (let i = START_IDX; i < candles.length - FUTURE_SHOW - 1; i += STRIDE) {
    let r;
    try { r = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: 1440 }); } catch { continue; }
    for (const c of r?.candidates || []) {
      const quiz = QUIZ_OF[c.pattern];
      if (!quiz || c.status !== 'confirmed' || !(c.confidence >= MIN_CONF)) continue;
      const pts = (c.points || []).filter((p) => p && Number.isInteger(p.index) && Number.isFinite(p.price));
      if (pts.length < 2) continue;
      const first = Math.min(...pts.map((p) => p.index));
      const key = `${c.pattern}|${first}`;
      if (seen.has(key)) continue;        // та же фигура на соседних барах — берём самую раннюю находку
      seen.add(key);
      const a = atr[i];
      if (!a) continue;
      // Движение после находки: от закрытия бара находки, на следующих HORIZON барах
      let up = 0, down = 0;
      for (let j = i + 1; j <= Math.min(candles.length - 1, i + HORIZON); j++) {
        up = Math.max(up, (candles[j].high - candles[i].close) / a);
        down = Math.max(down, (candles[i].close - candles[j].low) / a);
      }
      if (Math.max(up, down) < MIN_MOVE_ATR) continue;
      found.push({ ticker, quiz, detector: c.pattern, conf: c.confidence, i, first, pts, up, down, candles, a });
      n += 1;
    }
  }
  console.log(`${ticker}: ${candles.length} баров, находок с движением ≥ ${MIN_MOVE_ATR} ATR: ${n}`);
}

// Отбор: по каждой фигуре — самые уверенные, не больше PER_TICKER с одного тикера, не больше PER_PATTERN всего
const items = [];
const byQuiz = {};
for (const f of found) (byQuiz[f.quiz] ||= []).push(f);
for (const [quiz, list] of Object.entries(byQuiz)) {
  // Уверенность у детектора почти одинакова внутри типа фигуры (см. PATTERN_CONFIDENCE_REPORT.md), поэтому сортировка только по ней
  // отдавала бы первые тикеры списка. Сначала перемешиваем (одинаково при каждом запуске), затем сортируем по корзине уверенности.
  list.sort((a, b) => hash(a.ticker + a.i + a.detector) - hash(b.ticker + b.i + b.detector));
  list.sort((a, b) => Math.floor(b.conf / 5) - Math.floor(a.conf / 5));
  const perTicker = {};
  let taken = 0;
  for (const f of list) {
    if (taken >= PER_PATTERN) break;
    if ((perTicker[f.ticker] || 0) >= PER_TICKER) continue;
    // не берём два примера одного тикера, стоящих почти рядом по времени (были бы почти одним графиком)
    if (items.some((x) => x.t === f.ticker && Math.abs(x.endDay - dayOf(f.candles[f.i].date)) < 60 && x.truth === quiz)) continue;
    perTicker[f.ticker] = (perTicker[f.ticker] || 0) + 1;
    taken += 1;
    const start = Math.max(0, Math.min(f.first - BEFORE, f.i - MAX_VISIBLE));
    const end = Math.min(f.candles.length - 1, f.i + FUTURE_SHOW);
    const slice = f.candles.slice(start, end + 1);
    const days = slice.map((c) => dayOf(c.date));
    items.push({
      id: `${f.ticker}-${days[f.i - start]}-${f.detector}`,
      t: f.ticker,
      truth: quiz,
      det: f.detector,
      conf: f.conf,
      cut: f.i - start,                    // номер последней видимой свечи (момент находки)
      d0: days[0],
      dd: days.slice(1).map((d, k) => d - days[k]),
      b: slice.map((c) => [round(c.open), round(c.high), round(c.low), round(c.close)]),
      pts: f.pts.map((p) => [p.index - start, round(p.price), p.type || '']),
      up: Math.round(f.up * 10) / 10,      // дальше всего вверх, в ATR, за HORIZON баров
      down: Math.round(f.down * 10) / 10,
      endDay: days[f.i - start],
    });
  }
}
items.sort((a, b) => a.truth.localeCompare(b.truth));
for (const it of items) delete it.endDay;

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  note: `Дневные графики ${TICKERS.length} ликвидных акций Мосбиржи. Фигуру нашёл алгоритм приложения (уверенность ≥ ${MIN_CONF}); после неё цена за ${HORIZON} баров прошла не меньше ${MIN_MOVE_ATR} ATR (вверх или вниз). «Ответ» — название от алгоритма, не проверенная истина.`,
  horizon: HORIZON, minMoveAtr: MIN_MOVE_ATR, minConfidence: MIN_CONF,
  items,
};
const dir = path.join(repoRoot, 'public/trainer');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'real_patterns.json');
fs.writeFileSync(file, JSON.stringify(out));
const counts = {};
for (const it of items) counts[it.truth] = (counts[it.truth] || 0) + 1;
console.log(`\nСохранено ${items.length} примеров → ${path.relative(repoRoot, file)} (${Math.round(fs.statSync(file).size / 1024)} КБ)`);
console.log(counts);
