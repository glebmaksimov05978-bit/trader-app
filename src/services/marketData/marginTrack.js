// src/services/marketData/marginTrack.js
//
// ГО (гарантийное обеспечение), плечо и параметры фьючерсов из таблицы Мосбиржи + слежение за их изменением.
//
// Зачем. ГО по контракту биржа пересматривает (чаще всего на клиринге, иногда внутри дня), а плечо = стоимость контракта /
// ГО меняется и от ГО, и от цены. Трейдер, который считал позицию по вчерашнему ГО, получает неверный риск и неверное
// плечо — поэтому значения нужно подтягивать свежими, показывать рядом с инструментом и говорить, когда они изменились.
//
// Источник: ОДИН запрос к бирже (ISS, без токена, ≈70 КБ, ~1 с) отдаёт ВСЕ фьючерсы: шаг цены, стоимость шага, ГО, лот,
// биржевой сбор, дату экспирации, последнюю цену. Это «биржевое» ГО — одно число на обе стороны; у брокера (Т-Банк) оно
// своё для лонга и шорта и обычно выше на несколько процентов (у Роснефти шорт +27 %). Если у робота есть доступ к
// Т-Банку через посредника, сюда приходит и оно (источник 'tbank'), иначе — биржевое ('moex'), и в интерфейсе это подписано.
//
// Модуль чистый и без зависимостей: его загружают приложение, роботы (GitHub Actions / Яндекс) и тесты.

const DAY = 86400000;
export const DEFAULT_MIN_DAYS = 5;          // за сколько дней до экспирации корень переходит на следующий контракт (как в futuresRoll)
export const DEFAULT_NOTIFY_PCT = 3;        // с какого изменения ГО (в %) слать сообщение
export const EXPIRY_WARN_DAYS = 5;          // за сколько дней предупреждать об экспирации открытой позиции
export const CHANGE_VISIBLE_DAYS = 14;      // сколько дней в радаре виден значок «ГО изменилось»

/** URL запроса к ISS: все фьючерсы разом. */
export const FORTS_URL = 'https://iss.moex.com/iss/engines/futures/markets/forts/securities.json?iss.meta=off&iss.only=securities,marketdata'
  + '&securities.columns=SECID,SHORTNAME,ASSETCODE,LASTTRADEDATE,MINSTEP,STEPPRICE,INITIALMARGIN,LOTVOLUME,BUYSELLFEE,SECTYPE,PREVSETTLEPRICE,LOWLIMIT,HIGHLIMIT'
  + '&marketdata.columns=SECID,LAST,SETTLEPRICE,UPDATETIME';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Контракт с датой (BRZ6, SiH7, 92F7) — а не вечный (EURRUBF). */
export const isDatedContract = (secid) => /^[A-Za-z0-9]{1,3}[FGHJKMNQUVXZ]\d$/.test(String(secid || ''));

/**
 * Ответ ISS → Map<SECID, строка>. Строка: { secid, name, root, asset, expiry:Date|null, minStep, stepPrice, margin, lot, fee,
 * price, priceKind:'last'|'settle'|'prev'|null, lowLimit, highLimit, time }.
 */
export function parseFortsTable(json) {
  const out = new Map();
  const sec = json?.securities;
  if (!sec?.columns || !Array.isArray(sec.data)) return out;
  const c = (n) => sec.columns.indexOf(n);
  const md = new Map();
  const mc = json?.marketdata?.columns || [];
  for (const r of json?.marketdata?.data || []) {
    md.set(String(r[mc.indexOf('SECID')]), { last: r[mc.indexOf('LAST')], settle: r[mc.indexOf('SETTLEPRICE')], time: r[mc.indexOf('UPDATETIME')] });
  }
  for (const r of sec.data) {
    const secid = String(r[c('SECID')] ?? '');
    if (!secid) continue;
    const m = md.get(secid) || {};
    let price = num(m.last), priceKind = price > 0 ? 'last' : null;
    if (!(price > 0)) { price = num(m.settle); priceKind = price > 0 ? 'settle' : null; }
    if (!(price > 0)) { price = num(r[c('PREVSETTLEPRICE')]); priceKind = price > 0 ? 'prev' : null; }
    const exp = r[c('LASTTRADEDATE')];
    const expiry = exp ? new Date(`${exp}T20:59:59Z`) : null; // последний день торгов до конца вечерней сессии (по Москве ~23:59)
    out.set(secid, {
      secid, name: r[c('SHORTNAME')] || secid, root: String(r[c('SECTYPE')] || ''), asset: r[c('ASSETCODE')] || '',
      expiry: expiry && !Number.isNaN(expiry.getTime()) ? expiry : null,
      minStep: num(r[c('MINSTEP')]), stepPrice: num(r[c('STEPPRICE')]), margin: num(r[c('INITIALMARGIN')]),
      lot: num(r[c('LOTVOLUME')]) || 1, fee: num(r[c('BUYSELLFEE')]),
      price: price || null, priceKind, lowLimit: num(r[c('LOWLIMIT')]) || null, highLimit: num(r[c('HIGHLIMIT')]) || null,
      time: m.time || null,
    });
  }
  return out;
}

export const daysLeftOf = (row, now = new Date()) => (row?.expiry ? Math.floor((row.expiry.getTime() - now.getTime()) / DAY) : null);

/**
 * Какой контракт стоит за тикером из радара/сделки. Конкретный код (MMZ6) — он сам; корень (MM, BR, Si) — ближайший действующий
 * контракт, до экспирации которого осталось не меньше minDays дней (так же выбирает futuresRoll.js). null — такого фьючерса нет.
 * @returns {{row:object, viaRoot:string|null}|null}
 */
export function resolveContract(table, ticker, now = new Date(), minDays = DEFAULT_MIN_DAYS) {
  const t = String(ticker || '').trim();
  if (!t || !table?.size) return null;
  const low = t.toLowerCase();
  let exact = table.get(t) || null;
  if (!exact) for (const r of table.values()) { if (r.secid.toLowerCase() === low) { exact = r; break; } }
  if (exact) return { row: exact, viaRoot: null };
  const alive = [...table.values()]
    .filter((r) => r.root && r.root.toLowerCase() === low && isDatedContract(r.secid) && r.expiry && daysLeftOf(r, now) >= 0)
    .sort((a, b) => a.expiry - b.expiry);
  const pick = alive.find((r) => daysLeftOf(r, now) >= minDays) || alive[0] || null;
  return pick ? { row: pick, viaRoot: t } : null;
}

/** Стоимость одного контракта в рублях при цене price: цена / шаг × стоимость шага. 0 — считать не из чего. */
export function contractValueRub(row, price) {
  const p = num(price ?? row?.price);
  return p > 0 && num(row?.minStep) > 0 && num(row?.stepPrice) > 0 ? (p / row.minStep) * row.stepPrice : 0;
}

/** Плечо = стоимость контракта / ГО. 0 — считать не из чего. */
export function leverageOf(valueRub, marginRub) {
  const v = num(valueRub), m = num(marginRub);
  return v > 0 && m > 0 ? v / m : 0;
}

const pctChange = (to, from) => (num(from) > 0 ? ((num(to) - num(from)) / num(from)) * 100 : 0);

/** Настройки уведомлений о ГО из alertPrefs (по умолчанию всё включено, порог 3 %). */
export function marginPrefsOf(alertPrefs) {
  const p = alertPrefs || {};
  const pct = Number(p.marginNotifyPct);
  return {
    radar: p.marginNotifyRadar !== false,
    open: p.marginNotifyOpen !== false,
    minPct: Number.isFinite(pct) && pct > 0 ? Math.min(50, Math.max(1, pct)) : DEFAULT_NOTIFY_PCT,
  };
}

/**
 * Один проход слежения.
 * @param {object} a
 * @param {object|null} a.prev   прошлое состояние: { items:{SECID:{buy,sell,src,since,prevBuy,prevSell,base:{buy,sell}}}, roots:{ROOT:SECID}, warned:{SECID:'YYYY-MM-DD'} }
 * @param {Array<{ticker:string, scope:'radar'|'open'}>} a.wanted  что отслеживать; scope 'open' сильнее 'radar'
 * @param {Map} a.table          parseFortsTable(...)
 * @param {Map<string,{buy:number,sell:number}>} [a.tbank]  ГО Т-Банка по SECID (если есть)
 * @param {{radar:boolean, open:boolean, minPct:number}} a.prefs
 * @param {Date} [a.now]
 * @param {string} [a.today]     'YYYY-MM-DD' (по Москве) — для «предупредили сегодня»
 * @returns {{state:object, changes:Array, rolls:Array, expiring:Array, missing:string[]}}
 */
export function planMarginRun({ prev, wanted, table, tbank = new Map(), prefs, now = new Date(), today = now.toISOString().slice(0, 10) }) {
  const items = {}, roots = {};
  const changes = [], rolls = [], expiring = [], missing = [];
  const warned = { ...(prev?.warned || {}) };
  // Дубли (радар у двух стратегий + открытая позиция по тому же контракту) сводим к одному: «позиция» сильнее «радара».
  const byTicker = new Map();
  for (const w of wanted || []) {
    const key = String(w.ticker || '').toUpperCase();
    if (!key) continue;
    const cur = byTicker.get(key);
    if (!cur || (w.scope === 'open' && cur.scope !== 'open')) byTicker.set(key, { ticker: w.ticker, scope: w.scope === 'open' ? 'open' : 'radar' });
  }
  const seenSecid = new Map();
  for (const w of byTicker.values()) {
    const res = resolveContract(table, w.ticker, now);
    if (!res) { missing.push(w.ticker); continue; }
    const { row, viaRoot } = res;
    const secid = row.secid;
    if (seenSecid.has(secid)) { if (w.scope === 'open') seenSecid.get(secid).scope = 'open'; continue; }
    const rec = { w, row, viaRoot, scope: w.scope };
    seenSecid.set(secid, rec);
  }
  const allowed = (scope) => (scope === 'open' ? prefs.open : prefs.radar);

  for (const [secid, { w, row, viaRoot, scope }] of seenSecid) {
    if (viaRoot) {
      roots[viaRoot.toUpperCase()] = secid;
      const was = prev?.roots?.[viaRoot.toUpperCase()];
      if (was && was !== secid && allowed(scope)) rolls.push({ ticker: w.ticker, root: viaRoot, from: was, to: secid, scope });
    }
    const tb = tbank.get(secid);
    const buy = num(tb?.buy) || row.margin;
    const sell = num(tb?.sell) || row.margin;
    if (!(buy > 0) && !(sell > 0)) continue; // ГО нет — нечего отслеживать
    const src = tb ? 'tbank' : 'moex';
    const old = prev?.items?.[secid];
    const same = old && old.src === src ? old : null;
    const entry = { buy, sell, src, base: { buy, sell } };
    if (same) {
      const moved = Math.abs(buy - same.buy) > 0.005 || Math.abs(sell - same.sell) > 0.005;
      if (moved) { entry.prevBuy = same.buy; entry.prevSell = same.sell; entry.since = now.toISOString(); }
      else { if (same.prevBuy != null) { entry.prevBuy = same.prevBuy; entry.prevSell = same.prevSell; } if (same.since) entry.since = same.since; }
      const base = same.base || { buy: same.buy, sell: same.sell };
      const pb = pctChange(buy, base.buy), ps = pctChange(sell, base.sell);
      if (Math.max(Math.abs(pb), Math.abs(ps)) >= prefs.minPct) {
        // Базу сдвигаем всегда — даже если сообщения для этого вида выключены, чтобы при включении не прислать «старое».
        if (allowed(scope)) changes.push({ ticker: w.ticker, secid, scope, src, row, from: { buy: base.buy, sell: base.sell }, to: { buy, sell }, pct: { buy: pb, sell: ps } });
      } else entry.base = base;
    } else if (old?.since) entry.since = null; // смена источника — не изменение ГО
    items[secid] = entry;

    // Предупреждение об экспирации — только по открытым позициям и один раз в сутки.
    const left = daysLeftOf(row, now);
    if (scope === 'open' && left != null && left >= 0 && left <= EXPIRY_WARN_DAYS && prefs.open && warned[secid] !== today) {
      expiring.push({ ticker: w.ticker, secid, daysLeft: left, row });
      warned[secid] = today;
    }
  }
  // «Предупредили сегодня» храним недолго: записи старше 10 дней выбрасываем.
  for (const k of Object.keys(warned)) if (!warned[k] || Date.parse(warned[k]) < now.getTime() - 10 * DAY) delete warned[k];
  return { state: { at: now.toISOString(), items, roots, warned }, changes, rolls, expiring, missing };
}

const ru = (n, d = 0) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });
const sign = (p) => (p > 0 ? '+' : p < 0 ? '−' : '');
const pctText = (p) => `${sign(p)}${ru(Math.abs(p), Math.abs(p) < 10 ? 1 : 0)} %`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const levText = (l) => (l > 0 ? `${ru(l, l < 10 ? 1 : 0)}×` : '—');

/** Текст сообщения в Telegram (HTML) или null, если сообщать нечего. */
export function formatMarginMessage({ changes = [], rolls = [], expiring = [] }) {
  const lines = [];
  if (changes.length) {
    lines.push('📊 <b>Изменилось ГО по фьючерсам</b>');
    for (const c of changes) {
      const where = c.scope === 'open' ? 'открытая позиция' : 'радар';
      const price = c.row.price;
      const value = contractValueRub(c.row, price);
      const sides = [];
      const sameSides = Math.abs(c.from.buy - c.from.sell) < 0.005 && Math.abs(c.to.buy - c.to.sell) < 0.005;
      const mk = (label, f, t, p) => `${label ? `${label} ` : ''}${ru(f)} → ${ru(t)} ₽ (${pctText(p)})`;
      if (sameSides) sides.push(`ГО ${mk('', c.from.buy, c.to.buy, c.pct.buy)}`);
      else { sides.push(`ГО лонг ${mk('', c.from.buy, c.to.buy, c.pct.buy)}`); sides.push(`шорт ${mk('', c.from.sell, c.to.sell, c.pct.sell)}`); }
      const levFrom = leverageOf(value, c.from.buy), levTo = leverageOf(value, c.to.buy);
      const lev = levFrom > 0 && levTo > 0 ? ` · плечо при цене ${ru(price, price < 100 ? 2 : 0)}: ${levText(levFrom)} → ${levText(levTo)}` : '';
      lines.push(`• <b>${esc(c.secid)}</b> (${where}): ${sides.join(', ')}${lev}`);
    }
    const anyMoex = changes.some((c) => c.src !== 'tbank');
    if (anyMoex) lines.push('<i>ГО — по данным биржи. У брокера оно обычно выше на несколько процентов, шорт — иногда заметно выше: перед сделкой сверьтесь с терминалом.</i>');
  }
  if (rolls.length) {
    if (lines.length) lines.push('');
    lines.push('🔄 <b>Контракт сменился</b>');
    for (const r of rolls) {
      const rec = r.row;
      lines.push(`• «${esc(r.root)}»: теперь ${esc(r.to)} (был ${esc(r.from)})${rec?.margin ? `, ГО ${ru(rec.margin)} ₽` : ''}`);
    }
  }
  if (expiring.length) {
    if (lines.length) lines.push('');
    lines.push('⏳ <b>Скоро экспирация открытой позиции</b>');
    for (const e of expiring) lines.push(`• <b>${esc(e.secid)}</b>: ${e.daysLeft === 0 ? 'последний день торгов — сегодня' : `до конца торгов ${e.daysLeft} дн.`} Позицию нужно закрыть или перенести на следующий контракт.`);
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * Что показать в строке радара. table — свежая таблица биржи (живая), state — состояние робота (может отсутствовать).
 * @returns {null|{secid, viaRoot, src, buy, sell, price, priceKind, value, levBuy, levSell, daysLeft, lot, fee, name, change}}
 */
export function marginView({ ticker, table, state, now = new Date() }) {
  const res = resolveContract(table, ticker, now);
  if (!res) return null;
  const { row, viaRoot } = res;
  const st = state?.items?.[row.secid];
  const fresh = st && state.at && now.getTime() - Date.parse(state.at) < 36 * 3600 * 1000;
  const tb = fresh && st.src === 'tbank';
  const buy = tb ? st.buy : row.margin;
  const sell = tb ? st.sell : row.margin;
  const value = contractValueRub(row);
  let change = null;
  if (st && st.prevBuy != null && st.since && now.getTime() - Date.parse(st.since) < CHANGE_VISIBLE_DAYS * DAY && st.src === (tb ? 'tbank' : 'moex')) {
    const p = pctChange(st.buy, st.prevBuy);
    if (Math.abs(p) >= 0.05) change = { from: st.prevBuy, to: st.buy, pct: p, at: st.since };
  }
  return {
    secid: row.secid, viaRoot, src: tb ? 'tbank' : 'moex', buy, sell, price: row.price, priceKind: row.priceKind,
    value, levBuy: leverageOf(value, buy), levSell: leverageOf(value, sell),
    daysLeft: daysLeftOf(row, now), lot: row.lot, fee: row.fee, name: row.name, time: row.time, change,
  };
}

/** Короткая строка для радара: «ГО 2 751 ₽ · плечо ≈ 9×». */
export function marginLine(v) {
  if (!v || !(v.buy > 0)) return '';
  const two = Math.abs(v.buy - v.sell) >= 0.005;
  const go = two ? `ГО лонг ${ru(v.buy)} / шорт ${ru(v.sell)} ₽` : `ГО ${ru(v.buy)} ₽`;
  const lev = v.levBuy > 0 ? ` · плечо ≈ ${two && v.levSell > 0 ? `${levText(v.levBuy)} / ${levText(v.levSell)}` : levText(v.levBuy)}` : '';
  return `${go}${lev}`;
}
