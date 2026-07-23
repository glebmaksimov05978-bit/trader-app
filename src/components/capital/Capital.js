// src/components/capital/Capital.js
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats, computeLiveBalance } from '../../services/trades';
import { formatCurrency, formatNumber, calcTrade } from '../../utils/calculator';
import { CONDITION_CATALOG, defaultStrategy, getStrategies, STRATEGY_TEMPLATES, CUSTOM_CONDITION_PRESETS } from '../../services/analytics/strategy';
import { PATTERN_LABELS, PATTERN_DIRECTIONS } from '../shared/TechnicalAnalysisBlock';
import ExitRulesEditor from '../shared/ExitRulesEditor';
import toast from 'react-hot-toast';
import './Capital.css';

// The flat two-section list ("market" / "plan") outgrew itself — 18 conditions in one
// column made eyes glaze over (real user report: "пунктов много, глаза разбегаются").
// Grouped into collapsible <details> sections instead; a group opens by default when
// any of its conditions is already enabled, so an existing strategy shows itself.
// `color` gives each group its own left-border/accent — icons alone still read as one
// undifferentiated grey list at a glance (real user report: "не только стикерами,
// всё равно глаза разбегаются").
const CONDITION_GROUPS = [
  { id: 'indicators', label: '📉 Индикаторы (RSI / MACD)', ids: ['rsi_below', 'rsi_above', 'macd_positive', 'macd_negative'], color: '#3b82f6' },
  { id: 'ema', label: '📈 Скользящие средние (EMA)', ids: ['price_above_ema200', 'price_below_ema200'], color: '#f59e0b' },
  { id: 'levels', label: '📏 Уровни и полосы Боллинджера', ids: ['near_support', 'near_resistance', 'bollinger_lower', 'bollinger_upper'], color: '#10b981' },
  { id: 'patterns', label: '📐 Фигуры теханализа', ids: ['pattern_confirmed'], color: '#a855f7' },
  { id: 'context', label: '🌊 Рыночный контекст и объём', ids: ['volume_above_avg', 'market_trending', 'market_sideways', 'volatility_not_high'], color: '#06b6d4' },
  { id: 'plan', label: '📝 Условия плана (из Калькулятора)', ids: ['min_rr', 'max_risk_percent', 'max_margin_usage'], color: '#ef4444' },
];

export default function Capital() {
  const { user, userProfile, updateUserProfile } = useAuth();
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [saving, setSaving] = useState(false);
  // Real user request: switch between a few saved strategies instead of typing numbers
  // over every time. Lives as an ARRAY on the profile (not a separate Firestore
  // collection — see strategy.js:getStrategies for why), `editingId` is whichever tab
  // is open in this form; `activeStrategyId` is the one live everywhere else
  // (Calculator/Radar/Journal) and doesn't have to be the same one you're editing.
  const [strategies, setStrategies] = useState(() => getStrategies(userProfile));
  const [activeStrategyId, setActiveStrategyId] = useState(userProfile?.activeStrategyId || null);
  const [editingId, setEditingId] = useState(null);
  const [savingStrategy, setSavingStrategy] = useState(false);
  const [confirmTemplate, setConfirmTemplate] = useState(null); // template pending overwrite confirmation
  const [confirmDeleteStrategyId, setConfirmDeleteStrategyId] = useState(null);

  useEffect(() => {
    const list = getStrategies(userProfile);
    setStrategies(list);
    const active = userProfile?.activeStrategyId && list.some((s) => s.id === userProfile.activeStrategyId)
      ? userProfile.activeStrategyId : list[0]?.id;
    setActiveStrategyId(active);
    setEditingId((cur) => (cur && list.some((s) => s.id === cur) ? cur : active));
  }, [userProfile]);

  const strategy = strategies.find((s) => s.id === editingId) || strategies[0] || defaultStrategy();
  // Every mutator below used to call setStrategy(s => ...) directly on a single object;
  // now they all go through this so exactly one array entry (the one being edited)
  // changes, the rest stay untouched.
  const updateEditingStrategy = (updater) => {
    setStrategies((list) => list.map((s) => (s.id === editingId ? updater(s) : s)));
  };
  const setStrategy = updateEditingStrategy; // drop-in for the existing `setStrategy(s => ({...s, ...}))` call sites below

  const addStrategy = () => {
    const next = defaultStrategy();
    setStrategies((list) => [...list, next]);
    setEditingId(next.id);
  };
  const renameStrategy = (id, name) => setStrategies((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));
  const deleteStrategy = (id) => {
    setStrategies((list) => {
      if (list.length <= 1) return list; // guarded by disabling the button too — never delete the last one
      const next = list.filter((s) => s.id !== id);
      if (editingId === id) setEditingId(next[0].id);
      if (activeStrategyId === id) setActiveStrategyId(next[0].id);
      return next;
    });
    setConfirmDeleteStrategyId(null);
  };

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
  // Which specific figures count toward "есть подтверждённая фигура" — undefined/empty
  // means "any figure" (the old, only behavior). Real user request: pick only the
  // figures that matter to you, not every one of the 22 the engine can find. Kept as a
  // single shared confidence threshold rather than per-figure percentages — 22 separate
  // % inputs would recreate the exact "глаза разбегаются" clutter this reorg was meant
  // to fix.
  const togglePatternInCondition = (patternId) => {
    setStrategy(s => ({
      ...s,
      conditions: s.conditions.map(c => {
        if (c.id !== 'pattern_confirmed') return c;
        const current = c.patterns || [];
        const next = current.includes(patternId) ? current.filter(p => p !== patternId) : [...current, patternId];
        return { ...c, patterns: next };
      }),
    }));
  };
  const setReadinessThreshold = (v) => setStrategy(s => ({ ...s, readinessThreshold: v }));

  // Templates only ship catalog conditions — a trader's own "Свои условия" notes (news
  // checks, exotic indicators) aren't part of any template's formula, so loading one
  // shouldn't wipe them out. Same for `id`/`exitRules`: a template only ever describes
  // entry conditions, so this strategy's identity and exit setup survive loading one.
  const applyTemplate = (tpl) => {
    setStrategy(s => ({
      ...s, name: tpl.label, conditions: tpl.conditions.map(c => ({ ...c })),
      readinessThreshold: tpl.readinessThreshold, customConditions: s.customConditions || [],
    }));
  };

  // "Свои условия" — free-text checklist items for anything not in the catalog (exotic
  // indicators, fundamental/news checks). No `evaluate` function exists for these; the
  // trader ticks them by hand in the Calculator each time (see evaluateStrategy in
  // strategy.js). Presets just prefill the label so nobody's inventing wording from a
  // blank field, but the text stays fully editable.
  const [customLabel, setCustomLabel] = useState('');
  const [customDirection, setCustomDirection] = useState('both');
  const addCustomCondition = () => {
    const label = customLabel.trim();
    if (!label) return;
    setStrategy(s => ({
      ...s,
      customConditions: [...(s.customConditions || []), { id: `custom_${Date.now()}`, label, direction: customDirection }],
    }));
    setCustomLabel('');
    setCustomDirection('both');
  };
  const removeCustomCondition = (id) => {
    setStrategy(s => ({ ...s, customConditions: (s.customConditions || []).filter(c => c.id !== id) }));
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
      // The legacy singular `strategy` field is left alone (not written, not deleted) —
      // getStrategies() only falls back to it when `strategies` is absent, so once this
      // save lands, every future read on this account uses the array. No migration
      // script, no rules redeploy.
      await updateUserProfile({ strategies, activeStrategyId });
      toast.success('Стратегии сохранены');
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

      {/* No explicit alignItems here on purpose — grid's default `stretch` makes both
          columns match the taller one's height, and the contracts card below grows to
          fill it (flex:1). With `alignItems:'start'` (the old value) the shorter left
          column just stopped early, leaving a chunk of empty space next to a much
          taller «Настройки риск-менеджмента» panel — real user report/screenshot. */}
      <div className="grid-2">
        {/* Limits gauges */}
        <div className="flex flex-col gap-4" style={{height:'100%'}}>
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

          {/* Max contracts calculator — flex:1 so it (not the shorter daily-loss card
              above it) absorbs any extra height from the taller settings column. */}
          <div className="card" style={{flex:1, display:'flex', flexDirection:'column'}}>
            <div className="section-title">
              <div className="section-title-icon">🔢</div>
              Сколько контрактов торговать?
            </div>
            {/* Real user report: "не понимаю для чего эта модальное окно, что она
                регулирует". Clarifying what makes this different from the full
                Calculator — nothing is "regulated" here, it's a read-only sanity check
                against the risk settings saved in the card to the right. */}
            <p className="text-xs text-muted" style={{marginBottom:12}}>
              Быстрая прикидка по риску из настроек справа — без тикера и Тейк-профита,
              просто «сколько контрактов позволяет мой риск при этой цене входа и стопе».
              Полный расчёт сделки (с тикером, планом и сохранением в журнал) — в Калькуляторе.
            </p>
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
              <div className="text-muted text-sm" style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'12px 0'}}>
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

        {/* Несколько стратегий — переключение вкладками вместо перезаписи одной каждый
            раз (real user request). Активная (★) — та, что реально работает в
            Калькуляторе/Радаре/Журнале; редактируемая вкладка может быть другой —
            удобно доработать вариант, не трогая то, что уже используется вживую. */}
        <div className="flex gap-2" style={{marginBottom:16, flexWrap:'wrap', alignItems:'center'}}>
          {strategies.map((s) => (
            <div key={s.id} style={{display:'flex', alignItems:'center', gap:2}}>
              <button
                className={`btn btn-sm ${editingId === s.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setEditingId(s.id)}
                title={s.id === activeStrategyId ? 'Активна сейчас' : 'Кликните, чтобы редактировать'}
              >
                {s.id === activeStrategyId && '★ '}{s.name || 'Без названия'}
              </button>
              {editingId === s.id && s.id !== activeStrategyId && (
                <button className="btn btn-ghost btn-sm" title="Сделать активной (будет работать в Калькуляторе/Радаре/Журнале)"
                  onClick={() => setActiveStrategyId(s.id)}>☆</button>
              )}
              {editingId === s.id && strategies.length > 1 && (
                <button className="btn btn-ghost btn-sm" style={{color:'var(--red)'}} title="Удалить стратегию"
                  onClick={() => setConfirmDeleteStrategyId(s.id)}>🗑</button>
              )}
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={addStrategy}>+ Новая стратегия</button>
        </div>

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

        <div className="text-xs text-muted" style={{marginBottom:10}}>
          У каждого рыночного условия можно выбрать «Только лонг» или «Только шорт» справа — тогда для
          сделки в другую сторону оно не будет считаться проваленным, а просто не покажется в основном
          списке. Если ничего не выбрать — условие проверяется для обеих сторон.
        </div>
        {CONDITION_GROUPS.map(group => {
          const defs = CONDITION_CATALOG.filter(c => group.ids.includes(c.id));
          const enabledCount = defs.filter(def => getCondition(def.id)?.enabled).length;
          return (
            <details key={group.id} open={enabledCount > 0} style={{marginBottom:10}}>
              <summary style={{cursor:'pointer', padding:'10px 14px 10px 12px', borderRadius:10, background:'var(--bg-surface-2)', borderTop:'1px solid var(--border-subtle)', borderRight:'1px solid var(--border-subtle)', borderBottom:'1px solid var(--border-subtle)', borderLeft:`3px solid ${group.color}`, fontSize:13, fontWeight:600}}>
                {group.label}
                <span className="text-xs text-muted" style={{fontWeight:400, marginLeft:8}}>
                  {enabledCount > 0 ? `выбрано: ${enabledCount} из ${defs.length}` : `${defs.length} услов.`}
                </span>
              </summary>
              <div className="flex flex-col gap-2" style={{marginTop:8, marginLeft:4, paddingLeft:8, borderLeft:`2px solid ${group.color}33`}}>
                {group.id === 'patterns' && (() => {
                  // Reference list of every figure the engine can detect, split by
                  // textbook direction — shown ABOVE the condition checkbox (real user
                  // request: "сначала перечень, человек просмотрел, потом поставил
                  // галочку"), and each figure is itself a checkbox: picking specific
                  // figures narrows what "есть подтверждённая фигура" actually checks
                  // for (default = any figure, same as before this list existed).
                  const patternCond = getCondition('pattern_confirmed');
                  const selected = patternCond?.patterns || [];
                  return (
                    <div style={{padding:'10px 14px', borderRadius:10, background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)', marginBottom:4}}>
                      <div style={{fontSize:13, fontWeight:600, marginBottom:2}}>📚 Какие фигуры умеет искать движок</div>
                      <div className="text-xs text-muted" style={{marginBottom:10}}>
                        {selected.length > 0
                          ? `Отмечено ${selected.length} — в условии «есть подтверждённая фигура» ниже учитываются только они.`
                          : 'Ничего не отмечено — условие ниже засчитывает ЛЮБУЮ подтверждённую фигуру. Отметьте нужные, чтобы сузить.'}
                      </div>
                      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12, fontSize:12}}>
                        {[['bullish', '🟢 Бычьи (сигнал вверх)'], ['bearish', '🔴 Медвежьи (сигнал вниз)'], ['neutral', '⚪ Нейтральные (куда пробьёт)']].map(([dir, title]) => (
                          <div key={dir}>
                            <div style={{fontWeight:600, marginBottom:4}}>{title}</div>
                            {PATTERN_DIRECTIONS[dir].map(p => (
                              <label key={p} style={{display:'flex', alignItems:'center', gap:6, padding:'2px 0', cursor:'pointer', color:'var(--text-secondary)'}}>
                                <input type="checkbox" checked={selected.includes(p)} onChange={() => togglePatternInCondition(p)} />
                                {PATTERN_LABELS[p] || p}
                              </label>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {defs.map(def => {
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
                      {enabled && def.category === 'market' && (
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
            </details>
          );
        })}

        <div style={{marginBottom:20}}>
          <div className="calc-section-title">🚪 Выход</div>
          <div className="text-xs text-muted" style={{marginBottom:10}}>
            Стоп и тейк каждый по своей логике: фиксированный %, множитель ATR, или у ближайшего уровня
            S/R / EMA200 (пересчитывается на момент входа). Плюс два необязательных выхода без цены —
            когда условия входа перестали выполняться, или по времени. В Калькуляторе кнопка «Подставить
            по стратегии» предложит число из этих настроек, поле остаётся полностью редактируемым.
          </div>
          <ExitRulesEditor
            value={strategy.exitRules}
            onChange={(next) => setStrategy((s) => ({ ...s, exitRules: next }))}
            maxBarsEnabled={strategy.exitRules?.maxBars != null}
            onMaxBarsEnabledChange={(checked) => setStrategy((s) => ({
              ...s, exitRules: { ...s.exitRules, maxBars: checked ? (s.exitRules.maxBars ?? 20) : null },
            }))}
          />
        </div>

        <div style={{marginBottom:20}}>
          <div className="calc-section-title">✍️ Свои условия</div>
          <div className="text-xs text-muted" style={{marginBottom:10}}>
            Для всего, чего нет в каталоге выше (экзотические индикаторы, проверка новостей) —
            впишите своей формулировкой. ⚠️ Приложение это не считает и не проверяет — в
            Калькуляторе вы будете отмечать такой пункт вручную, глядя на график/новости сами.
          </div>
          <div className="flex gap-2" style={{marginBottom:10, flexWrap:'wrap'}}>
            <select className="input" style={{width:'auto', fontSize:13}} value=""
              onChange={e => { if (e.target.value) setCustomLabel(e.target.value); }}>
              <option value="">— выбрать из популярных —</option>
              {CUSTOM_CONDITION_PRESETS.map(group => (
                <optgroup key={group.group} label={group.group}>
                  {group.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="flex gap-2" style={{flexWrap:'wrap', alignItems:'center'}}>
            <input className="input" style={{flex:1, minWidth:220}} placeholder="Своя формулировка условия..."
              value={customLabel} onChange={e => setCustomLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addCustomCondition()} />
            <select className="input" style={{width:'auto', fontSize:12}} value={customDirection}
              onChange={e => setCustomDirection(e.target.value)}>
              <option value="both">Лонг и шорт</option>
              <option value="long">Только лонг</option>
              <option value="short">Только шорт</option>
            </select>
            <button className="btn btn-secondary btn-sm" onClick={addCustomCondition} disabled={!customLabel.trim()}>
              + Добавить
            </button>
          </div>
          {strategy.customConditions?.length > 0 && (
            <div className="flex flex-col gap-2" style={{marginTop:10}}>
              {strategy.customConditions.map(c => (
                <div key={c.id} style={{
                  display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
                  padding:'8px 14px', borderRadius:10, background:'var(--bg-surface-2)', border:'1px solid var(--border-subtle)',
                }}>
                  <span style={{fontSize:13}}>
                    {c.label}
                    {c.direction !== 'both' && (
                      <span className="text-xs text-muted" style={{marginLeft:8}}>
                        ({c.direction === 'long' ? 'только лонг' : 'только шорт'})
                      </span>
                    )}
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeCustomCondition(c.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button className="btn btn-primary" onClick={saveStrategy} disabled={savingStrategy}>
          {savingStrategy ? <><div className="spinner" style={{width:14,height:14}}/> Сохранение...</> : '💾 Сохранить стратегии'}
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

      {confirmDeleteStrategyId && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteStrategyId(null)}>
          <div className="modal" style={{maxWidth:420}} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Удалить стратегию?</h3>
              <button className="modal-close" onClick={() => setConfirmDeleteStrategyId(null)}>✕</button>
            </div>
            <div style={{padding:'16px 0', color:'var(--text-secondary)', fontSize:14, lineHeight:1.6}}>
              «{strategies.find((s) => s.id === confirmDeleteStrategyId)?.name}» пропадёт из списка. Если передумаете —
              просто не нажимайте «Сохранить стратегии» внизу страницы.
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setConfirmDeleteStrategyId(null)}>Отмена</button>
              <button className="btn btn-primary" style={{background:'var(--red)'}} onClick={() => deleteStrategy(confirmDeleteStrategyId)}>
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
