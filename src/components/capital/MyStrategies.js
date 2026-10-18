// src/components/capital/MyStrategies.js
//
// «Мои стратегии»: одна таблица, где у каждой стратегии видно, чем она занята — на каком горизонте
// и таймфрейме работает, стоит ли «на сопровождении», не в режиме ли наблюдения. Раньше эти
// настройки были разбросаны по четырём местам (звёздочка активной, стратегия тикера в радаре,
// список бумажных в Настройках, корзины портфеля).
//
// «Добавить в Сопровождение» — два вопроса: горизонт и рабочий таймфрейм. После этого стратегия
// появляется в обзоре Сопровождения отдельной плашкой, и робот ведёт по ней бумажные сделки.
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import Icon from '../shared/Icon';
import { classifyStrategy, kindBadge } from '../../services/analytics/strategyKind';
import {
  HORIZONS, suggestedTimeframes, followWarnings, validateFollow, followStrategy, unfollowStrategy,
  setObserve, captionOf, isFollowed, isObserved, tfLabel, TF_INFO,
} from '../../services/analytics/strategyMeta';

const ALL_TF = Object.keys(TF_INFO);

export default function MyStrategies({ strategies, activeStrategyId, editingId, onPersist, onSetActive, onEdit, onAdd, saving }) {
  const [formFor, setFormFor] = useState(null); // id стратегии, для которой открыта форма
  const [draft, setDraft] = useState({ horizon: null, timeframe: null, observe: false });

  const openForm = (s) => {
    setFormFor(s.id);
    setDraft({
      horizon: s.horizon || null,
      timeframe: s.timeframe || null,
      observe: s.observe === true,
    });
  };

  const pickHorizon = (id) => {
    // Таймфрейм подставляем по горизонту, если ещё не выбран или не подходит.
    const sug = suggestedTimeframes(id);
    setDraft((d) => ({ ...d, horizon: id, timeframe: d.timeframe && sug.includes(d.timeframe) ? d.timeframe : sug[0] || d.timeframe }));
  };

  const apply = async (s) => {
    const v = validateFollow(draft);
    if (!v.ok) { toast.error(v.error); return; }
    const next = strategies.map((x) => (x.id === s.id ? followStrategy(x, draft) : x));
    await onPersist(next, `«${s.name || 'Стратегия'}» добавлена в Сопровождение`);
    setFormFor(null);
  };

  const remove = async (s) => {
    const next = strategies.map((x) => (x.id === s.id ? unfollowStrategy(x) : x));
    await onPersist(next, `«${s.name || 'Стратегия'}» убрана из Сопровождения`);
  };

  const toggleObserve = async (s) => {
    const next = strategies.map((x) => (x.id === s.id ? setObserve(x, !isObserved(x)) : x));
    await onPersist(next, isObserved(s) ? 'Наблюдение выключено — уведомления вернутся' : 'Режим наблюдения: сделки идут, уведомлений нет');
  };

  const warnings = formFor ? followWarnings(draft) : [];
  const followedCount = strategies.filter(isFollowed).length;

  return (
    <div className="card ms-card">
      <div className="section-title">
        <div className="section-title-icon"><Icon name="layers" size={15} /></div>
        Мои стратегии
      </div>
      <p className="text-sm text-secondary" style={{ marginBottom: 14 }}>
        Здесь видно, какие стратегии работают и как. Стратегия, добавленная в Сопровождение, получает
        свою плашку в обзоре и своего «бумажного» робота: он проверяет список радара и открывает
        виртуальные сделки. Стратегии одного горизонта и таймфрейма можно сравнивать между собой.
      </p>

      <div className="ms-list">
        {strategies.map((s) => {
          const followed = isFollowed(s);
          const observed = isObserved(s);
          const cap = captionOf(s);
          const kind = kindBadge(classifyStrategy(s));
          return (
            <div key={s.id} className={`ms-row ${editingId === s.id ? 'editing' : ''}`}>
              <div className="ms-main">
                <div className="ms-name-row">
                  <button
                    className={`ms-star ${s.id === activeStrategyId ? 'on' : ''}`}
                    onClick={() => onSetActive(s.id)}
                    title={s.id === activeStrategyId ? 'По умолчанию: для новых тикеров и Калькулятора' : 'Сделать стратегией по умолчанию'}
                    aria-label="Стратегия по умолчанию"
                  >
                    <Icon name="star" size={15} />
                  </button>
                  <span className="ms-name">{s.name || 'Без названия'}</span>
                  <span className="ms-kind">{kind.toLowerCase()}</span>
                </div>
                <div className="ms-tags">
                  {followed ? (
                    <>
                      <span className="ms-tag on"><Icon name="check" size={12} /> в Сопровождении</span>
                      {cap && <span className="ms-tag">{cap}</span>}
                      {observed && <span className="ms-tag obs"><Icon name="eye" size={12} /> наблюдение</span>}
                    </>
                  ) : (
                    <span className="ms-tag off">не в Сопровождении</span>
                  )}
                </div>
              </div>
              <div className="ms-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => onEdit(s.id)} title="Открыть условия и правила выхода этой стратегии">
                  <Icon name="edit" size={13} /> Условия
                </button>
                {followed ? (
                  <>
                    <button className="btn btn-ghost btn-sm" onClick={() => openForm(s)}>Горизонт и таймфрейм</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleObserve(s)} disabled={saving}
                      title="Бумажные сделки идут, но в Telegram по этой стратегии ничего не приходит">
                      {observed ? 'Выключить наблюдение' : 'Наблюдение'}
                    </button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => remove(s)} disabled={saving}>
                      Убрать
                    </button>
                  </>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => openForm(s)}>
                    <Icon name="plus" size={13} /> Добавить в Сопровождение
                  </button>
                )}
              </div>

              {formFor === s.id && (
                <div className="ms-form">
                  <div className="ms-q">1. Горизонт: как долго обычно держится сделка</div>
                  <div className="ms-chips">
                    {HORIZONS.map((h) => (
                      <button key={h.id} className={`ms-chip ${draft.horizon === h.id ? 'on' : ''}`} onClick={() => pickHorizon(h.id)}>
                        <b>{h.label}</b><span>{h.hint}</span>
                      </button>
                    ))}
                  </div>

                  <div className="ms-q">2. Рабочий таймфрейм: по каким свечам стратегия принимает решение</div>
                  <div className="ms-chips tf">
                    {ALL_TF.map((tf) => {
                      const rec = draft.horizon ? suggestedTimeframes(draft.horizon).includes(tf) : false;
                      return (
                        <button key={tf} className={`ms-chip small ${draft.timeframe === tf ? 'on' : ''}`}
                          onClick={() => setDraft((d) => ({ ...d, timeframe: tf }))}>
                          <b>{tfLabel(tf)}</b>{rec && <span>рекомендуем</span>}
                        </button>
                      );
                    })}
                  </div>

                  <label className="ms-check">
                    <input type="checkbox" checked={draft.observe} onChange={(e) => setDraft((d) => ({ ...d, observe: e.target.checked }))} />
                    <span>Режим наблюдения — сделки идут, уведомлений в Telegram не будет</span>
                  </label>

                  {warnings.map((w) => (
                    <div key={w} className="ms-warn"><Icon name="warning" size={14} /> {w}</div>
                  ))}

                  <div className="ms-form-btns">
                    <button className="btn btn-primary btn-sm" onClick={() => apply(s)} disabled={saving || !validateFollow(draft).ok}>
                      {saving ? 'Сохраняю…' : (followed ? 'Сохранить' : 'Добавить')}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setFormFor(null)}>Отмена</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {onAdd && (
        <button className="btn btn-ghost btn-sm" style={{marginTop:10}} onClick={onAdd}><Icon name="plus" size={13} /> Новая стратегия</button>
      )}

      {followedCount === 0 && (
        <div className="ms-empty">
          Пока ни одна стратегия не добавлена в Сопровождение — оно показывает все стратегии, как раньше.
          Добавьте нужные: появятся плашки с горизонтом и таймфреймом, а у робота — своя бумажная лента по каждой.
        </div>
      )}
    </div>
  );
}
