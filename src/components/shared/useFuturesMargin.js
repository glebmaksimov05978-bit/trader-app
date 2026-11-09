// src/components/shared/useFuturesMargin.js
//
// Живая таблица фьючерсов биржи (одним запросом на все контракты) + состояние робота (ГО Т-Банка, история изменений) для компонентов.
// Таблица обновляется раз в минуту, пока вкладка на виду; состояние читается один раз. Общий кэш — в services/futuresMargin.js,
// поэтому сколько бы строк радара и контрактных подписей ни было на экране, биржу они опрашивают один раз в 45 секунд.
import { useEffect, useState } from 'react';
import { fetchFortsTable, getMarginState } from '../../services/futuresMargin';

const REFRESH_MS = 60 * 1000;

/**
 * @param {boolean} enabled  нужны ли данные (нет фьючерсов на экране — биржу не опрашиваем)
 * @param {string} [uid]     пользователь, чьё состояние робота читать
 * @returns {{table: Map|null, state: object|null}}
 */
export default function useFuturesMargin(enabled, uid) {
  const [table, setTable] = useState(null);
  const [state, setState] = useState(null);
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
  return { table, state };
}
