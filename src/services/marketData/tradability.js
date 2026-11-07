// src/services/marketData/tradability.js
//
// «Торгуется ли это сейчас на Мосбирже» — проверка при добавлении инструмента в радар. Раньше тикер, введённый руками
// («нет в каталоге — добавить как есть»), принимался вслепую и считался акцией: истёкший фьючерс ММU5 попадал в радар,
// а ночью робот-чистильщик (scripts/radar/cleanupRadar.mjs) удалял его и писал в Telegram «больше не торгуется».
// Теперь это выясняется сразу: и тип (фьючерс/акция) определяется по коду, и срок вышел или нет.
//
// Осторожность та же, что у чистильщика: сеть упала, биржа не ответила — ответ «не знаю» (ok: true, unknown: true), добавление
// не блокируем. Блокируем только когда биржа ясно сказала «нет такого» или «не торгуется».
import { guessInstrumentType } from '../import/instrumentResolver';
import { isFuturesRoot, rootTickerOfContract, FUTURES_ROOTS } from './futuresRoll';

const ISS = 'https://iss.moex.com/iss';

/**
 * @returns {Promise<{ok:boolean, unknown?:boolean, type?:string, reason?:string, replaceWith?:string}>}
 *   ok:false — добавлять нельзя (reason — по-русски для человека); replaceWith — корень, которым можно заменить истёкший контракт.
 */
export async function checkTradable(ticker, instrumentType, { fetchImpl, timeoutMs = 6000 } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return { ok: false, reason: 'Пустой тикер' };
  const type = instrumentType || guessInstrumentType(t);
  if (type === 'future' && isFuturesRoot(t)) return { ok: true, type }; // корень сам переходит на действующий контракт
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: true, unknown: true, type };
  let rows;
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(
        `${ISS}/securities.json?q=${encodeURIComponent(t)}&iss.meta=off&iss.only=securities&securities.columns=secid,shortname,is_traded,group`,
        ctl ? { signal: ctl.signal } : undefined,
      );
      if (!res.ok) return { ok: true, unknown: true, type };
      rows = (await res.json())?.securities?.data || [];
    } finally { if (timer) clearTimeout(timer); }
  } catch {
    return { ok: true, unknown: true, type };
  }
  const hit = rows.find((r) => String(r[0]).toUpperCase() === t);
  const root = rootTickerOfContract(t);
  if (!hit) {
    return root
      ? { ok: false, type, replaceWith: root, reason: `Контракт ${t} уже не торгуется (срок вышел). Вместо него подойдёт «${root}» — ${FUTURES_ROOTS[root].name}, он сам переходит на действующий контракт.` }
      : { ok: false, type, reason: `${t} не найден на Мосбирже. Проверьте написание.` };
  }
  const traded = Number(hit[2]) === 1;
  const realType = hit[3] === 'futures_forts' ? 'future' : (String(hit[3] || '').startsWith('currency') ? 'currency' : 'stock');
  if (traded) return { ok: true, type: realType };
  if (realType === 'future' && root) {
    return { ok: false, type: realType, replaceWith: root, reason: `Контракт ${t} уже не торгуется (срок вышел). Вместо него подойдёт «${root}» — ${FUTURES_ROOTS[root].name}, он сам переходит на действующий контракт.` };
  }
  return { ok: false, type: realType, reason: `${t} сейчас не торгуется на Мосбирже.` };
}
