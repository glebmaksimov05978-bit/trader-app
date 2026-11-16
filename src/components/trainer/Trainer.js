// src/components/trainer/Trainer.js
//
// Тренажёр «Тренд»: учебные сделки и игра на распознавание фигур. Всё здесь — УЧЕБНОЕ: сделки пишутся в отдельную
// коллекцию trainerTrades и не попадают в Журнал, капитал, отчёты и статистику реальных стратегий.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import Icon from '../shared/Icon';
import PatternGame from './PatternGame';
import RealPatternGame from './RealPatternGame';
import ReplayDesk from './ReplayDesk';
import LiveDesk from './LiveDesk';
import TrainerReview from './TrainerReview';
import { getTrainerTrades } from '../../services/trainer/trainerTrades';
import { getTrainerAccount, accountState } from '../../services/trainer/trainerAccount';
import { emptyProgress } from '../../services/trainer/patternQuiz';
import { emptyRealProgress } from '../../services/trainer/realPatterns';
import './Trainer.css';

const TABS = [
  { id: 'patterns', label: 'Учебные фигуры' },
  { id: 'real', label: 'Фигуры на реальных графиках' },
  { id: 'replay', label: 'Переигровка истории' },
  { id: 'live', label: 'Живые цены' },
  { id: 'review', label: 'Разбор' },
];

export default function Trainer() {
  const { user, userProfile, updateUserProfile } = useAuth();
  // Вкладка из адреса: из Сопровождения пробная сделка открывается сразу в «Живых ценах» (/trainer?tab=live).
  // Адрес читается напрямую (без useSearchParams): страница должна открываться и вне роутера — так её проверяют тесты.
  const [tab, setTab] = useState(() => {
    let want = null;
    try { want = new URLSearchParams(window.location.search).get('tab'); } catch { /* нет адреса */ }
    return TABS.some((t) => t.id === want) ? want : 'patterns';
  });
  const [trades, setTrades] = useState([]);
  const [loadError, setLoadError] = useState(false);

  const uid = user?.uid;
  const reload = useCallback(async () => {
    if (!uid) return;
    try { setTrades(await getTrainerTrades(uid)); setLoadError(false); } catch { setLoadError(true); }
  }, [uid]);
  useEffect(() => { reload(); }, [reload]);

  // Учебный счёт: стартовый капитал и риск % — в профиле; баланс считается по закрытым учебным сделкам.
  const account = useMemo(() => getTrainerAccount(userProfile), [userProfile]);
  const acc = useMemo(() => accountState(trades, account), [trades, account]);
  // Пробные сделки по сигналам системы («Вошёл пробно») ведутся в Сопровождении — здесь только свои учебные.
  const ownTrades = useMemo(() => (trades || []).filter((t) => !t.fromSignal), [trades]);
  const [accEdit, setAccEdit] = useState(null); // { startCapital, riskPct } — форма настройки счёта
  const saveAccount = async (restart) => {
    const start = parseFloat(String(accEdit?.startCapital ?? account.startCapital).replace(/\s/g, '').replace(',', '.'));
    const risk = parseFloat(String(accEdit?.riskPct ?? account.riskPct).replace(',', '.'));
    if (!(start > 0)) return;
    if (!(risk > 0 && risk <= 20)) return;
    const next = { startCapital: start, riskPct: risk, startedAt: restart ? new Date().toISOString() : (account.startedAt || null) };
    try { await updateUserProfile({ trainerAccount: next }); } catch { /* не критично */ }
    setAccEdit(null);
  };

  const saveReal = useCallback((p) => { Promise.resolve(updateUserProfile({ trainerReal: p })).catch(() => {}); }, [updateUserProfile]);
  const saveProgress = useCallback((p) => { Promise.resolve(updateUserProfile({ trainerPatterns: p })).catch(() => {}); }, [updateUserProfile]);

  return (
    <div className="page trainer-page">
      <div className="page-header">
        <h1 className="page-title">Тренажёр</h1>
        <p className="page-subtitle">Учебные сделки на настоящих графиках и игра на распознавание фигур. Всё здесь — не реальное: в Журнал, капитал и отчёты это не попадает.</p>
      </div>

      <div className="tabs tr-tabs" role="tablist" data-tour="trainer-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {loadError && <div className="tr-scope" style={{ marginTop: 12 }}><Icon name="warning" size={14} /><span>Не удалось загрузить учебные сделки. Разбор может быть неполным — обновите страницу.</span></div>}

      {(tab === 'replay' || tab === 'live' || tab === 'review') && (
        <div className="tr-account" data-tour="trainer-account">
          <div className="tr-acc-main">
            <span className="tr-acc-k">Учебный счёт</span>
            <b className="tr-acc-bal">{Math.round(acc.balance).toLocaleString('ru-RU')} ₽</b>
            <span className={acc.pnl >= 0 ? 'tr-acc-up' : 'tr-acc-down'}>
              {acc.pnl >= 0 ? '+' : '−'}{Math.abs(Math.round(acc.pnl)).toLocaleString('ru-RU')} ₽ · {acc.returnPct >= 0 ? '+' : '−'}{Math.abs(acc.returnPct).toFixed(1).replace('.', ',')}%
            </span>
          </div>
          <div className="tr-acc-facts">
            <span>старт {Math.round(acc.startCapital).toLocaleString('ru-RU')} ₽</span>
            <span>сделок {acc.count}{acc.count ? `, прибыльных ${acc.wins}` : ''}</span>
            <span>макс. просадка {Math.round(acc.maxDd).toLocaleString('ru-RU')} ₽ ({acc.maxDdPct.toFixed(1).replace('.', ',')}%)</span>
            <span>риск на сделку {String(acc.riskPct).replace('.', ',')}% = <b>{acc.riskNow.toLocaleString('ru-RU')} ₽</b></span>
            <button type="button" className="tr-acc-btn" onClick={() => setAccEdit(accEdit ? null : { startCapital: String(account.startCapital), riskPct: String(account.riskPct) })}>
              {accEdit ? 'Отмена' : 'Настроить'}
            </button>
          </div>
          {accEdit && (
            <div className="tr-acc-form">
              <label>Стартовый капитал, ₽<input className="input" inputMode="decimal" value={accEdit.startCapital} onChange={(e) => setAccEdit((a) => ({ ...a, startCapital: e.target.value }))} /></label>
              <label>Риск на сделку, % от баланса<input className="input" inputMode="decimal" value={accEdit.riskPct} onChange={(e) => setAccEdit((a) => ({ ...a, riskPct: e.target.value }))} /></label>
              <button type="button" className="btn btn-primary" onClick={() => saveAccount(false)}>Сохранить</button>
              <button type="button" className="btn btn-ghost" onClick={() => saveAccount(true)} title="Баланс снова со стартового капитала; прошлые учебные сделки остаются в разборе">Начать счёт заново</button>
              <p className="tr-note" style={{ flexBasis: '100%' }}>Риск следующей сделки считается от текущего баланса, как на настоящем счёте: в просадке позиция меньше. Деньги учебные — в Журнал и отчёты не попадают.</p>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {tab === 'patterns' && <PatternGame progress={userProfile?.trainerPatterns || emptyProgress()} onProgress={saveProgress} />}
        {tab === 'real' && <RealPatternGame progress={userProfile?.trainerReal || emptyRealProgress()} onProgress={saveReal} />}
        {tab === 'replay' && <ReplayDesk onSaved={reload} defaultRisk={acc.riskNow} />}
        {tab === 'live' && <LiveDesk trades={ownTrades} onChanged={reload} defaultRisk={acc.riskNow} />}
        {tab === 'review' && <TrainerReview trades={ownTrades} onChanged={reload} />}
      </div>
    </div>
  );
}
