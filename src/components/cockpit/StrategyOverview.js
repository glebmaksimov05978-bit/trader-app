// src/components/cockpit/StrategyOverview.js
//
// «Обзор» Сопровождения: общий экран, где видно, что сейчас происходит у каждой стратегии. Это
// не рейтинг и не сравнение «кто лучше»: стратегии с разными горизонтами (краткосрок,
// среднесрок, долгосрок) друг с другом не меряют. У каждой своя карточка — открытые бумажные
// сделки, закрытые и их итог, сколько тикеров она сейчас смотрит и сколько из них «горячие».
// Нажатие на карточку переключает Сопровождение в режим этой стратегии.
import React from 'react';
import Icon from '../shared/Icon';
import { classifyStrategy, kindBadge } from '../../services/analytics/strategyKind';

const money = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('ru-RU')} ₽`;

function holdText(days) {
  if (days == null) return null;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} ч`;
  return `${Math.round(days * 10) / 10} дн`;
}

/**
 * @param {Array} strategies — все стратегии профиля
 * @param {Array} groups — результат groupPaperByStrategy(...).groups
 * @param {Object} radar — { [strategyId]: { total, hot } }
 * @param {(id: string) => void} onPick
 */
export default function StrategyOverview({ strategies, groups, radar, onPick }) {
  const byId = new Map(groups.map((g) => [g.key, g]));
  // Стратегии из профиля — всегда, даже без сделок; плюс «осиротевшие» группы (стратегия удалена).
  const rows = strategies.map((s) => ({ id: s.id, name: s.name || 'Без названия', strategy: s, group: byId.get(s.id) || null }));
  const known = new Set(strategies.map((s) => s.id));
  groups.filter((g) => !known.has(g.key)).forEach((g) => rows.push({ id: g.key, name: g.label, strategy: null, group: g }));

  if (!rows.length) return null;

  return (
    <section className="ck-panel so-wrap">
      <header className="so-head">
        <h2>Стратегии</h2>
        <span className="so-hint">у каждой своя лента — друг с другом не сравниваются</span>
      </header>
      <div className="so-grid">
        {rows.map((r) => {
          const g = r.group;
          const rd = radar?.[r.id] || { total: 0, hot: 0 };
          const hold = holdText(g?.avgHoldDays);
          return (
            <button key={r.id} className="so-card" onClick={() => onPick(r.id)}>
              <div className="so-card-top">
                <span className="so-name">{r.name}</span>
                <Icon name="chevronRight" size={16} className="so-go" />
              </div>
              <div className="so-meta">
                {r.strategy && <span>{kindBadge(classifyStrategy(r.strategy)).toLowerCase()}</span>}
                {g?.timeframes?.length > 0 && <span>{g.timeframes.join(', ')}</span>}
              </div>
              <div className="so-stats">
                <div><b>{g?.open ?? 0}</b><span>открыто</span></div>
                <div><b>{g?.closed ?? 0}</b><span>закрыто</span></div>
                <div>
                  <b className={g && g.closed ? (g.pnl >= 0 ? 'up' : 'down') : ''}>{g && g.closed ? money(g.pnl) : '—'}</b>
                  <span>итог</span>
                </div>
              </div>
              <div className="so-foot">
                <span>радар: {rd.total} {rd.hot > 0 && <b className="so-hot">· готово к входу {rd.hot}</b>}</span>
                {g && g.closed > 0 && <span>прибыльных {Math.round(g.winrate)}%{hold ? ` · держит ~${hold}` : ''}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
