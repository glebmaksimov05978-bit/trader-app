// src/components/cockpit/RadarPanel.js
//
// Радар входа внутри «Сопровождения» — тот же самый механизм, что уже работает в
// Журнале и на Дашборде (RadarLiveContext + services/radar.js), просто показан здесь,
// рядом с открытой позицией, чтобы не переключаться между вкладками. Ничего не
// дублирует: список инструментов и опрос стратегии — общие на всё приложение.
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useRadarLive } from '../../context/RadarLiveContext';
import { getRadarItems } from '../../services/radar';
import { getActiveStrategy } from '../../services/analytics/strategy';

export default function RadarPanel() {
  const { user, userProfile } = useAuth();
  const navigate = useNavigate();
  const { radarLive, setRadarLive, radarUpdatedAt, radarResults } = useRadarLive() || {};
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(true);
  const strategy = getActiveStrategy(userProfile);

  useEffect(() => {
    if (!user) return;
    getRadarItems(user.uid).then(setItems).catch(() => setItems([]));
  }, [user]);

  if (!open) {
    return (
      <aside className="ck-radar-col">
        <button className="ck-panel ck-radar-collapsed" onClick={() => setOpen(true)}>
          <span>‹</span>
          <span className="ck-radar-vert">Радар · {items.length}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="ck-radar-col">
      <div className="ck-panel ck-radar">
        <div className="ck-radar-head">
          <h3>Радар входа</h3>
          <span className="ck-cnt">{items.length}</span>
          <button className="ck-collapse" onClick={() => setOpen(false)}>›</button>
        </div>
        <div className="ck-radar-ctl">
          <button className={`ck-radar-live ${radarLive ? 'on' : ''}`} onClick={() => setRadarLive?.(!radarLive)}>
            {radarLive ? '● Слежу за списком' : '○ Включить слежение'}
          </button>
        </div>
        {strategy?.name && <div className="ck-radar-strategy">Стратегия: {strategy.name}</div>}
        {radarUpdatedAt && (
          <div className="ck-radar-updated">
            обновлено {radarUpdatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}

        <div className="ck-radar-list">
          {!items.length && (
            <div className="ck-radar-empty">Список пуст — добавь инструменты в Журнале, вкладка «Радар».</div>
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
      </div>
    </aside>
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
