// src/services/marketData/radarCleanup.js
//
// Что делать с «мёртвыми» записями радара. Чистое решение без сети и базы — чтобы его можно
// было проверить тестом на выдуманных данных; сам обход и запись — scripts/radar/cleanupRadar.mjs.
//
// Мёртвые записи бывают двух видов, и с ними поступают по-разному:
//   1. Конкретный фьючерс, чей срок вышел (ММУ5 после сентября 2025). Это не ошибка, а обычная
//      жизнь контракта: если известен «корень» (MM — мини-индекс), запись ЗАМЕНЯЕТСЯ на корень, и
//      дальше инструмент сам переходит с контракта на контракт (futuresRoll.js). Стратегия и
//      таймфрейм записи сохраняются.
//   2. Инструмента нет на бирже вообще (бумага ушла с торгов, выдуманный тикер вроде VTBRF).
//      Заменить нечем — запись убирается.
//
// Осторожность важнее аккуратности: любые сомнения (список биржи не загрузился, он подозрительно
// короткий, акция числится торгуемой где-то ещё) — запись НЕ трогаем. Удалять чужие данные по
// сбою сети нельзя.
import { isFuturesRoot, rootTickerOfContract } from './futuresRoll.js';

const MIN_STOCK_LIST = 200;   // в списке бумаг Мосбиржи их сотни; короче — ответ неполный, верить нельзя
const MIN_FUTURE_LIST = 50;
const MAX_SHARE_REMOVED = 0.5; // больше половины радара за раз — это не чистка, а сбой

/**
 * @param {Array<{id, ticker, instrumentType}>} items — записи радара
 * @param {object} ctx
 * @param {Set<string>|null} ctx.stockSecids     — тикеры, торгуемые сейчас на рынке акций (null — не загрузилось)
 * @param {Set<string>|null} ctx.futureSecids    — коды действующих фьючерсов (null — не загрузилось)
 * @param {Map<string,string>} [ctx.stockStatus] — для акций, которых нет в списке: 'traded' (торгуется на другой
 *   площадке/это индекс) | 'dead' (на бирже нет или не торгуется) | иное — неизвестно
 * @returns {{ actions: Array<{id, ticker, action:'replace'|'remove', to?:string, reason:string}>, aborted?: string }}
 */
export function planRadarCleanup(items, ctx) {
  const actions = [];
  const present = new Set((items || []).map((i) => String(i.ticker || '').toUpperCase()));
  const planned = new Set(); // кем уже заменяем — чтобы не получить два одинаковых корня

  for (const it of items || []) {
    const ticker = String(it.ticker || '').toUpperCase();
    const type = it.instrumentType || 'stock';

    if (type === 'future') {
      if (isFuturesRoot(ticker)) continue;                              // корень — живой по определению
      if (!ctx.futureSecids || ctx.futureSecids.size < MIN_FUTURE_LIST) continue; // нет надёжного списка
      if (ctx.futureSecids.has(ticker)) continue;                       // контракт ещё торгуется (в т.ч. вечные)
      const root = rootTickerOfContract(ticker);
      if (root) {
        if (present.has(root) || planned.has(root)) {
          actions.push({ id: it.id, ticker, action: 'remove', reason: `контракт ${ticker} истёк; ${root} уже есть в радаре` });
        } else {
          planned.add(root);
          actions.push({ id: it.id, ticker, action: 'replace', to: root, reason: `контракт ${ticker} истёк — заменён на «${root}», он сам переходит на новый контракт` });
        }
      } else {
        actions.push({ id: it.id, ticker, action: 'remove', reason: `фьючерса ${ticker} нет на бирже (истёк или такого тикера не существует)` });
      }
      continue;
    }

    if (type === 'stock') {
      if (!ctx.stockSecids || ctx.stockSecids.size < MIN_STOCK_LIST) continue;
      if (ctx.stockSecids.has(ticker)) continue;
      if (ctx.stockStatus?.get(ticker) === 'dead') {
        actions.push({ id: it.id, ticker, action: 'remove', reason: `${ticker} больше не торгуется на Мосбирже` });
      }
    }
  }

  const removed = actions.filter((a) => a.action === 'remove').length;
  if ((items || []).length && removed / items.length > MAX_SHARE_REMOVED) {
    return { actions: [], aborted: `к удалению ${removed} из ${items.length} записей — больше половины радара, похоже на сбой данных биржи; ничего не трогаю` };
  }
  return { actions };
}
