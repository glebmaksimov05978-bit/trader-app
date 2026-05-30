// src/components/capital/Capital.js
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats } from '../../services/trades';
import { formatCurrency, formatNumber, calcTrade } from '../../utils/calculator';
import toast from 'react-hot-toast';
import './Capital.css';

export default function Capital() {
  const { user, userProfile, updateUserProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [saving, setSaving] = useState(false);

  const [settings, setSettings] = useState({
    depositSize: userProfile?.depositSize || 100000,
    dailyLossLimit: userProfile?.dailyLossLimit || 3,
    maxRiskPerTrade: userProfile?.maxRiskPerTrade || 1,
    maxDailyTrades: userProfile?.maxDailyTrades || 10,
    maxDrawdownStop: userProfile?.maxDrawdownStop || 10,
    contractPrice: '',
    entryPrice: '',
    stopLoss: '',
    minStepAmount: '',
    minStep: '',
    lot: '1',
    initialMargin: '',
  });

  useEffect(() => {
    if (userProfile) {
      setSettings(s => ({
        ...s,
        depositSize: userProfile.depositSize || s.depositSize,
        dailyLossLimit: userProfile.dailyLossLimit || s.dailyLossLimit,
        maxRiskPerTrade: userProfile.maxRiskPerTrade || s.maxRiskPerTrade,
        maxDailyTrades: userProfile.maxDailyTrades || s.maxDailyTrades,
        maxDrawdownStop: userProfile.maxDrawdownStop || s.maxDrawdownStop,
      }));
    }
  }, [userProfile]);

  useEffect(() => {
    if (!user) return;
    getUserTrades(user.uid).then(t => {
      setTrades(t);
      setStats(calcStats(t));
    });
  }, [user]);

  const set = (k, v) => setSettings(s => ({ ...s, [k]: v }));

  const saveSettings = async () => {
    setSaving(true);
    try {
      await updateUserProfile({
        depositSize: parseFloat(settings.depositSize),
        dailyLossLimit: parseFloat(settings.dailyLossLimit),
        maxRiskPerTrade: parseFloat(settings.maxRiskPerTrade),
        maxDailyTrades: parseInt(settings.maxDailyTrades),
        maxDrawdownStop: parseFloat(settings.maxDrawdownStop),
      });
      toast.success('Настройки сохранены');
    } catch {
      toast.error('Ошибка сохранения');
    }
    setSaving(false);
  };

  const deposit = parseFloat(settings.depositSize) || 100000;
  const riskPct = parseFloat(settings.maxRiskPerTrade) || 1;
  const dailyLossPct = parseFloat(settings.dailyLossLimit) || 3;
  const ddStopPct = parseFloat(settings.maxDrawdownStop) || 10;

  const riskPerTrade = Math.round(deposit * riskPct / 100);
  const dailyLossRub = Math.round(deposit * dailyLossPct / 100);
  const maxDdRub = Math.round(deposit * ddStopPct / 100);
  const maxDailyLoss = parseFloat(settings.dailyLossLimit) || 3;
  const maxTradesPerRisk = Math.floor(maxDailyLoss / riskPct);

  // Calc max contracts for given params
  const contractCalc = calcTrade({
    entryPrice: settings.entryPrice,
    stopLoss: settings.stopLoss,
    depositSize: settings.depositSize,
    riskPercent: settings.maxRiskPerTrade,
    lot: settings.lot,
    minStep: settings.minStep,
    minStepAmount: settings.minStepAmount,
    initialMargin: settings.initialMargin,
  });

  // Current day PnL from journal
  const today = new Date().toDateString();
  const todayTrades = trades.filter(t => {
    const d = t.date?.seconds ? new Date(t.date.seconds * 1000) : new Date(t.date);
    return d.toDateString() === today && t.status === 'closed';
  });
  const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const todayLossUsed = Math.abs(Math.min(todayPnl, 0));
  const todayLimitUsedPct = Math.min((todayLossUsed / dailyLossRub) * 100, 100);

  // Drawdown from peak
  const currentBalance = deposit + (stats?.totalPnl || 0);
  const peakBalance = Math.max(deposit, currentBalance); // simplified
  const currentDd = Math.max(0, peakBalance - currentBalance);
  const currentDdPct = peakBalance > 0 ? (currentDd / peakBalance) * 100 : 0;

  const tradesStopped = todayLossUsed >= dailyLossRub || currentDdPct >= ddStopPct;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">💰 Управление капиталом</h1>
        <p className="page-subtitle">Риск-менеджмент и контроль просадки</p>
      </div>

      {/* Status cards */}
      <div className="grid-4" style={{marginBottom:24}}>
        <div className={`kpi-card ${currentBalance >= deposit ? 'green' : 'red'}`}>
          <div className="kpi-label">Текущий депозит</div>
          <div className="kpi-value" style={{color: currentBalance >= deposit ? 'var(--green)' : 'var(--red)', fontSize:22}}>
            {formatCurrency(Math.round(currentBalance))}
          </div>
          <div className="kpi-sub">{currentBalance >= deposit ? '+' : ''}{formatCurrency(Math.round(currentBalance - deposit))}</div>
        </div>

        <div className={`kpi-card ${todayPnl >= 0 ? 'green' : todayLossUsed >= dailyLossRub * 0.8 ? 'red' : 'gold'}`}>
          <div className="kpi-label">P&L сегодня</div>
          <div className="kpi-value" style={{color: todayPnl >= 0 ? 'var(--green)' : 'var(--red)', fontSize:22}}>
            {todayPnl >= 0 ? '+' : ''}{formatCurrency(Math.round(todayPnl))}
          </div>
          <div className="kpi-sub">{todayTrades.length} сделок сегодня</div>
        </div>

        <div className={`kpi-card ${currentDdPct >= ddStopPct ? 'red' : currentDdPct >= ddStopPct * 0.7 ? 'gold' : 'blue'}`}>
          <div className="kpi-label">Просадка от пика</div>
          <div className="kpi-value" style={{
            color: currentDdPct >= ddStopPct ? 'var(--red)' : currentDdPct >= ddStopPct*0.7 ? 'var(--gold)' : 'var(--blue)',
            fontSize:22
          }}>
            {formatNumber(currentDdPct, 1)}%
          </div>
          <div className="kpi-sub">Лимит: {ddStopPct}% ({formatCurrency(maxDdRub)})</div>
        </div>

        <div className={`kpi-card ${tradesStopped ? 'red' : 'purple'}`}>
          <div className="kpi-label">Статус торгов</div>
          <div className="kpi-value" style={{fontSize:16, marginTop:4}}>
            {tradesStopped ? '🛑 СТОП' : '✅ Торгуем'}
          </div>
          <div className="kpi-sub">{tradesStopped ? 'Лимит потерь достигнут' : `Макс. риск: ${formatCurrency(riskPerTrade)}`}</div>
        </div>
      </div>

      <div className="grid-2" style={{alignItems:'start'}}>
        {/* Limits gauges */}
        <div className="flex flex-col gap-4">
          {/* Daily loss gauge */}
          <div className="card">
            <div className="section-title">
              <div className="section-title-icon">📉</div>
              Дневной лимит убытка
            </div>
            <div className="capital-gauge">
              <div className="capital-gauge-labels">
                <span className="text-sm text-secondary">Использовано: {formatCurrency(Math.round(todayLossUsed))}</span>
                <span className="text-sm font-semibold" style={{color: todayLimitUsedPct > 80 ? 'var(--red)' : 'var(--text-primary)'}}>
                  {todayLimitUsedPct.toFixed(0)}% / Лимит: {formatCurrency(dailyLossRub)}
                </span>
              </div>
              <div className="capital-gauge-bar">
                <div className="capital-gauge-fill" style={{
                  width:`${todayLimitUsedPct}%`,
                  background: todayLimitUsedPct > 80 ? 'linear-gradient(90deg,#f59e0b,#ef4444)' :
                    todayLimitUsedPct > 50 ? 'linear-gradient(90deg,#4f46e5,#f59e0b)' : 'var(--accent-gradient)'
                }}/>
              </div>
              {todayLimitUsedPct >= 100 && (
                <div className="capital-alert">
                  🛑 Дневной лимит убытка исчерпан. Торговля на сегодня остановлена.
                </div>
              )}
            </div>

            <div className="stat-row">
              <span className="stat-row-label">Макс. сделок по риску в день</span>
              <span className="stat-row-value">{maxTradesPerRisk}</span>
            </div>
            <div className="stat-row">
              <span className="stat-row-label">Сделок проведено сегодня</span>
              <span className="stat-row-value">{todayTrades.length} / {settings.maxDailyTrades}</span>
            </div>
          </div>

          {/* Max contracts calculator */}
          <div className="card">
            <div className="section-title">
              <div className="section-title-icon">🔢</div>
              Сколько контрактов торговать?
            </div>
            <div className="grid-2" style={{marginBottom:12}}>
              <div className="input-group">
                <label className="input-label">Цена входа</label>
                <input className="input" type="number" value={settings.entryPrice}
                  onChange={e => set('entryPrice', e.target.value)} placeholder="0"/>
              </div>
              <div className="input-group">
                <label className="input-label">Стоп-лосс</label>
                <input className="input" type="number" value={settings.stopLoss}
                  onChange={e => set('stopLoss', e.target.value)} placeholder="0"/>
              </div>
              <div className="input-group">
                <label className="input-label">Шаг цены</label>
                <input className="input" type="number" value={settings.minStep}
                  onChange={e => set('minStep', e.target.value)} placeholder="1"/>
              </div>
              <div className="input-group">
                <label className="input-label">Стоим. шага (₽)</label>
                <input className="input" type="number" value={settings.minStepAmount}
                  onChange={e => set('minStepAmount', e.target.value)} placeholder="0"/>
              </div>
              <div className="input-group">
                <label className="input-label">ГО (₽ / контракт)</label>
                <input className="input" type="number" value={settings.initialMargin}
                  onChange={e => set('initialMargin', e.target.value)} placeholder="0"/>
              </div>
              <div className="input-group">
                <label className="input-label">Лот</label>
                <input className="input" type="number" value={settings.lot}
                  onChange={e => set('lot', e.target.value)} placeholder="1"/>
              </div>
            </div>

            {contractCalc ? (
              <div className="capital-result-box">
                <div className="capital-result-main">
                  <span className="capital-result-num">{contractCalc.contracts}</span>
                  <span className="capital-result-label">контрактов</span>
                </div>
                <div className="grid-2" style={{width:'100%'}}>
                  <div className="stat-row"><span className="stat-row-label">Риск (₽)</span>
                    <span className="stat-row-value text-red">{formatCurrency(contractCalc.riskAmount)}</span></div>
                  <div className="stat-row"><span className="stat-row-label">ГО (₽)</span>
                    <span className="stat-row-value">{formatCurrency(contractCalc.totalMargin)}</span></div>
                  <div className="stat-row"><span className="stat-row-label">Тиков до SL</span>
                    <span className="stat-row-value">{contractCalc.ticksToSL}</span></div>
                  <div className="stat-row"><span className="stat-row-label">Загрузка деп.</span>
                    <span className="stat-row-value" style={{color: contractCalc.marginUsagePercent > 50 ? 'var(--red)' : 'var(--text-primary)'}}>
                      {contractCalc.marginUsagePercent}%</span></div>
                </div>
              </div>
            ) : (
              <div className="text-muted text-sm" style={{padding:'12px 0'}}>
                Заполните цену входа и стоп-лосс
              </div>
            )}
          </div>
        </div>

        {/* Settings */}
        <div className="card">
          <div className="section-title">
            <div className="section-title-icon">⚙️</div>
            Настройки риск-менеджмента
          </div>

          <div className="flex flex-col gap-3">
            <div className="input-group">
              <label className="input-label">Размер депозита (₽)</label>
              <input className="input" type="number" value={settings.depositSize}
                onChange={e => set('depositSize', e.target.value)} />
            </div>
            <div className="input-group">
              <label className="input-label">Риск на 1 сделку (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="0.1" value={settings.maxRiskPerTrade}
                  onChange={e => set('maxRiskPerTrade', e.target.value)} />
              </div>
              <div className="input-hint">= {formatCurrency(riskPerTrade)} на сделку</div>
            </div>
            <div className="input-group">
              <label className="input-label">Дневной лимит убытка (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="0.5" value={settings.dailyLossLimit}
                  onChange={e => set('dailyLossLimit', e.target.value)} />
              </div>
              <div className="input-hint">= {formatCurrency(dailyLossRub)} / день</div>
            </div>
            <div className="input-group">
              <label className="input-label">Стоп просадки от максимума (%)</label>
              <div className="input-prefix">
                <span className="input-prefix-text">%</span>
                <input className="input" type="number" step="1" value={settings.maxDrawdownStop}
                  onChange={e => set('maxDrawdownStop', e.target.value)} />
              </div>
              <div className="input-hint">Стоп при просадке {formatCurrency(maxDdRub)}</div>
            </div>
            <div className="input-group">
              <label className="input-label">Макс. сделок в день</label>
              <input className="input" type="number" value={settings.maxDailyTrades}
                onChange={e => set('maxDailyTrades', e.target.value)} />
            </div>

            <div className="divider" />

            {/* Rules summary */}
            <div className="capital-rules">
              <div className="capital-rule">💡 При риске {riskPct}% и лимите {dailyLossPct}% — макс. <strong>{maxTradesPerRisk} убыточных сделок</strong> в день</div>
              <div className="capital-rule">🛑 Прекращать торговлю при убытке дня &gt; <strong>{formatCurrency(dailyLossRub)}</strong></div>
              <div className="capital-rule">📉 Остановить торговлю при просадке &gt; <strong>{ddStopPct}% ({formatCurrency(maxDdRub)})</strong></div>
            </div>

            <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
              {saving ? <><div className="spinner" style={{width:14,height:14}}/> Сохранение...</> : '💾 Сохранить настройки'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
