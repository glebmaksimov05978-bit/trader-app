// src/components/trainer/Trainer.js
//
// Тренажёр «Тренд»: учебные сделки и игра на распознавание фигур. Всё здесь — УЧЕБНОЕ: сделки пишутся в отдельную
// коллекцию trainerTrades и не попадают в Журнал, капитал, отчёты и статистику реальных стратегий.
import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import Icon from '../shared/Icon';
import PatternGame from './PatternGame';
import ReplayDesk from './ReplayDesk';
import TrainerReview from './TrainerReview';
import { getTrainerTrades } from '../../services/trainer/trainerTrades';
import { emptyProgress } from '../../services/trainer/patternQuiz';
import './Trainer.css';

const TABS = [
  { id: 'patterns', label: 'Увидеть фигуру' },
  { id: 'replay', label: 'Переигровка истории' },
  { id: 'review', label: 'Разбор' },
];

export default function Trainer() {
  const { user, userProfile, updateUserProfile } = useAuth();
  const [tab, setTab] = useState('patterns');
  const [trades, setTrades] = useState([]);
  const [loadError, setLoadError] = useState(false);

  const uid = user?.uid;
  const reload = useCallback(async () => {
    if (!uid) return;
    try { setTrades(await getTrainerTrades(uid)); setLoadError(false); } catch { setLoadError(true); }
  }, [uid]);
  useEffect(() => { reload(); }, [reload]);

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

      <div style={{ marginTop: 16 }}>
        {tab === 'patterns' && <PatternGame progress={userProfile?.trainerPatterns || emptyProgress()} onProgress={saveProgress} />}
        {tab === 'replay' && <ReplayDesk onSaved={reload} />}
        {tab === 'review' && <TrainerReview trades={trades} onChanged={reload} />}
      </div>
    </div>
  );
}
