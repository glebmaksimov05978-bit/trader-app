// src/services/analytics/entrySnapshot.js
//
// «Снимок входа»: что именно сошлось и какими были индикаторы в момент, когда робот открыл сделку системы.
// Без него в сделке оставался только счёт «5 из 8» — какие условия сошлись и при каких значениях, узнать потом
// было нельзя (а пересчёт задним числом не гарантирует тот же ответ: история свечей у биржи уточняется).
// Модуль без зависимостей: его читают и приложение, и робот (scripts/paper/runPaperTrades.mjs).
//
// В результате нет ни одного undefined — база на стороне робота (Admin SDK) отвергает запись целиком,
// если встретит undefined хоть в одном поле.

const round = (n) => Number(Number(n).toPrecision(8));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Плоский набор «имя → число/строка/да-нет»: вложенные объекты разворачиваются на один уровень (bollinger.upper →
// bollinger_upper), всё остальное (массивы, даты, пустые значения) пропускается.
function flatten(obj, limit) {
  const out = {};
  let n = 0;
  const put = (k, v) => {
    if (n >= limit) return;
    if (isNum(v)) { out[k] = round(v); n += 1; }
    else if (typeof v === 'boolean' || (typeof v === 'string' && v.length <= 60)) { out[k] = v; n += 1; }
  };
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === 'date' || v == null || Array.isArray(v) || v instanceof Date) continue;
    if (typeof v === 'object') { for (const [k2, v2] of Object.entries(v)) put(`${k}_${k2}`, v2); }
    else put(k, v);
  }
  return out;
}

/**
 * @param {object} a
 * @param {Array}  a.results        evaluateStrategy(...).results
 * @param {object} [a.indicators]   ctx.indicators (computeIndicatorsAtEntry)
 * @param {object} [a.marketContext] ctx.marketContext
 * @returns {{entryConditions: Array<{id:string,label:string,passed:boolean,detail?:string}>, entryIndicators: object, entryMarketContext: object}}
 */
export function entrySnapshot({ results, indicators, marketContext }) {
  const entryConditions = (Array.isArray(results) ? results : [])
    .filter((r) => r && !r.na)
    .slice(0, 40)
    .map((r) => {
      const row = { id: String(r.id ?? ''), label: String(r.label ?? ''), passed: !!r.passed };
      if (typeof r.detail === 'string' && r.detail) row.detail = r.detail.slice(0, 200);
      if (r.custom) row.custom = true;
      return row;
    });
  return {
    entryConditions,
    entryIndicators: flatten(indicators, 60),
    entryMarketContext: flatten(marketContext, 30),
  };
}
