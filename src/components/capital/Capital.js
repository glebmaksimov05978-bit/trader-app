// src/components/capital/Capital.js
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats, computeLiveBalance } from '../../services/trades';
import { formatCurrency, formatNumber, calcTrade } from '../../utils/calculator';
import { CONDITION_CATALOG, defaultStrategy, STRATEGY_TEMPLATES } from '../../services/analytics/strategy';
import toast from 'react-hot-toast';
import './Capital.css';

const CATEGORY_LABELS = { market: '📈 Рыночные условия (считаются по тикеру)', plan: '📝 Условия плана (из Калькулятора)' };

export default function Capital() {
  const { user, userProfile, updateUserProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [saving, setSaving] = useState(false);
  const [strategy, setStrategy] = useState(defaultStrategy());
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [confirmTemplate, setConfirmTemplate] = useState(null); // template pending overwrite confirmation

  useEffect(() => {
    if (userProfile?.strategy) setStrategy(userProfile.strategy);
  }, [userProfile]);

  const [settings, setSettings] = useState({
    depositSize: userProfile?.depositSize ?? 0,
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

  const getCondition = (id) => strategy.conditions.find(c => c.id === id);
  const toggleCondition = (id) => {
    setStrategy(s => {
      const existing = s.conditions.find(c => c.id === id);
      if (existing) {
        return { ...s, conditions: s.conditions.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c) };
      }
      const def = CONDITION_CATALOG.find(c => c.id === id);
      // Firestore rejects `undefined` field values outright — conditions without a
      // parameter (e.g. "цена выше EMA200") must not get `param: undefined`, or the
      // whole setDoc throws and the save silently fails.
      return { ...s, conditions: [...s.conditions, { id, enabled: true, param: def?.defaultParam ?? null, direction: def?.defaultDirection || 'both' }] };
    });
  };
  const setConditionParam = (id, param) => {
    setStrategy(s => ({ ...s, conditions: s.conditions.map(c => c.id === id ? { ...c, param } : c) }));
  };
  const setConditionDirection = (id, direction) => {
    setStrategy(s => ({ ...s, conditions: s.conditions.map(c => c.id === id ? { ...c, direction } : c) }));
  };
  const setReadinessThreshold = (v) => setStrategy(s => ({ ...s, readinessThreshold: v }));

  const applyTemplate = (tpl) => {
    setStrategy({ name: tpl.label, conditions: tpl.conditions.map(c => ({ ...c })), readinessThreshold: tpl.readinessThreshold });
  };
  // window.confirm blocks the whole tab on a native OS dialog — inconsistent with the
  // rest of the app's own themed modals, and (caught live, testing) hangs anything
  // driving the browser programmatically. Same custom-confirm pattern as Journal.js's
  // delete-trade dialog.
  const loadTemplate = (tpl) => {
    if (strategy.conditions.length > 0) { setConfirmTemplate(tpl); return; }
    applyTemplate(tpl);
  };

  const saveStrategy = async () => {
    setSavingStrategy(true);
    try {
      await updateUserProfile({ strategy });
      toast.success('Стратегия сохранена');
    } catch (e) {
      toast.error('Ошибка сохранения: ' + (e.message || 'неизвестная ошибка'));
    }
    setSavingStrategy(false);
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const newDeposit = parseFloat(settings.depositSize);
      // Only re-stamp the anchor when the deposit number actually changed — saving the
      // rest of the risk settings (which happens far more often) shouldn't silently
      // reset which trades count toward the live balance.
      const depositChanged = newDeposit !== (userProfile?.depositSize ?? null);
      await updateUserProfile({
        depositSize: newDeposit,
        ...(depositChanged ? { depositSetAt: new Date().toISOString() } : {}),
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

  const deposit = parseFloat(settings.depositSize) || 0;
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

  // Drawdown from peak — computeLiveBalance only counts trades closed on/after the
  // deposit was last actually changed, so importing an old report doesn't retroactively
  // drag today's stated deposit down by losses that already happened before it (real
  // user report).
  const currentBalance = computeLiveBalance(trades, deposit, userProfile?.depositSetAt);
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

      {/* Моя стратегия — конструктор чек-листа. Считает движок из module 4/3, здесь
          только выбор условий и порогов, никакой отдельной логики оценки. */}
      <div className="card" style={{marginTop:24}}>
        <div className="section-title">
          <div className="section-title-icon">🎯</div>
          Моя стратегия
        </div>
        <p className="text-sm text-secondary" style={{marginBottom:16}}>
          Выберите условия, которые важны для вашей стратегии. Счётчик «N из M» появится в Калькуляторе
          при анализе тикера и в виджете Радара на Дашборде. Условие без данных (например, мало истории
          по тикеру) просто не учитывается в счёте — не считается ни выполненным, ни провальным.
        </p>

        <div style={{marginBottom:20}}>
          <div className="text-xs text-muted" style={{marginBottom:8}}>
            Шаблоны — стартовый черновик, не проверенная временем формула. Загрузите один, дальше правьте
            под себя как обычно; со временем раздел «3 привычки недели» покажет, помогает ли выбранный
            порог готовности на ваших реальных сделках.
          </div>
          <div className="flex gap-2" style={{flexWrap:'wrap'}}>
            {STRATEGY_TEMPLATES.map(tpl => (
              <button key={tpl.id} className="btn btn-secondary btn-sm" title={tpl.description} onClick={() => loadTemplate(tpl)}>
                {tpl.label}
              </button>
            ))}
          </div>
        </div>

        <div className="calc-grid-2" style={{marginBottom:16, maxWidth:520}}>
          <div className="input-group">
            <label className="input-label">Название стратегии</label>
            <input className="input" value={strategy.name}
              onChange={e => setStrategy(s => ({ ...s, name: e.target.value }))} placeholder="Моя стратегия" />
          </div>
          <div className="input-group">
            <label className="input-label">Порог готовности к входу, %</label>
            <input className="input" type="number" min="0" max="100" step="5"
              value={strategy.readinessThreshold ?? ''} placeholder="не задан"
              onChange={e => setReadinessThreshold(e.target.value === '' ? null : parseFloat(e.target.value))} />
          </div>
        </div>

        {['market', 'plan'].map(category => (
          <div key={category} style={{marginBottom:20}}>
            <div className="calc-section-title">{CATEGORY_LABELS[category]}</div>
            {category === 'market' && (
              <div className="text-xs text-muted" style={{marginBottom:10}}>
                У каждого условия можно выбрать «Только лонг» или «Только шорт» справа — тогда для сделки в
                другую сторону оно не будет считаться проваленным, а просто не покажется в основном списке.
                Если ничего не выбрать — условие проверяется для обеих сторон (например, если вы намеренно
                торгуете перекупленность RSI в лонг, а не по обычной логике — просто выберите «Только лонг»
                у этого условия).
              </div>
            )}
            <div className="flex flex-col gap-2">
              {CONDITION_CATALOG.filter(c => c.category === category).map(def => {
                const cond = getCondition(def.id);
                const enabled = !!cond?.enabled;
                return (
                  <div key={def.id} style={{
                    display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
                    padding:'10px 14px', borderRadius:10,
                    background: enabled ? 'rgba(79,70,229,0.08)' : 'var(--bg-surface-2)',
                    border: `1px solid ${enabled ? 'rgba(79,70,229,0.3)' : 'var(--border-subtle)'}`,
                  }}>
                    <label style={{display:'flex', alignItems:'center', gap:10, cursor:'pointer', flex:1}}>
                      <input type="checkbox" checked={enabled} onChange={() => toggleCondition(def.id)} />
                      <span style={{fontSize:13, color: enabled ? 'var(--text-primary)' : 'var(--text-secondary)'}}>
                        {def.label}
                      </span>
                    </label>
                    {enabled && def.paramLabel && (
                      <div style={{display:'flex', alignItems:'center', gap:6, flexShrink:0}}>
                        <span className="text-xs text-muted">{def.paramLabel}</span>
                        <input className="input" type="number" step="any"
                          value={cond?.param ?? def.defaultParam}
                          onChange={e => setConditionParam(def.id, parseFloat(e.target.value))}
                          style={{width:70, padding:'4px 8px', fontSize:13}} />
                      </div>
                    )}
                    {enabled && category === 'market' && (
                      <select
                        className="input"
                        value={cond?.direction || 'both'}
                        onChange={e => setConditionDirection(def.id, e.target.value)}
                        title="Для сделок в какую сторону проверять это условие — противоположная сторона не считается проваленной, а просто пропускается"
                        style={{width:'auto', padding:'4px 8px', fontSize:12, flexShrink:0}}
                      >
                        <option value="both">Лонг и шорт</option>
                        <option value="long">Только лонг</option>
                        <option value="short">Только шорт</option>
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <button className="btn btn-primary" onClick={saveStrategy} disabled={savingStrategy}>
          {savingStrategy ? <><div className="spinner" style={{width:14,height:14}}/> Сохранение...</> : '💾 Сохранить стратегию'}
        </button>
      </div>

      {confirmTemplate && (
        <div className="modal-overlay" onClick={() => setConfirmTemplate(null)}>
          {/* Wider, and shows what the template actually contains — the old text was
              vague ("не сохранено — можно будет вернуть, просто не сохраняя") and asked
              the trader to replace their setup blind (real user report: both unclear). */}
          <div className="modal" style={{maxWidth:480}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Заменить условия стратегии?</h3>
              <button className="modal-close" onClick={() => setConfirmTemplate(null)}>✕</button>
            </div>
            <div style={{padding:'16px 0', color:'var(--text-secondary)', fontSize:14, lineHeight:1.6}}>
              <p style={{margin:'0 0 12px'}}>
                Текущий набор условий заменится на шаблон «{confirmTemplate.label}». Если передумаете —
                просто не нажимайте «Сохранить стратегию» внизу страницы, и в базе останется прежний набор.
              </p>
              <div style={{fontSize:12, color:'var(--text-muted)', marginBottom:6}}>Шаблон включает:</div>
              <div className="flex flex-col gap-1">
                {confirmTemplate.conditions.map((c) => {
                  const def = CONDITION_CATALOG.find((d) => d.id === c.id);
                  if (!def) return null;
                  return (
                    <div key={c.id} style={{fontSize:13, padding:'4px 10px', background:'var(--bg-surface-2)', borderRadius:8}}>
                      {def.label.replace('X', c.param ?? def.defaultParam)}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setConfirmTemplate(null)}>Отмена</button>
              <button className="btn btn-primary" onClick={() => { applyTemplate(confirmTemplate); setConfirmTemplate(null); }}>
                Заменить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
