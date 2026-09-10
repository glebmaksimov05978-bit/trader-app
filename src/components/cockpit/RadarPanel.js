// src/components/cockpit/RadarPanel.js
//
// Радар входа внутри «Сопровождения» — тот же самый механизм, что уже работает в
// Журнале и на Дашборде (RadarLiveContext + services/radar.js), просто показан здесь,
// рядом с открытой позицией, чтобы не переключаться между вкладками. Ничего не
// дублирует: список инструментов и опрос стратегии — общие на всё приложение.
//
// Раньше добавить тикер можно было только из Журнала — здесь прямо внутри секции
// стоит короткая форма, чтобы не переключаться между вкладками ради одного действия.
import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { useRadarLive } from '../../context/RadarLiveContext';
import { getRadarItems, addRadarItem } from '../../services/radar';
import { getActiveStrategy } from '../../services/analytics/strategy';
import CollapsibleSection from './CollapsibleSection';

export default function RadarPanel() {
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();
  const { radarLive, setRadarLive, radarUpdatedAt, radarResults } = useRadarLive() || {};
  const [items, setItems] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [ticker, setTicker] = useState('');
  const [saving, setSaving] = useState(false);
  const strategy = getActiveStrategy(userProfile);

  const load = () => { if (user) getRadarItems(user.uid).then(setItems).catch(() => setItems([])); };
  useEffect(load, [user]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!ticker.trim()) return;
    setSaving(true);
    try {
      await addRadarItem(user.uid, { ticker: ticker.trim(), instrumentType: 'stock' });
      toast.success(`${ticker.trim().toUpperCase()} добавлен в радар`);
      setTicker('');
      setAddOpen(false);
      load();
    } catch {
      toast.error('Не удалось добавить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CollapsibleSection
      title="Радар входа"
      badge={items.length}
      actions={(
        <button className={`ck-radar-live ${radarLive ? 'on' : ''}`} onClick={() => setRadarLive?.(!radarLive)} title="Следить за списком автоматически">
          {radarLive ? '●' : '○'}
        </button>
      )}
    >
      {/* Все инструменты радара проверяются по ОДНОЙ активной стратегии — своей для
          каждого тикера пока нет, поэтому явно называем её и даём ссылку сменить. */}
      <div className="ck-radar-strategy">
        Стратегия: <b>{strategy?.name || 'не выбрана'}</b>
        {' · '}<Link to="/settings">сменить</Link>
      </div>
      {radarUpdatedAt && (
        <div className="ck-radar-updated">
          обновлено {radarUpdatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}

      <div className="ck-radar-list">
        {!items.length && (
          <div className="ck-radar-empty">Список пуст — добавь тикер кнопкой ниже.</div>
        )}
        {items.map((it) => {
          const res = radarResults?.[it.id];
          const pct = res?.result?.total ? Math.round((res.result.passed / res.result.total) * 100) : null;
          const hot = pct != null && pct >= (strategy?.readinessThreshold ?? 100);
          return (
            <button
              key={it.id}
              className={`ck-radar-row ${hot ? 'hot' : ''}`}
              onClick={() => navigate('/journal')}
              title="Открыть Радар в Журнале"
            >
              <RadarRing pct={pct} hot={hot} />
              <div className="ck-radar-info">
                <div className="ck-radar-ticker">{it.ticker}</div>
                <div className="ck-radar-sub">
                  {res?.error ? res.error
                    : pct != null ? `${res.result.passed} из ${res.result.total} условий`
                      : 'ждёт проверки'}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {addOpen ? (
        <form className="ck-radar-add-form" onSubmit={handleAdd}>
          <input
            autoFocus
            className="ck-radar-add-input"
            placeholder="Тикер, напр. SBER"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
          />
          <button className="ck-btn ck-btn-primary" type="submit" disabled={saving || !ticker.trim()}>
            {saving ? '…' : 'Добавить'}
          </button>
          <button className="ck-btn" type="button" onClick={() => { setAddOpen(false); setTicker(''); }}>
            Отмена
          </button>
        </form>
      ) : (
        <button className="ck-radar-add-btn" onClick={() => setAddOpen(true)}>+ Добавить тикер</button>
      )}
    </CollapsibleSection>
  );
}

function RadarRing({ pct, hot }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  const value = pct ?? 0;
  const off = c * (1 - value / 100);
  const color = pct == null ? 'var(--text-muted)' : hot ? 'var(--gold)' : value >= 60 ? 'var(--accent-primary)' : 'var(--text-muted)';
  return (
    <div className="ck-radar-ring">
      <svg width="34" height="34">
        <circle cx="17" cy="17" r={r} fill="none" stroke="var(--bg-surface-3)" strokeWidth="3" />
        <circle
          cx="17" cy="17" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c.toFixed(1)} strokeDashoffset={off.toFixed(1)}
          transform="rotate(-90 17 17)"
        />
      </svg>
      <span style={{ color }}>{pct ?? '—'}</span>
    </div>
  );
}
