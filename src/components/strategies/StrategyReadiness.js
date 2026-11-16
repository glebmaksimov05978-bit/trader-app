// src/components/strategies/StrategyReadiness.js
//
// «Готовность к Сопровождению»: по каждой стратегии — сколько шагов пройдено и что именно не хватает, чтобы робот вёл
// её сигналы, а Сопровождение показывало готовность к входу и правила ведения. Расчёт — strategyReadiness.js.
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { strategyReadiness } from '../../services/analytics/strategyReadiness';

// Где это сделать: подсказки к шагам (таблица «Мои стратегии» и редактор стратегии — ниже на этой же вкладке).
const WHERE = {
  timeframe: 'ниже, «Мои стратегии» → «Добавить в Сопровождение»: горизонт и таймфрейм',
  entry: 'ниже, в редакторе стратегии → «Условия входа»',
  stop: 'ниже, в редакторе стратегии → «Правила выхода» → стоп',
  exit: 'ниже, в редакторе стратегии → «Правила выхода» → цель или следящий выход',
  radar: null,
  robot: 'ниже, «Мои стратегии» → «Добавить в Сопровождение»',
};

export default function StrategyReadiness({ strategies, radarItems, paperTrades, userProfile }) {
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => (strategies || []).map((s) => ({
    s,
    r: strategyReadiness(s, {
      radarItems, paperTrades,
      activeStrategyId: userProfile?.activeStrategyId,
      paperStrategyIds: userProfile?.alertPrefs?.paperStrategyIds,
    }),
  })), [strategies, radarItems, paperTrades, userProfile]);
  if (!rows.length) return null;

  return (
    <div className="card sr-card">
      <div className="section-title" style={{ marginBottom: 4 }}>Готовность к Сопровождению</div>
      <p className="mr-note" style={{ marginTop: 0 }}>
        Что нужно стратегии, чтобы робот присылал по ней сигналы и вёл сделки системы, а Сопровождение показывало готовность
        к входу и правила ведения позиции.
      </p>
      <div className="sr-list">
        {rows.map(({ s, r }) => {
          const isOpen = open === s.id;
          return (
            <div key={s.id} className={`sr-row ${r.ready ? 'ok' : ''}`}>
              <button type="button" className="sr-head" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}>
                <span className="sr-name">{s.name || 'Без названия'}</span>
                <span className="sr-dots" aria-label={`${r.done} из ${r.total}`}>
                  {r.steps.slice(0, r.total).map((st) => <i key={st.id} className={st.ok ? 'on' : ''} title={st.title} />)}
                </span>
                <span className="sr-state">
                  {r.ready
                    ? (r.steps[r.total].ok ? 'работает' : 'готова — ждёт первого сигнала')
                    : `не хватает: ${r.nextStep.title.toLowerCase()}`}
                </span>
                <span className="sr-caret">{isOpen ? '▴' : '▾'}</span>
              </button>
              {isOpen && (
                <ol className="sr-steps">
                  {r.steps.map((st) => (
                    <li key={st.id} className={st.ok ? 'ok' : 'no'}>
                      <span className="sr-mark">{st.ok ? '✓' : '—'}</span>
                      <div>
                        <b>{st.title}</b>
                        <div className="sr-detail">{st.detail}</div>
                        {!st.ok && st.id === 'radar' && <div className="sr-where"><Link to="/journal?view=radar">Открыть радар</Link> и добавить инструменты с этой стратегией</div>}
                        {!st.ok && WHERE[st.id] && <div className="sr-where">Где: {WHERE[st.id]}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
