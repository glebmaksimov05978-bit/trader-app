// src/components/onboarding/OnboardingCard.js
//
// Карточка «Обучение» в Настройках: пройти любой тур заново, отключить подсказки при первом заходе в раздел.
import React from 'react';
import toast from 'react-hot-toast';
import Icon from '../shared/Icon';
import { useOnboarding } from './OnboardingContext';
import { TOUR_LIST } from './tours';

export default function OnboardingCard({ trusted = false }) {
  const { start, isDone, disabled, setDisabled } = useOnboarding();
  const list = TOUR_LIST.filter((t) => (t.id === 'backtest' ? trusted : true));
  return (
    <div className="card" style={{ marginBottom: 20 }} data-onboarding-card>
      <div className="section-title">
        <div className="section-title-icon"><Icon name="info" size={15} /></div>
        Обучение
      </div>
      <label className="flex items-center gap-2" style={{ cursor: 'pointer', marginBottom: 4 }}>
        <input
          type="checkbox"
          checked={!disabled}
          onChange={async (e) => {
            try { await setDisabled(!e.target.checked); toast.success(e.target.checked ? 'Подсказки включены' : 'Подсказки отключены'); }
            catch { toast.error('Не удалось сохранить'); }
          }}
        />
        <span>Показывать подсказки при первом заходе в раздел</span>
      </label>
      <div className="onb-list">
        {list.map((t) => (
          <div key={t.id} className="onb-row">
            <div>
              <div className="onb-name">{t.title}{isDone(t.id) && <span className="onb-done">пройден</span>}</div>
              <div className="onb-about">{t.about}</div>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => start(t.id)}>{isDone(t.id) ? 'Пройти снова' : 'Пройти'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
