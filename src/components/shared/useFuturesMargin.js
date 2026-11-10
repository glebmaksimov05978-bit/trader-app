// src/components/shared/useFuturesMargin.js
//
// Живая таблица фьючерсов биржи (одним запросом на все контракты) + состояние робота (ГО Т-Банка, история изменений) + ГО Т-Банка, которое
// приложение спрашивает у брокера само по токену трейдера (services/marketData/brokerMarginClient.js) — оно главнее биржевого.
// Таблица обновляется раз в минуту, пока вкладка на виду; состояние читается один раз; ГО брокера кэшируется на полчаса.
// Общий кэш — в services/futuresMargin.js, поэтому сколько бы строк радара и контрактных подписей ни было на экране, биржу они опрашивают
// один раз в 45 секунд.
import { useEffect, useMemo, useState } from 'react';
import { fetchFortsTable, getMarginState } from '../../services/futuresMargin';
import { resolveContract } from '../../services/marketData/marginTrack';
import { fetchBrokerMargins } from '../../services/marketData/brokerMarginClient';

const REFRESH_MS = 60 * 1000;
const BROKER_REFRESH_MS = 30 * 60 * 1000;

/**
 * @param {boolean} enabled  нужны ли данные (нет фьючерсов на экране — биржу не опрашиваем)
 * @param {string} [uid]     пользователь, чьё состояние робота читать
 * @param {{token?: string, tickers?: string[]}} [broker]  токен Т-Инвестиций и тикеры/корни, по которым нужно ГО брокера
 * @returns {{table: Map|null, state: object|null, broker: Map<string,{buy:number,sell:number}>|null}}
 */
export default function useFuturesMargin(enabled, uid, broker = null) {
  const [table, setTable] = useState(null);
  const [state, setState] = useState(null);
  const [brokerMap, setBrokerMap] = useState(null);
  const token = broker?.token || '';
  const tickersKey = (broker?.tickers || []).join(',');

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const load = () => {
      if (typeof document !== 'undefined' && document.hidden) return; // вкладка не на виду — биржу не дёргаем
      fetchFortsTable().then((t) => { if (alive) setTable(t); }).catch(() => {});
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [enabled]);
  useEffect(() => {
    if (!uid || !enabled) return;
    getMarginState(uid).then((st) => setState(st || null)).catch(() => {});
  }, [uid, enabled]);

  // Какие именно контракты нужны брокеру: корни вроде «MM» превращаем в ближайший действующий (как делает радар).
  const secidsKey = useMemo(() => {
    if (!token || !table || !tickersKey) return '';
    const ids = new Set();
    tickersKey.split(',').filter(Boolean).forEach((t) => { const r = resolveContract(table, t); if (r?.row?.secid) ids.add(r.row.secid); });
    return [...ids].sort().join(',');
  }, [token, table, tickersKey]);

  useEffect(() => {
    if (!enabled || !token || !secidsKey) { setBrokerMap(null); return undefined; }
    let alive = true;
    const ids = secidsKey.split(',');
    const load = () => fetchBrokerMargins(token, ids).then((m) => { if (alive) setBrokerMap(m.size ? m : null); }).catch(() => {});
    load();
    const id = setInterval(load, BROKER_REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, [enabled, token, secidsKey]);

  return { table, state, broker: brokerMap };
}
