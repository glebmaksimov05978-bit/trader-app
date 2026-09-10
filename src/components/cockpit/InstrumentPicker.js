// src/components/cockpit/InstrumentPicker.js
//
// Выбор инструментов для радара из каталога вместо ввода тикера руками.
//
// Почему это отдельное окно, а не строка ввода: раньше добавление в радар требовало
// ЗНАТЬ тикер. Ошибся буквой — получил строку с ошибкой и не понял, инструмента нет
// или сломался запрос (реальная жалоба: «непонятно мне, как искать и добавлять те,
// за которыми я слежу»). Здесь список видно, отмечать можно сразу несколько, а тикер
// руками остаётся запасным вариантом — для того, чего в каталоге нет.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SECTORS, searchCatalog, searchInstruments, catalogEntry } from '../../services/marketData/instrumentCatalog';
import { availableTimeframes } from '../../services/marketData/candles';

const TYPE_LABEL = { stock: 'акция', future: 'фьючерс', currency: 'валюта' };
const TYPES = [
  { value: 'stock', label: 'Акции' },
  { value: 'future', label: 'Фьючерсы' },
  { value: 'currency', label: 'Валюта' },
];

export default function InstrumentPicker({
  open,
  onClose,
  onAdd,          // async (items: [{ticker, type}], { timeframe, strategyId }) => void
  existing = [],  // тикеры, которые уже в радаре
  tinkoffToken,
  ownTickers = [], // чем трейдер уже торговал — показываем первым делом
  strategies = [], // сохранённые стратегии — выбор, по какой смотреть именно этот тикер
  defaultStrategyId = null,
  saving = false,
}) {
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState(null);
  const [type, setType] = useState(null);
  const [rows, setRows] = useState(() => searchCatalog('', {}));
  const [picked, setPicked] = useState([]);
  const [timeframe, setTimeframe] = useState('D1');
  // Раньше весь радар смотрелся по одной активной стратегии профиля — нельзя было
  // следить за одним тикером по пробойной, а за другим по откатной одновременно
  // (реальная жалоба: «непонятно, как за какой стратегией смотрятся тикеры»).
  const [strategyId, setStrategyId] = useState(defaultStrategyId);
  const [searching, setSearching] = useState(false);
  const reqId = useRef(0);

  const existingSet = useMemo(() => new Set(existing.map((t) => (t || '').toUpperCase())), [existing]);
  const pickedSet = useMemo(() => new Set(picked.map((p) => p.ticker)), [picked]);

  // Локальный список — мгновенно, биржевой поиск — с задержкой: иначе на каждую букву
  // уходил бы запрос к Tinkoff, а список дёргался бы под пальцами.
  useEffect(() => {
    if (!open) return undefined;
    setRows(searchCatalog(query, { sector, type }));
    const q = query.trim();
    if (!tinkoffToken || q.length < 2 || sector) { setSearching(false); return undefined; }
    setSearching(true);
    const id = ++reqId.current;
    const timer = setTimeout(async () => {
      const found = await searchInstruments({ query: q, tinkoffToken, sector, type });
      if (id === reqId.current) { setRows(found); setSearching(false); }
    }, 350);
    // Гасить «ищу…» в уборке не нужно: следующий прогон эффекта выставит его заново,
    // а при закрытии окна состояние всё равно сбрасывается.
    return () => clearTimeout(timer);
  }, [query, sector, type, tinkoffToken, open]);

  useEffect(() => {
    if (open) { setQuery(''); setSector(null); setType(null); setPicked([]); setStrategyId(defaultStrategyId); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const toggle = (item) => {
    if (existingSet.has(item.ticker)) return;
    setPicked((cur) => (cur.some((p) => p.ticker === item.ticker)
      ? cur.filter((p) => p.ticker !== item.ticker)
      : [...cur, { ticker: item.ticker, type: item.type }]));
  };

  // Тикера нет ни в каталоге, ни в биржевом поиске — но трейдер может знать лучше.
  // Даём добавить как есть: радар проверит его при первом же опросе и честно скажет,
  // если инструмент не находится.
  const raw = query.trim().toUpperCase();
  const showRaw = raw.length >= 3
    && !rows.some((r) => r.ticker === raw)
    && !existingSet.has(raw)
    && /^[A-Z0-9]+$/.test(raw);

  const suggested = (!query.trim() && !sector && !type)
    ? ownTickers
      .filter((t) => !existingSet.has(t))
      .slice(0, 8)
      .map((t) => catalogEntry(t) || { ticker: t, name: 'из вашего журнала', type: 'stock', sector: null })
    : [];

  // Через портал в document.body — иначе окно каталога оказывается внутри колонки
  // «Сопровождения», и график цены из соседней колонки рисуется ПОВЕРХ него (реальная
  // жалоба). Причина та же, что была у ImportModal: любой предок с animation/transform
  // становится контейнером для position:fixed и запирает z-index внутри своего слоя.
  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ip-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Каталог инструментов</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="ip-search">
          <input
            autoFocus
            className="input"
            placeholder="Тикер или название: SBER, Северсталь, золото…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="ip-search-note">
            {tinkoffToken
              ? (searching ? 'ищу на бирже…' : 'встроенный список + поиск по всей бирже через Т-Банк')
              : 'встроенный список ликвидных бумаг; с токеном Т-Банка ищется вся биржа'}
          </div>
        </div>

        {/* Тип — отдельная строка от секторов: это разные признаки (у фьючерсов и валюты
            сектора вообще нет), совмещать их в один ряд чипов было бы путаницей. */}
        <div className="ip-sectors ip-types">
          <button className={`ip-chip ${!type ? 'on' : ''}`} onClick={() => setType(null)}>Все типы</button>
          {TYPES.map((t) => (
            <button key={t.value} className={`ip-chip ${type === t.value ? 'on' : ''}`} onClick={() => setType(type === t.value ? null : t.value)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="ip-sectors">
          <button className={`ip-chip ${!sector ? 'on' : ''}`} onClick={() => setSector(null)}>Все секторы</button>
          {SECTORS.map((s) => (
            <button key={s} className={`ip-chip ${sector === s ? 'on' : ''}`} onClick={() => setSector(sector === s ? null : s)}>
              {s}
            </button>
          ))}
        </div>

        <div className="ip-list">
          {suggested.length > 0 && (
            <>
              <div className="ip-group">Вы этим торговали</div>
              {suggested.map((item) => (
                <Row key={`own-${item.ticker}`} item={item} picked={pickedSet.has(item.ticker)}
                  already={existingSet.has(item.ticker)} onClick={() => toggle(item)} />
              ))}
              <div className="ip-group">Весь каталог</div>
            </>
          )}

          {rows.map((item) => (
            <Row key={item.ticker} item={item} picked={pickedSet.has(item.ticker)}
              already={existingSet.has(item.ticker)} onClick={() => toggle(item)} />
          ))}

          {showRaw && (
            <button className="ip-row ip-row-raw" onClick={() => toggle({ ticker: raw, type: 'stock' })}>
              <span className="ip-check">{pickedSet.has(raw) ? '✓' : '+'}</span>
              <div className="ip-info">
                <div className="ip-ticker">{raw}</div>
                <div className="ip-name">нет в каталоге — добавить как есть</div>
              </div>
            </button>
          )}

          {!rows.length && !showRaw && !suggested.length && (
            <div className="ip-empty">
              {searching ? 'Ищу…' : 'Ничего не нашлось. Попробуйте другое написание или введите тикер целиком.'}
            </div>
          )}
        </div>

        <div className="modal-footer ip-footer">
          <div className="ip-tf-row">
            {strategies.length > 1 && (
              <div className="ip-tf">
                <span>Смотреть по стратегии</span>
                <select className="input" value={strategyId || ''} onChange={(e) => setStrategyId(e.target.value || null)}>
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>{s.name || 'без названия'}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="ip-tf">
              <span>Таймфрейм проверки</span>
              <select className="input" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                {availableTimeframes(!!tinkoffToken).map((tf) => (
                  <option key={tf.key} value={tf.key}>{tf.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="ip-actions">
            <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
            <button
              className="btn btn-primary"
              disabled={!picked.length || saving}
              onClick={() => onAdd(picked, { timeframe, strategyId })}
            >
              {saving ? 'Добавляю…' : picked.length ? `Добавить (${picked.length})` : 'Добавить'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ item, picked, already, onClick }) {
  return (
    <button className={`ip-row ${picked ? 'on' : ''} ${already ? 'off' : ''}`} onClick={onClick} disabled={already}>
      <span className="ip-check">{already ? '•' : picked ? '✓' : '+'}</span>
      <div className="ip-info">
        <div className="ip-ticker">{item.ticker}</div>
        <div className="ip-name">{item.name}</div>
      </div>
      <span className="ip-type">
        {already ? 'уже в радаре' : `${TYPE_LABEL[item.type] || item.type}${item.sector ? ` · ${item.sector}` : ''}`}
      </span>
    </button>
  );
}
