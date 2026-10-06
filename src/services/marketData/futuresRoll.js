// src/services/marketData/futuresRoll.js
//
// «Вечные» инструменты из сменяемых контрактов: нефть, газ, платина, палладий и фьючерсы на
// акции живут по несколько месяцев и заменяются новыми (BRX6 → BRZ6 → BRF7…). Трейдеру
// нужно думать про «нефть», а не про код конкретного контракта, поэтому:
//
//   1. В каталоге/радаре лежит КОРЕНЬ (BR, NG, PT…). Ниже он превращается в конкретный
//      контракт, которым реально торгуют (первый, до экспирации которого осталось не меньше
//      N дней).
//   2. Для АНАЛИЗА (индикаторы, графики, условия стратегии) история склеивается из этого
//      контракта и нескольких предыдущих — иначе у свежего контракта было бы всего пару
//      месяцев свечей и индикаторам не на чём считаться. Склейка со сдвигом по отношению цен
//      на стыке (стандартная «обратная» корректировка), чтобы на стыке не было ложного скачка.
//   3. Сделки (бумажные и настоящие) открываются ТОЛЬКО по конкретному контракту, а не по
//      склейке; за N дней до его экспирации новые входы не открываются.
//
// Модуль сам подключается к candles.js через registerRootResolver — так candles.js остаётся
// без единой новой зависимости (его без правок загружают десятки исследовательских скриптов).
import { fetchDailyCandles, registerRootResolver } from './candles.js';

const ISS_BASE = 'https://iss.moex.com/iss';
const MONTH_LETTERS = 'FGHJKMNQUVXZ'; // янв…дек по коду биржи
export const DEFAULT_MIN_DAYS_TO_EXPIRY = 5;
// Сколько прошлых контрактов подклеивать: месячные живут недолго, квартальные — дольше.
const stitchCount = (root) => (root.cycle === 'monthly' ? 6 : 4);
const LIST_TTL_MS = 10 * 60 * 1000;

// prefix — начало кода контракта; asset — ASSETCODE на бирже (не всегда совпадает с prefix);
// cycle — как часто выходят контракты: monthly — каждый месяц, quarterly — март/июнь/сентябрь/декабрь.
export const FUTURES_ROOTS = {
  BR: { name: 'Нефть Brent', prefix: 'BR', asset: 'BR', cycle: 'monthly' },
  NG: { name: 'Природный газ', prefix: 'NG', asset: 'NG', cycle: 'monthly' },
  PT: { name: 'Платина', prefix: 'PT', asset: 'PLT', cycle: 'quarterly' },
  PD: { name: 'Палладий', prefix: 'PD', asset: 'PLD', cycle: 'quarterly' },
  GK: { name: 'Норникель (фьючерс)', prefix: 'GK', asset: 'GMKN', cycle: 'quarterly' },
  LK: { name: 'Лукойл (фьючерс)', prefix: 'LK', asset: 'LKOH', cycle: 'quarterly' },
  RN: { name: 'Роснефть (фьючерс)', prefix: 'RN', asset: 'ROSN', cycle: 'quarterly' },
  VB: { name: 'ВТБ (фьючерс)', prefix: 'VB', asset: 'VTBR', cycle: 'quarterly' },
};

export const isFuturesRoot = (ticker) => Object.prototype.hasOwnProperty.call(FUTURES_ROOTS, String(ticker || '').toUpperCase());

const DAY_MS = 86400000;
export const daysBetween = (from, to) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/** Код контракта по корню и дате выпуска: ('BR', 2026, 12) → 'BRZ6'. month — 1..12. */
export function contractCode(prefix, year, month) {
  return `${prefix}${MONTH_LETTERS[month - 1]}${year % 10}`;
}

/** Месяцы выпуска контрактов в году для цикла. */
function cycleMonths(cycle) {
  return cycle === 'monthly' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [3, 6, 9, 12];
}

/**
 * Коды `count` контрактов ДО указанного (старше), от свежего к старому. Нужны для склейки
 * истории: у истёкших контрактов в списке биржи записей нет, но свечи по их коду отдаются.
 */
export function previousCodes(root, year, month, count) {
  const months = cycleMonths(root.cycle);
  const out = [];
  let y = year, i = months.indexOf(month);
  if (i < 0) return out;
  while (out.length < count) {
    i -= 1;
    if (i < 0) { i = months.length - 1; y -= 1; }
    out.push({ code: contractCode(root.prefix, y, months[i]), year: y, month: months[i] });
  }
  return out;
}

/** Разобрать код контракта обратно: ('BRZ6', root) → { year: ?, month: 12 }. Год — ближайший к `now`. */
export function parseCode(code, root, now = new Date()) {
  const m = new RegExp(`^${root.prefix}([${MONTH_LETTERS}])(\\d)$`).exec(code);
  if (!m) return null;
  const month = MONTH_LETTERS.indexOf(m[1]) + 1;
  const digit = Number(m[2]);
  const decade = Math.floor(now.getUTCFullYear() / 10) * 10;
  let year = decade + digit;
  if (year < now.getUTCFullYear() - 5) year += 10;
  if (year > now.getUTCFullYear() + 5) year -= 10;
  return { year, month };
}

/**
 * Из списка действующих контрактов [{secid, expiry: Date}] выбрать нужные.
 *   nearest  — ближайший к экспирации (ещё торгуется);
 *   tradable — первый, до конца которого осталось не меньше minDays дней: им и торгуем.
 * Список может быть в любом порядке.
 */
export function pickContracts(contracts, now, minDays = DEFAULT_MIN_DAYS_TO_EXPIRY) {
  const alive = (contracts || [])
    .filter((c) => c.expiry && daysBetween(now, c.expiry) >= 0)
    .sort((a, b) => a.expiry - b.expiry)
    .map((c) => ({ ...c, daysLeft: daysBetween(now, c.expiry) }));
  const nearest = alive[0] || null;
  const tradable = alive.find((c) => c.daysLeft >= minDays) || null;
  return { alive, nearest, tradable };
}

/**
 * Склейка рядов свечей по контрактам. `parts` — от СТАРОГО к НОВОМУ: каждая часть
 * { candles: [{date, open, high, low, close, volume}] }, последняя — базовый (торгуемый)
 * контракт, его цены не трогаются. Более старые части: берутся только бары РАНЬШЕ начала уже
 * склеенного хвоста и умножаются на коэффициент стыка (цена нового / цена старого на одном и
 * том же баре) — на стыке нет ложного скачка. Нет общего бара (контракты не торговались
 * одновременно) — часть пропускается: подставлять «на глаз» нельзя.
 */
export function stitchContracts(parts) {
  const sorted = parts.filter((p) => p?.candles?.length);
  if (!sorted.length) return [];
  let out = sorted[sorted.length - 1].candles.map((c) => ({ ...c }));
  for (let i = sorted.length - 2; i >= 0; i--) {
    const prev = sorted[i].candles;
    const firstT = out[0].date.getTime();
    const prevByTime = new Map(prev.map((c) => [c.date.getTime(), c]));
    // Общий бар: первый бар хвоста, который есть и в старом контракте.
    let k = -1;
    for (let j = 0; j < Math.min(out.length, 400); j++) {
      if (prevByTime.has(out[j].date.getTime())) { k = j; break; }
    }
    if (k < 0) continue;
    const ratio = out[k].close / prevByTime.get(out[k].date.getTime()).close;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const older = prev
      .filter((c) => c.date.getTime() < firstT)
      .map((c) => ({
        ...c,
        open: c.open * ratio, high: c.high * ratio, low: c.low * ratio, close: c.close * ratio,
      }));
    out = [...older, ...out];
  }
  return out;
}

// --- Биржа ---------------------------------------------------------------------------------
let listCache = { at: 0, rows: null };

async function activeContractRows() {
  if (listCache.rows && Date.now() - listCache.at < LIST_TTL_MS) return listCache.rows;
  const resp = await fetch(
    `${ISS_BASE}/engines/futures/markets/forts/securities.json?iss.meta=off`
    + '&iss.only=securities&securities.columns=SECID,ASSETCODE,LASTTRADEDATE',
  );
  if (!resp.ok) throw new Error(`MOEX ISS error ${resp.status}`);
  const json = await resp.json();
  const rows = (json.securities?.data || []).map(([secid, asset, last]) => ({
    secid, asset, expiry: last ? new Date(`${last}T23:59:59+03:00`) : null,
  }));
  listCache = { at: Date.now(), rows };
  return rows;
}

/** Действующие контракты корня с датами экспирации. */
export async function activeContractsOf(root) {
  const rows = await activeContractRows();
  return rows.filter((r) => r.asset === root.asset && r.expiry);
}

/** Дата экспирации любого действующего контракта по коду (null — не найден, вечный = 2100). */
export async function expiryOfContract(secid) {
  const rows = await activeContractRows();
  const hit = rows.find((r) => r.secid === String(secid).toUpperCase());
  return hit?.expiry || null;
}

/**
 * Разбор корня: каким контрактом торговать сейчас и можно ли открывать новые входы.
 * Возвращает null для обычного (не корневого) тикера.
 */
export async function resolveFutureRoot(ticker, now = new Date(), minDays = DEFAULT_MIN_DAYS_TO_EXPIRY) {
  const key = String(ticker || '').toUpperCase();
  if (!isFuturesRoot(key)) return null;
  const root = FUTURES_ROOTS[key];
  const { alive, nearest, tradable } = pickContracts(await activeContractsOf(root), now, minDays);
  return { rootTicker: key, root, alive, nearest, tradable, minDays };
}

/**
 * Можно ли открывать НОВУЮ позицию по этому тикеру. Для корня — есть ли контракт с запасом до
 * экспирации; для конкретного контракта — не слишком ли он близок к концу. Вечные (экспирация
 * 2100) и не-фьючерсы пропускаются. Ответ: { ok, ticker (чем торговать), reason? }.
 */
export async function entryGuard(ticker, instrumentType, now = new Date(), minDays = DEFAULT_MIN_DAYS_TO_EXPIRY) {
  const key = String(ticker || '').toUpperCase();
  if (instrumentType !== 'future') return { ok: true, ticker: key };
  if (isFuturesRoot(key)) {
    const r = await resolveFutureRoot(key, now, minDays);
    if (!r.tradable) {
      return { ok: false, ticker: r.nearest?.secid || key, reason: `нет контракта ${key} с запасом более ${minDays} дн. до экспирации` };
    }
    return { ok: true, ticker: r.tradable.secid, rootTicker: key, daysLeft: r.tradable.daysLeft };
  }
  const expiry = await expiryOfContract(key);
  if (!expiry || expiry.getUTCFullYear() >= 2099) return { ok: true, ticker: key };
  const daysLeft = daysBetween(now, expiry);
  if (daysLeft < minDays) {
    return { ok: false, ticker: key, daysLeft, reason: `контракт ${key} истекает через ${Math.max(daysLeft, 0)} дн. — новые входы не открываются (порог ${minDays} дн.)` };
  }
  return { ok: true, ticker: key, daysLeft };
}

// --- Подключение к candles.js ----------------------------------------------------------------
async function fetchRootCandles(args) {
  const key = String(args.ticker || '').toUpperCase();
  if (args.instrumentType !== 'future' || !isFuturesRoot(key)) return null;
  const now = args.toDate ? new Date(args.toDate) : new Date();
  const r = await resolveFutureRoot(key, now);
  // Базовый контракт: тот, которым торгуют; нет такого — ближайший (ряд всё равно нужен для графика).
  const base = r.tradable || r.nearest;
  if (!base) throw new Error(`Нет действующих контрактов ${key}`);

  const parsed = parseCode(base.secid, r.root, now);
  const prevs = parsed ? previousCodes(r.root, parsed.year, parsed.month, stitchCount(r.root)) : [];
  // Более ранние из ДЕЙСТВУЮЩИХ контрактов тоже годятся — они уже в списке биржи, но
  // перечисленные генератором коды их покрывают; дубли склейка не создаёт (берёт бары раньше хвоста).
  const own = { ...args, ticker: base.secid };
  const results = await Promise.allSettled([
    fetchDailyCandles(own),
    ...prevs.map((p) => fetchDailyCandles({ ...args, ticker: p.code })),
  ]);
  const baseRes = results[0];
  if (baseRes.status !== 'fulfilled' || !baseRes.value.length) {
    throw new Error(`Нет свечей по контракту ${base.secid}`);
  }
  // От старого к новому: прошлые контракты в обратном порядке, затем базовый.
  const parts = [...results.slice(1)].reverse()
    .map((x) => ({ candles: x.status === 'fulfilled' ? x.value : [] }));
  parts.push({ candles: baseRes.value });
  return stitchContracts(parts);
}

registerRootResolver(fetchRootCandles);
