// src/components/cockpit/StrategyOverview.js
//
// «Обзор» Сопровождения: общий экран, где видно, что сейчас происходит у каждой стратегии. Это
// не рейтинг и не сравнение «кто лучше»: стратегии с разными горизонтами (краткосрок,
// среднесрок, долгосрок) друг с другом не меряют. У каждой своя плашка — НАЗВАНИЕ крупно, под
// ним рабочий таймфрейм и горизонт, затем открытые бумажные сделки, закрытые и их итог, сколько
// тикеров она сейчас смотрит и какие из них «горячие» (по ним можно сразу открыть график).
// Нажатие на плашку переключает Сопровождение в режим этой стратегии.
import React from 'react';
import { Link } from 'react-router-dom';
import Icon from '../shared/Icon';
import { classifyStrategy, kindBadge } from '../../services/analytics/strategyKind';
import { captionOf, isObserved, tfLabel } from '../../services/analytics/strategyMeta';

const money = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('ru-RU')} ₽`;

function holdText(days) {
  if (days == null) return null;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} ч`;
  return `${Math.round(days * 10) / 10} дн`;
}

const MAX_CHIPS = 4;

/**
 * @param {Array} strategies — стратегии, которые показываем (на сопровождении)
 * @param {Array} groups — результат groupPaperByStrategy(...).groups
 * @param {Object} radar — { [strategyId]: { total, hot, hotItems: [{ ticker, instrumentType }] } }
 * @param {(id: string) => void} onPick
 * @param {(item: {ticker, instrumentType}) => void} [onOpenTicker] — открыть график без стратегии
 * @param {(id: string) => void} [onToggleObserve]
 * @param {Object} [pending] — { [strategyId]: сколько открытых бумажных сигналов ждут вашей отметки }
 * @param {Array<string>} [knownIds] — id ВСЕХ стратегий профиля: группа сделок стратегии, снятой с
 *   сопровождения, не должна всплывать «осиротевшей» плашкой
 */
export default function StrategyOverview({
  strategies, groups, radar, onPick, onOpenTicker, onToggleObserve, single = false, knownIds = null, pending = null,
}) {
  const byId = new Map(groups.map((g) => [g.key, g]));
  // Стратегии из профиля — всегда, даже без сделок; плюс «осиротевшие» группы (стратегия удалена).
  const rows = strategies.map((s) => ({ id: s.id, name: s.name || 'Без названия', strategy: s, group: byId.get(s.id) || null }));
  const known = new Set(knownIds || strategies.map((s) => s.id));
  groups.filter((g) => !known.has(g.key)).forEach((g) => rows.push({ id: g.key, name: g.label, strategy: null, group: g }));

  if (!rows.length) return null;

  const pick = (id) => onPick(id);

  return (
    <section className="ck-panel so-wrap">
      <header className="so-head">
        <h2>{single ? 'Стратегия' : 'Стратегии'}</h2>
        {!single && <span className="so-hint">разные горизонты и таймфреймы друг с другом не сравниваются</span>}
      </header>
      <div className="so-grid">
        {rows.map((r) => {
          const g = r.group;
          const rd = radar?.[r.id] || { total: 0, hot: 0, hotItems: [] };
          const hold = holdText(g?.avgHoldDays);
          const cap = r.strategy ? captionOf(r.strategy) : '';
          const tfFromTrades = g?.timeframes?.length ? g.timeframes.map(tfLabel).join(', ') : '';
          const observed = r.strategy && isObserved(r.strategy);
          const chips = (rd.hotItems || []).slice(0, MAX_CHIPS);
          const more = (rd.hotItems || []).length - chips.length;
          return (
            <div
              key={r.id}
              className={`so-card ${observed ? 'observed' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => pick(r.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r.id); } }}
            >
              <div className="so-card-top">
                <span className="so-name" title={r.name}>{r.name}</span>
                <Icon name="chevronRight" size={16} className="so-go" />
              </div>
              {/* Подпись под названием: рабочий таймфрейм и горизонт. Если стратегия ещё без
                  паспорта — подсказка, где его задать, а не пустое место. */}
              <div className="so-caption">
                {cap ? (
                  <span className="so-cap">{cap}</span>
                ) : r.strategy ? (
                  <Link to="/capital" className="so-cap-missing" onClick={(e) => e.stopPropagation()}>
                    {tfFromTrades ? `таймфрейм ${tfFromTrades} · ` : ''}задайте горизонт и таймфрейм
                  </Link>
                ) : (
                  <span className="so-cap-missing">{tfFromTrades || 'стратегия удалена'}</span>
                )}
                {r.strategy && <span className="so-kind">{kindBadge(classifyStrategy(r.strategy)).toLowerCase()}</span>}
                {observed && <span className="so-obs"><Icon name="eye" size={12} /> наблюдение</span>}
              </div>

              <div className="so-stats">
                <div><b>{g?.open ?? 0}</b><span>открыто</span></div>
                <div><b>{g?.closed ?? 0}</b><span>закрыто</span></div>
                <div>
                  <b className={g && g.closed ? (g.pnl >= 0 ? 'up' : 'down') : ''}>{g && g.closed ? money(g.pnl) : '—'}</b>
                  <span>итог</span>
                </div>
              </div>

              {/* Радар этой стратегии: сколько тикеров смотрит, и горячие — кнопками. Нажатие
                  открывает ГРАФИК инструмента без «призмы» стратегии. */}
              <div className="so-radar">
                <span className="so-radar-k">
                  радар: {rd.total}{rd.hot > 0 && <b className="so-hot"> · готово к входу {rd.hot}</b>}
                </span>
                {chips.length > 0 && (
                  <span className="so-chips">
                    {chips.map((c) => (
                      <button
                        key={c.ticker}
                        className="so-chip"
                        title="Открыть график инструмента"
                        onClick={(e) => { e.stopPropagation(); onOpenTicker?.(c); }}
                      >
                        {c.ticker}
                      </button>
                    ))}
                    {more > 0 && <span className="so-more">+{more}</span>}
                  </span>
                )}
              </div>

              {(pending?.[r.id] || 0) > 0 && (
                <div className="so-pending" title="Откройте сделку этой стратегии и отметьте, вошли вы по сигналу или пропустили">
                  <Icon name="bell" size={12} /> ждут вашей отметки: {pending[r.id]}
                </div>
              )}

              <div className="so-foot">
                <span>
                  {g && g.closed > 0 ? `прибыльных ${Math.round(g.winrate)}%${hold ? ` · держит ~${hold}` : ''}` : 'закрытых сделок пока нет'}
                </span>
                {r.strategy && onToggleObserve && (
                  <button
                    className={`so-observe ${observed ? 'on' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onToggleObserve(r.id); }}
                    title="Режим наблюдения: бумажные сделки идут, уведомлений в Telegram нет"
                  >
                    <Icon name={observed ? 'eye' : 'eyeOff'} size={13} /> {observed ? 'наблюдаю' : 'наблюдение'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
