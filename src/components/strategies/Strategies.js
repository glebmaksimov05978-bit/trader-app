// src/components/strategies/Strategies.js
//
// Раздел «Стратегии» — мастерская правил (решение владельца, 2026-11-11…15): всё про стратегии собрано в одном месте.
//   • «Правила» — список стратегий и конструктор условий входа и выхода (раньше — второй блок «Капитала»);
//   • «История» — проверка правил на прошлых данных (бывший отдельный пункт меню «Бэктест»; пока только доверенным);
//   • «Вживую» — что у каждой стратегии происходит сейчас: открытые и закрытые сделки системы, краткий итог.
// Полный разбор результата — в «Анализе», деньги и лимиты — в «Капитале». Здесь ничего не дублируется: вкладки
// показывают те же компоненты и те же данные, что раньше жили в других разделах.
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { TRUSTED_UIDS } from '../../constants/trustedUids';
import { getStrategies } from '../../services/analytics/strategy';
import { getPaperTrades } from '../../services/paperTrades';
import { groupPaperByStrategy } from '../../services/analytics/paperGroups';
import { writeCkView } from '../cockpit/Cockpit';
import Capital from '../capital/Capital';
import Backtest from '../backtest/Backtest';
import StrategyOverview from '../cockpit/StrategyOverview';
import StrategyReadiness from './StrategyReadiness';
import { getRadarItems } from '../../services/radar';
import '../cockpit/Cockpit.css';
import '../report/MonthlyReport.css';

export default function Strategies() {
  const { user, userProfile, isAdmin } = useAuth();
  const navigate = useNavigate();
  const canBacktest = !!(isAdmin || TRUSTED_UIDS.includes(user?.uid));
  const tabs = useMemo(() => [
    { id: 'rules', label: 'Правила' },
    ...(canBacktest ? [{ id: 'history', label: 'История' }] : []),
    { id: 'live', label: 'Вживую' },
  ], [canBacktest]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabs.some((t) => t.id === searchParams.get('tab')) ? searchParams.get('tab') : 'rules';
  const setTab = (id) => setSearchParams((p) => { if (id === 'rules') p.delete('tab'); else p.set('tab', id); return p; }, { replace: true });

  const strategies = useMemo(() => getStrategies(userProfile), [userProfile]);
  const [paper, setPaper] = useState(null);
  useEffect(() => {
    if (!user || paper) return;
    getPaperTrades(user.uid).then(setPaper).catch(() => setPaper([]));
  }, [user, paper]);
  // Радар — для «Готовности к Сопровождению» (есть ли у стратегии инструменты, которые робот смотрит).
  const [radarItems, setRadarItems] = useState(null);
  useEffect(() => {
    if (tab !== 'rules' || !user || radarItems) return;
    getRadarItems(user.uid).then(setRadarItems).catch(() => setRadarItems([]));
  }, [tab, user, radarItems]);
  const groups = useMemo(() => groupPaperByStrategy(paper || []).groups, [paper]);

  // Нажатие на стратегию открывает Сопровождение уже в её режиме.
  const openInCockpit = (id) => {
    writeCkView({ scopeId: id, strategyId: id, previewTicker: null, previewType: null, activeId: null });
    navigate('/cockpit');
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Стратегии</h1>
        <p className="page-subtitle">По каким правилам вы торгуете: условия входа и выхода, проверка на истории и что происходит вживую</p>
      </div>

      <div className="mr-tabs" role="tablist" aria-label="Разделы стратегий">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === 'rules' && (
        <>
          <StrategyReadiness strategies={strategies} radarItems={radarItems || []} paperTrades={paper || []} userProfile={userProfile} />
          <Capital view="strategies" embedded />
        </>
      )}

      {tab === 'history' && canBacktest && <Backtest embedded />}

      {tab === 'live' && (
        <>
          <p className="mr-note" style={{ marginTop: 0 }}>
            Сделки системы по каждой стратегии: робот ведёт их на бумаге по вашим правилам. Нажмите на стратегию — откроется
            Сопровождение в её режиме. Подробный разбор результата — в{' '}
            <Link to="/report?tab=strategies">Анализе</Link>.
          </p>
          {paper == null ? (
            <div className="card">Загружаю сделки системы…</div>
          ) : (strategies.length || groups.length) ? (
            <StrategyOverview
              strategies={strategies}
              knownIds={strategies.map((x) => x.id)}
              groups={groups}
              radar={{}}
              showRadar={false}
              onPick={openInCockpit}
            />
          ) : (
            <div className="card">Стратегий пока нет — добавьте первую на вкладке «Правила».</div>
          )}
        </>
      )}
    </div>
  );
}
